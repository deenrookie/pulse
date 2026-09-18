import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'
import SharedTrafficView from './views/SharedTrafficView'
import './theme.css'

try { document.documentElement.dataset.theme = location.pathname.startsWith('/share/') ? 'linear' : localStorage.getItem('pulse.theme') || 'linear' } catch { /* storage unavailable */ }

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    {location.pathname.startsWith('/share/') ? <SharedTrafficView /> : <App />}
  </React.StrictMode>,
)
