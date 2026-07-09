export function Loading({ text }) {
  return (
    <div className="loading">
      <div className="spinner" />
      <span>{text}</span>
    </div>
  );
}

export function EmptyState({ icon, text }) {
  return (
    <div className="empty-state">
      <i className={`ti ${icon}`} aria-hidden="true" />
      <p>{text}</p>
    </div>
  );
}

export function Alert({ children, tone = 'danger' }) {
  const icon = tone === 'success' ? 'ti-check' : tone === 'info' ? 'ti-info-circle' : 'ti-alert-circle';
  return (
    <div className={`alert alert-${tone}`}>
      <i className={`ti ${icon}`} aria-hidden="true" />
      <span>{children}</span>
    </div>
  );
}
