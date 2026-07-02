import { useState } from 'react'
import styles from './JiffyModal.module.css'

const EMPTY = { env_name: '', url: '', client_id: '', client_secret: '' }

function JiffyModal({ initial, onSave, onClose }) {
  const [form, setForm] = useState(initial ? {
    env_name: initial.env_name,
    url: initial.url,
    client_id: initial.client_id,
    client_secret: initial.client_secret,
  } : EMPTY)
  const [saving, setSaving] = useState(false)
  const [errors, setErrors] = useState({})
  const [showSecret, setShowSecret] = useState(false)

  function validate() {
    const e = {}
    if (!form.env_name.trim()) e.env_name = 'Environment name is required'
    if (!form.url.trim()) e.url = 'URL is required'
    if (!form.client_id.trim()) e.client_id = 'Client ID is required'
    if (!form.client_secret.trim()) e.client_secret = 'Client secret is required'
    return e
  }

  async function handleSubmit(e) {
    e.preventDefault()
    const errs = validate()
    if (Object.keys(errs).length) { setErrors(errs); return }
    setSaving(true)
    await onSave(form)
    setSaving(false)
  }

  function set(field, value) {
    setForm(f => ({ ...f, [field]: value }))
    setErrors(e => ({ ...e, [field]: undefined }))
  }

  return (
    <div className={styles.overlay} onClick={e => e.target === e.currentTarget && onClose()}>
      <div className={styles.modal}>
        {/* Header */}
        <div className={styles.modalHeader}>
          <div className={styles.modalIcon}>⚡</div>
          <div>
            <h2 className={styles.modalTitle}>{initial ? 'Edit' : 'Add'} Integration</h2>
            <p className={styles.modalSub}>Fill in your environment credentials</p>
          </div>
          <button className={styles.closeBtn} onClick={onClose}>✕</button>
        </div>

        {/* Form */}
        <form className={styles.form} onSubmit={handleSubmit}>
          <Field
            label="Environment Name"
            placeholder="e.g. Production, Staging, Dev"
            value={form.env_name}
            onChange={v => set('env_name', v)}
            error={errors.env_name}
          />
          <Field
            label="URL"
            placeholder="https://your-instance.example.com"
            value={form.url}
            onChange={v => set('url', v)}
            error={errors.url}
          />
          <Field
            label="Client ID"
            placeholder="Enter client ID"
            value={form.client_id}
            onChange={v => set('client_id', v)}
            error={errors.client_id}
          />
          <div className={styles.fieldWrap}>
            <label className={styles.label}>Client Secret</label>
            <div className={styles.secretRow}>
              <input
                className={`${styles.input} ${errors.client_secret ? styles.inputError : ''}`}
                type={showSecret ? 'text' : 'password'}
                placeholder="Enter client secret"
                value={form.client_secret}
                onChange={e => set('client_secret', e.target.value)}
              />
              <button type="button" className={styles.toggleSecret} onClick={() => setShowSecret(s => !s)}>
                {showSecret ? '🙈' : '👁️'}
              </button>
            </div>
            {errors.client_secret && <span className={styles.error}>{errors.client_secret}</span>}
          </div>

          <div className={styles.footer}>
            <button type="button" className={styles.cancelBtn} onClick={onClose}>Cancel</button>
            <button type="submit" className={styles.saveBtn} disabled={saving}>
              {saving ? 'Saving...' : initial ? 'Save Changes' : 'Add Integration'}
            </button>
          </div>
        </form>
      </div>
    </div>
  )
}

function Field({ label, placeholder, value, onChange, error }) {
  return (
    <div className={styles.fieldWrap}>
      <label className={styles.label}>{label}</label>
      <input
        className={`${styles.input} ${error ? styles.inputError : ''}`}
        placeholder={placeholder}
        value={value}
        onChange={e => onChange(e.target.value)}
      />
      {error && <span className={styles.error}>{error}</span>}
    </div>
  )
}

export default JiffyModal
