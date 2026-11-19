import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  createInitialMinimizedSections,
  getFieldColSize,
  getFieldSourceClassName,
  getFieldTooltip,
  getSectionVisibleFields,
  getTaskFieldValue,
  getVisibleTaskFields,
  taskSections,
} from '../constants/projectTaskFields';
import DisplayDateInput from './DisplayDateInput';
import PriorityNumericField from './PriorityNumericField';
import { useScrollContainerWheel } from '../hooks/useScrollContainerWheel';
import { formatCompactDisplayDate, formatDisplayDate, toYmd } from '../utils/dateFormat';
import { employeeDisplayName, employeeMatchesName, employeeTeamName, resolveEmployeeSelectValue } from '../utils/employeeNames';
import { resolveAssigneeDisplayName } from '../utils/algorithm';
import { compareTeamNames, sortEmployeesByTeamThenName } from '../utils/teamOrder';
import { getFieldCellTooltip, INACTIVE_ROW_TOOLTIP } from '../utils/pdeFieldTooltips';
import { getTaskNameOptionsForRow } from '../utils/nrmTasks';
import {
  algorithmNames,
  buildAllocationSlots,
  clearAllocationOverridePatch,
  unpinAllocationSlotPatch,
  displayHourSharesForSlots,
  equalHourShares,
  hasManualAllocation,
  nextAllocationSlot,
  pinAllocationNamesPatch,
  redistributeHourShares,
  sharePatchForSlots,
  sharePercentOptions,
} from '../utils/dlQuickUpdate';


const FROZEN_FIELD_KEYS = new Set(['task_name']);

function getFrozenFieldClassName(field) {
  return FROZEN_FIELD_KEYS.has(field.key)
    ? 'sticky-col sticky-col-task-frozen sticky-col-task-name'
    : '';
}

function getFieldSectionKey(fieldKey, sections = taskSections) {
  const section = sections.find((item) =>
    item.fields.some((field) => field.key === fieldKey),
  );
  return section?.key ?? '';
}

function isFirstVisibleFieldInSection(fieldKey, visibleFields, sections = taskSections) {
  const sectionKey = getFieldSectionKey(fieldKey, sections);
  const firstInSection = visibleFields.find(
    (field) => getFieldSectionKey(field.key, sections) === sectionKey,
  );
  return firstInSection?.key === fieldKey;
}

function getSectionBoundaryClass(fieldKey, visibleFields, sections = taskSections) {
  const sectionKey = getFieldSectionKey(fieldKey, sections);
  if (sectionKey === 'task' || !isFirstVisibleFieldInSection(fieldKey, visibleFields, sections)) {
    return '';
  }
  return ' section-boundary-start';
}

function buildGroupedEmployees(employees) {
  const map = new Map();
  employees.forEach((employee) => {
    const teamName = employeeTeamName(employee) || 'No team';
    if (!map.has(teamName)) {
      map.set(teamName, []);
    }
    map.get(teamName).push(employee);
  });

  return [...map.entries()]
    .sort(([a], [b]) => compareTeamNames(a, b))
    .map(([teamName, members]) => ({
      teamName,
      members: sortEmployeesByTeamThenName(members),
    }));
}

const EmployeeSelect = memo(function EmployeeSelect({
  value,
  onChange,
  groupedEmployees,
  disabled = false,
  className = '',
}) {
  const flatEmployees = useMemo(
    () => groupedEmployees.flatMap(({ members }) => members),
    [groupedEmployees],
  );
  const selected = resolveEmployeeSelectValue(value, flatEmployees);
  const hasMatch = flatEmployees.some((employee) => employeeMatchesName(employee, selected));

  return (
    <select
      className={`task-employee-select ${className}`.trim()}
      value={selected}
      disabled={disabled}
      onChange={(e) => onChange(e.target.value)}
    >
      <option value="">—</option>
      {!hasMatch && selected ? (
        <option value={selected}>{selected}</option>
      ) : null}
      {groupedEmployees.map(({ teamName, members }) => (
        <optgroup key={teamName} label={teamName}>
          {members.map((employee) => {
            const label = employeeDisplayName(employee);
            return (
              <option key={employee.id} value={label}>
                {label}
              </option>
            );
          })}
        </optgroup>
      ))}
    </select>
  );
});

const TaskDlAllocationEditor = memo(function TaskDlAllocationEditor({
  task,
  groupedEmployees,
  readOnly = false,
  title = '',
  onChangePatch,
}) {
  const baseSlots = useMemo(() => buildAllocationSlots(task), [task]);
  const names = useMemo(() => baseSlots.map((slot) => slot.name), [baseSlots]);
  const freeSlot = useMemo(() => nextAllocationSlot(task), [task]);
  const [adding, setAdding] = useState(false);
  const [shares, setShares] = useState(() => displayHourSharesForSlots(task, baseSlots));
  const nameKey = names.join('|');
  const sourceKey = baseSlots.map((slot) => slot.source).join('|');
  const shareKey = [task?.override_share_1, task?.override_share_2, task?.override_share_3].join('|');
  const algoKey = [task?.algorithm_1, task?.algorithm_2, task?.algorithm_3].join('|');
  const showReset = !readOnly && hasManualAllocation(task);

  useEffect(() => {
    setShares(displayHourSharesForSlots(task, baseSlots));
    if (names.length >= 3 || freeSlot == null) {
      setAdding(false);
    }
  }, [nameKey, names.length, shareKey, algoKey, sourceKey, freeSlot, task, baseSlots]);

  const addSlotNumber = freeSlot || (names.length < 3 ? names.length + 1 : null);
  const slots = adding && addSlotNumber
    ? [
      ...baseSlots.map((slot, index) => ({ ...slot, index })),
      { name: '', index: names.length, slot: addSlotNumber, source: 'empty', override: '', algorithm: '' },
    ]
    : baseSlots.map((slot, index) => ({ ...slot, index }));

  const shareTotal = shares.reduce((sum, value) => sum + Number(value || 0), 0);
  const overAllocated = shareTotal > 100;
  const overBy = overAllocated ? (shareTotal - 100) : 0;
  const canAdd = !readOnly && addSlotNumber != null && !adding && names.length > 0;

  const handleReset = () => {
    const algo = algorithmNames(task);
    const nextShares = equalHourShares(algo.length || names.length);
    onChangePatch(clearAllocationOverridePatch());
    setShares(nextShares);
    setAdding(false);
  };

  return (
    <div className="dl-quick-alloc" title={title || undefined}>
      <div className="dl-quick-alloc-slots">
        {slots.length === 0 ? (
          <button
            type="button"
            className="dl-quick-alloc-add"
            disabled={readOnly}
            onClick={() => setAdding(true)}
          >
            + Add person
          </button>
        ) : (
          slots.map((slot) => {
            const chipClass = [
              'dl-quick-alloc-chip',
              slot.source === 'manual' ? 'is-manual' : '',
              slot.source === 'algo' ? 'is-algo' : '',
              slot.source === 'empty' || !slot.name ? 'is-empty' : '',
            ].filter(Boolean).join(' ');

            return (
              <div key={`${slot.slot}-${slot.name || 'new'}-${slot.index}`} className="dl-quick-alloc-slot">
                <span className="dl-quick-alloc-index" aria-hidden="true">{slot.index + 1}</span>
                <div className={chipClass}>
                  <EmployeeSelect
                    value={slot.name}
                    onChange={(value) => {
                      const trimmed = String(value ?? '').trim();
                      if (slot.source === 'empty') {
                        if (!trimmed) {
                          setAdding(false);
                          return;
                        }
                        const nextSlots = [
                          ...baseSlots,
                          { slot: slot.slot, name: trimmed, source: 'manual' },
                        ];
                        const nextShares = equalHourShares(nextSlots.length);
                        setShares(nextShares);
                        // Pin everyone so the share split is kept on the next algo run.
                        onChangePatch({
                          ...pinAllocationNamesPatch(nextSlots),
                          ...sharePatchForSlots(nextSlots, nextShares),
                        });
                        setAdding(false);
                        return;
                      }
                      // Pin or clear this slot only — other algo slots stay grey.
                      // Clearing the last pin also drops leftover shares.
                      if (!trimmed) {
                        onChangePatch(unpinAllocationSlotPatch(task, slot.slot));
                        return;
                      }
                      onChangePatch({ [`override_${slot.slot}`]: trimmed });
                    }}
                    groupedEmployees={groupedEmployees}
                    disabled={readOnly}
                    className="dl-quick-select dl-quick-alloc-person"
                  />
                  {slot.name ? (
                    <select
                      className="dl-quick-select dl-quick-alloc-share"
                      value={String(shares[slot.index] ?? '')}
                      disabled={readOnly}
                      aria-label={`Hours share for ${slot.name}`}
                      onChange={(event) => {
                        const nextValue = Number(event.target.value);
                        const base = shares.length === names.length
                          ? shares
                          : displayHourSharesForSlots(task, baseSlots);
                        const nextShares = redistributeHourShares(base, slot.index, nextValue);
                        setShares(nextShares);
                        // Pin every visible person — otherwise a single % edit leaves
                        // only one override and the algo collapses the split to 1 person.
                        onChangePatch({
                          ...pinAllocationNamesPatch(baseSlots),
                          ...sharePatchForSlots(baseSlots, nextShares),
                        });
                      }}
                    >
                      {sharePercentOptions(shares).map((pct) => (
                        <option key={pct} value={pct}>{pct}%</option>
                      ))}
                    </select>
                  ) : null}
                  {!readOnly && slot.name && (slot.source === 'manual' || slot.source === 'algo') ? (
                    <button
                      type="button"
                      className="dl-quick-alloc-remove"
                      title={
                        slot.source === 'manual' && slot.algorithm
                          ? `Reset to algorithm (${slot.algorithm})`
                          : `Remove ${slot.name}`
                      }
                      aria-label={
                        slot.source === 'manual' && slot.algorithm
                          ? `Reset ${slot.name} to algorithm`
                          : `Remove ${slot.name}`
                      }
                      onClick={() => {
                        const patch = unpinAllocationSlotPatch(task, slot.slot);
                        onChangePatch(patch);
                        const nextTask = { ...task, ...patch };
                        const nextSlots = buildAllocationSlots(nextTask);
                        setShares(displayHourSharesForSlots(nextTask, nextSlots));
                        setAdding(false);
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </div>
              </div>
            );
          })
        )}
        {canAdd ? (
          <button
            type="button"
            className="dl-quick-alloc-add"
            onClick={() => setAdding(true)}
          >
            + Add
          </button>
        ) : null}
      </div>
      {showReset ? (
        <button
          type="button"
          className="dl-quick-alloc-reset"
          title="Reset to algorithm"
          onClick={handleReset}
        >
          <span className="dl-quick-alloc-reset-ico" aria-hidden="true" />
          Reset
        </button>
      ) : null}
      {names.length > 0 ? (
        <span className={`dl-quick-alloc-total${shareTotal === 100 ? ' is-complete' : ''}${overAllocated ? ' is-over' : ''}`}>
          {shareTotal}%
        </span>
      ) : null}
      {overAllocated ? (
        <span className="dl-quick-alloc-warning">Over by {overBy}%</span>
      ) : null}
    </div>
  );
});

function normalizePercentDraft(value) {
  return String(value ?? '').trim().replace(/%$/, '').trim();
}

function TaskPercentInput({
  value,
  onChange,
  className,
  readOnly,
  instantCommit = false,
  title,
}) {
  const [draft, setDraft] = useState(() => normalizePercentDraft(value));
  const committedRef = useRef(normalizePercentDraft(value));

  useEffect(() => {
    const next = normalizePercentDraft(value);
    if (next !== committedRef.current) {
      committedRef.current = next;
      setDraft(next);
    }
  }, [value]);

  const commit = useCallback(() => {
    const raw = normalizePercentDraft(draft);
    const next = raw === ''
      ? ''
      : (() => {
        const num = Number(raw);
        if (!Number.isFinite(num)) {
          return raw;
        }
        return String(Math.min(100, Math.max(0, Math.round(num))));
      })();

    if (next !== committedRef.current) {
      committedRef.current = next;
      onChange(next);
    }
    setDraft(next);
  }, [draft, onChange]);

  const handleChange = useCallback((event) => {
    const next = event.target.value.replace(/%/g, '');
    setDraft(next);
    if (instantCommit) {
      const committed = normalizePercentDraft(next);
      committedRef.current = committed;
      onChange(committed);
    }
  }, [instantCommit, onChange]);

  return (
    <span className="task-percent-input-wrap">
      <input
        type="text"
        inputMode="decimal"
        value={draft}
        readOnly={readOnly}
        disabled={readOnly}
        className={className}
        title={title}
        onChange={handleChange}
        onBlur={() => {
          if (!instantCommit) {
            commit();
          }
        }}
        onKeyDown={(event) => {
          if (!instantCommit && event.key === 'Enter') {
            event.currentTarget.blur();
          }
        }}
      />
      <span className="task-percent-input-suffix" aria-hidden="true">%</span>
    </span>
  );
}

function TaskTextInput({
  value,
  onChange,
  className,
  size,
  readOnly,
  type = 'text',
  inputMode,
  instantCommit = false,
  title,
  onClick,
  onDoubleClick,
  onBlur,
  autoFocus = false,
  inputRef = null,
}) {
  const [draft, setDraft] = useState(() => value ?? '');
  const committedRef = useRef(value ?? '');

  useEffect(() => {
    const next = value ?? '';
    if (next !== committedRef.current) {
      committedRef.current = next;
      setDraft(next);
    }
  }, [value]);

  const commit = useCallback(() => {
    const next = draft ?? '';
    if (next !== committedRef.current) {
      committedRef.current = next;
      onChange(next);
    }
  }, [draft, onChange]);

  const handleChange = useCallback(
    (event) => {
      const next = event.target.value;
      setDraft(next);
      if (instantCommit) {
        committedRef.current = next;
        onChange(next);
      }
    },
    [instantCommit, onChange],
  );

  return (
    <input
      ref={inputRef}
      type={type}
      inputMode={inputMode}
      value={draft}
      readOnly={readOnly}
      disabled={readOnly}
      className={className}
      size={size}
      title={title}
      autoFocus={autoFocus}
      onChange={handleChange}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onBlur={(event) => {
        if (!instantCommit) {
          commit();
        }
        onBlur?.(event);
      }}
      onKeyDown={(e) => {
        if (!instantCommit && e.key === 'Enter') {
          e.currentTarget.blur();
        }
      }}
    />
  );
}

const TaskCell = memo(function TaskCell({
  field,
  value,
  task,
  tasks,
  rowIndex,
  fieldKey,
  onCellChange,
  groupedEmployees,
  instantCommit = false,
  isFieldLocked = false,
  applyDlPlanReduction = false,
  taskNameOptions = [],
  isInvalid = false,
  onSelectRow = null,
  taskNameDoubleClickToEdit = false,
}) {
  const colSize = getFieldColSize(field);
  const [editingTaskName, setEditingTaskName] = useState(false);
  const taskNameInputRef = useRef(null);
  const sourceClass = getFieldSourceClassName(field);
  const lockedClass = isFieldLocked ? 'dl-field-locked' : '';
  const invalidClass = isInvalid ? 'pde-field-invalid' : '';
  const cellTooltip = getFieldCellTooltip(field, task, { isFieldLocked, applyDlPlanReduction });
  const inputClassName = `task-col-input col-input-${colSize} ${sourceClass} ${lockedClass} ${invalidClass}`.trim();
  const inputSize =
    colSize === 'num'
      ? 4
      : colSize === 'percent'
        ? 3
      : colSize === 'decimal' || colSize === 'priority'
        ? 6
        : colSize === 'wide'
          ? 10
          : colSize === 'text'
            ? 8
            : undefined;

  const commitChange = useCallback(
    (next) => {
      if (isFieldLocked) {
        return;
      }
      onCellChange(rowIndex, fieldKey, next);
    },
    [fieldKey, isFieldLocked, onCellChange, rowIndex],
  );

  const readOnly = field.readOnly || isFieldLocked;

  if (field.type === 'checkbox') {
    const checked = field.key === 'rfi' ? value === '1' || value === true : Boolean(value);

    return (
      <input
        type="checkbox"
        className={lockedClass || undefined}
        title={isFieldLocked ? cellTooltip : undefined}
        checked={checked}
        disabled={isFieldLocked}
        onChange={(e) => {
          if (field.key === 'rfi') {
            commitChange(e.target.checked ? '1' : '0');
          } else {
            commitChange(e.target.checked);
          }
        }}
      />
    );
  }

  if (field.type === 'select') {
    return (
      <select
        className={inputClassName}
        title={cellTooltip || undefined}
        value={value || ''}
        disabled={isFieldLocked}
        onChange={(e) => commitChange(e.target.value)}
      >
        {field.options.map((option) => (
          <option key={option || 'empty'} value={option}>
            {option || '—'}
          </option>
        ))}
      </select>
    );
  }

  if (field.key === 'task_name' && taskNameOptions.length > 0 && !readOnly && !task?.id) {
    const rowOptions = getTaskNameOptionsForRow(taskNameOptions, tasks, rowIndex, value);
    const selectValue = value ?? '';

    return (
      <select
        className={`${inputClassName} task-name-select`.trim()}
        title={cellTooltip || 'Select a task from the NRM list'}
        value={selectValue}
        disabled={isFieldLocked}
        onClick={(event) => {
          event.stopPropagation();
          onSelectRow?.(rowIndex);
        }}
        onChange={(e) => commitChange(e.target.value)}
      >
        <option value="">Select task...</option>
        {selectValue && !rowOptions.includes(selectValue) ? (
          <option value={selectValue}>{selectValue}</option>
        ) : null}
        {rowOptions.map((name) => (
          <option key={name} value={name}>
            {name}
          </option>
        ))}
      </select>
    );
  }

  if (field.key === 'task_name') {
    const handleSelect = (event) => {
      event.stopPropagation();
      onSelectRow?.(rowIndex);
    };

    if (taskNameDoubleClickToEdit && !readOnly) {
      if (!editingTaskName) {
        return (
          <button
            type="button"
            className={`task-name-row-trigger ${inputClassName}`.trim()}
            title={cellTooltip || 'Click to highlight row · Double-click to edit'}
            onClick={handleSelect}
            onDoubleClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onSelectRow?.(rowIndex);
              setEditingTaskName(true);
              queueMicrotask(() => taskNameInputRef.current?.focus?.());
            }}
          >
            {value || '—'}
          </button>
        );
      }

      return (
        <TaskTextInput
          type={field.type || 'text'}
          value={value ?? ''}
          readOnly={false}
          onChange={(next) => {
            commitChange(next);
          }}
          className={inputClassName}
          size={inputSize}
          title={cellTooltip || undefined}
          instantCommit={instantCommit}
          autoFocus
          inputRef={taskNameInputRef}
          onClick={handleSelect}
          onDoubleClick={handleSelect}
          onBlur={() => {
            setEditingTaskName(false);
          }}
        />
      );
    }

    return (
      <TaskTextInput
        type={field.type || 'text'}
        value={value ?? ''}
        readOnly={readOnly}
        onChange={commitChange}
        className={inputClassName}
        size={inputSize}
        title={cellTooltip || undefined}
        instantCommit={instantCommit}
        onClick={handleSelect}
        onDoubleClick={handleSelect}
      />
    );
  }

  if (field.type === 'employee') {
    if (field.readOnly) {
      const displayValue = resolveAssigneeDisplayName(value, groupedEmployees.flatMap(({ members }) => members));
      return (
        <span
          className="task-algorithm-display"
          title={displayValue || 'No algorithm assignment'}
        >
          {displayValue || '—'}
        </span>
      );
    }

    if (isFieldLocked) {
      return (
        <EmployeeSelect
          value={value}
          onChange={() => {}}
          groupedEmployees={groupedEmployees}
          disabled
          className={lockedClass}
        />
      );
    }

    return (
      <EmployeeSelect
        value={value}
        onChange={commitChange}
        groupedEmployees={groupedEmployees}
      />
    );
  }

  if (field.type === 'dl_allocation') {
    return (
      <TaskDlAllocationEditor
        task={task}
        groupedEmployees={groupedEmployees}
        readOnly={readOnly}
        title={cellTooltip || field.title || ''}
        onChangePatch={(patch) => onCellChange(rowIndex, patch)}
      />
    );
  }

  if (field.type === 'date') {
    if (field.readOnly || isFieldLocked) {
      const fullDate = formatDisplayDate(value);
      const compactDate = formatCompactDisplayDate(value);
      return (
        <span
          className={`task-readonly-date ${lockedClass} ${invalidClass}`.trim()}
          title={cellTooltip || fullDate || field.title}
        >
          {compactDate || '—'}
        </span>
      );
    }

    return (
      <DisplayDateInput
        value={value ?? ''}
        onChange={commitChange}
        className={`task-date-input ${lockedClass}`.trim()}
        placeholder=""
        title={cellTooltip || undefined}
        min={field.key === 'completion' ? toYmd(task?.doc_supply) || undefined : undefined}
        invalid={isInvalid}
        compact
      />
    );
  }

  if (field.key === 'progress_left_hours') {
    const progressPer = parseFloat(task?.progress_per ?? '');
    const showLeft = !Number.isNaN(progressPer) && progressPer > 0;
    if (!showLeft) {
      return (
        <span className="task-readonly-value" title={cellTooltip || undefined}>
          —
        </span>
      );
    }
  }

  if (field.key === 'ats') {
    const display = value !== null && value !== undefined && String(value).trim() !== ''
      ? String(parseInt(String(value), 10))
      : '';
    return (
      <span
        className="task-algorithm-display task-num-display"
        title={cellTooltip || 'Set by Run algorithm'}
      >
        {display && !Number.isNaN(Number(display)) ? display : '—'}
      </span>
    );
  }

  if (field.key === 'ots') {
    return (
      <TaskTextInput
        type="text"
        inputMode="numeric"
        value={value ?? ''}
        readOnly={readOnly}
        onChange={(next) => {
          if (next === '') {
            commitChange('');
            return;
          }
          const parsed = Math.min(3, Math.max(0, parseInt(next, 10)));
          commitChange(Number.isNaN(parsed) ? '' : String(parsed));
        }}
        className={inputClassName}
        size={inputSize}
        title={cellTooltip || undefined}
        instantCommit={instantCommit}
      />
    );
  }

  if (field.key === 'sh') {
    return (
      <TaskPercentInput
        value={value ?? ''}
        readOnly={readOnly}
        onChange={(next) => {
          if (next === '') {
            commitChange('');
            return;
          }
          const parsed = parseInt(next, 10);
          commitChange(Number.isNaN(parsed) ? '' : String(Math.min(100, Math.max(0, parsed))));
        }}
        className={inputClassName}
        title={cellTooltip || undefined}
        instantCommit={instantCommit}
      />
    );
  }

  if (field.key === 'tt_hours_logged') {
    const hours = Number(value);
    const plan = Number(task?.plan ?? task?.progress_plan);
    const display = Number.isFinite(hours) && hours > 0 ? hours.toFixed(1) : '—';
    const overPlan = Number.isFinite(hours) && hours > 0
      && Number.isFinite(plan) && plan > 0
      && hours > plan;
    return (
      <span
        className={`task-readonly-value task-num-display${overPlan ? ' task-tt-hours-over-plan' : ''}`}
        title={cellTooltip || field.title}
      >
        {display}
      </span>
    );
  }

  if (field.key === 'progress_per' || field.key === 'dl_progress_per') {
    if (readOnly) {
      const raw = normalizePercentDraft(value);
      return (
        <span
          className="task-readonly-value task-percent-readonly"
          title={cellTooltip || undefined}
        >
          {raw !== '' ? `${raw}%` : '—'}
        </span>
      );
    }

    return (
      <TaskPercentInput
        value={value ?? ''}
        readOnly={readOnly}
        onChange={commitChange}
        className={inputClassName}
        title={cellTooltip || undefined}
        instantCommit={instantCommit}
      />
    );
  }

  if (colSize === 'priority') {
    return (
      <PriorityNumericField
        value={value ?? ''}
        onChange={commitChange}
        readOnly={readOnly}
        computed={field.key === 'pri'}
        title={cellTooltip || getFieldTooltip(field)}
        ariaLabel={field.label}
        instantCommit={instantCommit}
      />
    );
  }

  return (
    <TaskTextInput
      type={field.type || 'text'}
      value={value ?? ''}
      readOnly={readOnly}
      onChange={commitChange}
      className={inputClassName}
      size={inputSize}
      title={cellTooltip || undefined}
      instantCommit={instantCommit}
    />
  );
});

const TaskRow = memo(function TaskRow({
  task,
  tasks,
  rowIndex,
  groupedEmployees,
  onCellChange,
  selected,
  onToggleSelected,
  onSelectRow = null,
  visibleFields,
  minimizedBySection,
  instantCommit = false,
  sections = taskSections,
  inactiveRowPredicate = null,
  inactiveRowTitle = INACTIVE_ROW_TOOLTIP,
  lockedFieldPredicate = null,
  applyDlPlanReduction = false,
  preferDlOwner = false,
  suppressAlgorithmDuplicateOverrides = false,
  taskNameOptions = [],
  invalidFields = {},
  getRowClassName = null,
  taskNameDoubleClickToEdit = false,
}) {
  const isInactiveRow = inactiveRowPredicate ? !inactiveRowPredicate(task) : false;
  const rowClassName = [
    selected ? 'project-task-row-selected' : '',
    isInactiveRow ? 'project-task-row-no-plan' : '',
    getRowClassName ? getRowClassName(task) : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <tr className={rowClassName || undefined} title={isInactiveRow ? inactiveRowTitle : undefined}>
      <td className="sticky-col actions-col select-col">
        <input
          type="checkbox"
          checked={selected}
          onChange={() => onToggleSelected(rowIndex)}
          aria-label={`Select task row ${rowIndex + 1}`}
        />
      </td>
      {visibleFields.map((field) => {
        const sectionKey = getFieldSectionKey(field.key, sections);
        const sectionMinimized = minimizedBySection[sectionKey];
        const isFieldLocked = lockedFieldPredicate
          ? lockedFieldPredicate(task, field.key)
          : false;
        const cellTooltip = getFieldCellTooltip(field, task, { isFieldLocked, applyDlPlanReduction });
        const cellClassName = [
          `col-${getFieldColSize(field)}`,
          `col-field-${field.key}`,
          getFieldSourceClassName(field),
          getFrozenFieldClassName(field),
          getSectionBoundaryClass(field.key, visibleFields, sections),
          sectionMinimized ? `section-${sectionKey}-minimized` : '',
          isFieldLocked ? 'dl-field-locked-cell' : '',
        ]
          .filter(Boolean)
          .join(' ');

        return (
          <td key={field.key} className={cellClassName} title={cellTooltip || undefined}>
            <TaskCell
              field={field}
              fieldKey={field.key}
              task={task}
              tasks={tasks}
              value={getTaskFieldValue(task, field.key, { preferDlOwner, suppressAlgorithmDuplicateOverrides })}
              rowIndex={rowIndex}
              groupedEmployees={groupedEmployees}
              onCellChange={onCellChange}
              instantCommit={field.key === 'pp' ? false : instantCommit}
              isFieldLocked={isFieldLocked}
              applyDlPlanReduction={applyDlPlanReduction}
              taskNameOptions={taskNameOptions}
              isInvalid={Boolean(invalidFields?.[field.key])}
              onSelectRow={onSelectRow}
              taskNameDoubleClickToEdit={taskNameDoubleClickToEdit}
            />
          </td>
        );
      })}
    </tr>
  );
});

export default function ProjectTaskGrid({
  tasks,
  employees = [],
  onChange,
  selectedRows,
  onSelectedRowsChange,
  sections = taskSections,
  pageClassName = '',
  inactiveRowPredicate = null,
  inactiveRowTitle = INACTIVE_ROW_TOOLTIP,
  lockedFieldPredicate = null,
  applyDlPlanReduction = false,
  preferDlOwner = false,
  suppressAlgorithmDuplicateOverrides = false,
  suppressBulkHint = false,
  taskNameOptions = [],
  instantCommit = false,
  invalidFields = {},
  onToggleAllDone = null,
  allDoneChecked = false,
  someDoneChecked = false,
  scrollClassName = 'pde-table-shell project-task-scroll',
  tableClassName = 'project-task-table',
  getRowClassName = null,
  sectionsStartMinimized = false,
  defaultMinimizedSectionKeys = null,
  taskNameDoubleClickToEdit = false,
}) {
  const groupedEmployees = useMemo(() => buildGroupedEmployees(employees), [employees]);
  const minimizeSchemaKey = useMemo(
    () => sections
      .map((section) => `${section.key}:${(section.minimizedFieldKeys || []).join(',')}`)
      .join('|'),
    [sections],
  );
  const defaultMinimizedKey = useMemo(
    () => (Array.isArray(defaultMinimizedSectionKeys)
      ? defaultMinimizedSectionKeys.join('|')
      : ''),
    [defaultMinimizedSectionKeys],
  );
  const [minimizedSections, setMinimizedSections] = useState(() =>
    createInitialMinimizedSections(sections, {
      startMinimized: sectionsStartMinimized,
      defaultMinimizedKeys: defaultMinimizedSectionKeys,
    }),
  );
  const selectAllRef = useRef(null);
  const doneAllRef = useRef(null);
  const scrollRef = useRef(null);

  useScrollContainerWheel(scrollRef);

  useEffect(() => {
    setMinimizedSections(
      createInitialMinimizedSections(sections, {
        startMinimized: sectionsStartMinimized,
        defaultMinimizedKeys: defaultMinimizedSectionKeys,
      }),
    );
    // Only reset when section schema or serialized default keys change — not when the
    // defaultMinimizedSectionKeys array reference changes on every parent re-render.
  }, [minimizeSchemaKey, sectionsStartMinimized, defaultMinimizedKey]);

  const visibleFields = useMemo(
    () => getVisibleTaskFields(sections, minimizedSections),
    [minimizedSections, sections],
  );
  const gridColSpan = visibleFields.length + 1;
  const selectedRowSet = useMemo(() => new Set(selectedRows), [selectedRows]);

  useEffect(() => {
    onSelectedRowsChange((current) => {
      const next = current.filter((index) => index < tasks.length);
      return next.length === current.length ? current : next;
    });
  }, [tasks.length, onSelectedRowsChange]);

  const allSelected = tasks.length > 0 && selectedRows.length === tasks.length;
  const someSelected = selectedRows.length > 0 && !allSelected;

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected;
    }
  }, [someSelected, allSelected]);

  useEffect(() => {
    if (doneAllRef.current) {
      doneAllRef.current.indeterminate = someDoneChecked && !allDoneChecked;
    }
  }, [allDoneChecked, someDoneChecked]);

  const handleCellChange = useCallback(
    (rowIndex, key, value) => {
      const rowIndices = selectedRows.length === 0
        ? undefined
        : [...new Set([rowIndex, ...selectedRows])];
      // Allocation edits arrive as one patch ({ override_1, override_share_1, ... }).
      // Apply each field so PDE and the histogram editor persist every value.
      if (key && typeof key === 'object') {
        Object.entries(key).forEach(([field, fieldValue]) => {
          onChange(rowIndex, field, fieldValue, rowIndices);
        });
        return;
      }

      onChange(rowIndex, key, value, rowIndices);
    },
    [onChange, selectedRows],
  );

  const toggleRowSelection = useCallback((rowIndex) => {
    onSelectedRowsChange((current) => {
      if (current.includes(rowIndex)) {
        return current.filter((index) => index !== rowIndex);
      }
      return [...current, rowIndex].sort((a, b) => a - b);
    });
  }, [onSelectedRowsChange]);

  const selectRowExclusive = useCallback((rowIndex) => {
    onSelectedRowsChange([rowIndex]);
  }, [onSelectedRowsChange]);

  const toggleSelectAll = useCallback(() => {
    onSelectedRowsChange((current) => {
      if (tasks.length === 0) {
        return current;
      }
      if (current.length === tasks.length) {
        return [];
      }
      return tasks.map((_, index) => index);
    });
  }, [onSelectedRowsChange, tasks]);

  const toggleSectionMinimize = useCallback((sectionKey) => {
    setMinimizedSections((current) => ({
      ...current,
      [sectionKey]: !current[sectionKey],
    }));
  }, []);

  const instantBulkEdit = selectedRows.length > 0;
  const useInstantCommit = instantCommit || instantBulkEdit;

  return (
    <div className={`project-task-panel${pageClassName ? ` ${pageClassName}` : ''}`}>
      {!suppressBulkHint && selectedRows.length > 0 && (
        <div className="project-task-bulk-hint" role="status">
          {selectedRows.length} task{selectedRows.length === 1 ? '' : 's'} selected — edits apply instantly to all selected rows.
        </div>
      )}
      <div ref={scrollRef} className={scrollClassName}>
        <table className={tableClassName}>
          <colgroup>
            <col className="select-col" />
            {visibleFields.map((field) => (
              <col
                key={field.key}
                className={`col-${getFieldColSize(field)} col-field-${field.key}`}
              />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th
                className="sticky-col actions-col select-col section-header select-col-header"
                scope="col"
                title="Select all"
                aria-label="Select all"
              >
                <span className="select-col-header-label" aria-hidden="true" />
              </th>
              {sections.map((section) => {
                const isMinimized = minimizedSections[section.key];
                const visibleSectionFields = getSectionVisibleFields(section, isMinimized);

                return (
                  <th
                    key={section.key}
                    colSpan={visibleSectionFields.length}
                    className={`section-header ${isMinimized ? 'section-header-minimized' : ''}${section.key !== 'task' ? ' section-boundary-start' : ''}${section.key === 'task' && visibleSectionFields.length > 0 ? ' section-header-frozen sticky-col sticky-col-task-frozen sticky-col-task-header' : ''}`}
                    onClick={() => toggleSectionMinimize(section.key)}
                    title={isMinimized ? 'Click to expand section' : 'Click to minimize section'}
                  >
                    {isMinimized && section.minimizedTitle ? section.minimizedTitle : section.title}
                  </th>
                );
              })}
            </tr>
            <tr>
              <th
                className="sticky-col actions-col select-col project-task-field-header select-col-checkbox-header"
                scope="col"
              >
                <label className="project-task-select-all" title="Select all task rows">
                  <input
                    ref={selectAllRef}
                    type="checkbox"
                    checked={allSelected}
                    onChange={toggleSelectAll}
                    disabled={tasks.length === 0}
                    aria-label="Select all tasks"
                  />
                </label>
              </th>
              {visibleFields.map((field) => {
                const tooltip = getFieldTooltip(field);
                return (
                <th
                  key={field.key}
                  className={`col-${getFieldColSize(field)} col-field-${field.key} project-task-field-header ${getFieldSourceClassName(field)} ${getFrozenFieldClassName(field)}${getSectionBoundaryClass(field.key, visibleFields, sections)}`}
                  title={tooltip || undefined}
                >
                  {field.key === 'done' && onToggleAllDone ? (
                    <label className="project-task-done-all" title="Mark all tasks as done">
                      <input
                        ref={doneAllRef}
                        type="checkbox"
                        checked={allDoneChecked}
                        disabled={
                          tasks.length === 0
                          || tasks.every((task) => lockedFieldPredicate?.(task, 'done'))
                        }
                        onChange={(event) => onToggleAllDone(event.target.checked)}
                        aria-label="Mark all tasks as done"
                      />
                      <span className="project-task-field-header-label">{field.label}</span>
                    </label>
                  ) : field.type === 'dl_allocation' ? (
                  <span className="project-task-field-header-label alloc-head-label">
                    {field.label}
                    <span className="alloc-head-hint" aria-hidden="true">
                      <span><i className="alloc-head-sw is-algo" />Algorithm</span>
                      <span><i className="alloc-head-sw is-manual" />Manual</span>
                    </span>
                  </span>
                  ) : (
                  <span className="project-task-field-header-label">
                    {field.label}
                  </span>
                  )}
                </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {tasks.length === 0 && (
              <tr>
                <td colSpan={gridColSpan}>
                  No tasks yet. Click &quot;Add task row&quot; to start.
                </td>
              </tr>
            )}
            {tasks.map((task, rowIndex) => (
              <TaskRow
                key={task.id ?? `new-${rowIndex}`}
                task={task}
                tasks={tasks}
                rowIndex={rowIndex}
                groupedEmployees={groupedEmployees}
                onCellChange={handleCellChange}
                selected={selectedRowSet.has(rowIndex)}
                onToggleSelected={toggleRowSelection}
                onSelectRow={selectRowExclusive}
                visibleFields={visibleFields}
                minimizedBySection={minimizedSections}
                instantCommit={useInstantCommit}
                sections={sections}
                inactiveRowPredicate={inactiveRowPredicate}
                inactiveRowTitle={inactiveRowTitle}
                lockedFieldPredicate={lockedFieldPredicate}
                applyDlPlanReduction={applyDlPlanReduction}
                preferDlOwner={preferDlOwner}
                suppressAlgorithmDuplicateOverrides={suppressAlgorithmDuplicateOverrides}
                taskNameOptions={taskNameOptions}
                invalidFields={invalidFields[rowIndex]}
                getRowClassName={getRowClassName}
                taskNameDoubleClickToEdit={taskNameDoubleClickToEdit}
              />
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
