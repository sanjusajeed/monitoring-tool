import styles from './MetricCard.module.css'

function colorForPercent(value) {
  if (value >= 80) return styles.red
  if (value >= 60) return styles.yellow
  return styles.green
}

function ProgressBar({ value, colorClass }) {
  return (
    <div className={styles.track}>
      <div
        className={`${styles.fill} ${colorClass}`}
        style={{ width: `${Math.min(value, 100)}%` }}
      />
    </div>
  )
}

function MetricCard({ label, value, unit, icon, showBar, color }) {
  const colorClass = color
    ? styles[color]
    : colorForPercent(parseFloat(value))

  return (
    <div className={styles.card}>
      <div className={styles.header}>
        <span className={styles.label}>{label}</span>
        <span className={styles.icon}>{icon}</span>
      </div>
      <div className={`${styles.value} ${colorClass}`}>
        {value}
        {unit && <span className={styles.unit}>{unit}</span>}
      </div>
      {showBar && (
        <ProgressBar value={parseFloat(value)} colorClass={colorClass} />
      )}
    </div>
  )
}

export default MetricCard
