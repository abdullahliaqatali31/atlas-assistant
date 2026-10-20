/**
 * Themes, accent colour and Lite mode. Tokens live in styles.css under
 * :root[data-theme], [data-accent] and [data-lite]; this applies the owner's
 * choice (remembered on this computer) and follows Windows' light or dark
 * setting when the theme is "system".
 */
import { useEffect, useState } from 'react'

export const THEMES = ['system', 'midnight', 'graphite', 'aurora', 'daylight'] as const
export type ThemeName = (typeof THEMES)[number]
export const ACCENTS = ['theme', 'cyan', 'blue', 'violet', 'emerald', 'amber', 'rose'] as const
export type Accent = (typeof ACCENTS)[number]
export type LiteChoice = 'auto' | 'on' | 'off'

export const THEME_LABEL: Record<ThemeName, string> = {
  system: 'Follow Windows (Midnight or Daylight)',
  midnight: 'Midnight: deep navy, cyan glow',
  graphite: 'Graphite: neutral dark, calm',
  aurora: 'Aurora: vivid dark, violet',
  daylight: 'Daylight: clean and light',
}

export interface Appearance {
  theme: ThemeName
  accent: Accent
  lite: LiteChoice
}

const KEY = 'appearance'
const DEFAULT: Appearance = { theme: 'system', accent: 'theme', lite: 'auto' }

const read = (): Appearance => {
  try {
    const v = JSON.parse(localStorage.getItem(KEY) ?? '{}') as Partial<Appearance>
    return {
      theme: (THEMES as readonly string[]).includes(v.theme ?? '') ? (v.theme as ThemeName) : DEFAULT.theme,
      accent: (ACCENTS as readonly string[]).includes(v.accent ?? '') ? (v.accent as Accent) : DEFAULT.accent,
      lite: v.lite === 'on' || v.lite === 'off' ? v.lite : 'auto',
    }
  } catch {
    return DEFAULT
  }
}

/** A modest machine, or Windows asking for less transparency or motion: go light. */
export const machineWantsLite = () => {
  const nav = navigator as Navigator & { deviceMemory?: number }
  return (
    (navigator.hardwareConcurrency ?? 8) <= 4 ||
    (nav.deviceMemory ?? 8) <= 4 ||
    window.matchMedia('(prefers-reduced-transparency: reduce)').matches ||
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

export const applyAppearance = (a: Appearance) => {
  const root = document.documentElement
  const dark = !window.matchMedia('(prefers-color-scheme: light)').matches
  const theme = a.theme === 'system' ? (dark ? 'midnight' : 'daylight') : a.theme
  root.dataset.theme = theme
  if (a.accent === 'theme') delete root.dataset.accent
  else root.dataset.accent = a.accent
  const lite = a.lite === 'on' || (a.lite === 'auto' && machineWantsLite())
  root.dataset.lite = String(lite)
  root.style.colorScheme = theme === 'daylight' ? 'light' : 'dark'
  // Lite: a solid window in the theme's own base colour (no desktop blending behind every frame).
  const toHex = (c: string) => {
    const m = /^#([0-9a-f]{6})$/i.exec(c) ?? /^#([0-9a-f])([0-9a-f])([0-9a-f])$/i.exec(c)
    return m ? (m.length === 2 ? `#${m[1]}` : `#${m[1]}${m[1]}${m[2]}${m[2]}${m[3]}${m[3]}`) : '#070c18'
  }
  void window.ui?.setSolid?.(lite, toHex(getComputedStyle(root).getPropertyValue('--solid').trim())).catch(() => undefined)
}

/** The owner's appearance, applied now and whenever Windows' light or dark setting changes. */
export const useAppearance = () => {
  const [a, setA] = useState<Appearance>(read)
  useEffect(() => {
    applyAppearance(a)
    try {
      localStorage.setItem(KEY, JSON.stringify(a))
    } catch {
      // Remembering the look is a convenience only.
    }
    const m = window.matchMedia('(prefers-color-scheme: light)')
    const on = () => applyAppearance(a)
    m.addEventListener('change', on)
    return () => m.removeEventListener('change', on)
  }, [a])
  return [a, (patch: Partial<Appearance>) => setA(x => ({ ...x, ...patch }))] as const
}

/** Applied before React renders, so there is no flash of the wrong theme. */
export const applyStoredAppearance = () => applyAppearance(read())

/** One change from outside Settings (the command palette): merged, applied and remembered. */
export const changeAppearance = (patch: Partial<Appearance>) => {
  const next = { ...read(), ...patch }
  applyAppearance(next)
  try {
    localStorage.setItem(KEY, JSON.stringify(next))
  } catch {
    // Remembering the look is a convenience only.
  }
  return next
}
export const currentAppearance = () => read()
