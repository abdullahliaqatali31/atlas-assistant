/**
 * How the conversation looks, the owner's choice: text size, density, bubble
 * style and width. Saved in this window's storage and applied as CSS
 * variables on the message list, so nothing else needs to know.
 */
import type { CSSProperties } from 'react'

export interface ChatView {
  size: 's' | 'm' | 'l' | 'xl'
  density: 'compact' | 'cozy'
  style: 'bubbles' | 'minimal'
  width: 'narrow' | 'wide' | 'full'
}

export const DEFAULT_CHAT_VIEW: ChatView = { size: 'm', density: 'compact', style: 'bubbles', width: 'wide' }

export const CHAT_VIEW_CHOICES: { [K in keyof ChatView]: { label: string; options: { value: ChatView[K]; label: string }[] } } = {
  size: { label: 'Text size', options: [{ value: 's', label: 'S' }, { value: 'm', label: 'M' }, { value: 'l', label: 'L' }, { value: 'xl', label: 'XL' }] },
  density: { label: 'Spacing', options: [{ value: 'compact', label: 'Compact' }, { value: 'cozy', label: 'Comfortable' }] },
  style: { label: 'Style', options: [{ value: 'bubbles', label: 'Bubbles' }, { value: 'minimal', label: 'Minimal' }] },
  width: { label: 'Width', options: [{ value: 'narrow', label: 'Narrow' }, { value: 'wide', label: 'Wide' }, { value: 'full', label: 'Full' }] },
}

const KEY = 'chat.view'
export const CHAT_VIEW_EVENT = 'chat-view-changed'

const pick = <K extends keyof ChatView>(k: K, v: unknown): ChatView[K] => (CHAT_VIEW_CHOICES[k].options.some(o => o.value === v) ? (v as ChatView[K]) : DEFAULT_CHAT_VIEW[k])

export const readChatView = (): ChatView => {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Record<string, unknown>
    return { size: pick('size', raw.size), density: pick('density', raw.density), style: pick('style', raw.style), width: pick('width', raw.width) }
  } catch {
    return DEFAULT_CHAT_VIEW
  }
}

export const saveChatView = (v: ChatView) => {
  try {
    localStorage.setItem(KEY, JSON.stringify(v))
  } catch {
    // Storage unavailable: the choice lasts this session.
  }
  window.dispatchEvent(new CustomEvent(CHAT_VIEW_EVENT, { detail: v }))
}

const TEXT = { s: 13, m: 14, l: 16, xl: 18 } as const

/** The CSS variables the message list reads. */
export const chatViewVars = (v: ChatView): CSSProperties =>
  ({
    '--chat-text': `${TEXT[v.size]}px`,
    '--voice-caption': `${TEXT[v.size] + 3}px`,
    '--chat-pad-x': v.density === 'compact' ? '0.75rem' : '0.95rem',
    '--chat-pad-y': v.density === 'compact' ? '0.45rem' : '0.7rem',
    '--chat-gap': v.density === 'compact' ? '0.5rem' : '0.85rem',
    '--chat-max': v.width === 'narrow' ? '72%' : v.width === 'wide' ? '86%' : '100%',
  }) as CSSProperties
