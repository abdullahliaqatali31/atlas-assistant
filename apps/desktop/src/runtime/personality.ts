/**
 * Host side of the owner's personality profile: answers profile ops from
 * main against the memory store and keeps the speech-to-text language pin in
 * step with the chosen language. Only main's IPC (the owner's Setup and
 * onboarding screens) reaches this; no tool or model output does.
 */
import type { MemoryStore } from '@assistant/memory'
import { sttLanguageFor } from '@assistant/shared'

import type { PersonalityHostEvent, PersonalityOp, PersonalityView } from '../shared/personality.ts'

export const viewOf = (memory: MemoryStore): PersonalityView => ({
  ...memory.personality(),
  onboarded: memory.isOnboarded(),
  history: memory.personalityHistory(8).map(({ version, reason, at }) => ({ version, reason, at })),
})

/** The pin for the current profile; 'auto' falls back to ASSISTANT_LANGUAGES. */
export const sttPin = (memory: MemoryStore, configured: readonly string[]) => sttLanguageFor(memory.personality().profile.language, configured)

export const runPersonalityOp = (memory: MemoryStore | null, requestId: string, op: PersonalityOp): PersonalityHostEvent => {
  if (!memory) return { type: 'personality', requestId, error: 'The assistant is not ready yet.' }
  try {
    switch (op.kind) {
      case 'get':
        break
      case 'update':
        memory.updatePersonality(op.patch, op.reason)
        break
      case 'undo':
        memory.undoPersonality()
        break
      case 'reset':
        memory.resetPersonality()
        break
      case 'onboarded':
        memory.setOnboarded(op.done)
        break
      case 'export':
        return { type: 'personality', requestId, view: viewOf(memory), exported: JSON.stringify(memory.exportPersonality(), null, 2) }
    }
    return { type: 'personality', requestId, view: viewOf(memory) }
  } catch (error) {
    return { type: 'personality', requestId, error: error instanceof Error ? error.message : String(error) }
  }
}

export async function* once(text: string): AsyncIterable<string> {
  yield text
}
