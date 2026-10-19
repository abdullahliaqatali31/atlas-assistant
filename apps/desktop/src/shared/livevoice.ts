/**
 * Live voice: OpenAI Realtime, speech in and speech out in one model over
 * WebRTC, answering in well under a second. It is the voice; Atlas (Claude or
 * whichever brain is set) stays the mind, reached through one tool. Main mints
 * a short-lived session with everything fixed (model, voice, instructions,
 * tools), so the page never sees the API key or changes the session.
 */

export const LIVE_TIERS = ['mini', 'standard'] as const
export type LiveTier = (typeof LIVE_TIERS)[number]

/** USD per million tokens (OpenAI pricing, checked 2026-08). */
export interface LiveRates {
  textInput: number
  textCachedInput: number
  textOutput: number
  audioInput: number
  audioCachedInput: number
  audioOutput: number
}

export const LIVE_MODELS: Record<LiveTier, { id: string; label: string; rates: LiveRates }> = {
  mini: { id: 'gpt-realtime-2.1-mini', label: 'Mini · fast and cheap', rates: { textInput: 0.6, textCachedInput: 0.06, textOutput: 2.4, audioInput: 10, audioCachedInput: 0.3, audioOutput: 20 } },
  standard: { id: 'gpt-realtime-2', label: 'Standard · richest voice', rates: { textInput: 4, textCachedInput: 0.4, textOutput: 24, audioInput: 32, audioCachedInput: 0.4, audioOutput: 64 } },
}

export const LIVE_VOICES = ['marin', 'cedar', 'coral', 'sage', 'shimmer', 'alloy', 'ash', 'ballad', 'echo', 'verse'] as const
export type LiveVoiceName = (typeof LIVE_VOICES)[number]

/** Captions of what the owner said (billed separately, a fraction of a cent a minute). */
export const LIVE_TRANSCRIBE_MODEL = 'gpt-4o-mini-transcribe'

export interface LiveVoiceSettings {
  enabled: boolean
  tier: LiveTier
  voice: LiveVoiceName
  /** A session stops when it has cost this much (USD). */
  capUsd: number
}

export const DEFAULT_LIVE_VOICE: LiveVoiceSettings = { enabled: false, tier: 'mini', voice: 'marin', capUsd: 3 }

export const parseLiveVoice = (v: unknown): LiveVoiceSettings => {
  const o = (v ?? {}) as Partial<LiveVoiceSettings>
  return {
    enabled: o.enabled === true,
    tier: LIVE_TIERS.includes(o.tier as LiveTier) ? (o.tier as LiveTier) : DEFAULT_LIVE_VOICE.tier,
    voice: LIVE_VOICES.includes(o.voice as LiveVoiceName) ? (o.voice as LiveVoiceName) : DEFAULT_LIVE_VOICE.voice,
    capUsd: typeof o.capUsd === 'number' && Number.isFinite(o.capUsd) ? Math.min(50, Math.max(0.25, o.capUsd)) : DEFAULT_LIVE_VOICE.capUsd,
  }
}

/** The realtime usage block (response.done → response.usage). */
export interface RealtimeUsage {
  input_tokens?: number
  output_tokens?: number
  input_token_details?: { text_tokens?: number; audio_tokens?: number; image_tokens?: number; cached_tokens?: number; cached_tokens_details?: { text_tokens?: number; audio_tokens?: number } }
  output_token_details?: { text_tokens?: number; audio_tokens?: number }
}

const n = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : 0)

/**
 * What one response cost. Cached tokens are billed at the cached rate; an
 * input with no breakdown counts as audio (the dearer kind), so the meter
 * never under-reports.
 */
export const usageCost = (u: RealtimeUsage, r: LiveRates): number => {
  const inD = u.input_token_details
  const outD = u.output_token_details
  const cachedText = n(inD?.cached_tokens_details?.text_tokens)
  const cachedAudio = n(inD?.cached_tokens_details?.audio_tokens) || (inD?.cached_tokens_details ? 0 : n(inD?.cached_tokens))
  const textIn = inD ? Math.max(0, n(inD.text_tokens) - cachedText) : 0
  const audioIn = inD ? Math.max(0, n(inD.audio_tokens) - cachedAudio) : n(u.input_tokens)
  const textOut = outD ? n(outD.text_tokens) : 0
  const audioOut = outD ? n(outD.audio_tokens) : n(u.output_tokens)
  return (textIn * r.textInput + cachedText * r.textCachedInput + audioIn * r.audioInput + cachedAudio * r.audioCachedInput + textOut * r.textOutput + audioOut * r.audioOutput) / 1_000_000
}

/** What main hands the page to open a live session. */
export interface LiveSession {
  token: string
  /** Epoch seconds; the token is good for one connection before this. */
  expiresAt: number | null
  model: string
  tier: LiveTier
  capUsd: number
}

export const LIVE_TOOLS = ['ask_atlas', 'end_conversation'] as const
