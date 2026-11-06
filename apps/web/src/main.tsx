import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { createQueryClient } from './lib/queries'
import { syncThemeFromStorage, THEME_STORAGE_KEY, watchSystemTheme } from './lib/theme'
import { createAppRouter } from './router'
import './index.css'

const root = document.getElementById('root')
if (!root) throw new Error('missing #root element')

watchSystemTheme()
// Keep tabs in step when the theme changes in another one.
window.addEventListener('storage', (event) => {
  if (event.key === THEME_STORAGE_KEY) syncThemeFromStorage()
})

const queryClient = createQueryClient()
const router = createAppRouter({ queryClient })

createRoot(root).render(
  <StrictMode>
    <App queryClient={queryClient} router={router} />
  </StrictMode>,
)
