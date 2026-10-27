/**
 * Live voice, main side: mints one short-lived OpenAI Realtime client secret
 * per conversation with the whole session fixed here — model, voice, turn
 * detection, instructions and the two tools — so the page never holds the
 * API key and cannot change what the session is. At most one mint every few
 * seconds.
 */
import { LIVE_MODELS, LIVE_TRANSCRIBE_MODEL, type LiveSession, type LiveVoiceSettings } from '../shared/livevoice.ts'

const ENDPOINT = 'https://api.openai.com/v1/realtime/client_secrets'
const MIN_GAP_MS = 3_000

/** How the voice behaves: warm and quick itself, everything real goes to Atlas's mind. */
export const liveInstructions = (assistant: string, owner: string) =>
  [
    `You are ${assistant}, ${owner ? `${owner}'s` : 'the owner’s'} personal assistant on their Windows PC, talking live by voice.`,
    'Sound like a warm, quick, witty friend. Match the owner’s language exactly: Roman Urdu, Urdu-English mix, or English — whatever they speak. Keep spoken replies short (one or two sentences) unless they ask for detail. No filler like "let me check".',
    'You are the voice. Your mind — memory, tasks and reminders, files, apps, WhatsApp, email, news, weather, the World map, the PC, the web and every action — is reached only through the ask_atlas tool.',
    'Call ask_atlas for anything beyond small talk: questions about the owner’s life or world, anything you are not sure of, and every request to do something. Pass the owner’s request in their own words, with any detail from this conversation it needs.',
    'When ask_atlas answers, say it naturally and briefly in the owner’s language. Do not add facts it did not give. Read at most three items of a list and offer the rest. Never say something was done unless ask_atlas said so.',
    'If ask_atlas says the owner must confirm something, ask them plainly, then call ask_atlas with their answer (for example "haan" or "nahi").',
    'Small talk, jokes and banter you may do yourself, with good taste; laugh at yourself when you get something wrong.',
    'When the owner ends the chat ("bas", "that’s all", "khuda hafiz", "bye"), say a short goodbye and call end_conversation.',
  ].join('\n')

const TOOLS = [
  {
    type: 'function',
    name: 'ask_atlas',
    description: 'Ask Atlas’s mind (memory, tasks, files, apps, messages, the map, the PC, the web, and every action). Returns the answer to say.',
    parameters: { type: 'object', properties: { request: { type: 'string', description: 'The owner’s request in their own words, with needed detail.' } }, required: ['request'], additionalProperties: false },
  },
  { type: 'function', name: 'end_conversation', description: 'End the live conversation after saying goodbye.', parameters: { type: 'object', properties: {}, additionalProperties: false } },
]

export class LiveVoice {
  private lastMint = 0

  constructor(
    private readonly deps: {
      key: () => string | undefined
      settings: () => LiveVoiceSettings
      names: () => { assistant: string; owner: string }
      fetchImpl?: typeof fetch
    },
  ) {}

  get available() {
    return Boolean(this.deps.key())
  }

  async mint(): Promise<LiveSession> {
    const key = this.deps.key()
    if (!key) throw new Error('Live voice needs an OpenAI key: add it in Setup › Power up.')
    const s = this.deps.settings()
    if (!s.enabled) throw new Error('Live voice is off (Setup › Connection › Voice).')
    if (Date.now() - this.lastMint < MIN_GAP_MS) throw new Error('One moment — starting the last session.')
    this.lastMint = Date.now()
    const model = LIVE_MODELS[s.tier].id
    const { assistant, owner } = this.deps.names()
    const body = {
      session: {
        type: 'realtime',
        model,
        // Long talks stay cheap: older turns are dropped, the instructions kept.
        truncation: { type: 'retention_ratio', retention_ratio: 0.5, token_limits: { post_instructions: 3000 } },
        audio: {
          input: {
            noise_reduction: { type: 'near_field' },
            transcription: { model: LIVE_TRANSCRIBE_MODEL },
            // It hears when a thought is finished, not just a pause; room noise never cuts its answer off.
            turn_detection: { type: 'semantic_vad', eagerness: 'low', create_response: true, interrupt_response: false },
          },
          output: { voice: s.voice },
        },
        instructions: liveInstructions(assistant.replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40) || 'Atlas', owner.replace(/[^\p{L}\p{N} .'-]/gu, '').slice(0, 40)),
        tools: TOOLS,
        tool_choice: 'auto',
      },
    }
    const res = await (this.deps.fetchImpl ?? fetch)(ENDPOINT, {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(20_000),
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
    const text = await res.text()
    if (!res.ok) throw new Error(res.status === 401 ? 'OpenAI refused the key (Setup › Power up › Test).' : res.status === 429 ? 'OpenAI says slow down or add credit to the account.' : `OpenAI could not start a live session (${res.status}).`)
    let data: { value?: string; expires_at?: number; client_secret?: { value?: string; expires_at?: number } }
    try {
      data = JSON.parse(text)
    } catch {
      throw new Error('OpenAI answered in an unexpected way.')
    }
    const token = data.value ?? data.client_secret?.value
    if (!token) throw new Error('OpenAI did not return a session token.')
    return { token, expiresAt: data.expires_at ?? data.client_secret?.expires_at ?? null, model, tier: s.tier, capUsd: s.capUsd }
  }
}
