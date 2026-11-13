import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { installTokens } from './styles/tokens'
import { App } from './app/App'
import { RootBoundary } from './app/RootBoundary'
import { ignoreStrayDrops } from './app/drops'
import './styles/app.css'

installTokens()
ignoreStrayDrops(window)

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RootBoundary>
      <App />
    </RootBoundary>
  </StrictMode>,
)
