import { memo, useCallback, useMemo, useRef } from 'react';
import { useIsMobile } from '../../hooks/useIsMobile';
import {
  buildDayCellHoverTitle,
  buildDayCapacitySegments,
  buildHistogramTeamGroups,
  buildHistogramTimeline,
  buildRowDaySlotsCache,
  buildRowHistogramFlagsForTimeline,
  histogramColumnWidthAt,
  histogramMonthSpanWidth,
  histogramTimelineWidth,
  getContinuousBarSegmentsForTimeline,
  consolidateTaskEmployeeBars,
  histogramBarGroupKey,
  resolveBarSegmentsForTimeline,
  buildBarSegmentProgressOverlayWidths,
  isEmployeeFreeNextDays,
  isEmployeeHolidayDay,
  isHalfWorkingDayHours,
  formatHistogramAvaLabel,
  isWeekend,
  lookupDayHoursForRow,
  rowHasBarOnDay,
  timelineDayColumns,
} from './ganttUtils';
import HistogramTaskBar from './HistogramTaskBar';
import {
  HISTOGRAM_DAY_PARTITIONS,
  HISTOGRAM_DAY_SPLIT_BANDS_ENABLED,
  HISTOGRAM_DEFAULT_WORK_DAY_HOURS,
  HISTOGRAM_GANTT_ROW_HEIGHT,
  HISTOGRAM_HEADER_DAY_ROW_HEIGHT,
  HISTOGRAM_HEADER_MONTH_ROW_HEIGHT,
  HISTOGRAM_HEADER_ROW_HEIGHT,
  HISTOGRAM_LABEL_WIDTH,
  HISTOGRAM_TEAM_ROW_HEIGHT,
} from './histogramLayout';
import {
  buildHistogramMonthSpans,
  formatHistogramDayHeader,
  toStorageDate,
} from '../../utils/dateFormat';
import { findEmployeeById, operativeNameClassName } from '../../utils/employeeTrainee';
import SyncedHorizontalScroll from './SyncedHorizontalScroll';
import { useHistogramBarInteraction } from './useHistogramBarInteraction';
import ResourceHistogramTrainingBars from './ResourceHistogramTrainingBars';

const GANTT_ROW_HEIGHT = HISTOGRAM_GANTT_ROW_HEIGHT;
const EMPTY_PREVIEW_BY_BAR_ID = Object.freeze({});

function rowUsesBarPreview(row, previewByBarId, activeBarId, dragPreview) {
  if (dragPreview && (
    dragPreview.sourceRowName === row.name
    || dragPreview.targetRowName === row.name
  )) {
    return true;
  }
  if (activeBarId && (row.bars ?? []).some((bar) => bar.id === activeBarId)) {
    return true;
  }
  if (!previewByBarId) {
    return false;
  }
  return (row.bars ?? []).some((bar) => previewByBarId[bar.id]);
}

const DaySplitGrid = memo(function DaySplitGrid() {
  return (
    <div className="resource-gantt-day-split" aria-hidden="true">
      {Array.from({ length: HISTOGRAM_DAY_PARTITIONS - 1 }, (_, index) => (
        <span
          key={index}
          className="resource-gantt-day-split-line"
          style={{ left: `${((index + 1) / HISTOGRAM_DAY_PARTITIONS) * 100}%` }}
        />
      ))}
    </div>
  );
});

const DaySplitOverlay = memo(function DaySplitOverlay({ timeline, showDaySplit }) {
  // Always render so day borders paint above task bars (pointer-events: none).
  if (!timeline?.columns?.length) {
    return null;
  }

  return (
    <div className="resource-gantt-day-split-overlay" aria-hidden="true">
      {timeline.columns.map((column, index) => {
        const day = histogramColumnDay(column);
        const width = histogramColumnWidthAt(timeline, index);
        if (!showDaySplitForDay(showDaySplit, day)) {
          return (
            <div
              key={column.key || day || index}
              className={`resource-gantt-day-split-overlay-col${isWeekend(day) ? ' weekend' : ''}`}
              style={{ width }}
            />
          );
        }
        return (
          <div
            key={column.key || day || index}
            className={`resource-gantt-day-split-overlay-col${isWeekend(day) ? ' weekend' : ''}`}
            style={{ width }}
          >
            <DaySplitGrid />
          </div>
        );
      })}
    </div>
  );
});

function showDaySplitForDay(showDaySplit, day) {
  return showDaySplit && !isWeekend(day);
}

function histogramColumnDay(column) {
  return column?.day || column?.start || '';
}

function isTodayColumn(column, todayYmd) {
  return histogramColumnDay(column) === todayYmd;
}

const HistogramTimelineHeader = memo(function HistogramTimelineHeader({
  timeline,
  timelineWidth,
  todayYmd,
}) {
  const dayColumns = timelineDayColumns(timeline);
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

const GanttDayCell = memo(function GanttDayCell({
  day,
  rowName,
  bars,
  dailyHours,
  showAvailability,
  availabilityHours,
  employeeHolidays,
  employees,
  showDaySplit,
  columnWidth,
  isToday = false,
  capacitySegments,
  hasBar,
  showAva,
  showHoliday,
  showHalfDay = false,
  halfDayHours = null,
}) {
  const hoverContextRef = useRef(null);
  const showCapacityBand = !isWeekend(day) && capacitySegments.length > 0;
  const showSplit = showDaySplitForDay(showDaySplit, day);
  const halfDayLabel = showHalfDay ? formatHistogramAvaLabel(halfDayHours) : '';

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
    }
    event.currentTarget.title = buildDayCellHoverTitle(hoverContextRef.current);
  }, [rowName, day, bars, dailyHours, availabilityHours, employeeHolidays, employees]);

  return (
    <div
      className={[
        'resource-gantt-grid-cell',
        isWeekend(day) ? 'weekend' : '',
        showAva != null && !showHalfDay ? 'has-inline-ava' : '',
        showHoliday && !showHalfDay ? 'has-holiday' : '',
        showHalfDay ? 'has-half-day' : '',
        showCapacityBand ? 'has-capacity-band' : '',
        showSplit ? 'has-day-split' : '',
        isToday ? 'is-today' : '',
      ].filter(Boolean).join(' ')}
      data-histogram-day={isToday ? day : undefined}
      style={{ width: columnWidth, height: GANTT_ROW_HEIGHT }}
      onMouseEnter={handleMouseEnter}
    >
      {showSplit && <DaySplitGrid />}
      {showHalfDay ? (
        <div className="resource-gantt-half-day" aria-hidden="true">
          <span className="resource-gantt-half-day-holiday">H</span>
          <span className="resource-gantt-half-day-hours">{halfDayLabel}</span>
        </div>
      ) : (
        <>
          {showHoliday && (
            <span className="resource-gantt-holiday-chip" aria-hidden="true">H</span>
          )}
          {showAva != null && (
            <span className="resource-gantt-inline-ava">{formatHistogramAvaLabel(showAva)}</span>
          )}
        </>
      )}
      {showCapacityBand && (
        <div className="resource-gantt-day-capacity" aria-hidden="true">
          {capacitySegments.map((segment, index) => (
            <span
              key={`${day}-${segment.kind}-${index}`}
              className={`resource-gantt-day-capacity-segment resource-gantt-day-capacity-segment-${segment.kind}`}
              style={{
                width: `${segment.percent}%`,
                backgroundColor: segment.kind === 'empty' ? undefined : segment.color,
              }}
              title={segment.title}
            />
          ))}
        </div>
      )}
    </div>
  );
});

const GanttTimelineCell = memo(function GanttTimelineCell({
  timeline,
  column,
  columnIndex,
  rowDayCells,
  showDaySplit,
  todayYmd,
}) {
  const day = column.day || column.start;
  const cell = rowDayCells.get(day);
  const columnWidth = histogramColumnWidthAt(timeline, columnIndex);

  if (!cell) {
    return (
      <div
        className="resource-gantt-grid-cell weekend"
        style={{ width: columnWidth, height: GANTT_ROW_HEIGHT }}
      />
    );
  }

  return (
    <GanttDayCell
      day={day}
      rowName={cell.rowName}
      bars={cell.bars}
      dailyHours={cell.dailyHours}
      showAvailability={cell.showAvailability}
      availabilityHours={cell.availabilityHours}
      employeeHolidays={cell.employeeHolidays}
      employees={cell.employees}
      showDaySplit={showDaySplit}
      columnWidth={columnWidth}
      isToday={isTodayColumn(column, todayYmd)}
      capacitySegments={cell.capacitySegments}
      hasBar={cell.hasBar}
      showAva={cell.showAva}
      showHoliday={cell.showHoliday}
      showHalfDay={cell.showHalfDay}
      halfDayHours={cell.halfDayHours}
    />
  );
});

import { contrastTextForBackground } from '../../utils/colorContrast';

function flagLabelText(flag) {
  return flag.nrmNumber || '';
}

function flagLabelContrast(hexColor) {
  return contrastTextForBackground(hexColor);
}

const HistogramFlag = memo(function HistogramFlag({ flag }) {
  const label = flag.kind === 'start' ? 'Doc supply' : 'Completion';
  const nrmLabel = flagLabelText(flag);
  const textColor = flagLabelContrast(flag.color);

  return (
    <span
      className={`resource-histogram-flag resource-histogram-flag-${flag.kind}`}
      style={{ left: flag.left, backgroundColor: flag.color }}
      title={`${label}${nrmLabel ? ` · NRM ${nrmLabel}` : ''}: ${flag.taskName} (${flag.projectName}) — ${flag.date}`}
      aria-hidden="true"
    >
      {nrmLabel ? (
        <span
          className="resource-histogram-flag-label"
          style={{ color: textColor }}
        >
          {nrmLabel}
        </span>
      ) : null}
    </span>
  );
});

function buildRowDayCells({
  row,
  timeline,
  dailyHours,
  bookedDailyHours = null,
  showAvailability,
  availabilityHours,
  employeeHolidays,
  employees,
}) {
  const cells = new Map();
  // Count hidden completed / no-docs assignments so AVA remaining stays accurate
  // even when those bars are filtered off the chart.
  const hoursForAvailability = bookedDailyHours ?? dailyHours;

  timeline.columns.forEach((column) => {
    const day = column.day || column.start;
    const layoutContext = {
      rowName: row.name,
      employeeHolidays,
      employees,
    };
    const hasBar = rowHasBarOnDay(row.bars, day, layoutContext);
    const avaHours = lookupDayHoursForRow(availabilityHours, row.name, day, employees) ?? 0;
    const bookedAll = lookupDayHoursForRow(hoursForAvailability, row.name, day, employees) ?? 0;
    const isHoliday = isEmployeeHolidayDay(row.name, day, employeeHolidays, employees);
    const isHalfDay = !isWeekend(day)
      && !isHoliday
      && isHalfWorkingDayHours(avaHours, HISTOGRAM_DEFAULT_WORK_DAY_HOURS);
    const shouldShowCapacity = !isWeekend(day)
      && !isHoliday
      && (hasBar || bookedAll > 0.05 || (showAvailability && avaHours > 0));
    const capacitySegments = shouldShowCapacity
      ? buildDayCapacitySegments({
        rowName: row.name,
        day,
        bars: row.bars,
        dailyHours: hoursForAvailability,
        availabilityHours,
        employeeHolidays,
        employees,
      })
      : [];

    // Remaining AVA after all assignments (including hidden completed). Fully
    // booked → 0; partially booked → leftover hours; free day → full AVA.
    const remainingAva = Math.max(0, avaHours - bookedAll);
    const showAva = showAvailability && !hasBar && !isHoliday && !isHalfDay && avaHours > 0
      ? remainingAva
      : null;

    const showHalfDay = Boolean(!hasBar && isHalfDay);
    cells.set(day, {
      rowName: row.name,
      bars: row.bars,
      dailyHours: hoursForAvailability,
      showAvailability,
      availabilityHours,
      employeeHolidays,
      employees,
      hasBar,
      showAva,
      showHoliday: isHoliday,
      showHalfDay,
      halfDayHours: showHalfDay ? Math.max(0, avaHours - bookedAll) : null,
      capacitySegments,
    });
  });

  return cells;
}

const HistogramEmployeeRow = memo(function HistogramEmployeeRow({
  row,
  timeline,
  timelineWidth,
  dailyHours,
  bookedDailyHours = null,
  availabilityHours,
  showAvailability,
  showStartFlags,
  showEndFlags,
  hideCompletedProjects,
  hiddenCompletedProjectIds = null,
  projects = [],
  onBarClick,
  onEmployeeClick,
  onTrainingClick,
  employeeHolidays,
  employees,
  showDaySplit,
  todayYmd,
  barEditsEnabled = false,
  previewByBarId = {},
  activeBarId = null,
  activeMode = null,
  activeSegmentIndex = null,
  dragPreview = null,
  onInteractionStart,
  rowTrainings = [],
  showTrainings = true,
  freeCheckBars = null,
  highlightedTaskIds = null,
  focusedPlanTaskIds = null,
  dlEditedTaskIds = null,
  dlEditByTaskId = null,
}) {
  const timelineRowRef = useRef(null);
  const rowKey = row.employeeId ?? row.name;
  const rowEmployee = useMemo(
    () => findEmployeeById(employees, row.employeeId),
    [employees, row.employeeId],
  );
  const operativeNameClass = operativeNameClassName(rowEmployee);

  const displayBars = useMemo(() => {
    const sorted = [...(row.bars ?? [])].sort(
      (a, b) => String(a.start || '').localeCompare(String(b.start || '')),
    );
    // Always keep merged display — unmerging on activeBarId made end-resize
    // jump/lag before the preview could stretch.
    return consolidateTaskEmployeeBars(sorted, {
      rowName: row.name,
      availabilityHours,
      employeeHolidays,
      employees,
      bars: sorted,
    });
  }, [row.bars, row.name, availabilityHours, employeeHolidays, employees]);

  // Apply every live preview (resized + pushed) before layout so day-split bands
  // and neighbors move together — avoids bars looking dislocated mid-drag.
  // Untouched rows keep the same displayBars reference so they skip layout work.
  const layoutBars = useMemo(() => {
    if (!previewByBarId) {
      return displayBars;
    }
    let touched = false;
    const next = displayBars.map((bar) => {
      const preview = previewByBarId[bar.id];
      if (!preview) {
        return bar;
      }
      touched = true;
      return preview;
    });
    return touched ? next : displayBars;
  }, [displayBars, previewByBarId]);

  const layoutContext = useMemo(() => ({
    rowName: row.name,
    availabilityHours,
    employeeHolidays,
    employees,
    resizeStartBarId: activeMode === 'resize-start' ? activeBarId : null,
  }), [row.name, availabilityHours, employeeHolidays, employees, activeMode, activeBarId]);

  const incomingDragBar = dragPreview?.reassigning
    && dragPreview.targetRowName === row.name
    ? dragPreview.previewBar
    : null;

  const renderBars = useMemo(() => {
    if (!incomingDragBar) {
      return layoutBars;
    }

    const incomingKey = histogramBarGroupKey(incomingDragBar);
    const withoutIncomingGroup = layoutBars.filter(
      (bar) => histogramBarGroupKey(bar) !== incomingKey,
    );

    if (withoutIncomingGroup.some((bar) => bar.id === incomingDragBar.id)) {
      return withoutIncomingGroup;
    }

    return [...withoutIncomingGroup, incomingDragBar].sort(
      (left, right) => String(left.start || '').localeCompare(String(right.start || '')),
    );
  }, [layoutBars, incomingDragBar]);

  const daySlotsCache = useMemo(() => {
    if (!HISTOGRAM_DAY_SPLIT_BANDS_ENABLED) {
      return null;
    }
    return buildRowDaySlotsCache(
      renderBars,
      timelineDayColumns(timeline),
      layoutContext,
      { soloFullWidth: false },
    );
  }, [renderBars, timeline, layoutContext]);

  // Keep AVA / flags on committed schedules during drag — rebuilding them every
  // preview frame was a major source of resize lag across long timelines.
  const rowDayCells = useMemo(
    () => buildRowDayCells({
      row: { ...row, bars: displayBars },
      timeline,
      dailyHours,
      bookedDailyHours,
      showAvailability,
      availabilityHours,
      employeeHolidays,
      employees,
    }),
    [row, displayBars, timeline, dailyHours, bookedDailyHours, showAvailability, availabilityHours, employeeHolidays, employees],
  );

  const rowFlags = useMemo(
    () => buildRowHistogramFlagsForTimeline(displayBars, row.name, timeline, {
      hideCompleted: hideCompletedProjects,
      projects,
      hiddenCompletedProjectIds,
    }),
    [displayBars, row.name, timeline, hideCompletedProjects, projects, hiddenCompletedProjectIds],
  );

  const barSegmentsByBarId = useMemo(() => {
    const map = new Map();
    const useDaySplitSegments = HISTOGRAM_DAY_SPLIT_BANDS_ENABLED;
    renderBars.forEach((bar) => {
      map.set(
        bar.id,
        useDaySplitSegments
          ? resolveBarSegmentsForTimeline(
            bar,
            renderBars,
            timeline,
            layoutContext,
            true,
            daySlotsCache,
          )
          : getContinuousBarSegmentsForTimeline(
            bar,
            renderBars,
            timeline,
            layoutContext,
          ),
      );
    });
    return map;
  }, [renderBars, timeline, layoutContext, daySlotsCache]);

  const isFreeNextThreeDays = useMemo(
    () => isEmployeeFreeNextDays({
      rowName: row.name,
      bars: freeCheckBars ?? row.bars,
      employeeHolidays,
      employees,
      days: 3,
    }),
    [row.name, freeCheckBars, row.bars, employeeHolidays, employees],
  );

  const startFlags = showStartFlags
    ? rowFlags.filter((flag) => flag.kind === 'start')
    : [];
  const endFlags = showEndFlags
    ? rowFlags.filter((flag) => flag.kind === 'end')
    : [];

  const timelineBlock = (
    <div className="resource-histogram-timeline-block" style={{ width: timelineWidth }}>
      <div
        ref={timelineRowRef}
        className="resource-gantt-timeline-row"
        style={{ width: timelineWidth, height: GANTT_ROW_HEIGHT }}
        data-histogram-row-name={row.name}
      >
        {timeline.columns.map((col, columnIndex) => (
          <GanttTimelineCell
            key={`${rowKey}-gantt-${col.key}`}
            timeline={timeline}
            column={col}
            columnIndex={columnIndex}
            rowDayCells={rowDayCells}
            showDaySplit={showDaySplit}
            todayYmd={todayYmd}
          />
        ))}
        {renderBars.flatMap((bar) => {
          const isIncomingPreview = incomingDragBar?.id === bar.id;
          const isSourceDrag = dragPreview?.sourceRowName === row.name
            && dragPreview?.barId === bar.id
            && dragPreview?.reassigning;
          const renderBar = bar;
          const segmentsForRender = barSegmentsByBarId.get(bar.id) ?? [];

          // Keep a faint source ghost while reassigning so the bar never
          // vanishes between rows during drag.
          if (isSourceDrag) {
            const ghostProgressWidths = buildBarSegmentProgressOverlayWidths(
              renderBar,
              segmentsForRender,
            );
            return segmentsForRender.map((segment, segmentIndex) => (
              <HistogramTaskBar
                key={`${bar.id}-${segmentIndex}-ghost`}
                bar={renderBar}
                segment={segment}
                segmentIndex={segmentIndex}
                timeline={timeline}
                editable={false}
                isFirstSegment={segmentIndex === 0}
                isLastSegment={segmentIndex === segmentsForRender.length - 1}
                isDragging
                suppressHover
                className="is-reassign-source-ghost"
                progressOverlayWidthPx={ghostProgressWidths[segmentIndex]}
                todayYmd={todayYmd}
              />
            ));
          }

          const progressOverlayWidths = buildBarSegmentProgressOverlayWidths(
            renderBar,
            segmentsForRender,
          );

          return segmentsForRender.map((segment, segmentIndex) => (
            <HistogramTaskBar
              key={`${bar.id}-${segmentIndex}`}
              bar={renderBar}
              segment={segment}
              segmentIndex={segmentIndex}
              timeline={timeline}
              onBarClick={onBarClick}
              editable={barEditsEnabled && !isIncomingPreview}
              isFirstSegment={segmentIndex === 0}
              isLastSegment={segmentIndex === segmentsForRender.length - 1}
              progressOverlayWidthPx={progressOverlayWidths[segmentIndex]}
              isResizing={
                activeBarId === bar.id
                && activeMode !== 'drag'
                && activeSegmentIndex === segmentIndex
              }
              isDragging={
                activeBarId === bar.id
                && activeMode === 'drag'
              }
              isDropBlocked={Boolean(isIncomingPreview && dragPreview?.blocked)}
              suppressHover={Boolean(activeBarId)}
              className={
                [
                  highlightedTaskIds?.has(String(bar.task_id ?? bar.id))
                    ? 'is-editor-highlighted'
                    : '',
                  focusedPlanTaskIds?.has(String(bar.task_id ?? bar.id))
                    ? 'is-dl-plan-focused'
                    : '',
                  dlEditedTaskIds?.has(String(bar.task_id ?? bar.id))
                    ? 'is-dl-plan-edited'
                    : '',
                ].filter(Boolean).join(' ')
              }
              dlPlanEdit={dlEditByTaskId?.get(String(bar.task_id ?? bar.id)) || null}
              todayYmd={todayYmd}
              onInteractionStart={(payload) => {
                // Use the displayed bar (may be mergeAdjacent of several fragments).
                // Looking up row.bars by id returns only the first fragment, and the
                // remaining same-task fragments then act as competitors — so end-resize
                // cannot stretch past the next fragment.
                const workingBar = payload.bar;
                const sameAssignment = (candidate) => (
                  String(candidate.task_id) === String(workingBar?.task_id)
                  && String(candidate.employee || '').trim().toLowerCase()
                    === String(workingBar?.employee || '').trim().toLowerCase()
                );

                onInteractionStart?.({
                  ...payload,
                  bar: workingBar,
                  rowName: row.name,
                  rowBars: displayBars.filter((candidate) => !sameAssignment(candidate)),
                  sourceRowBars: displayBars,
                  siblingBars: [],
                });
              }}
            />
          ));
        })}
        {startFlags.map((flag) => <HistogramFlag key={flag.id} flag={flag} />)}
        {endFlags.map((flag) => <HistogramFlag key={flag.id} flag={flag} />)}
        <ResourceHistogramTrainingBars
          trainings={showTrainings ? rowTrainings : []}
          timeline={timeline}
          rowName={row.name}
          rowBars={layoutBars}
          dailyHours={dailyHours}
          availabilityHours={availabilityHours}
          employeeHolidays={employeeHolidays}
          employees={employees}
          onTrainingClick={onTrainingClick}
        />
        <DaySplitOverlay timeline={timeline} showDaySplit={showDaySplit} />
      </div>
    </div>
  );

  return (
    <div
      className="resource-histogram-resource-block"
      data-histogram-row-name={row.name}
    >
      <div className="resource-gantt-label-col resource-histogram-name-col">
        <button
          type="button"
          className="resource-histogram-name resource-histogram-name-btn"
          title={`${row.name} — view projects and closest training gap`}
          onClick={() => onEmployeeClick?.(row)}
        >
          <span className={operativeNameClass}>{row.name}</span>
          {isFreeNextThreeDays && (
            <span
              className="resource-histogram-free-dot"
              title="Free for the next 3 days (no tasks scheduled)"
              aria-label="Free for the next 3 days"
            />
          )}
        </button>
      </div>

      {timelineBlock}
    </div>
  );
});

const HISTOGRAM_LABEL_WIDTH_MOBILE = 112;

function ResourceHistogramView({
  range,
  employees,
  bars,
  dailyHours,
  bookedDailyHours = null,
  availabilityHours,
  showAvailability = false,
  showStartFlags = false,
  showEndFlags = false,
  hideCompletedProjects = true,
  hiddenCompletedProjectIds = null,
  projects = [],
  projectFilterId = null,
  teamFilterId = null,
  employeeHolidays = {},
  showDaySplit = false,
  onBarClick,
  onEmployeeClick,
  onTrainingClick,
  barEditsEnabled = false,
  onBarEditCommit,
  onBarEditPreview,
  showTrainings = true,
  trainingsByEmployeeId = null,
  freeCheckBars = null,
  highlightedTaskIds = [],
  focusedPlanTaskIds = [],
  dlEditedTaskIds = [],
  dlEditByTaskId = null,
}) {
  // Narrower operative column on phones so more of the timeline is visible.
  const labelWidth = useIsMobile() ? HISTOGRAM_LABEL_WIDTH_MOBILE : HISTOGRAM_LABEL_WIDTH;
  const start = range?.start;
  const end = range?.end;
  const todayYmd = toStorageDate(new Date());
  const highlightedTaskIdSet = useMemo(
    () => new Set((highlightedTaskIds ?? []).map(String)),
    [highlightedTaskIds],
  );
  const focusedPlanTaskIdSet = useMemo(
    () => new Set((focusedPlanTaskIds ?? []).map(String)),
    [focusedPlanTaskIds],
  );
  const dlEditedTaskIdSet = useMemo(
    () => new Set((dlEditedTaskIds ?? []).map(String)),
    [dlEditedTaskIds],
  );
  const hasEditorHighlights = highlightedTaskIdSet.size > 0;
  const hasPlanFocus = !hasEditorHighlights && focusedPlanTaskIdSet.size > 0;

  const timeline = useMemo(() => {
    if (!start || !end) {
      return null;
    }
    return buildHistogramTimeline(start, end);
  }, [start, end]);

  const onlyWithData = Boolean(projectFilterId);

  const teamGroups = useMemo(
    () => buildHistogramTeamGroups({
      employees: employees ?? [],
      bars: bars ?? [],
      dailyHours: dailyHours ?? {},
      availabilityHours: availabilityHours ?? {},
      employeeHolidays: employeeHolidays ?? {},
      onlyWithData,
      requireOap: true,
    }),
    [employees, bars, dailyHours, availabilityHours, employeeHolidays, onlyWithData],
  );

  const rowsByName = useMemo(() => {
    const map = new Map();
    teamGroups.forEach((group) => {
      group.rows.forEach((row) => {
        map.set(row.name, row);
      });
    });
    return map;
  }, [teamGroups]);

  const getRowByName = useCallback((rowName) => rowsByName.get(rowName) ?? null, [rowsByName]);

  const {
    previewByBarId,
    activeBarId,
    activeMode,
    activeSegmentIndex,
    dragPreview,
    startInteraction,
    interactionOverlay,
  } = useHistogramBarInteraction({
    timeline,
    employeeHolidays,
    availabilityHours,
    employees,
    getRowByName,
    onCommit: onBarEditCommit,
    onPreview: onBarEditPreview,
    onBarClick,
    enabled: barEditsEnabled,
  });

  if (!start || !end || !timeline) {
    return (
      <div className="gantt-empty card">
        <p>No date range available for the histogram.</p>
      </div>
    );
  }

  const { columns } = timeline;
  const timelineWidth = histogramTimelineWidth(timeline);

  if (teamGroups.length === 0) {
    return (
      <div className="gantt-empty card">
        <p>
          {projectFilterId
            ? 'No operatives with OAP or tasks for the selected project in this date range.'
            : teamFilterId
              ? 'No operatives with OAP found for the selected team.'
              : 'No operatives with OAP to display. Add OAP values in Operatives Allocation.'}
        </p>
      </div>
    );
  }

  return (
    <div className="resource-histogram-zoom-surface">
      {interactionOverlay}
      <div
        style={{ '--histogram-label-width': `${labelWidth}px` }}
        className={`resource-histogram-combined card resource-histogram-combined--day${showDaySplit ? ' resource-histogram-combined--day-split' : ''}${barEditsEnabled ? '' : ' resource-histogram-combined--bar-edits-locked'}${hasEditorHighlights ? ' resource-histogram-combined--editor-highlighting' : ''}${hasPlanFocus ? ' resource-histogram-combined--plan-highlighting' : ''}`}>
      <SyncedHorizontalScroll
        scrollWidth={timelineWidth}
        todayYmd={todayYmd}
        labelWidth={labelWidth}
        labelHeader={<span>Operative</span>}
        timelineHeader={(
          <HistogramTimelineHeader
            timeline={timeline}
            timelineWidth={timelineWidth}
            todayYmd={todayYmd}
          />
        )}
      >
        <div
          className="resource-histogram-combined-grid"
          style={{ minWidth: labelWidth + timelineWidth }}
        >
          {teamGroups.map((group) => (
            <div key={group.teamName} className="resource-histogram-team-block">
              <div
                className="resource-histogram-team-row"
                style={{ height: HISTOGRAM_TEAM_ROW_HEIGHT }}
              >
                <div
                  className="resource-histogram-team-label"
                  title={group.teamName}
                >
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
                <HistogramEmployeeRow
                  key={row.employeeId ?? row.name}
                  row={row}
                  timeline={timeline}
                  timelineWidth={timelineWidth}
                  dailyHours={dailyHours}
                  bookedDailyHours={bookedDailyHours}
                  availabilityHours={availabilityHours}
                  showAvailability={showAvailability}
                  showStartFlags={showStartFlags}
                  showEndFlags={showEndFlags}
                  hideCompletedProjects={hideCompletedProjects}
                  hiddenCompletedProjectIds={hiddenCompletedProjectIds}
                  projects={projects}
                  onBarClick={onBarClick}
                  onEmployeeClick={onEmployeeClick}
                  onTrainingClick={onTrainingClick}
                  employeeHolidays={employeeHolidays}
                  employees={employees}
                  showDaySplit={showDaySplit}
                  todayYmd={todayYmd}
                  barEditsEnabled={barEditsEnabled}
                  previewByBarId={
                    rowUsesBarPreview(row, previewByBarId, activeBarId, dragPreview)
                      ? previewByBarId
                      : EMPTY_PREVIEW_BY_BAR_ID
                  }
                  activeBarId={activeBarId}
                  activeMode={activeMode}
                  activeSegmentIndex={activeSegmentIndex}
                  dragPreview={dragPreview}
                  onInteractionStart={startInteraction}
                  showTrainings={showTrainings}
                  rowTrainings={trainingsByEmployeeId?.get(String(row.employeeId)) ?? []}
                  freeCheckBars={freeCheckBars}
                  highlightedTaskIds={highlightedTaskIdSet}
                  focusedPlanTaskIds={focusedPlanTaskIdSet}
                  dlEditedTaskIds={dlEditedTaskIdSet}
                  dlEditByTaskId={dlEditByTaskId}
                />
              ))}
            </div>
          ))}
        </div>
      </SyncedHorizontalScroll>
    </div>
    </div>
  );
}

export default memo(ResourceHistogramView);
