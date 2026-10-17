import { CalendarDays, FolderOpen, Globe, Mail, Plug, type LucideIcon } from 'lucide-react'
import {
  siAnthropic,
  siElevenlabs,
  siGithub,
  siGmail,
  siGooglecalendar,
  siGoogledrive,
  siNotion,
  siTodoist,
  siWhatsapp,
  type SimpleIcon,
} from 'simple-icons'

/**
 * Real brand marks come from Simple Icons (CC0 collection; each mark remains
 * its owner's trademark and is used only to identify that service). Brands
 * Simple Icons does not carry (Microsoft, Slack, Playwright) get a neutral
 * symbol instead of an imitation of their logo.
 */
const BRANDS: Record<string, SimpleIcon> = {
  gmail: siGmail,
  'google-calendar': siGooglecalendar,
  googlecalendar: siGooglecalendar,
  'google-drive': siGoogledrive,
  github: siGithub,
  notion: siNotion,
  todoist: siTodoist,
  whatsapp: siWhatsapp,
  anthropic: siAnthropic,
  elevenlabs: siElevenlabs,
}

const GENERIC: Record<string, LucideIcon> = {
  playwright: Globe,
  browser: Globe,
  filesystem: FolderOpen,
  files: FolderOpen,
  outlook: Mail,
  'microsoft-365': Mail,
  'm365-calendar': CalendarDays,
}

/** Brands drawn in black are recoloured for dark glass so they stay visible. */
const isNearBlack = (hex: string) => {
  const n = parseInt(hex, 16)
  return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255) < 120
}

/** A connector or provider mark inside a soft tile, keyed by a server/catalogue id. */
export function BrandIcon({ id, size = 36, title }: { id: string; size?: number; title?: string }) {
  const key = id.toLowerCase()
  const brand = BRANDS[key] ?? Object.entries(BRANDS).find(([k]) => key.includes(k))?.[1]
  const Generic = GENERIC[key] ?? Object.entries(GENERIC).find(([k]) => key.includes(k))?.[1] ?? Plug
  const color = brand ? (isNearBlack(brand.hex) ? 'var(--text)' : `#${brand.hex}`) : 'var(--accent)'

  return (
    <span
      className="inline-flex shrink-0 items-center justify-center rounded-xl border border-border"
      style={{
        width: size,
        height: size,
        background: brand && !isNearBlack(brand.hex) ? `color-mix(in srgb, #${brand.hex} 14%, transparent)` : 'var(--surface-strong)',
      }}
      title={title ?? brand?.title}
    >
      {brand ? (
        <svg viewBox="0 0 24 24" width={size * 0.55} height={size * 0.55} fill={color} role="img" aria-label={title ?? brand.title}>
          <path d={brand.path} />
        </svg>
      ) : (
        <Generic style={{ width: size * 0.55, height: size * 0.55, color }} aria-hidden />
      )}
    </span>
  )
}
