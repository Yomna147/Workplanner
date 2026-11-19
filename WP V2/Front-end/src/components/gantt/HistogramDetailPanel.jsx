import { memo, useMemo } from 'react';
import { formatDisplayDate } from '../../utils/dateFormat';
import { formatHoursDisplay } from '../../utils/formatHoursDisplay';
import {
  barHoursOnDay,
  barScheduledWeekdays,
  buildDayCellHoverTitle,
  dayCapacityForRow,
  formatHistogramCapacityDayLine,
  isEmployeeHolidayDay,
  lookupDayHoursForRow,
} from './ganttUtils';
import './histogram-detail-panel.css';

function InfoBox({ title, children }) {
  return (
    <section className="histogram-crm-info-box">
      <h4>{title}</h4>
      {children}
    </section>
  );
}

function displayValue(value) {
  const text = String(value ?? '').trim();
  return text || '—';
}

function formatHours(value) {
  return formatHoursDisplay(value);
}

function allocationSlots(bar) {
  return [1, 2, 3]
    .map((slot) => ({
      slot,
      algorithm: bar[`algorithm_${slot}`],
      override: bar[`override_${slot}`],
    }))
    .filter(({ algorithm, override }) => (
      String(algorithm ?? '').trim() !== '' || String(override ?? '').trim() !== ''
    ));
}

function buildCapacityDays(bar, dailyHours, availabilityHours, employeeHolidays, employees) {
  const employee = bar?.employee || '';
  if (!employee) {
    return [];
  }

  return barScheduledWeekdays(bar).map((day) => {
    const assigned = barHoursOnDay(bar, day);
    const booked = lookupDayHoursForRow(dailyHours, employee, day, employees) ?? 0;
    const capacity = dayCapacityForRow(employee, day, availabilityHours, employeeHolidays, employees);

    return {
      day,
      assigned,
      booked,
      capacity,
      isHoliday: isEmployeeHolidayDay(employee, day, employeeHolidays, employees),
    };
  }).filter((entry) => entry.assigned > 0.05 || entry.isHoliday);
}

export default memo(function HistogramDetailPanel({
  bar,
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
  onClose,
  onFilterProject,
}) {
  const capacityDays = useMemo(() => {
    if (!bar) {
      return [];
    }
    return buildCapacityDays(bar, dailyHours, availabilityHours, employeeHolidays, employees);
  }, [bar, dailyHours, availabilityHours, employeeHolidays, employees]);

  if (!bar) {
    return null;
  }

  const allocationRows = allocationSlots(bar);
  const progress = bar.progress_per ?? bar.progress;
  const daySummary = buildDayCellHoverTitle({
    rowName: bar.employee,
    day: bar.start,
    bars: [bar],
    dailyHours,
    availabilityHours,
    employeeHolidays,
    employees,
  });

  return (
    <div
      className="histogram-crm-detail-overlay"
      onDoubleClick={onClose}
      role="presentation"
    >
      <aside
        className="histogram-crm-detail-panel"
        onClick={(event) => event.stopPropagation()}
        onDoubleClick={(event) => event.stopPropagation()}
        aria-label="Histogram task details"
      >
        <div className="histogram-crm-detail-top">
          <div className="histogram-crm-detail-heading">
            <span
              className="histogram-crm-detail-color"
              style={{ backgroundColor: bar.color || '#3B82F6' }}
              aria-hidden
            />
            <h2>{bar.task_name || 'Untitled task'}</h2>
          </div>
          <div className="histogram-crm-detail-top-actions">
            {bar.project_id && onFilterProject ? (
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onFilterProject(String(bar.project_id))}
              >
                Filter project
              </button>
            ) : null}
            <button
              type="button"
              className="histogram-crm-detail-close"
              onClick={onClose}
              aria-label="Close details panel"
            >
              ×
            </button>
          </div>
        </div>

        <div className="histogram-crm-detail-subtitle">
          {bar.project_name || 'Unknown project'}
          {bar.part_name ? ` · ${bar.part_name}` : ''}
          {bar.employee ? ` · ${bar.employee}` : ''}
        </div>

        <div className="histogram-crm-detail-stages">
          <span className={`histogram-crm-stage-pill${bar.done ? '' : ' histogram-crm-stage-pill-active'}`}>
            {bar.done ? 'Done' : 'Open'}
          </span>
          {bar.pri != null && String(bar.pri).trim() !== '' ? (
            <span className="histogram-crm-stage-pill histogram-crm-stage-pill-active">
              Pri {bar.pri}
            </span>
          ) : null}
          {bar.pp != null && String(bar.pp).trim() !== '' ? (
            <span className="histogram-crm-stage-pill">PP {bar.pp}</span>
          ) : null}
          {bar.sp ? <span className="histogram-crm-stage-pill">Single person</span> : null}
        </div>

        <div className="histogram-crm-detail-stack">
            <InfoBox title="About task">
              <div className="histogram-crm-detail-grid">
                <div>
                  <strong>NRM</strong>
                  <span>{displayValue(bar.nrm_number)}</span>
                </div>
                <div>
                  <strong>Assignee</strong>
                  <span>{displayValue(bar.employee)}</span>
                </div>
                <div>
                  <strong>Plan</strong>
                  <span>{formatHours(bar.plan ?? bar.hours)} h</span>
                </div>
                <div>
                  <strong>Est</strong>
                  <span>{formatHours(bar.est)} h</span>
                </div>
                <div>
                  <strong>Progress</strong>
                  <span>
                    {progress != null && String(progress).trim() !== ''
                      ? `${String(progress).replace(/%$/, '')}%`
                      : '—'}
                  </span>
                </div>
                <div>
                  <strong>Act / left</strong>
                  <span>
                    {formatHours(bar.act)}
                    {' / '}
                    {formatHours(bar.duration_left)}
                  </span>
                </div>
                <div>
                  <strong>Con / ATS</strong>
                  <span>
                    {displayValue(bar.con)}
                    {' / '}
                    {displayValue(bar.ats)}
                  </span>
                </div>
                <div>
                  <strong>RAP</strong>
                  <span>{displayValue(bar.rap)}</span>
                </div>
              </div>
            </InfoBox>

            <InfoBox title="Schedule">
              <div className="histogram-crm-detail-grid">
                <div>
                  <strong>Doc supply (start)</strong>
                  <span>{formatDisplayDate(bar.doc_supply || bar.start) || '—'}</span>
                </div>
                <div>
                  <strong>Completion (end)</strong>
                  <span>{formatDisplayDate(bar.completion || bar.end) || '—'}</span>
                </div>
                <div>
                  <strong>Assigned hours</strong>
                  <span>{formatHours(bar.hours)} h total</span>
                </div>
                <div>
                  <strong>Priority</strong>
                  <span>
                    Pri {displayValue(bar.pri)}
                    {bar.pp != null ? ` · PP ${bar.pp}` : ''}
                  </span>
                </div>
              </div>
            </InfoBox>

            {allocationRows.length > 0 ? (
              <InfoBox title="Allocation">
                <ul className="histogram-crm-allocation-list">
                  {allocationRows.map(({ slot, algorithm, override }) => (
                    <li key={slot} className="histogram-crm-allocation-slot">
                      <div className="histogram-crm-detail-grid histogram-crm-allocation-grid">
                        <div>
                          <strong>Algorithm {slot}</strong>
                          <span>{displayValue(algorithm)}</span>
                        </div>
                        <div>
                          <strong>Override {slot}</strong>
                          <span>{displayValue(override)}</span>
                        </div>
                      </div>
                    </li>
                  ))}
                </ul>
              </InfoBox>
            ) : null}

            <InfoBox title="Capacity &amp; allocation">
              {capacityDays.length > 0 ? (
                <ul className="histogram-crm-list histogram-crm-capacity-list">
                  {capacityDays.map((entry) => (
                    <li key={entry.day}>
                      <strong>{formatDisplayDate(entry.day)}</strong>
                      {formatHistogramCapacityDayLine(entry)}
                    </li>
                  ))}
                </ul>
              ) : (
                <p style={{ margin: 0, fontSize: 12 }}>{daySummary || 'No schedule data for this task.'}</p>
              )}
            </InfoBox>
        </div>
      </aside>
    </div>
  );
});
