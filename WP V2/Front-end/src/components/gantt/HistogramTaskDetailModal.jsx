import Modal from '../Modal';
import { formatDisplayDate } from '../../utils/dateFormat';

function displayValue(value) {
  const text = String(value ?? '').trim();
  return text || '—';
}

function formatHours(value) {
  const text = String(value ?? '').trim();
  if (!text) {
    return '—';
  }
  const num = Number(text);
  if (!Number.isFinite(num)) {
    return text;
  }
  return Number.isInteger(num) ? String(num) : (Math.round(num * 10) / 10).toFixed(1);
}

function assigneeList(bar) {
  const fields = [
    ['Override 1', bar.override_1],
    ['Override 2', bar.override_2],
    ['Override 3', bar.override_3],
    ['Algorithm 1', bar.algorithm_1],
    ['Algorithm 2', bar.algorithm_2],
    ['Algorithm 3', bar.algorithm_3],
  ];
  return fields.filter(([, value]) => String(value ?? '').trim() !== '');
}

export default function HistogramTaskDetailModal({ bar, open, onClose }) {
  if (!bar) {
    return null;
  }

  const assignees = assigneeList(bar);
  const progress = bar.progress_per ?? bar.progress;

  return (
    <Modal open={open} title="Task details" onClose={onClose}>
      <div className="histogram-task-detail">
        <div className="histogram-task-detail-heading">
          <span
            className="histogram-task-detail-color"
            style={{ backgroundColor: bar.color || '#3B82F6' }}
            aria-hidden
          />
          <div>
            <strong>{bar.task_name || 'Untitled task'}</strong>
            <p>
              {bar.project_name || 'Unknown project'}
              {bar.part_name ? ` · ${bar.part_name}` : ''}
            </p>
          </div>
        </div>

        <dl className="histogram-task-detail-grid">
          <div>
            <dt>NRM</dt>
            <dd>{displayValue(bar.nrm_number)}</dd>
          </div>
          <div>
            <dt>Assignee</dt>
            <dd>{displayValue(bar.employee)}</dd>
          </div>
          <div>
            <dt>Doc supply</dt>
            <dd>{formatDisplayDate(bar.doc_supply || bar.start) || '—'}</dd>
          </div>
          <div>
            <dt>Completion</dt>
            <dd>{formatDisplayDate(bar.completion || bar.end) || '—'}</dd>
          </div>
          <div>
            <dt>Plan</dt>
            <dd>{formatHours(bar.plan ?? bar.hours)}</dd>
          </div>
          <div>
            <dt>Est</dt>
            <dd>{formatHours(bar.est)}</dd>
          </div>
          <div>
            <dt>Progress</dt>
            <dd>
              {progress != null && String(progress).trim() !== ''
                ? `${String(progress).replace(/%$/, '')}%`
                : '—'}
            </dd>
          </div>
          <div>
            <dt>Act / left</dt>
            <dd>
              {formatHours(bar.act)}
              {' / '}
              {formatHours(bar.duration_left)}
            </dd>
          </div>
          <div>
            <dt>PP / Pri</dt>
            <dd>
              {bar.pp ?? '—'}
              {' / '}
              {bar.pri ?? '—'}
            </dd>
          </div>
          <div>
            <dt>Con / ATS</dt>
            <dd>
              {displayValue(bar.con)}
              {' / '}
              {displayValue(bar.ats)}
            </dd>
          </div>
          <div>
            <dt>Status</dt>
            <dd>{bar.done ? 'Done' : 'Open'}{bar.sp ? ' · SP' : ''}</dd>
          </div>
        </dl>

        {assignees.length > 0 && (
          <div className="histogram-task-detail-assignees">
            <h4>Allocation</h4>
            <ul>
              {assignees.map(([label, value]) => (
                <li key={label}>
                  <span>{label}</span>
                  <strong>{value}</strong>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>
    </Modal>
  );
}
