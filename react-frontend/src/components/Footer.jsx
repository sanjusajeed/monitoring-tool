import styles from './Footer.module.css'

function Footer({ lastUpdated, apiUrl, hasError }) {
  return (
    <footer className={styles.footer}>
      <span>🕐 Last updated: {lastUpdated || '—'}</span>
      <span>🌐 {apiUrl}</span>
      <span className={hasError ? styles.error : styles.live}>
        {hasError ? '⚠️ Fetch error — retrying...' : '✅ Live'}
      </span>
    </footer>
  )
}

export default Footer
