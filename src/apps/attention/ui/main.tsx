import './panel.css'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { Panel } from './Panel'

const root = document.getElementById('root')
if (root) {
  createRoot(root).render(
    <StrictMode>
      <Panel />
    </StrictMode>
  )
}
