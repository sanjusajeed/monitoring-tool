import { useState } from 'react'
import styles from './IntegrationCard.module.css'

const BASE_URL = `${import.meta.env.VITE_API_BASE_URL || ''}/api/integrations/jiffy`

function IntegrationCard({ record, type, onEdit, onDelete }) {
  const [testState, setTestState] = useState('idle') // idle | loading | success | error
  const [testMessage, setTestMessage] = useState('')

  async function handleTest() {
    setTestState('loading')
    setTestMessage('')
    try {
      const res = await fetch(`${BASE_URL}/${record.id}/test`, { method: 'POST' })
      const data = await res.json()
      setTestState(data.success ? 'success' : 'error')
      setTestMessage(data.message)
    } catch {
      setTestState('error')
      setTestMessage('Could not reach the backend')
    }
  }

  return (
    <div className={styles.card}>
      <div className={styles.cardHeader}>
        <div className={styles.logoWrap} style={{ background: type.colorBg, color: type.color }}>
          {type.logo}
        </div>
        <div className={styles.info}>
          <span className={styles.name}>{type.name}</span>
          <span className={styles.env}>{record.env_name}</span>
        </div>
        <span className={styles.activePill}>Active</span>
      </div>

      <div className={styles.fields}>
        <Field label="URL"           value={record.url} />
        <Field label="Client ID"     value={record.client_id} />
        <Field label="Client Secret" value={'•'.repeat(12)} masked />
      </div>

      {testState !== 'idle' && (
        <div className={`${styles.testResult} ${styles[testState]}`}>
          {testState === 'loading' && <span className={styles.spinner} />}
          {testState === 'success' && <span className={styles.resultIcon}>✓</span>}
          {testState === 'error'   && <span className={styles.resultIcon}>✕</span>}
          <span>{testState === 'loading' ? 'Testing connection...' : testMessage}</span>
        </div>
      )}

      <div className={styles.actions}>
        <button
          className={`${styles.testBtn} ${testState === 'loading' ? styles.testLoading : ''}`}
          onClick={handleTest}
          disabled={testState === 'loading'}
        >
          {testState === 'loading' ? 'Testing...' : 'Test'}
        </button>
        <button className={styles.editBtn} onClick={onEdit}>Edit</button>
        <button className={styles.deleteBtn} onClick={onDelete}>Delete</button>
      </div>
    </div>
  )
}

function Field({ label, value, masked }) {
  return (
    <div className={styles.field}>
      <span className={styles.fieldLabel}>{label}</span>
      <span className={`${styles.fieldValue} ${masked ? styles.masked : ''}`}>{value}</span>
    </div>
  )
}

export default IntegrationCard
