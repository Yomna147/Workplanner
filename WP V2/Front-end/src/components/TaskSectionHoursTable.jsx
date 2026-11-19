import { useState } from 'react';
import { projectProgressTaskSections } from '../constants/projectTaskFields';
import ProjectTaskGrid from './ProjectTaskGrid';
import { displayProjectColor } from '../utils/projectColor';
import { formatProjectStatus } from '../utils/projectSort';
import { taskExceedsDlHours } from '../utils/taskSectionDetailCalculations';

export function ProjectProgressTaskGrid({
  tasks,
  employees,
  onChange,
  lockedFieldPredicate,
  highlightExceedsDl = false,
}) {
  const [selectedRows, setSelectedRows] = useState([]);

  return (
    <ProjectTaskGrid
      tasks={tasks}
      employees={employees}
      onChange={onChange}
      selectedRows={selectedRows}
      onSelectedRowsChange={setSelectedRows}
      sections={projectProgressTaskSections}
      pageClassName="project-progress-task-panel"
      scrollClassName="project-progress-table-scroll"
      tableClassName="project-task-table project-progress-grid-table"
      getRowClassName={(task) => {
        const classes = [];
        if (task.dl_sec_hrs_approved) {
          classes.push('project-progress-row-approved');
        }
        if (highlightExceedsDl && taskExceedsDlHours(task)) {
          classes.push('project-progress-row-exceeds-dl');
        }
        return classes.join(' ');
      }}
      lockedFieldPredicate={lockedFieldPredicate}
      suppressBulkHint
    />
  );
}

export function ProjectProgressProjectHeader({
  project,
  taskCount,
  approvedCount = 0,
  expanded,
  onToggle,
}) {
  const statusLabel = formatProjectStatus(project);

  return (
    <button
      type="button"
      className={`project-progress-project-toggle${expanded ? ' is-expanded' : ''}`}
      onClick={onToggle}
      aria-expanded={expanded}
    >
      <span className="project-progress-toggle-leading">
        <span className={`project-progress-chevron${expanded ? ' is-expanded' : ''}`} aria-hidden="true" />
        <span
          className="project-progress-color-swatch"
          style={{ backgroundColor: displayProjectColor(project) }}
          aria-hidden="true"
        />
      </span>
      <span className="project-progress-project-copy">
        <span className="project-progress-project-title-row">
          <span className="project-progress-project-title">{project.name}</span>
          <span className="project-progress-meta-pill">{taskCount} task{taskCount === 1 ? '' : 's'}</span>
          <span className={`project-progress-status project-progress-status--${statusLabel.toLowerCase().replace(/\s+/g, '-')}`}>
            {statusLabel}
          </span>
          {approvedCount > 0 ? (
            <span className="project-progress-meta-pill project-progress-meta-pill--approved">
              {approvedCount} approved
            </span>
          ) : null}
          {project.team?.name ? (
            <span className="project-progress-meta-pill project-progress-meta-pill--team">
              {project.team.name}
            </span>
          ) : null}
        </span>
      </span>
    </button>
  );
}

export function ProjectProgressLegend({ showExceedsDlHint = false }) {
  return (
    <div className="project-progress-guide" role="note">
      <div className="project-progress-guide-copy">
        <span className="project-progress-guide-title">Expected hours</span>
        <span className="project-progress-guide-text">
          Enter expected hours for each workflow stage. Totals update automatically.
          {' TT hrs shows Time Tracking time logged for the selected operative (from TT Project Hours).'}
          {showExceedsDlHint ? ' Rows highlighted in amber exceed the DL hours budget.' : ''}
        </span>
      </div>
      <div className="project-progress-guide-badges" aria-hidden="true">
        <span className="project-progress-guide-badge project-progress-guide-badge--editable">Editable</span>
        <span className="project-progress-guide-badge project-progress-guide-badge--total">Total</span>
        <span className="project-progress-guide-badge">TT hrs (from cache)</span>
        <span className="project-progress-guide-badge project-progress-guide-badge--approved">DL approved</span>
        {showExceedsDlHint ? (
          <span className="project-progress-guide-badge project-progress-guide-badge--exceeds-dl">Exceeds DL hrs</span>
        ) : null}
      </div>
    </div>
  );
}
