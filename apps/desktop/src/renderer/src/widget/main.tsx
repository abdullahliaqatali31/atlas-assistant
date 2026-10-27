import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles.css'
import { applyStoredAppearance } from '../theme.ts'
import { startWeb } from '../web/transport.ts'
import { Widget } from './Widget.tsx'

// The desktop widget: its own small page (no maps, no pages), paired by the ticket in its address.
applyStoredAppearance()
const root = createRoot(document.getElementById('root')!)
void startWeb().then(ready =>
  root.render(
    <StrictMode>
      {ready ? <Widget /> : <p className="p-4 text-xs text-white/70">Connecting to Atlas…</p>}
    </StrictMode>,
  ),
)
