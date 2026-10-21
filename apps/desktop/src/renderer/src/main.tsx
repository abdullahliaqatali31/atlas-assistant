import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'
import './styles.css'
import { applyStoredAppearance } from './theme.ts'
import { LinkBanner } from './web/LinkBanner.tsx'
import { PairScreen } from './web/PairScreen.tsx'
import { isWeb, startWeb } from './web/transport.ts'

// The owner's theme before the first paint: no flash of the wrong colours.
applyStoredAppearance()

const root = createRoot(document.getElementById('root')!)

// In a browser the bridges come over a WebSocket from Atlas on the PC; an unknown browser pairs first.
void (isWeb ? startWeb() : Promise.resolve(true)).then(ready =>
  root.render(
    <StrictMode>
      {ready ? <App /> : <PairScreen />}
      {ready && isWeb && <LinkBanner />}
    </StrictMode>,
  ),
)
