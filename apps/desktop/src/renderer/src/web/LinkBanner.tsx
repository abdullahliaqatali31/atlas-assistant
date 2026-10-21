/** In a browser: a small notice while the PC is out of reach (it reconnects by itself). */
import { WifiOff } from 'lucide-react'
import { useEffect, useState } from 'react'

import { linkState, onLink } from './transport.ts'

export function LinkBanner() {
  const [link, setLink] = useState(linkState)
  useEffect(() => onLink(setLink), [])
  if (link !== 'lost') return null
  return (
    <div role="status" className="fixed top-3 left-1/2 z-[100] flex -translate-x-1/2 items-center gap-2 rounded-full border border-warm/60 bg-surface px-3 py-1.5 text-xs text-warm shadow-xl">
      <WifiOff className="size-3.5" aria-hidden /> Reconnecting to your PC…
    </div>
  )
}
