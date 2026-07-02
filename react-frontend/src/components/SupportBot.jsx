import { useState } from 'react'
import styles from './SupportBot.module.css'

const REPORT_URL = `${import.meta.env.VITE_API_BASE_URL || ''}/api/support/report-issue`

function BotIcon() {
  return (
    <svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <rect x="3" y="8" width="18" height="12" rx="2"/>
      <path d="M12 8V4"/>
      <circle cx="12" cy="3" r="1"/>
      <circle cx="9" cy="13" r="1" fill="currentColor"/>
      <circle cx="15" cy="13" r="1" fill="currentColor"/>
      <path d="M9 17h6"/>
    </svg>
  )
}

function CloseIcon() {
  return (
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      <line x1="18" y1="6" x2="6" y2="18"/>
      <line x1="6" y1="6" x2="18" y2="18"/>
    </svg>
  )
}

function SupportBot() {
  const [open, setOpen] = useState(false)
  const [message, setMessage] = useState('')
  const [email, setEmail] = useState('')
  const [sending, setSending] = useState(false)
  const [status, setStatus] = useState(null)

  async function handleSend(e) {
    e.preventDefault()
    if (!message.trim()) return
    setSending(true)
    setStatus(null)
    try {
      const res = await fetch(REPORT_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          message: message.trim(),
          user_email: email.trim() || null,
        }),
      })
      if (!res.ok) {
        const err = await res.json().catch(() => ({}))
        throw new Error(err.detail || `HTTP ${res.status}`)
      }
      setStatus({ type: 'success', text: 'Thanks! Your message has been sent.' })
      setMessage('')
      setEmail('')
    } catch (e) {
      setStatus({ type: 'error', text: e.message })
    } finally {
      setSending(false)
    }
  }

  return (
    <>
      <button
        className={styles.fab}
        onClick={() => { setOpen(o => !o); setStatus(null) }}
        aria-label="Report an issue"
      >
        {open ? <CloseIcon /> : <BotIcon />}
      </button>

      {open && (
        <div className={styles.panel} role="dialog">
          <div className={styles.header}>
            <span className={styles.headerTitle}>Report an issue</span>
            <button className={styles.iconBtn} onClick={() => setOpen(false)} aria-label="Close">
              <CloseIcon />
            </button>
          </div>

          <p className={styles.intro}>
            Hi! Noticed something wrong? Describe the issue and we'll get it.
          </p>

          <form className={styles.form} onSubmit={handleSend}>
            <label className={styles.field}>
              <span>Your email (optional)</span>
              <input
                type="email"
                value={email}
                onChange={e => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </label>

            <label className={styles.field}>
              <span>What's the issue?</span>
              <textarea
                rows={5}
                value={message}
                onChange={e => setMessage(e.target.value)}
                placeholder="Describe what you were doing and what went wrong..."
                required
              />
            </label>

            {status && (
              <div className={status.type === 'success' ? styles.success : styles.error}>
                {status.text}
              </div>
            )}

            <button type="submit" className={styles.sendBtn} disabled={sending || !message.trim()}>
              {sending ? 'Sending...' : 'Send'}
            </button>
          </form>
        </div>
      )}
    </>
  )
}

export default SupportBot
