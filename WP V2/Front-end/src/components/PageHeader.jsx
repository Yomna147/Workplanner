export default function PageHeader({ title, actions, titleAddon, eyebrow, compact = false }) {
  return (
    <header className={`page-header${compact ? ' page-header-compact' : ''}`}>
      <div className="page-heading page-heading-row">
        <div className="page-heading-copy">
          <div className="page-heading-title-row">
            <h2>{title}</h2>
            {eyebrow ? <p className="eyebrow">{eyebrow}</p> : null}
            {titleAddon ? (
              <div className="page-heading-title-addon">
                {titleAddon}
              </div>
            ) : null}
          </div>
        </div>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
    </header>
  );
}
