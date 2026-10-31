import { QueryClientProvider } from '@tanstack/react-query'
import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { BrowserRouter } from 'react-router'
import { queryClient } from '@/api/hooks'
import { AuthProvider } from '@/auth/AuthProvider'
import { ToastProvider } from '@/components/ui/toast'
import { AppContextProvider } from '@/context/AppContext'
import { applyStoredTheme } from '@/layout/theme'
import App from './App'
import './index.css'

applyStoredTheme()

const root = document.getElementById('root')
if (!root) throw new Error('Root element not found')

createRoot(root).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <BrowserRouter>
          <AuthProvider>
            <AppContextProvider>
              <App />
            </AppContextProvider>
          </AuthProvider>
        </BrowserRouter>
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
)
