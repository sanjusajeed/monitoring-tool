import styles from './Header.module.css'

function StatusBadge({ status }) {
  const label = status === 'healthy' ? 'Healthy' : 'Warning'
  return (
    <div className={`${styles.badge} ${styles[status]}`}>
      <span className={styles.dot} />
      {label}
    </div>
  )
}

function Header({ status }) {
  return (
    <header className={styles.header}>
      <div className={styles.left}>
        <div className={styles.icon}>📊</div>
        <div>
          <h1 className={styles.title}>Monitoring Dashboard</h1>
          <p className={styles.subtitle}>System metrics · auto-refreshes every 5 seconds</p>
        </div>
      </div>
      {status && <StatusBadge status={status} />}
    </header>
  )
}

export default Header
