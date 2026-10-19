import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'

import '../styles.css'
import { applyStoredAppearance } from '../theme.ts'
import { GlassApp } from './GlassApp.tsx'

applyStoredAppearance()

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <GlassApp />
  </StrictMode>,
)
