import styles from './NetworkCard.module.css'

function NetworkCard({ label, value, direction }) {
  const isIn = direction === 'in'
  return (
    <div className={styles.card}>
      <div className={`${styles.iconWrap} ${isIn ? styles.inBg : styles.outBg}`}>
        {isIn ? '⬇️' : '⬆️'}
      </div>
      <div>
        <div className={styles.label}>{label}</div>
        <div className={`${styles.value} ${isIn ? styles.blue : styles.purple}`}>
          {value}
          <span className={styles.unit}>Mbps</span>
        </div>
      </div>
    </div>
  )
}

export default NetworkCard
