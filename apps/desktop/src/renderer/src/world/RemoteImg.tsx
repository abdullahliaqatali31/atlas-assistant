/**
 * A picture from Wikimedia Commons or airport-data.com, fetched by main
 * (window.world.image) so it loads reliably; until it arrives, or if it
 * cannot, a quiet placeholder (initials for a person) instead of a broken icon.
 */
import { useEffect, useState } from 'react'

const seen = new Map<string, string | null>()

export function RemoteImg({ src, alt = '', className = '', initials, onMissing }: { src: string | null | undefined; alt?: string; className?: string; initials?: string; onMissing?: () => void }) {
  const [data, setData] = useState<string | null | undefined>(() => (src ? seen.get(src) : null))
  useEffect(() => {
    if (!src) return setData(null)
    if (seen.has(src)) return setData(seen.get(src))
    let gone = false
    setData(undefined)
    void window.world.image(src).then(
      d => {
        seen.set(src, d)
        if (!gone) setData(d)
      },
      () => !gone && setData(null),
    )
    return () => {
      gone = true
    }
  }, [src])
  useEffect(() => {
    if (data === null) onMissing?.()
    // Only when it turns out missing.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])
  if (data) return <img src={data} alt={alt} className={className} />
  if (data === null && !initials) return null
  return (
    <span className={`grid place-items-center bg-surface font-mono text-[10px] text-muted ${data === undefined ? 'animate-pulse' : ''} ${className}`} aria-hidden>
      {initials ?? ''}
    </span>
  )
}

export const initialsOf = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map(w => w[0]!.toUpperCase())
    .join('')
