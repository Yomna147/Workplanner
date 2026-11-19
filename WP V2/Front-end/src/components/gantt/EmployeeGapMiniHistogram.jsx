import { memo, useMemo } from 'react';
import { formatHistogramDayHeader } from '../../utils/dateFormat';
import {
  buildGapOnlyDayCell,
  buildHistogramTimeline,
  isWeekend,
  timelineDayColumns,
} from './ganttUtils';

const GAP_STRIP_ROW_HEIGHT = 22;
const GAP_STRIP_DAY_WIDTH = 20;

function GapDayCell({ day, cell, isToday }) {
  const classNames = [
    'training-gap-day',
    cell?.kind === 'weekend' ? 'is-weekend' : '',
    cell?.kind === 'holiday' ? 'is-holiday' : '',
    cell?.kind === 'full' ? 'is-full' : '',
    cell?.kind === 'gap' ? 'is-gap' : '',
    isToday ? 'is-today' : '',
  ].filter(Boolean).join(' ');

  return (
    <div
      className={classNames}
      style={{ width: GAP_STRIP_DAY_WIDTH, height: GAP_STRIP_ROW_HEIGHT }}
      title={cell?.title || undefined}
    >
      {cell?.kind === 'gap' ? (
        <span
          className="training-gap-day-fill"
          style={{ height: `${Math.max(12, cell.gapPercent)}%` }}
        />
      ) : null}
      {cell?.kind === 'holiday' ? (
        <span className="training-gap-day-holiday" aria-hidden="true">H</span>
      ) : null}
    </div>
  );
}

const EmployeeGapRow = memo(function EmployeeGapRow({
  rowName,
  timeline,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  todayYmd,
}) {
  const dayColumns = timelineDayColumns(timeline);

  const cellsByDay = useMemo(() => {
    const map = new Map();
    dayColumns.forEach((day) => {
      map.set(day, buildGapOnlyDayCell({
        rowName,
        day,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        employees,
      }));
    });
    return map;
  }, [rowName, dayColumns, dailyHours, availabilityHours, employeeHolidays, employees]);

  return (
    <div className="training-gap-row" style={{ width: timeline.columns.length * GAP_STRIP_DAY_WIDTH }}>
      {dayColumns.map((day) => (
        <GapDayCell
          key={`${rowName}-${day}`}
          day={day}
          cell={cellsByDay.get(day)}
          isToday={day === todayYmd}
        />
      ))}
    </div>
  );
});

function GapTimelineHeader({ timeline, todayYmd }) {
  const dayColumns = timelineDayColumns(timeline);

  return (
    <div
      className="training-gap-header"
      style={{ width: timeline.columns.length * GAP_STRIP_DAY_WIDTH }}
    >
      {dayColumns.map((day) => (
        <div
          key={day}
          className={`training-gap-header-day${isWeekend(day) ? ' is-weekend' : ''}${day === todayYmd ? ' is-today' : ''}`}
          style={{ width: GAP_STRIP_DAY_WIDTH }}
          title={day}
        >
          {formatHistogramDayHeader(day)}
        </div>
      ))}
    </div>
  );
}

export default function EmployeeGapMiniHistogram({
  range,
  rows = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
  todayYmd = '',
  showHeader = true,
}) {
  const timeline = useMemo(() => {
    if (!range?.start || !range?.end) {
      return null;
    }
    const built = buildHistogramTimeline(range.start, range.end);
    return {
      ...built,
      columnWidth: GAP_STRIP_DAY_WIDTH,
    };
  }, [range?.start, range?.end]);

  if (!timeline || rows.length === 0) {
    return <p className="training-gap-empty">No gap data for this range.</p>;
  }

  return (
    <div className="training-gap-mini-histogram">
      {showHeader ? <GapTimelineHeader timeline={timeline} todayYmd={todayYmd} /> : null}
      <div className="training-gap-rows">
        {rows.map((row) => (
          <EmployeeGapRow
            key={row.employeeId ?? row.name}
            rowName={row.name}
            timeline={timeline}
            dailyHours={dailyHours}
            availabilityHours={availabilityHours}
            employeeHolidays={employeeHolidays}
            employees={employees}
            todayYmd={todayYmd}
          />
        ))}
      </div>
    </div>
  );
}

export { GAP_STRIP_DAY_WIDTH, GAP_STRIP_ROW_HEIGHT };
