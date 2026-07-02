import { useState, useEffect } from 'react'
import Sidebar from './components/Sidebar'
import Dashboard from './pages/Dashboard'
import TenantApps from './pages/TenantApps'
import Integrations from './pages/Integrations'
import Alerts from './pages/Alerts'
import SevA from './pages/SevA'
import Crons from './pages/Crons'
import Settings from './pages/Settings'
import SupportBot from './components/SupportBot'
import UserGuide from './components/UserGuide'
import './App.css'


function App() {
  const [activePage, setActivePage] = useState('dashboard')
  const [navTarget, setNavTarget] = useState(null)
  const [guideOpen, setGuideOpen] = useState(false)
  const handleNavigate = (page, target = null) => {
    setNavTarget(target)
    setActivePage(page)
    window.scrollTo(0, 0)
  }

  // One-shot URL parse so external deep links (e.g. the "View Full Dashboard"
  // button in alert emails) can open a specific page on first mount. Cleans
  // the URL after applying so a subsequent reload doesn't re-navigate.
  useEffect(() => {
    const q = new URLSearchParams(window.location.search)
    const page = q.get('page')
    if (!page || page === 'dashboard') return
    handleNavigate(page, {
      tenant:  q.get('tenant')  || null,
      app:     q.get('app')     || null,
      env:     q.get('env')     || null,
      section: q.get('section') || null,
    })
    window.history.replaceState({}, '', '/')
  }, [])



  const pages = {
    dashboard: <Dashboard onNavigate={handleNavigate} />,
    'tenant-apps': <TenantApps initialTarget={navTarget} />,
    integrations: <Integrations />,
    alerts: <Alerts />,
    'sev-a': <SevA />,
    crons: <Crons />,
    settings: <Settings />,
  }

  return (
    <>
      <div
        className="layout"
        style={{}}
      >
        <Sidebar
          activePage={activePage}
          onNavigate={(page) => handleNavigate(page, null)}
          onOpenGuide={() => setGuideOpen(true)}
        />
        <div className="page-content">
          {pages[activePage]}
        </div>
        <SupportBot />
      </div>

      <UserGuide open={guideOpen} onClose={() => setGuideOpen(false)} />

    </>
  )
}

export default App
