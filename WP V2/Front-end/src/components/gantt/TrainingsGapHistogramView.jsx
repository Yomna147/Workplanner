import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  buildDayCellHoverTitle,
  buildGapOnlyDayCell,
  buildHistogramTimeline,
  histogramColumnWidthAt,
  histogramMonthSpanWidth,
  histogramTimelineWidth,
  isWeekend,
  timelineDayColumns,
} from './ganttUtils';
import {
  HISTOGRAM_GANTT_ROW_HEIGHT,
  HISTOGRAM_HEADER_DAY_ROW_HEIGHT,
  HISTOGRAM_HEADER_MONTH_ROW_HEIGHT,
  HISTOGRAM_HEADER_ROW_HEIGHT,
  HISTOGRAM_TEAM_ROW_HEIGHT,
} from './histogramLayout';
import {
  buildHistogramMonthSpans,
  formatHistogramDayHeader,
  toStorageDate,
} from '../../utils/dateFormat';
import { compareTeamNames, orderItemsByEmployeeAllocation, sortByTeamName } from '../../utils/teamOrder';
import { findEmployeeById, operativeNameClassName } from '../../utils/employeeTrainee';
import { resolveTrainingSessionLegend, trainingSessionKey } from '../../utils/trainingGroups';
import { mergeTrainingSchedulePreview, buildTrainingBarSegments } from './trainingBarEdits';
import TrainingGapBar from './TrainingGapBar';
import { useTrainingBarInteraction } from './useTrainingBarInteraction';
import RowAddButton from '../RowAddButton';
import SyncedHorizontalScroll from './SyncedHorizontalScroll';

export const TRAININGS_GAP_LABEL_WIDTH = 280;
export const TRAININGS_GAP_LABEL_WIDTH_TABLET = 168;
export const TRAININGS_GAP_LABEL_WIDTH_MOBILE = 118;

function useTrainingsGapLabelWidth() {
  const [labelWidth, setLabelWidth] = useState(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return TRAININGS_GAP_LABEL_WIDTH;
    }
    if (window.matchMedia('(max-width: 640px)').matches) {
      return TRAININGS_GAP_LABEL_WIDTH_MOBILE;
    }
    if (window.matchMedia('(max-width: 1024px)').matches) {
      return TRAININGS_GAP_LABEL_WIDTH_TABLET;
    }
    return TRAININGS_GAP_LABEL_WIDTH;
  });

  useEffect(() => {
    if (typeof window === 'undefined' || !window.matchMedia) {
      return undefined;
    }

    const mobile = window.matchMedia('(max-width: 640px)');
    const tablet = window.matchMedia('(max-width: 1024px)');

    const sync = () => {
      if (mobile.matches) {
        setLabelWidth(TRAININGS_GAP_LABEL_WIDTH_MOBILE);
      } else if (tablet.matches) {
        setLabelWidth(TRAININGS_GAP_LABEL_WIDTH_TABLET);
      } else {
        setLabelWidth(TRAININGS_GAP_LABEL_WIDTH);
      }
    };

    sync();

    if (mobile.addEventListener) {
      mobile.addEventListener('change', sync);
      tablet.addEventListener('change', sync);
      return () => {
        mobile.removeEventListener('change', sync);
        tablet.removeEventListener('change', sync);
      };
    }

    mobile.addListener(sync);
    tablet.addListener(sync);
    return () => {
      mobile.removeListener(sync);
      tablet.removeListener(sync);
    };
  }, []);

  return labelWidth;
}

function buildTrainingsTeamGroups(rows = [], teams = [], employees = []) {
  if (!Array.isArray(rows) || rows.length === 0) {
    return [];
  }

  const sortRows = (teamRows) => (
    teams.length > 0 && employees.length > 0
      ? orderItemsByEmployeeAllocation(teamRows, teams, employees, (row) => row.employeeId)
      : [...teamRows].sort((left, right) => left.name.localeCompare(right.name))
  );

  if (!Array.isArray(teams) || teams.length === 0) {
    const byTeam = new Map();
    rows.forEach((row) => {
      const teamName = row.teamName && row.teamName !== '—' ? row.teamName : 'No Team';
      if (!byTeam.has(teamName)) {
        byTeam.set(teamName, []);
      }
      byTeam.get(teamName).push(row);
    });

    return Array.from(byTeam.entries())
      .sort(([a], [b]) => compareTeamNames(a, b))
      .map(([teamName, teamRows]) => ({
        teamName,
        rows: sortRows(teamRows),
      }));
  }

  const buckets = new Map();
  rows.forEach((row) => {
    const teamKey = row.teamId != null && row.teamId !== '' ? String(row.teamId) : 'unassigned';
    if (!buckets.has(teamKey)) {
      buckets.set(teamKey, []);
    }
    buckets.get(teamKey).push(row);
  });

  const groups = sortByTeamName(teams, (team) => team.name)
    .map((team) => ({
      teamName: team.name,
      rows: sortRows(buckets.get(String(team.id)) ?? []),
    }))
    .filter((group) => group.rows.length > 0);

  const unassigned = sortRows(buckets.get('unassigned') ?? []);
  if (unassigned.length > 0) {
    groups.push({
      teamName: 'No Team',
      rows: unassigned,
    });
  }

  return groups;
}

function applyTrainingPreviews(trainings = [], previewByTrainingId = {}) {
  if (!previewByTrainingId || Object.keys(previewByTrainingId).length === 0) {
    return trainings;
  }

  return trainings.map((training) => {
    const preview = previewByTrainingId[String(training.id)];
    return preview
      ? mergeTrainingSchedulePreview(training, preview)
      : training;
  });
}

function histogramColumnDay(column) {
  return column?.day || column?.start || '';
}

function isTodayColumn(column, todayYmd) {
  return histogramColumnDay(column) === todayYmd;
}

function isYmdWithinRange(day, start, end) {
  if (!day || !start || !end) return false;
  const dayYmd = String(day).slice(0, 10);
  const startYmd = String(start).slice(0, 10);
  const endYmd = String(end).slice(0, 10);
  return dayYmd >= startYmd && dayYmd <= endYmd;
}

const TrainingsTimelineHeader = memo(function TrainingsTimelineHeader({
  timeline,
  timelineWidth,
  todayYmd,
}) {
  const dayColumns = useMemo(
    () => timelineDayColumns(timeline),
    [timeline],
  );
  const monthSpans = useMemo(
    () => buildHistogramMonthSpans(dayColumns),
    [dayColumns],
  );

  return (
    <div
      className="resource-histogram-timeline-header"
      style={{ width: timelineWidth, height: HISTOGRAM_HEADER_ROW_HEIGHT }}
    >
      <div
        className="resource-histogram-header-months"
        style={{ width: timelineWidth, height: HISTOGRAM_HEADER_MONTH_ROW_HEIGHT }}
      >
        {monthSpans.map((span) => (
          <div
            key={span.key}
            className={`resource-histogram-header-month is-shade-${span.shadeIndex % 2}`}
            style={{ width: histogramMonthSpanWidth(timeline, span.startIndex, span.dayCount) }}
            title={span.label}
          >
            {span.label}
          </div>
        ))}
      </div>
      <div
        className="resource-histogram-header-days"
        style={{ width: timelineWidth, height: HISTOGRAM_HEADER_DAY_ROW_HEIGHT }}
      >
        {dayColumns.map((day, index) => (
          <div
            key={day}
            data-histogram-day={day}
            className={`resource-gantt-day${isWeekend(day) ? ' weekend' : ''}${day === todayYmd ? ' is-today' : ''}`}
            style={{ width: histogramColumnWidthAt(timeline, index) }}
          >
            {formatHistogramDayHeader(day)}
          </div>
        ))}
      </div>
    </div>
  );
});

const TrainingGapGridCell = memo(function TrainingGapGridCell({
  day,
  cell,
  rowName,
  bars = [],
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  trainingsOnDay = [],
  columnWidth,
  isToday,
  onTrainingClick,
  showTrainingChips = false,
  sessionLegendLookup,
  focusedSessionKey = '',
}) {
  const hoverContextRef = useRef(null);

  const classNames = [
    'resource-gantt-grid-cell',
    'trainings-gap-grid-cell',
    isWeekend(day) ? 'weekend' : '',
    cell?.kind === 'holiday' ? 'has-holiday' : '',
    cell?.kind === 'gap' ? 'is-gap' : '',
    cell?.kind === 'full' ? 'is-full' : '',
    isToday ? 'is-today' : '',
  ].filter(Boolean).join(' ');

  const handleMouseEnter = useCallback((event) => {
    if (!hoverContextRef.current) {
      hoverContextRef.current = {
        rowName,
        day,
        bars,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        employees,
      };
    } else {
      hoverContextRef.current.bars = bars;
      hoverContextRef.current.dailyHours = dailyHours;
      hoverContextRef.current.availabilityHours = availabilityHours;
      hoverContextRef.current.employeeHolidays = employeeHolidays;
      hoverContextRef.current.employees = employees;
    }
    event.currentTarget.title = buildDayCellHoverTitle(hoverContextRef.current) || cell?.title || '';
  }, [
    rowName,
    day,
    bars,
    dailyHours,
    availabilityHours,
    employeeHolidays,
    employees,
    cell?.title,
  ]);

  const dayHoursTitle = cell?.title || undefined;

  return (
    <div
      className={classNames}
      data-histogram-day={isToday ? day : undefined}
      style={{ width: columnWidth, minHeight: HISTOGRAM_GANTT_ROW_HEIGHT }}
      title={dayHoursTitle}
      onMouseEnter={handleMouseEnter}
    >
      {cell?.kind === 'gap' ? (
        <span className="trainings-gap-hours-chip" aria-hidden="true">
          {cell.gapHours.toFixed(1)}
        </span>
      ) : null}
      {cell?.kind === 'holiday' ? (
        <span className="resource-gantt-holiday-chip" aria-hidden="true">H</span>
      ) : null}
      {showTrainingChips && trainingsOnDay.length > 0 ? (() => {
        const primaryTraining = trainingsOnDay[0];
        const legend = resolveTrainingSessionLegend(primaryTraining, sessionLegendLookup);
        const chipLabel = legend.legendNumber
          ? `${legend.legendNumber}. ${primaryTraining.title || 'Training'}`
          : (primaryTraining.title || 'Training');
        const chipSessionKey = trainingSessionKey(primaryTraining);
        const isFocused = focusedSessionKey && chipSessionKey === focusedSessionKey;
        const isMuted = focusedSessionKey && chipSessionKey !== focusedSessionKey;
        const trainingNames = trainingsOnDay.map((item) => item.title).join(', ');
        const chipTitle = dayHoursTitle
          ? `${dayHoursTitle}\n${trainingNames}`
          : trainingNames;

        return (
        <button
          type="button"
          className={[
            'trainings-gap-training-chip',
            isFocused ? 'is-session-focused' : '',
            isMuted ? 'is-session-muted' : '',
          ].filter(Boolean).join(' ')}
          style={{
            backgroundColor: legend.legendColor,
            color: '#fff',
          }}
          title={chipTitle}
          onClick={(event) => {
            event.stopPropagation();
            onTrainingClick?.(primaryTraining);
          }}
        >
          {chipLabel}
          {trainingsOnDay.length > 1 ? ` +${trainingsOnDay.length - 1}` : ''}
        </button>
        );
      })() : null}
    </div>
  );
});

const TrainingsGapEmployeeRow = memo(function TrainingsGapEmployeeRow({
  row,
  timeline,
  timelineWidth,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
  todayYmd,
  onAddTraining,
  onEmployeeClick,
  onTrainingClick,
  showTrainingSchedule = true,
  extendMode = false,
  sessionLegendLookup,
  focusedSessionKey = '',
  previewByTrainingId = {},
  activeTrainingId = null,
  activeMode = null,
  onTrainingInteractionStart,
}) {
  const dayColumns = useMemo(
    () => timelineDayColumns(timeline),
    [timeline],
  );
  const rowEmployee = useMemo(
    () => findEmployeeById(employees, row.employeeId),
    [employees, row.employeeId],
  );
  const operativeNameClass = operativeNameClassName(rowEmployee);
  const isFilteringSession = Boolean(focusedSessionKey);
  const effectiveTrainings = useMemo(
    () => applyTrainingPreviews(row.trainings, previewByTrainingId),
    [row.trainings, previewByTrainingId],
  );

  const cellsByDay = useMemo(() => {
    const map = new Map();
    dayColumns.forEach((day) => {
      map.set(day, buildGapOnlyDayCell({
        rowName: row.name,
        day,
        dailyHours,
        availabilityHours,
        employeeHolidays,
        employees,
      }));
    });
    return map;
  }, [row.name, dayColumns, dailyHours, availabilityHours, employeeHolidays, employees]);

  const trainingsByDay = useMemo(() => {
    const map = new Map();
    dayColumns.forEach((day) => {
      const items = (effectiveTrainings || []).filter((training) => (
        isYmdWithinRange(day, training.start_date, training.end_date || training.start_date)
      ));
      map.set(day, items);
    });
    return map;
  }, [dayColumns, effectiveTrainings]);

  const trainingBarSegments = useMemo(
    () => buildTrainingBarSegments(effectiveTrainings, timeline, dayColumns, {
      clipToFreeTime: !(
        activeTrainingId != null
        && effectiveTrainings.some((training) => String(training.id) === String(activeTrainingId))
      ),
      rowName: row.name,
      rowBars: row.bars ?? [],
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
      getSegmentMeta: (training) => {
        const legend = resolveTrainingSessionLegend(training, sessionLegendLookup);
        return {
          legendNumber: legend.legendNumber,
          legendColor: legend.legendColor,
        };
      },
    }),
    [
      effectiveTrainings,
      timeline,
      dayColumns,
      sessionLegendLookup,
      row.name,
      row.bars,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
      activeTrainingId,
    ],
  );

  return (
    <div
      className="resource-histogram-resource-block trainings-gap-employee-row"
      data-histogram-row-name={row.name}
    >
      <div className="resource-gantt-label-col resource-histogram-name-col trainings-gap-name-col">
        <div className="trainings-gap-name-head">
          <button
            type="button"
            className="resource-histogram-name trainings-gap-name-btn"
            title={`${row.name} — view trainings`}
            onClick={() => onEmployeeClick?.(row)}
          >
            <span className={operativeNameClass}>{row.name}</span>
          </button>
          <span className="trainings-gap-hours-badge" title="Gap hours in view">
            {row.gapHours.toFixed(1)}h
          </span>
          <RowAddButton
            className="trainings-gap-add-btn"
            title="Schedule training for this operative"
            onClick={() => onAddTraining?.(row.employeeId)}
          />
        </div>
      </div>

      <div className="resource-histogram-timeline-block" style={{ width: timelineWidth }}>
        <div
          className={`resource-gantt-timeline-row trainings-gap-timeline-row${showTrainingSchedule ? ' is-showing-training-bars' : ''}${isFilteringSession ? ' is-filtering-session' : ''}`}
          style={{ width: timelineWidth, minHeight: HISTOGRAM_GANTT_ROW_HEIGHT }}
          data-histogram-row-name={row.name}
        >
          {timeline.columns.map((column, columnIndex) => {
            const day = histogramColumnDay(column);
            return (
              <TrainingGapGridCell
                key={`${row.employeeId ?? row.name}-${column.key}`}
                day={day}
                cell={cellsByDay.get(day)}
                rowName={row.name}
                bars={row.bars ?? []}
                dailyHours={dailyHours}
                availabilityHours={availabilityHours}
                employeeHolidays={employeeHolidays}
                employees={employees}
                trainingsOnDay={trainingsByDay.get(day)}
                columnWidth={histogramColumnWidthAt(timeline, columnIndex)}
                isToday={isTodayColumn(column, todayYmd)}
                onTrainingClick={onTrainingClick}
                showTrainingChips={showTrainingSchedule && trainingBarSegments.length === 0}
                sessionLegendLookup={sessionLegendLookup}
                focusedSessionKey={focusedSessionKey}
              />
            );
          })}
          {showTrainingSchedule ? (
            <div className="trainings-gap-training-bars">
              {trainingBarSegments.map((segment) => {
                const segmentSessionKey = trainingSessionKey(segment.training);
                const isFocused = isFilteringSession && segmentSessionKey === focusedSessionKey;
                const isMuted = isFilteringSession && segmentSessionKey !== focusedSessionKey;

                return (
                <TrainingGapBar
                  key={`${segment.training.id}-${segment.dayIndex ?? segment.left}`}
                  segment={segment}
                  editable={showTrainingSchedule}
                  extendMode={extendMode}
                  isResizing={activeTrainingId === segment.training.id && activeMode !== 'drag'}
                  isFocused={isFocused}
                  isMuted={isMuted}
                  suppressHover={activeTrainingId != null}
                  rowName={row.name}
                  onTrainingClick={onTrainingClick}
                  onInteractionStart={(payload) => onTrainingInteractionStart?.({
                    ...payload,
                    rowName: row.name,
                  })}
                />
                );
              })}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});

function TrainingsGapHistogramView({
  range,
  rows = [],
  teams = [],
  dailyHours = {},
  availabilityHours = {},
  employeeHolidays = {},
  employees = [],
  sessionLegendLookup,
  focusedSessionKey = '',
  onAddTraining,
  onEmployeeClick,
  onTrainingClick,
  onTrainingScheduleChange,
  showTrainingSchedule = true,
  extendMode = false,
}) {
  const todayYmd = toStorageDate(new Date());
  const labelWidth = useTrainingsGapLabelWidth();

  const timeline = useMemo(() => {
    if (!range?.start || !range?.end) {
      return null;
    }
    return buildHistogramTimeline(range.start, range.end);
  }, [range?.start, range?.end]);

  const employeeIdByRowName = useMemo(() => {
    const map = new Map();
    rows.forEach((row) => {
      if (row?.name && row?.employeeId != null) {
        map.set(row.name, row.employeeId);
      }
    });
    return map;
  }, [rows]);

  const getEmployeeIdByRowName = useCallback(
    (rowName) => employeeIdByRowName.get(rowName) ?? null,
    [employeeIdByRowName],
  );

  const {
    previewByTrainingId,
    activeTrainingId,
    activeMode,
    startInteraction,
    interactionOverlay,
  } = useTrainingBarInteraction({
    timeline,
    enabled: showTrainingSchedule,
    onCommit: onTrainingScheduleChange,
    onTrainingClick,
    getEmployeeIdByRowName,
  });

  const teamGroups = useMemo(
    () => buildTrainingsTeamGroups(rows, teams, employees),
    [rows, teams, employees],
  );

  if (!range?.start || !range?.end || !timeline) {
    return (
      <div className="gantt-empty card">
        <p>No date range available for the trainings grid.</p>
      </div>
    );
  }

  if (teamGroups.length === 0) {
    return (
      <div className="gantt-empty card">
        <p>No operatives with capacity gaps in this range.</p>
      </div>
    );
  }

  const { columns } = timeline;
  const timelineWidth = histogramTimelineWidth(timeline);
  const contentWidth = timelineWidth + labelWidth;

  return (
    <>
    <div
      className={`resource-histogram-combined card trainings-gap-histogram resource-histogram-combined--day${showTrainingSchedule ? ' is-showing-schedule' : ''}`}
      style={{ '--histogram-label-width': `${labelWidth}px` }}
    >
      <SyncedHorizontalScroll
        className="trainings-gap-histogram-scroll"
        scrollWidth={timelineWidth}
        todayYmd={todayYmd}
        labelWidth={labelWidth}
        labelHeader={(
          <>
            <span>Operative</span>
            <small>Gap hours &amp; scheduled training</small>
          </>
        )}
        timelineHeader={(
          <TrainingsTimelineHeader
            timeline={timeline}
            timelineWidth={timelineWidth}
            todayYmd={todayYmd}
          />
        )}
      >
        <div
          className="resource-histogram-combined-grid"
          style={{ minWidth: contentWidth }}
        >
          {teamGroups.map((group) => (
            <div key={group.teamName} className="resource-histogram-team-block">
              <div
                className="resource-histogram-team-row"
                style={{ height: HISTOGRAM_TEAM_ROW_HEIGHT }}
              >
                <div className="resource-histogram-team-label" title={group.teamName}>
                  <span className="resource-histogram-team-name">{group.teamName}</span>
                </div>
                <div
                  className="resource-histogram-team-timeline"
                  style={{ width: timelineWidth, display: 'flex' }}
                  aria-hidden="true"
                >
                  {columns.map((column, columnIndex) => (
                    <div
                      key={`${group.teamName}-${column.key}-team-band`}
                      data-histogram-day={isTodayColumn(column, todayYmd) ? histogramColumnDay(column) : undefined}
                      className={`resource-histogram-team-day${isWeekend(histogramColumnDay(column)) ? ' weekend' : ''}${isTodayColumn(column, todayYmd) ? ' is-today' : ''}`}
                      style={{ width: histogramColumnWidthAt(timeline, columnIndex) }}
                    />
                  ))}
                </div>
              </div>

              {group.rows.map((row) => (
                <TrainingsGapEmployeeRow
                  key={row.employeeId ?? row.name}
                  row={row}
                  timeline={timeline}
                  timelineWidth={timelineWidth}
                  dailyHours={dailyHours}
                  availabilityHours={availabilityHours}
                  employeeHolidays={employeeHolidays}
                  employees={employees}
                  todayYmd={todayYmd}
                  onAddTraining={onAddTraining}
                  onEmployeeClick={onEmployeeClick}
                  onTrainingClick={onTrainingClick}
                  showTrainingSchedule={showTrainingSchedule}
                  extendMode={extendMode}
                  sessionLegendLookup={sessionLegendLookup}
                  focusedSessionKey={focusedSessionKey}
                  previewByTrainingId={previewByTrainingId}
                  activeTrainingId={activeTrainingId}
                  activeMode={activeMode}
                  onTrainingInteractionStart={startInteraction}
                />
              ))}
            </div>
          ))}
        </div>
      </SyncedHorizontalScroll>
    </div>
    {interactionOverlay}
    </>
  );
}

export default memo(TrainingsGapHistogramView);
