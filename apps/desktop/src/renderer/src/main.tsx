import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import { App } from './App.tsx'
import './styles.css'
import { applyStoredAppearance } from './theme.ts'

// The owner's theme before the first paint: no flash of the wrong colours.
applyStoredAppearance()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
