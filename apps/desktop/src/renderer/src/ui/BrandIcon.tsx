import { FolderOpen, Globe, Plug, type LucideIcon } from 'lucide-react'
import { useId } from 'react'

import { BRAND_SVG } from './brands.ts'

/**
 * A service's own full-colour mark (ui/brands.ts: the CC0 "logos" collection;
 * each mark remains its owner's trademark and only names that service).
 * Anything without a mark gets a neutral symbol, never an imitation.
 */
const GENERIC: Record<string, LucideIcon> = {
  browser: Globe,
  filesystem: FolderOpen,
  files: FolderOpen,
}

/** Other names the app uses for the same services. */
const ALIASES: Record<string, string> = {
  googlecalendar: 'google-calendar',
  'google-mail': 'gmail',
  'microsoft-outlook': 'outlook',
  'openai-compatible': 'openai',
  'google-gemini': 'gemini',
  'azure-speech': 'azure',
  'visual-studio-code': 'vscode',
  code: 'vscode',
}

/** The mark for an id: exactly, through an alias, or by one of its words ("mcp-github" → github). */
export const brandOf = (id: string) => {
  const key = id.toLowerCase()
  const exact = ALIASES[key] ?? key
  if (BRAND_SVG[exact]) return BRAND_SVG[exact]
  const words = key.split(/[^a-z0-9]+/).filter(Boolean)
  for (let n = words.length; n > 0; n--)
    for (let i = 0; i + n <= words.length; i++) {
      const part = words.slice(i, i + n).join('-')
      const hit = BRAND_SVG[ALIASES[part] ?? part]
      if (hit) return hit
    }
  return null
}

/** A mark's own gradient and clip ids, made unique so two copies on one page do not share them. */
const ownIds = (body: string, suffix: string) => body.replace(/id="([^"]+)"/g, `id="$1${suffix}"`).replace(/url\(#([^)]+)\)/g, `url(#$1${suffix})`).replace(/href="#([^"]+)"/g, `href="#$1${suffix}"`)

/** A connector or provider mark inside a soft tile, keyed by a server/catalogue id. */
export function BrandIcon({ id, size = 36, title }: { id: string; size?: number; title?: string }) {
  const suffix = `-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const brand = brandOf(id)
  const key = id.toLowerCase()
  const Generic = GENERIC[key] ?? Object.entries(GENERIC).find(([k]) => key.includes(k))?.[1] ?? Plug
  const inner = size * 0.6

  return (
    <span className="inline-flex shrink-0 items-center justify-center rounded-xl border border-border bg-surface-strong" style={{ width: size, height: size }} title={title}>
      {brand ? (
        <svg viewBox={`0 0 ${brand.w} ${brand.h}`} width={inner} height={inner} role="img" aria-label={title ?? id} dangerouslySetInnerHTML={{ __html: ownIds(brand.b, suffix) }} />
      ) : (
        <Generic style={{ width: inner, height: inner, color: 'var(--accent)' }} aria-hidden />
      )}
    </span>
  )
}

/** Just the mark, inline with text (a browser beside its name); nothing when the service has none. */
export function BrandMark({ id, size = 12 }: { id: string; size?: number }) {
  const suffix = `-${useId().replace(/[^a-zA-Z0-9]/g, '')}`
  const brand = brandOf(id)
  if (!brand) return null
  return <svg viewBox={`0 0 ${brand.w} ${brand.h}`} width={size} height={size} className="inline-block shrink-0 align-[-2px]" aria-hidden dangerouslySetInnerHTML={{ __html: ownIds(brand.b, suffix) }} />
}
