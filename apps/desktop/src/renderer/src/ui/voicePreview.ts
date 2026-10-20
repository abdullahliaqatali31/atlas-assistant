/**
 * Hear a voice before choosing it: main makes a short sample with the
 * owner's own key; it plays here (one at a time). Errors come back as text.
 */
import type { VoicePreviewProvider } from '../../../shared/powerup.ts'

let playing: HTMLAudioElement | null = null

export const previewVoice = async (provider: VoicePreviewProvider, voice: string): Promise<string | null> => {
  try {
    const audio = await window.powerup.previewVoice(provider, voice)
    if (!audio) return 'Add the key for this voice first.'
    playing?.pause()
    const url = URL.createObjectURL(new Blob([audio as BlobPart], { type: 'audio/mpeg' }))
    const el = new Audio(url)
    playing = el
    el.onended = () => URL.revokeObjectURL(url)
    await el.play()
    return null
  } catch (e) {
    return e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : 'Could not play the sample.'
  }
}
