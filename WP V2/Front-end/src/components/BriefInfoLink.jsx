const briefUrl = String(import.meta.env.VITE_APP_BRIEF_URL || '').trim();

export default function BriefInfoLink() {
  if (!briefUrl) {
    return (
      <span
        className="navbar-brief-link is-disabled"
        title="Brief link not configured yet"
        aria-label="Application brief (link not configured)"
      >
        <span className="navbar-brief-icon" aria-hidden="true">
          i
        </span>
      </span>
    );
  }

  return (
    <a
      href={briefUrl}
      target="_blank"
      rel="noopener noreferrer"
      className="navbar-brief-link"
      title="Open application brief"
      aria-label="Open application brief in Google Sheets"
    >
      <span className="navbar-brief-icon" aria-hidden="true">
        i
      </span>
    </a>
  );
}
