const PRIORITY_ITEMS = [
  {
    label: 'PP',
    summary: 'Project priority — lower numbers are scheduled sooner across active projects.',
  },
  {
    label: 'RAP',
    summary: 'Resource allocation priority within the project — influences operative selection order.',
  },
  {
    label: 'Pri',
    summary: 'Task priority (RAP + PP). Calculated automatically; lower values run first in the algorithm.',
  },
];

export default function ProjectPriorityLegend() {
  return (
    <div className="pde-priority-legend card" aria-label="Priority legend">
      <div className="pde-priority-legend-title">Priority fields</div>
      <ul className="pde-priority-legend-list">
        {PRIORITY_ITEMS.map((item) => (
          <li key={item.label} className="pde-priority-legend-item" title={item.summary}>
            <strong>{item.label}</strong>
            <span>{item.summary}</span>
          </li>
        ))}
      </ul>
      <p className="pde-priority-legend-note muted">
        Active projects are ordered by their lowest task Pri. Use PP and RAP to control queue position.
      </p>
    </div>
  );
}
