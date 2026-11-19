import { memo, useCallback, useMemo, useRef, useState } from 'react';
import DisplayDateInput from './DisplayDateInput';
import { useScrollContainerWheel } from '../hooks/useScrollContainerWheel';
import {
  getTrainingFieldColSize,
  getTrainingFieldValue,
  getTrainingSectionVisibleFields,
  getVisibleTrainingFields,
  trainingEmployeeSections,
  trainingSelectLabel,
} from '../constants/trainingFields';
import {
  TRAINING_DURATION_OPTIONS,
  TRAINING_PRIORITY_OPTIONS,
  TRAINING_STATUS_OPTIONS,
  TRAINING_URGENCY_OPTIONS,
  applyTrainingSingleDaySlot,
  normalizeTrainingDaySegment,
} from '../utils/trainingForm';
import { compareTeamNames } from '../utils/teamOrder';
import { formatDisplayDate } from '../utils/dateFormat';
import TrainingDaySegmentPicker from './TrainingDaySegmentPicker';

const DEFAULT_FROZEN_FIELD_KEYS = new Set(['employee_name']);

function getFrozenFieldClassName(field, frozenFieldKeys = DEFAULT_FROZEN_FIELD_KEYS) {
  const keys = frozenFieldKeys instanceof Set ? frozenFieldKeys : new Set(frozenFieldKeys);
  return keys.has(field.key)
    ? 'sticky-col sticky-col-task-frozen sticky-col-task-name'
    : '';
}

function getSectionBoundaryClass(fieldKey, visibleFields, sections, primarySectionKey = 'employee') {
  const sectionKey = getFieldSectionKey(fieldKey, sections);
  if (sectionKey === primarySectionKey || !isFirstVisibleFieldInSection(fieldKey, visibleFields, sections)) {
    return '';
  }
  return ' section-boundary-start';
}

function getFieldSectionKey(fieldKey, sections = trainingEmployeeSections) {
  const section = sections.find((item) =>
    item.fields.some((field) => field.key === fieldKey),
  );
  return section?.key ?? '';
}

function isFirstVisibleFieldInSection(fieldKey, visibleFields, sections = trainingEmployeeSections) {
  const sectionKey = getFieldSectionKey(fieldKey, sections);
  const firstInSection = visibleFields.find(
    (field) => getFieldSectionKey(field.key, sections) === sectionKey,
  );
  return firstInSection?.key === fieldKey;
}

function getSelectOptions(fieldKey) {
  if (fieldKey === 'duration') {
    return TRAINING_DURATION_OPTIONS;
  }
  if (fieldKey === 'status') {
    return TRAINING_STATUS_OPTIONS;
  }
  if (fieldKey === 'priority') {
    return TRAINING_PRIORITY_OPTIONS;
  }
  if (fieldKey === 'urgency') {
    return TRAINING_URGENCY_OPTIONS;
  }
  return [];
}

const TrainingFieldCell = memo(function TrainingFieldCell({
  row,
  field,
  rowIndex,
  onCellChange,
  isTraineeRow = false,
  employeeOptions = [],
  isDateDisabled = null,
  scheduleHint = '',
  fieldLocked = false,
}) {
  const value = getTrainingFieldValue(row, field.key);
  const colSize = getTrainingFieldColSize(field);
  const readOnly = Boolean(field.readOnly) || Boolean(field.forceReadOnly) || fieldLocked;
  const inputClassName = [
    `task-col-input col-${colSize}`,
    readOnly ? 'is-locked' : '',
  ].filter(Boolean).join(' ');

  const commitChange = useCallback(
    (next) => {
      if (readOnly) {
        return;
      }
      onCellChange(rowIndex, field.key, next);
    },
    [field.key, onCellChange, readOnly, rowIndex],
  );

  if (field.type === 'training-hours') {
    const min = field.min ?? 0.25;
    const max = field.max ?? 80;
    return (
      <input
        type="number"
        className={inputClassName}
        min={min}
        max={max}
        step="0.25"
        inputMode="decimal"
        value={value ?? ''}
        title={readOnly ? 'Not editable' : field.title}
        disabled={readOnly}
        tabIndex={readOnly ? -1 : undefined}
        onChange={(e) => commitChange(e.target.value)}
        onBlur={(e) => {
          const parsed = Number(e.target.value);
          if (!Number.isFinite(parsed) || parsed < min) {
            commitChange(min);
          }
        }}
      />
    );
  }

  if (field.type === 'select') {
    const options = getSelectOptions(field.key);
    return (
      <select
        className={inputClassName}
        title={readOnly ? 'Not editable' : field.title}
        value={value || ''}
        disabled={readOnly}
        tabIndex={readOnly ? -1 : undefined}
        onChange={(e) => commitChange(e.target.value)}
      >
        {options.map((option) => (
          <option key={option.value || 'empty'} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    );
  }

  if (field.type === 'employee-select') {
    const grouped = [];
    const byTeam = new Map();
    employeeOptions.forEach((option) => {
      const teamName = option.teamName || 'Operatives';
      if (!byTeam.has(teamName)) {
        byTeam.set(teamName, []);
      }
      byTeam.get(teamName).push(option);
    });
    [...byTeam.keys()]
      .sort(compareTeamNames)
      .forEach((teamName) => {
        grouped.push({ teamName, members: byTeam.get(teamName) });
      });
    const useGroups = grouped.length > 1;

    return (
      <select
        className={[
          'task-col-input training-roster-operative-select',
          readOnly ? 'is-locked' : '',
        ].filter(Boolean).join(' ')}
        title={readOnly ? 'Not editable' : field.title}
        value={value || ''}
        disabled={readOnly}
        tabIndex={readOnly ? -1 : undefined}
        onChange={(e) => commitChange(e.target.value)}
      >
        <option value="">Select operative…</option>
        {useGroups
          ? grouped.map((group) => (
            <optgroup key={group.teamName} label={group.teamName}>
              {group.members.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </optgroup>
          ))
          : employeeOptions.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
      </select>
    );
  }

  if (field.type === 'date') {
    if (readOnly) {
      return (
        <span className="task-readonly-date is-locked" title="Not editable">
          {formatDisplayDate(value) || '—'}
        </span>
      );
    }

    return (
      <DisplayDateInput
        value={value ?? ''}
        onChange={commitChange}
        className="task-date-input"
        placeholder=""
        title={scheduleHint || field.title}
        isDateDisabled={typeof isDateDisabled === 'function' ? isDateDisabled : undefined}
      />
    );
  }

  if (field.type === 'day-segment') {
    return (
      <TrainingDaySegmentPicker
        value={value}
        onChange={commitChange}
        disabled={readOnly}
        readOnly={readOnly}
        className={`training-day-segment-picker--grid${readOnly ? ' is-locked' : ''}`}
        aria-label={field.title || 'Day section'}
      />
    );
  }

  if (readOnly) {
    const displayValue = field.type === 'decimal' && value !== '' && value != null
      ? Number(value).toFixed(1)
      : value || '—';
    const readOnlyClassName = [
      'task-readonly-text',
      'is-locked',
      field.key === 'employee_name' ? 'task-algorithm-display' : '',
      field.key === 'employee_name' && isTraineeRow ? 'operative-name--trainee' : '',
    ].filter(Boolean).join(' ');
    return (
      <span
        className={readOnlyClassName}
        title={field.title || displayValue}
      >
        {displayValue}
      </span>
    );
  }

  if (field.type === 'url') {
    const link = String(value ?? '').trim();

    return (
      <input
        type="url"
        className={inputClassName}
        value={value ?? ''}
        title={link || field.title}
        onChange={(e) => commitChange(e.target.value)}
      />
    );
  }

  return (
    <input
      type="text"
      className={inputClassName}
      value={value ?? ''}
      title={field.title}
      onChange={(e) => commitChange(e.target.value)}
    />
  );
});

const TrainingRow = memo(function TrainingRow({
  row,
  rowIndex,
  onCellChange,
  onRemoveAssignment,
  removingId,
  visibleFields,
  frozenFieldKeys,
  sections,
  primarySectionKey,
  isTraineeRow = false,
  showActions = false,
  employeeOptionsForRow = null,
  isDateDisabledForRow = null,
  scheduleHintForRow = null,
  gridReadOnly = false,
  editableFieldKeys = null,
  highlighted = false,
}) {
  const isRemoving = removingId != null && String(removingId) === String(row.id);
  const isBusy = removingId != null;
  const editableKeys = editableFieldKeys instanceof Set
    ? editableFieldKeys
    : (Array.isArray(editableFieldKeys) ? new Set(editableFieldKeys) : null);

  return (
    <tr
      className={[
        isTraineeRow ? 'is-trainee-roster-row' : '',
        highlighted ? 'is-log-focus' : '',
      ].filter(Boolean).join(' ') || undefined}
      data-training-id={row?.id != null ? String(row.id) : undefined}
    >
      {visibleFields.map((field) => {
        const fieldLocked = gridReadOnly
          || Boolean(field.readOnly)
          || Boolean(field.forceReadOnly)
          || (editableKeys != null && !editableKeys.has(field.key));
        return (
          <td
            key={field.key}
            className={[
              `col-${getTrainingFieldColSize(field)}`,
              `col-field-${field.key}`,
              getFrozenFieldClassName(field, frozenFieldKeys),
              getSectionBoundaryClass(field.key, visibleFields, sections, primarySectionKey),
              fieldLocked ? 'is-readonly-cell' : 'is-editable-cell',
            ].filter(Boolean).join(' ')}
            title={field.type === 'select' ? trainingSelectLabel(field.key, getTrainingFieldValue(row, field.key), row) : undefined}
          >
            <TrainingFieldCell
              row={row}
              field={gridReadOnly ? { ...field, forceReadOnly: true } : field}
              rowIndex={rowIndex}
              onCellChange={onCellChange}
              isTraineeRow={isTraineeRow}
              fieldLocked={fieldLocked && !gridReadOnly && !field.readOnly && !field.forceReadOnly}
              employeeOptions={
                field.type === 'employee-select' && typeof employeeOptionsForRow === 'function'
                  ? employeeOptionsForRow(rowIndex, row)
                  : []
              }
              isDateDisabled={
                field.type === 'date' && typeof isDateDisabledForRow === 'function'
                  ? isDateDisabledForRow(rowIndex, row)
                  : null
              }
              scheduleHint={
                typeof scheduleHintForRow === 'function'
                  ? scheduleHintForRow(rowIndex, row)
                  : ''
              }
            />
          </td>
        );
      })}
      {showActions ? (
        <td className="col-sm training-roster-actions-cell">
          <button
            type="button"
            className="btn btn-danger btn-sm"
            onClick={() => onRemoveAssignment?.(row)}
            disabled={isBusy}
            title="Remove this operative from the training"
          >
            {isRemoving ? 'Removing...' : 'Remove'}
          </button>
        </td>
      ) : null}
    </tr>
  );
});

export function applyTrainingFieldChange(row, key, value) {
  if (key === 'start_date') {
    return applyTrainingSingleDaySlot({ ...row, start_date: value }, value);
  }

  if (key === 'end_date') {
    return applyTrainingSingleDaySlot({ ...row, start_date: value, end_date: value }, value);
  }

  if (key === 'total_hours' || key === 'duration') {
    return applyTrainingSingleDaySlot(row, row?.start_date);
  }

  if (key === 'day_segment') {
    return applyTrainingSingleDaySlot({
      ...row,
      day_segment: normalizeTrainingDaySegment(value, 0),
    }, row?.start_date);
  }

  return { ...row, [key]: value };
}

export default function TrainingEmployeeGrid({
  rows = [],
  onChange,
  onRemoveAssignment = null,
  removingId = null,
  sections = trainingEmployeeSections,
  pageClassName = 'training-roster-panel',
  frozenFieldKeys = ['employee_name'],
  primarySectionKey = 'employee',
  emptyMessage = 'No operatives assigned to this training.',
  simpleHeader = false,
  isTraineeRow = () => false,
  employeeOptionsForRow = null,
  isDateDisabledForRow = null,
  scheduleHintForRow = null,
  /** When set, only these field keys stay editable; others are dimmed/locked. */
  editableFieldKeys = null,
  highlightedRowId = null,
}) {
  const scrollRef = useRef(null);
  useScrollContainerWheel(scrollRef);
  const [minimizedSections, setMinimizedSections] = useState({});
  const frozenFieldKeySet = useMemo(() => new Set(frozenFieldKeys), [frozenFieldKeys]);
  const showActions = typeof onRemoveAssignment === 'function';
  const gridReadOnly = typeof onChange !== 'function';
  const editableFieldKeySet = useMemo(() => {
    if (!editableFieldKeys) {
      return null;
    }
    return editableFieldKeys instanceof Set
      ? editableFieldKeys
      : new Set(editableFieldKeys);
  }, [editableFieldKeys]);

  const visibleFields = useMemo(
    () => getVisibleTrainingFields(sections, minimizedSections),
    [sections, minimizedSections],
  );

  const toggleSectionMinimize = useCallback((sectionKey) => {
    setMinimizedSections((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey],
    }));
  }, []);

  const handleCellChange = useCallback(
    (rowIndex, key, value) => {
      if (editableFieldKeySet && !editableFieldKeySet.has(key)) {
        return;
      }
      onChange?.(rowIndex, key, value);
    },
    [editableFieldKeySet, onChange],
  );

  const gridColSpan = visibleFields.length + (showActions ? 1 : 0);

  return (
    <div className={`card project-task-panel ${pageClassName}${simpleHeader ? ' training-roster-panel--pro' : ''}`.trim()}>
      <div ref={scrollRef} className="project-task-scroll training-roster-scroll">
        <table className={`project-task-table training-roster-table${simpleHeader ? ' training-roster-table--pro' : ''}`.trim()}>
          <thead>
            {!simpleHeader ? (
            <tr>
              {sections.map((section, sectionIndex) => {
                const isMinimized = minimizedSections[section.key];
                const sectionFields = getTrainingSectionVisibleFields(section, isMinimized);

                return (
                  <th
                    key={section.key}
                    colSpan={sectionFields.length}
                    className={`section-header ${isMinimized ? 'section-header-minimized' : ''}${sectionIndex > 0 ? ' section-boundary-start' : ''}${sectionIndex === 0 && sectionFields.length > 0 ? ' section-header-frozen sticky-col sticky-col-task-frozen sticky-col-task-header' : ''}`}
                    onClick={() => toggleSectionMinimize(section.key)}
                    title={isMinimized ? 'Click to expand section' : 'Click to minimize section'}
                  >
                    {isMinimized && section.minimizedTitle ? section.minimizedTitle : section.title}
                  </th>
                );
              })}
              {showActions ? (
                <th className="section-header training-roster-actions-header" aria-hidden="true" />
              ) : null}
            </tr>
            ) : null}
            <tr>
              {visibleFields.map((field) => (
                <th
                  key={field.key}
                  className={`col-${getTrainingFieldColSize(field)} col-field-${field.key} project-task-field-header ${getFrozenFieldClassName(field, frozenFieldKeySet)}${getSectionBoundaryClass(field.key, visibleFields, sections, primarySectionKey)}`}
                  title={field.title || undefined}
                >
                  <span className="project-task-field-header-label">
                    {field.label}
                  </span>
                </th>
              ))}
              {showActions ? (
                <th className="col-sm project-task-field-header training-roster-actions-header">
                  <span className="project-task-field-header-label">Actions</span>
                </th>
              ) : null}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={gridColSpan}>
                  {emptyMessage}
                </td>
              </tr>
            ) : null}
            {rows.map((row, rowIndex) => (
              <TrainingRow
                key={row.id ?? `row-${rowIndex}`}
                row={row}
                rowIndex={rowIndex}
                onCellChange={handleCellChange}
                onRemoveAssignment={onRemoveAssignment}
                removingId={removingId}
                visibleFields={visibleFields}
                frozenFieldKeys={frozenFieldKeySet}
                sections={sections}
                primarySectionKey={primarySectionKey}
                isTraineeRow={isTraineeRow(row)}
                showActions={showActions}
                employeeOptionsForRow={employeeOptionsForRow}
                isDateDisabledForRow={isDateDisabledForRow}
                scheduleHintForRow={scheduleHintForRow}
                gridReadOnly={gridReadOnly}
                editableFieldKeys={editableFieldKeySet}
                highlighted={
                  highlightedRowId != null
                  && highlightedRowId !== ''
                  && String(row.id) === String(highlightedRowId)
                }
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
