import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles.css'
import { applyStoredAppearance } from '../theme.ts'
import { PresenceApp } from './PresenceApp.tsx'

// The owner's theme, as in the main window (same storage).
applyStoredAppearance()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <PresenceApp />
  </StrictMode>,
)
