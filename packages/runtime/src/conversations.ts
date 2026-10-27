/**
 * Earlier conversations are never sent to the model by themselves (only
 * the current one is, and long-term facts come from memory). These tools
 * let the assistant look back when the owner asks ("kal kya baat hui thi?")
 * and start a fresh conversation when the owner wants one ("naya chat").
 */
import type { MemoryStore } from '@assistant/memory'
import type { Rule } from '@assistant/policy'

import type { RuntimeTool } from './tools.ts'

export const CONVERSATION_RULES: Rule[] = [
  { id: 'default-chat_history_search', tool: 'chat_history_search', actionClass: 'observe', effect: 'allow' },
  { id: 'default-conversation_new', tool: 'conversation_new', actionClass: 'modify', effect: 'allow' },
]

const when = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', ' ')

export const conversationTools = (memory: MemoryStore, control: { requestNew(): void; currentId(): string }): RuntimeTool[] => [
  {
    name: 'chat_history_search',
    description:
      'Search earlier conversations with the owner by words ("kal kya baat hui thi Ahmed ke baare mein", "what did I say about the visa"). Returns matching messages with their date and conversation title, newest first. Use it only when the owner refers to something said in an earlier chat; the current conversation is already in front of you.',
    inputSchema: { type: 'object', properties: { query: { type: 'string', description: 'A few distinctive words.' } }, required: ['query'] },
    actionClass: 'observe',
    isUntrusted: false,
    run: async input => {
      const query = typeof input.query === 'string' ? input.query.trim().slice(0, 100) : ''
      const current = control.currentId()
      const hits = memory.searchMessages(query, 15).filter(h => h.conversationId !== current)
      if (!hits.length) return `Nothing in earlier conversations matches "${query}".`
      return hits.map(h => `- ${when(h.at)} UTC${h.title ? ` in "${h.title}"` : ''}, ${h.speaker === 'owner' ? 'owner' : 'you'}: ${h.content.replace(/\s+/g, ' ').slice(0, 300)}`).join('\n')
    },
  },
  {
    name: 'conversation_new',
    description:
      'Start a fresh conversation after this reply, when the owner asks ("naya chat shuru karo", "new topic", "start over"). The current one stays in the chat list. Say briefly that you are starting fresh.',
    inputSchema: { type: 'object', properties: {} },
    actionClass: 'modify',
    isUntrusted: false,
    run: async () => {
      control.requestNew()
      return 'A new conversation starts after this reply.'
    },
  },
]
