/**
 * Deterministic permission gate. Runs outside the LLM: the model can request an
 * action, only this module decides whether it runs, needs confirmation, or is
 * refused. Nothing a webpage, email or tool result says can change a rule.
 */

/** Ordered from least to most consequential. */
export const ACTION_CLASSES = [
  'observe',
  'draft',
  'modify',
  'external-send',
  'destructive',
  'credential',
  'payment',
] as const

export type ActionClass = (typeof ACTION_CLASSES)[number]

/** Classes that always need a fresh confirmation, whatever the standing rules say. */
const ALWAYS_CONFIRM: ReadonlySet<ActionClass> = new Set(['destructive', 'credential', 'payment'])

export interface ActionRequest {
  tool: string
  actionClass: ActionClass
  /** Folder, domain, recipient or server the action targets. */
  scope?: string
  /** Count or monetary value, compared against a rule's `maxValue`. */
  value?: number
  /** True when the request originated from untrusted content rather than the owner. */
  fromUntrustedSource?: boolean
  /**
   * The owner turned Full control on: their commands run without asking.
   * Deny rules and the always-confirm classes still hold, and after untrusted
   * content anything that sends something out or is risky still asks.
   */
  fullControl?: boolean
}

export interface Rule {
  id: string
  /** A tool name, "<server>__*" for every tool of one MCP server, or "*". */
  tool: string | '*'
  actionClass: ActionClass
  effect: 'allow' | 'ask' | 'deny'
  /** Folder or domain, matched on a boundary: "C:/Work" covers "C:/Work/a.md" but not "C:/Workshop". */
  scopePrefix?: string
  maxValue?: number
  expiresAt?: number
}

export type Decision =
  | { effect: 'allow'; ruleId: string; reason: string }
  | { effect: 'ask'; ruleId: string | null; reason: string }
  | { effect: 'deny'; ruleId: string | null; reason: string }

const matches = (rule: Rule, req: ActionRequest, now: number) => {
  if (rule.expiresAt !== undefined && rule.expiresAt <= now) return false
  if (!toolMatches(rule.tool, req.tool)) return false
  if (rule.actionClass !== req.actionClass) return false
  if (rule.scopePrefix !== undefined) {
    if (req.scope === undefined) return false
    if (!withinScope(req.scope, rule.scopePrefix)) return false
  }
  if (rule.maxValue !== undefined && (req.value ?? 0) > rule.maxValue) return false
  return true
}

const normalize = (s: string) => s.replaceAll('\\', '/').toLowerCase()

const SERVER_WILDCARD = '__*'

const toolMatches = (ruleTool: string, tool: string) =>
  ruleTool === '*' || ruleTool === tool || (ruleTool.endsWith(SERVER_WILDCARD) && tool.startsWith(ruleTool.slice(0, -1)))

/** Prefix match that stops at a path or domain boundary. */
export const withinScope = (scope: string, prefix: string) => {
  const s = normalize(scope)
  const p = normalize(prefix)
  if (!p || !s.startsWith(p)) return false
  return s.length === p.length || p.endsWith('/') || s[p.length] === '/'
}

/** More specific rules win; on a tie, deny beats ask beats allow. */
const specificity = (rule: Rule) =>
  (rule.tool === '*' ? 0 : rule.tool.endsWith(SERVER_WILDCARD) ? 3 : 4) + (rule.scopePrefix ? 2 : 0) + (rule.maxValue !== undefined ? 1 : 0)

const severity = { deny: 2, ask: 1, allow: 0 } as const

export const evaluate = (req: ActionRequest, rules: readonly Rule[], now: number): Decision => {
  const hits = rules
    .filter(rule => matches(rule, req, now))
    .sort((a, b) => specificity(b) - specificity(a) || severity[b.effect] - severity[a.effect])

  const top = hits[0]

  if (top?.effect === 'deny') {
    return { effect: 'deny', ruleId: top.id, reason: `Rule ${top.id} denies ${req.actionClass} via ${req.tool}.` }
  }

  if (ALWAYS_CONFIRM.has(req.actionClass)) {
    return { effect: 'ask', ruleId: top?.id ?? null, reason: `${req.actionClass} actions always need confirmation.` }
  }

  if (req.fromUntrustedSource && req.actionClass !== 'observe' && (!req.fullControl || req.actionClass === 'external-send' || req.scope?.startsWith('risky'))) {
    return {
      effect: 'ask',
      ruleId: top?.id ?? null,
      reason: 'The request came from untrusted content, so the owner must confirm it.',
    }
  }

  if (req.fullControl) {
    return { effect: 'allow', ruleId: top?.id ?? 'full-control', reason: 'Full control is on: the owner’s command runs without asking.' }
  }

  if (!top) {
    return req.actionClass === 'observe'
      ? { effect: 'ask', ruleId: null, reason: `No rule covers ${req.tool}; asking once.` }
      : { effect: 'ask', ruleId: null, reason: `No standing permission for ${req.actionClass} via ${req.tool}.` }
  }

  return top.effect === 'allow'
    ? { effect: 'allow', ruleId: top.id, reason: `Allowed by rule ${top.id}.` }
    : { effect: 'ask', ruleId: top.id, reason: `Rule ${top.id} requires confirmation.` }
}

/** MCP tool annotations, as servers declare them (all optional hints). */
export interface ToolAnnotations {
  readOnlyHint?: boolean
  destructiveHint?: boolean
  idempotentHint?: boolean
  openWorldHint?: boolean
}

/**
 * Map MCP hints to an action class. Hints come from the server, so they can
 * only make a tool look *safer* when the owner trusts that server; missing
 * hints default to the strictest non-confirm class.
 */
export const classifyMcpTool = (annotations: ToolAnnotations | undefined, isServerTrusted: boolean): ActionClass => {
  if (!annotations || !isServerTrusted) return 'external-send'
  if (annotations.readOnlyHint === true) return 'observe'
  if (annotations.destructiveHint === true) return 'destructive'
  if (annotations.openWorldHint === false) return 'modify'
  return 'external-send'
}
