import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// Prevent the browser from restoring the previous scroll position on refresh —
// the SPA always renders at "/" so the restored offset lands mid-content.
if ('scrollRestoration' in history) history.scrollRestoration = 'manual'

createRoot(document.getElementById('root')).render(<App />)
