import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import api from '../../api/client';
import Modal from '../../components/Modal';
import { TablePageSkeleton } from '../../components/PageSkeleton';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { canPageAction } from '../../utils/userPermissions';

/** Fallback if API does not return case_types yet. */
const DEFAULT_CASE_TYPES = [
  {
    value: 'progress_threshold',
    label: 'Task progress ≥',
    unit: '%',
    default: 80,
    scope: 'task_sync',
    description: 'Task progress reaches or exceeds the threshold.',
    help: 'Fires once when a saved task newly crosses this progress %. Used for ops (~80%) and management (~95%) reviews. Does not re-send until progress drops below the threshold and crosses again.',
    example: 'Example: 80 → notify when progress hits 80% or more.',
  },
  {
    value: 'over_plan_pct',
    label: 'Over plan by ≥',
    unit: '%',
    default: 10,
    scope: 'task_sync',
    description: 'Actual hours exceed plan by at least this percentage.',
    help: 'Compares Act vs Plan on the task. Fires when (Act − Plan) / Plan × 100 reaches the threshold. Plan must be greater than zero.',
    example: 'Example: 10 → notify when Act is at least 10% above Plan.',
  },
  {
    value: 'completion_approaching_days',
    label: 'Completion within',
    unit: 'days',
    default: 3,
    scope: 'task_sync',
    description: 'Incomplete task with completion date within the next N days.',
    help: 'Matches incomplete tasks whose Completion date is still in the future but within N days. Same signal as the dashed red ring on the resource histogram.',
    example: 'Example: 3 → notify when completion is 1–3 days away.',
  },
  {
    value: 'completion_overdue_days',
    label: 'Completion overdue ≥',
    unit: 'days',
    default: 0,
    scope: 'task_sync',
    description: 'Incomplete task past its completion date by at least N days.',
    help: 'Matches incomplete tasks whose Completion date is today or earlier. Same signal as the solid red ring on the histogram.',
    example: 'Example: 0 → notify as soon as completion is due or overdue.',
  },
  {
    value: 'task_done',
    label: 'Task marked done',
    unit: '',
    default: 1,
    scope: 'task_sync',
    hide_value: true,
    description: 'Task is marked done / completed.',
    help: 'Fires when a task is newly marked Done or reaches 100% progress on save.',
    example: 'No threshold — triggers on the done / 100% transition.',
  },
  {
    value: 'dl_override_filled',
    label: 'DL / project override set',
    unit: '',
    default: 1,
    scope: 'task_sync',
    hide_value: true,
    description: 'A project override field (Override 1–3) is filled on the task.',
    help: 'Fires when Override 1, 2, or 3 newly has a value from a DL or planner edit.',
    example: 'No threshold — triggers when any override field becomes non-empty.',
  },
  {
    value: 'dl_hours_threshold',
    label: 'DL hours ≥',
    unit: 'h',
    default: 8,
    scope: 'task_sync',
    description: 'DL hours on the task reach or exceed the threshold.',
    help: 'Uses the DL hours field. Fires once when the value newly crosses the threshold on save.',
    example: 'Example: 8 → notify when DL hours are at least 8.',
  },
  {
    value: 'dl_rfi_on',
    label: 'RFI flagged on',
    unit: '',
    default: 1,
    scope: 'task_sync',
    hide_value: true,
    description: 'RFI is turned on for the task.',
    help: 'Fires when RFI newly becomes Yes/on during a DL or PDE save.',
    example: 'No threshold — triggers on the RFI off → on transition.',
  },
  {
    value: 'dl_owner_claimed',
    label: 'DL claimed task owner',
    unit: '',
    default: 1,
    scope: 'task_sync',
    hide_value: true,
    description: 'A DL has locked / claimed ownership on the task.',
    help: 'Fires when dl_owner is newly set.',
    example: 'No threshold — triggers when DL ownership is first claimed.',
  },
  {
    value: 'capacity_gap_hours',
    label: 'Free capacity ≥',
    unit: 'h',
    default: 8,
    scope: 'scheduled',
    description: 'NRM operative has at least this many free hours in the training gap window.',
    help: 'Planner training-gap alert when an NRM operative has enough free hours for training. Email evaluation is scheduled (not on every task save).',
    example: 'Example: 8 → notify when free capacity is at least 8 hours.',
  },
  {
    value: 'incomplete_training_days',
    label: 'Training incomplete ≥',
    unit: 'days',
    default: 0,
    scope: 'scheduled',
    description: 'Training started and still not completed.',
    help: 'Planner counterpart to the operative incomplete-training login reminder. Email evaluation is scheduled.',
    example: 'Example: 0 → notify from the training start day while still incomplete.',
  },
  {
    value: 'dl_update_overdue',
    label: 'DL weekly update overdue',
    unit: '',
    default: 1,
    scope: 'scheduled',
    hide_value: true,
    description: 'A DL has not submitted their weekly quick update and is overdue.',
    help: 'Alerts planners when a DL’s weekly Quick Update is overdue. Evaluation is scheduled.',
    example: 'No threshold — triggers when DL status is overdue.',
  },
  {
    value: 'new_project_docs_ready',
    label: 'New project',
    unit: '',
    default: 1,
    scope: 'scheduled',
    hide_value: true,
    description: 'Active project has docs ready and a booked incomplete task whose Doc Supply / start date has passed.',
    help: 'Matches projects that are not completed/on hold, Have all docs is on, and an incomplete task has Doc Supply dated today or earlier. Notifies people booked on the task (algorithm / override slots), not OAP owners. Evaluation is scheduled.',
    example: 'No threshold — triggers while docs are ready and start has passed with booked open tasks.',
  },
  {
    value: 'dl_edited_after_submit',
    label: 'DL edited after weekly submit',
    unit: '',
    default: 1,
    scope: 'scheduled',
    hide_value: true,
    description: 'A DL changed task data after submitting the weekly Quick Update.',
    help: 'Matches the “Edited after submit” Quick Update status. Evaluation is scheduled.',
    example: 'No threshold — triggers when status becomes stale after submit.',
  },
  {
    value: 'histogram_schedule_override',
    label: 'Histogram schedule edit / override',
    unit: '',
    default: 1,
    scope: 'scheduled',
    hide_value: true,
    description: 'A planner saved a resource-histogram bar edit that overrides schedule.',
    help: 'Covers durable histogram schedule overrides. Evaluation is scheduled / on histogram save.',
    example: 'No threshold — triggers when a schedule override is saved.',
  },
  {
    value: 'training_project_override',
    label: 'Training overrides project work',
    unit: '',
    default: 1,
    scope: 'scheduled',
    hide_value: true,
    description: 'Training was confirmed over existing planned project tasks.',
    help: 'Fires when confirm_override schedules training on top of project work. Evaluation is scheduled / on training save.',
    example: 'No threshold — triggers when a training override is confirmed.',
  },
  {
    value: 'trainee_over_capacity_hours',
    label: 'Trainee over capacity ≥',
    unit: 'h',
    default: 1,
    scope: 'scheduled',
    description: 'Trainee/junior booked hours exceed weekly capacity.',
    help: 'Alerts when a trainee or junior is booked above weekly capacity. Evaluation is scheduled.',
    example: 'Example: 1 → notify when over capacity by 1 hour or more.',
  },
  {
    value: 'training_completed',
    label: 'Training completed',
    unit: '',
    default: 1,
    scope: 'training',
    hide_value: true,
    description: 'A trainee marks a course completed.',
    help: 'Fires when a training status changes to completed. Uses this rule’s recipients and in-app / email switches.',
    example: 'No threshold — triggers on the completed status.',
  },
  {
    value: 'training_rescheduled',
    label: 'Training rescheduled',
    unit: '',
    default: 1,
    scope: 'training',
    hide_value: true,
    description: 'A training start or end date moves to a new slot.',
    help: 'Fires when the start or end date changes. Uses this rule’s recipients and in-app / email switches.',
    example: 'No threshold — triggers when the dates change.',
  },
  {
    value: 'training_overdue',
    label: 'Training overdue, repeat every',
    unit: 'days',
    default: 2,
    scope: 'training',
    description: 'The assigned end date has passed, the course is not complete, and it has not been rescheduled.',
    help: 'Checked when a training is saved. Repeats until the course is completed or the dates are moved.',
    example: 'Example: 2 → notify again only after 2 days.',
  },
  {
    value: 'training_starting_soon',
    label: 'Training starts within',
    unit: 'days',
    default: 2,
    scope: 'training',
    description: 'A course starts in the next 1–2 days.',
    help: 'Checked when a training is saved, once per course, when the start date is 1 or 2 days away.',
    example: 'Example: 2 → remind when the start date is tomorrow or the day after.',
  },
];

function caseMeta(caseTypes, caseType) {
  return caseTypes.find((entry) => entry.value === caseType) || caseTypes[0] || DEFAULT_CASE_TYPES[0];
}

function caseHelpText(meta) {
  if (!meta) {
    return '';
  }
  return [meta.help || meta.description, meta.example, meta.scope === 'scheduled'
    ? 'Scheduled case: configure recipients now; email is not evaluated on every task save yet.'
    : meta.scope === 'training'
      ? 'Evaluated when a training assignment is saved. In-app shows the usual notification toast. Email sends only when global email and this rule’s email switch are on.'
      : 'Evaluated when project tasks are saved (edge-triggered, once per crossing).']
    .filter(Boolean)
    .join(' ');
}

function emptyRule(caseTypes = DEFAULT_CASE_TYPES) {
  const first = caseTypes[0] || DEFAULT_CASE_TYPES[0];
  return {
    code: '',
    label: '',
    description: '',
    case_type: first.value,
    case_value: first.default ?? 80,
    enabled: true,
    in_app_enabled: true,
    email_enabled: false,
    recipient_role_ids: [],
    recipient_user_ids: [],
    sort_order: 0,
  };
}

function roleNames(roles, ids) {
  return (ids || [])
    .map((id) => roles.find((entry) => Number(entry.id) === Number(id)))
    .filter(Boolean)
    .map((entry) => entry.name);
}

function ruleMatchesRoleFilter(rule, roleFilterId) {
  if (!roleFilterId) {
    return true;
  }
  const recipientRoles = (rule.recipient_role_ids || []).map(Number).filter(Boolean);
  return recipientRoles.includes(Number(roleFilterId));
}

function slugifyCode(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 48);
}

function deriveRuleCode(rule, index) {
  const existing = String(rule.code || '').trim();
  if (rule.id && existing) {
    return existing;
  }
  const fromLabel = slugifyCode(rule.label);
  if (fromLabel) {
    return fromLabel;
  }
  return `rule_${index + 1}`;
}

function userLabel(user) {
  const name = String(user?.name || '').trim();
  const login = String(user?.login_name || '').trim();
  if (name && login) {
    return `${name} (${login})`;
  }
  return name || login || `User #${user?.id}`;
}

function normalizeEmail(value) {
  return String(value ?? '').replace(/\s+/g, '');
}

function formatCaseSummary(rule, meta) {
  if (!meta) {
    return rule.case_type || 'Case';
  }
  if (meta.hide_value) {
    return meta.label;
  }
  const unit = meta.unit ? ` ${meta.unit}` : '';
  return `${meta.label} ${rule.case_value ?? meta.default ?? ''}${unit}`.trim();
}

function HelpTip({ text, label = 'More info' }) {
  const tipId = useId();
  const anchorRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState(null);

  const updatePosition = () => {
    const node = anchorRef.current;
    if (!node) {
      return;
    }
    const rect = node.getBoundingClientRect();
    const bubbleWidth = Math.min(280, window.innerWidth - 24);
    const estimatedHeight = 140;
    const gap = 8;
    const placeAbove = rect.top > estimatedHeight + gap + 12;
    let left = rect.left + rect.width / 2 - bubbleWidth / 2;
    left = Math.max(12, Math.min(left, window.innerWidth - bubbleWidth - 12));
    const top = placeAbove ? rect.top - gap : rect.bottom + gap;
    setCoords({ top, left, placeAbove, width: bubbleWidth });
  };

  useLayoutEffect(() => {
    if (!open) {
      setCoords(null);
      return undefined;
    }
    updatePosition();
    const handle = () => updatePosition();
    window.addEventListener('scroll', handle, true);
    window.addEventListener('resize', handle);
    return () => {
      window.removeEventListener('scroll', handle, true);
      window.removeEventListener('resize', handle);
    };
  }, [open, text]);

  if (!text) {
    return null;
  }

  return (
    <span
      className="email-help-tip"
      ref={anchorRef}
      tabIndex={0}
      aria-label={label}
      aria-describedby={open && coords ? tipId : undefined}
      onMouseEnter={() => setOpen(true)}
      onMouseLeave={() => setOpen(false)}
      onFocus={() => setOpen(true)}
      onBlur={() => setOpen(false)}
    >
      <span className="email-help-tip-icon" aria-hidden="true">?</span>
      {open && coords
        ? createPortal(
          <div
            id={tipId}
            className={`email-help-tip-bubble is-portal${coords.placeAbove ? ' is-above' : ' is-below'}`}
            role="tooltip"
            style={{
              top: `${coords.top}px`,
              left: `${coords.left}px`,
              width: `${coords.width}px`,
              transform: coords.placeAbove ? 'translateY(-100%)' : 'none',
            }}
          >
            {text}
          </div>,
          document.body,
        )
        : null}
    </span>
  );
}

function RoleCheckboxDropdown({
  roles,
  value,
  disabled,
  onChange,
  noneLabel = 'All roles',
  buttonLabel = 'Select roles',
}) {
  const rootRef = useRef(null);
  const [open, setOpen] = useState(false);
  const selectedIds = (value || []).map(Number).filter(Boolean);
  const selectedLabels = roleNames(roles, selectedIds);
  const summary = selectedLabels.length > 0 ? selectedLabels.join(', ') : noneLabel;

  useEffect(() => {
    if (!open) {
      return undefined;
    }
    const handlePointerDown = (event) => {
      if (rootRef.current && !rootRef.current.contains(event.target)) {
        setOpen(false);
      }
    };
    const handleKeyDown = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [open]);

  const toggleRole = (roleId) => {
    const id = Number(roleId);
    if (!id) {
      return;
    }
    if (selectedIds.includes(id)) {
      onChange(selectedIds.filter((entry) => entry !== id));
      return;
    }
    onChange([...selectedIds, id]);
  };

  if (!roles.length) {
    return <p className="email-recipient-empty muted">No roles available</p>;
  }

  return (
    <div
      className={`email-role-dropdown${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
      ref={rootRef}
    >
      <button
        type="button"
        className="email-role-dropdown-trigger email-notifications-select"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((current) => !current)}
      >
        <span className="email-role-dropdown-summary" title={summary}>
          {summary}
        </span>
        <span className="email-role-dropdown-chevron" aria-hidden="true" />
      </button>
      {open ? (
        <div className="email-role-dropdown-panel" role="listbox" aria-label={buttonLabel}>
          {roles.map((role) => {
            const checked = selectedIds.includes(Number(role.id));
            return (
              <label
                key={role.id}
                className={`email-role-dropdown-option${checked ? ' is-selected' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={checked}
                  disabled={disabled}
                  onChange={() => toggleRole(role.id)}
                />
                <span>{role.name}</span>
              </label>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function IdChipPicker({
  items,
  value,
  disabled,
  onChange,
  labelFor,
  emptyLabel,
  addLabel,
  allSelectedLabel,
  ariaLabel,
}) {
  const selectedIds = (value || []).map(Number).filter(Boolean);
  const selectedItems = selectedIds
    .map((id) => items.find((entry) => Number(entry.id) === id))
    .filter(Boolean);
  const availableItems = items.filter((entry) => !selectedIds.includes(Number(entry.id)));

  const addItem = (itemId) => {
    const id = Number(itemId);
    if (!id || selectedIds.includes(id)) {
      return;
    }
    onChange([...selectedIds, id]);
  };

  const removeItem = (itemId) => {
    onChange(selectedIds.filter((id) => id !== Number(itemId)));
  };

  return (
    <div className="email-recipient-picker">
      {selectedItems.length > 0 ? (
        <ul className="email-recipient-chips" aria-label={ariaLabel}>
          {selectedItems.map((entry) => (
            <li key={entry.id} className="email-recipient-chip">
              <span className="email-recipient-chip-label" title={entry.email || undefined}>
                {labelFor(entry)}
              </span>
              {!disabled ? (
                <button
                  type="button"
                  className="email-recipient-chip-remove"
                  onClick={() => removeItem(entry.id)}
                  aria-label={`Remove ${labelFor(entry)}`}
                >
                  ×
                </button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : (
        <p className="email-recipient-empty muted">{emptyLabel}</p>
      )}
      <select
        className="email-notifications-select email-recipient-select"
        disabled={disabled || availableItems.length === 0}
        value=""
        onChange={(event) => {
          addItem(event.target.value);
          event.target.value = '';
        }}
        aria-label={addLabel}
      >
        <option value="" disabled>
          {availableItems.length === 0 ? allSelectedLabel : addLabel}
        </option>
        {availableItems.map((entry) => (
          <option key={entry.id} value={String(entry.id)}>
            {labelFor(entry)}
            {entry.email ? ` — ${entry.email}` : ''}
          </option>
        ))}
      </select>
    </div>
  );
}

function RecipientPicker({ users, value, disabled, onChange }) {
  return (
    <IdChipPicker
      items={users}
      value={value}
      disabled={disabled}
      onChange={onChange}
      labelFor={userLabel}
      emptyLabel="Choose who should be notified"
      addLabel="+ Add person…"
      allSelectedLabel="All users selected"
      ariaLabel="Selected recipients"
    />
  );
}

function RuleActiveSwitch({ checked, disabled, onChange, id, label = 'Active' }) {
  return (
    <label
      className={`email-rule-active-switch${checked ? ' is-on' : ' is-off'}${disabled ? ' is-disabled' : ''}`}
      title={checked ? 'Rule is active — click to deactivate' : 'Rule is off — click to activate'}
    >
      <input
        id={id}
        type="checkbox"
        role="switch"
        checked={Boolean(checked)}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span className="email-rule-active-switch-track" aria-hidden="true">
        <span className="email-rule-active-switch-thumb" />
      </span>
      <span className="email-rule-active-switch-text">
        {checked ? 'Active' : 'Off'}
      </span>
    </label>
  );
}

function RuleSummaryCard({
  rule,
  index,
  canEdit,
  users,
  roles,
  caseTypes,
  onEdit,
  onRemove,
  onToggleEnabled,
}) {
  const meta = caseMeta(caseTypes, rule.case_type);
  const help = caseHelpText(meta);
  const recipientRoles = roleNames(roles, rule.recipient_role_ids);
  const recipients = (rule.recipient_user_ids || [])
    .map((id) => users.find((entry) => Number(entry.id) === Number(id)))
    .filter(Boolean)
    .map((entry) => userLabel(entry));
  const notifyParts = [
    recipientRoles.length > 0 ? `Roles: ${recipientRoles.join(', ')}` : null,
    recipients.length > 0 ? `People: ${recipients.join(', ')}` : null,
  ].filter(Boolean);

  return (
    <article className={`email-rule-card email-rule-summary${rule.enabled ? '' : ' is-disabled'}`}>
      <div className="email-rule-summary-top">
        <h4 className="email-rule-summary-title" title={rule.label || 'Untitled rule'}>
          {rule.label || 'Untitled rule'}
        </h4>
        <div className="email-rule-summary-actions">
          <RuleActiveSwitch
            checked={Boolean(rule.enabled)}
            disabled={!canEdit}
            onChange={(enabled) => onToggleEnabled?.(index, enabled)}
            label={`Activate ${rule.label || 'rule'}`}
          />
          {canEdit ? (
            <>
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={() => onEdit(index)}
                title="Edit this notification rule"
              >
                Edit
              </button>
              <button
                type="button"
                className="btn btn-danger btn-sm email-rule-remove-btn"
                onClick={() => onRemove(index)}
                title="Delete this notification rule"
              >
                Remove
              </button>
            </>
          ) : null}
        </div>
      </div>

      <p className="email-rule-summary-case">
        <span>{formatCaseSummary(rule, meta)}</span>
        <HelpTip text={help} label={`Explain ${meta.label}`} />
      </p>

      <dl className="email-rule-summary-meta">
        <div>
          <dt>
            Sent to
            <HelpTip text="Who receives the toast/email when the case condition is met on saved task data." />
          </dt>
          <dd title={notifyParts.join(' · ') || 'No recipients yet'}>
            {notifyParts.length > 0 ? notifyParts.join(' · ') : 'No recipients yet'}
          </dd>
        </div>
        <div>
          <dt>
            Delivery
            <HelpTip text="Use the Active switch to turn the rule on or off. In-app toast shows to the person who saves. Email also needs global email delivery enabled above." />
          </dt>
          <dd>
            {[
              rule.in_app_enabled ? 'In-app' : null,
              rule.email_enabled ? 'Email' : null,
            ].filter(Boolean).join(' · ') || 'No channels'}
          </dd>
        </div>
      </dl>
    </article>
  );
}

function RuleEditorForm({
  draft,
  caseTypes,
  users,
  roles,
  emailEnabled,
  canEdit,
  onChange,
  onAddWhenType,
  onEditWhenType,
  onDeleteWhenType,
}) {
  const meta = caseMeta(caseTypes, draft.case_type);
  const hideValue = Boolean(meta.hide_value);
  const unit = meta.unit || '';
  const help = caseHelpText(meta);

  return (
    <div className="email-rule-editor">
      <label className="email-rule-editor-field">
        <span className="email-rule-field-label">
          Rule name
          <HelpTip text="Short label shown on the rule card and in email subjects / toasts." />
        </span>
        <input
          className="email-notifications-input"
          value={draft.label}
          disabled={!canEdit}
          placeholder="e.g. Progress — Operations"
          onChange={(event) => onChange({ label: event.target.value })}
        />
      </label>

      <div className="email-rule-editor-field">
        <span className="email-rule-field-label">
          Case
          <HelpTip text="The data condition that triggers this rule (e.g. over plan). It fires from saved task values, not from who clicked Save." />
        </span>
        <div className="email-rule-when-row">
          <div className={`email-rule-condition-controls${hideValue ? ' is-single' : ''}`}>
            <select
              className="email-notifications-select email-rule-case-select"
              value={draft.case_type}
              disabled={!canEdit}
              title={help}
              onChange={(event) => {
                const nextType = event.target.value;
                const nextMeta = caseMeta(caseTypes, nextType);
                onChange({
                  case_type: nextType,
                  case_value: nextMeta.default ?? draft.case_value,
                });
              }}
            >
              {caseTypes.map((option) => (
                <option
                  key={option.value}
                  value={option.value}
                  title={caseHelpText(option)}
                >
                  {option.custom ? `${option.label} (custom)` : option.label}
                </option>
              ))}
            </select>
            {!hideValue ? (
              <div className="email-rule-threshold" title={meta.example || help}>
                <input
                  className="email-notifications-input email-rule-threshold-input"
                  type="number"
                  min="0"
                  step="0.1"
                  value={draft.case_value}
                  disabled={!canEdit}
                  aria-label="Threshold value"
                  onChange={(event) => onChange({ case_value: event.target.value })}
                />
                {unit ? (
                  <span className="email-rule-threshold-suffix" aria-hidden="true">
                    {unit}
                  </span>
                ) : null}
              </div>
            ) : null}
          </div>
          {canEdit ? (
            <div className="email-rule-when-actions">
              <button
                type="button"
                className="btn btn-secondary btn-sm"
                onClick={onAddWhenType}
                title="Add a new case to the dropdown"
              >
                Add case
              </button>
              {meta.custom ? (
                <>
                  <button
                    type="button"
                    className="btn btn-secondary btn-sm"
                    onClick={() => onEditWhenType?.(meta)}
                    title="Edit this custom case"
                  >
                    Edit case
                  </button>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    onClick={() => onDeleteWhenType?.(meta)}
                    title="Remove this custom case from the dropdown"
                  >
                    Delete case
                  </button>
                </>
              ) : null}
            </div>
          ) : null}
        </div>
        <div className="email-case-help-panel" title={help}>
          <p>{meta.description}</p>
          {meta.example ? <p className="muted">{meta.example}</p> : null}
          {meta.custom ? (
            <p className="muted">
              Custom case — uses behavior “{meta.evaluator || meta.value}”.
            </p>
          ) : null}
          {meta.scope === 'scheduled' ? (
            <p className="muted">
              Scheduled case — set recipients now; email evaluation for this case is not on task save yet.
            </p>
          ) : (
            <p className="muted">Runs when project tasks are saved (once per new threshold crossing).</p>
          )}
        </div>
      </div>

      <div className="email-rule-editor-field">
        <span className="email-rule-field-label">
          Send to roles
          <HelpTip text="When the case matches the task data, notify every active user in these roles." />
        </span>
        <p className="email-rule-field-hint muted">
          Recipients only — the Case above is what triggers the rule.
        </p>
        <RoleCheckboxDropdown
          roles={roles}
          value={draft.recipient_role_ids}
          disabled={!canEdit}
          noneLabel="No roles selected"
          buttonLabel="Send to roles"
          onChange={(recipientRoleIds) => onChange({ recipient_role_ids: recipientRoleIds })}
        />
      </div>

      <div className="email-rule-editor-field">
        <span className="email-rule-field-label">
          Send to people
          <HelpTip text="Optional specific people to notify, in addition to any roles above. Email needs a valid address on their account." />
        </span>
        <RecipientPicker
          users={users}
          value={draft.recipient_user_ids}
          disabled={!canEdit}
          onChange={(recipientUserIds) => onChange({ recipient_user_ids: recipientUserIds })}
        />
      </div>

      <div className="email-rule-editor-field">
        <span className="email-rule-field-label">
          Rule status
          <HelpTip text="Turn the rule on or off without deleting it. Off rules never run." />
        </span>
        <RuleActiveSwitch
          checked={Boolean(draft.enabled)}
          disabled={!canEdit}
          onChange={(enabled) => onChange({ enabled })}
          label="Rule active"
        />
      </div>

      <div className="email-rule-editor-field">
        <span className="email-rule-field-label">
          Delivery
          <HelpTip text="In-app toast names appear to the saver. Email also requires Enable email delivery above." />
        </span>
        <div className="email-rule-delivery-options">
          <label className="email-rule-delivery-option" title="Show a toast to the person who saves, listing intended recipient names.">
            <input
              type="checkbox"
              checked={Boolean(draft.in_app_enabled)}
              disabled={!canEdit}
              onChange={(event) => onChange({ in_app_enabled: event.target.checked })}
            />
            <span>In-app toast</span>
          </label>
          <label
            className="email-rule-delivery-option"
            title={emailEnabled
              ? 'Send email to the selected recipients when this rule triggers.'
              : 'Turn on email delivery in settings above first.'}
          >
            <input
              type="checkbox"
              checked={Boolean(draft.email_enabled)}
              disabled={!canEdit}
              onChange={(event) => onChange({ email_enabled: event.target.checked })}
            />
            <span>Email</span>
          </label>
        </div>
        {!emailEnabled ? (
          <p className="email-rule-delivery-hint muted">
            Email delivery is off — only in-app toasts for the person who saves will appear.
          </p>
        ) : null}
      </div>
    </div>
  );
}

function WhenTypeEditorForm({
  draft,
  builtInCaseTypes,
  isEdit,
  onChange,
}) {
  const selected = caseMeta(builtInCaseTypes, draft.evaluator);
  const hideValue = Boolean(selected.hide_value);

  return (
    <div className="email-rule-editor">
      <label className="email-rule-editor-field">
        <span className="email-rule-field-label">
          Dropdown label
          <HelpTip text="This text appears in the Case dropdown." />
        </span>
        <input
          className="email-notifications-input"
          value={draft.label}
          placeholder="e.g. Progress — Design lead"
          onChange={(event) => onChange({ label: event.target.value })}
        />
      </label>

      {!isEdit ? (
        <div className="email-rule-editor-field">
          <span className="email-rule-field-label">
            Behavior
            <HelpTip text="Pick which system check this case should use. Custom cases reuse a built-in evaluator." />
          </span>
          <select
            className="email-notifications-select"
            value={draft.evaluator}
            onChange={(event) => {
              const next = caseMeta(builtInCaseTypes, event.target.value);
              onChange({
                evaluator: event.target.value,
                default: next.default ?? draft.default,
                description: draft.description || next.description || '',
                help: draft.help || next.help || '',
              });
            }}
          >
            {builtInCaseTypes.map((option) => (
              <option key={option.value} value={option.value} title={caseHelpText(option)}>
                {option.label}
              </option>
            ))}
          </select>
          <div className="email-case-help-panel">
            <p>{selected.description}</p>
            {selected.help ? <p className="muted">{selected.help}</p> : null}
          </div>
        </div>
      ) : (
        <div className="email-case-help-panel">
          <p>Behavior is locked for custom cases: {selected.label}</p>
        </div>
      )}

      {!hideValue ? (
        <label className="email-rule-editor-field">
          <span className="email-rule-field-label">
            Default threshold
            <HelpTip text="Default value filled in when someone picks this case." />
          </span>
          <div className="email-rule-threshold">
            <input
              className="email-notifications-input email-rule-threshold-input"
              type="number"
              min="0"
              step="0.1"
              value={draft.default}
              onChange={(event) => onChange({ default: event.target.value })}
            />
            {selected.unit ? (
              <span className="email-rule-threshold-suffix">{selected.unit}</span>
            ) : null}
          </div>
        </label>
      ) : null}

      <label className="email-rule-editor-field">
        <span className="email-rule-field-label">Short description</span>
        <input
          className="email-notifications-input"
          value={draft.description}
          placeholder="Shown under the case"
          onChange={(event) => onChange({ description: event.target.value })}
        />
      </label>

      <label className="email-rule-editor-field">
        <span className="email-rule-field-label">Hover help</span>
        <textarea
          className="email-notifications-input email-when-help-textarea"
          rows={4}
          value={draft.help}
          placeholder="Longer explanation shown on hover"
          onChange={(event) => onChange({ help: event.target.value })}
        />
      </label>
    </div>
  );
}

export default function EmailNotifications() {
  const { user } = useAuth();
  const toast = useToast();
  const canEdit = canPageAction(user, 'Email Notifications', 'manage_rules');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [emailEnabled, setEmailEnabled] = useState(false);
  const [fromEmail, setFromEmail] = useState('');
  const [defaultFromEmail, setDefaultFromEmail] = useState('');
  const [testRecipientEmail, setTestRecipientEmail] = useState('');
  const [testing, setTesting] = useState(false);
  const [rules, setRules] = useState([]);
  const [originalRules, setOriginalRules] = useState([]);
  const [users, setUsers] = useState([]);
  const [roles, setRoles] = useState([]);
  const [roleFilter, setRoleFilter] = useState('');
  const [caseTypes, setCaseTypes] = useState(DEFAULT_CASE_TYPES);
  const [builtInCaseTypes, setBuiltInCaseTypes] = useState(DEFAULT_CASE_TYPES);
  const [editorOpen, setEditorOpen] = useState(false);
  const [editingIndex, setEditingIndex] = useState(null);
  const [draft, setDraft] = useState(() => emptyRule());
  const [whenEditorOpen, setWhenEditorOpen] = useState(false);
  const [whenEditorMode, setWhenEditorMode] = useState('create');
  const [whenSaving, setWhenSaving] = useState(false);
  const [whenDraft, setWhenDraft] = useState({
    value: '',
    label: '',
    evaluator: 'progress_threshold',
    default: 80,
    description: '',
    help: '',
  });

  const editorTitle = useMemo(
    () => (editingIndex == null ? 'Create notification rule' : 'Edit notification rule'),
    [editingIndex],
  );

  const filteredRules = useMemo(
    () => rules
      .map((rule, index) => ({ rule, index }))
      .filter(({ rule }) => ruleMatchesRoleFilter(rule, roleFilter)),
    [rules, roleFilter],
  );

  const whenEditorTitle = whenEditorMode === 'edit' ? 'Edit case' : 'Add case';

  const loadData = async () => {
    setLoading(true);
    try {
      const response = await api.get('/admin/email-notification-rules');
      const payload = response.data.data;
      setEmailEnabled(Boolean(payload.settings?.email_enabled));
      setFromEmail(normalizeEmail(payload.settings?.from_email || ''));
      setDefaultFromEmail(normalizeEmail(payload.settings?.default_from_email || ''));
      const nextCaseTypes = Array.isArray(payload.case_types) && payload.case_types.length > 0
        ? payload.case_types
        : DEFAULT_CASE_TYPES;
      const nextBuiltIn = Array.isArray(payload.built_in_case_types) && payload.built_in_case_types.length > 0
        ? payload.built_in_case_types
        : DEFAULT_CASE_TYPES.filter((entry) => !entry.custom);
      setCaseTypes(nextCaseTypes);
      setBuiltInCaseTypes(nextBuiltIn);
      setRules(payload.rules || []);
      setOriginalRules(payload.rules || []);
      setUsers(payload.users || []);
      setRoles(payload.roles || []);
      setError('');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to load email notification rules.');
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  useEffect(() => {
    if (user?.email) {
      setTestRecipientEmail((current) => current || normalizeEmail(user.email));
    }
  }, [user?.email]);

  const sendTestEmail = async () => {
    if (!canEdit) {
      return;
    }

    const recipient = normalizeEmail(testRecipientEmail);
    if (!recipient) {
      setError('Enter a recipient email for the test message.');
      return;
    }

    setTesting(true);
    setError('');
    setSuccess('');

    try {
      const response = await api.post('/admin/email-notification-rules/test-email', {
        recipient_email: recipient,
        from_email: normalizeEmail(fromEmail) || null,
      });
      setSuccess(response.data?.message || 'Test email sent.');
      toast.success(response.data?.message || 'Test email sent.');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to send test email.');
      setError(message);
      toast.error(message);
    } finally {
      setTesting(false);
    }
  };

  const openCreate = () => {
    setEditingIndex(null);
    setDraft(emptyRule(caseTypes));
    setEditorOpen(true);
  };

  const openEdit = (index) => {
    const rule = rules[index];
    if (!rule) {
      return;
    }
    setEditingIndex(index);
    setDraft({
      ...emptyRule(caseTypes),
      ...rule,
      recipient_role_ids: [...(rule.recipient_role_ids || [])],
      recipient_user_ids: [...(rule.recipient_user_ids || [])],
    });
    setEditorOpen(true);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    setEditingIndex(null);
  };

  const patchDraft = (patch) => {
    setDraft((current) => ({ ...current, ...patch }));
  };

  const openAddWhenType = () => {
    const first = builtInCaseTypes[0] || DEFAULT_CASE_TYPES[0];
    setWhenEditorMode('create');
    setWhenDraft({
      value: '',
      label: '',
      evaluator: first.value,
      default: first.default ?? 80,
      description: first.description || '',
      help: first.help || '',
    });
    setWhenEditorOpen(true);
  };

  const openEditWhenType = (meta) => {
    if (!meta?.custom) {
      return;
    }
    setWhenEditorMode('edit');
    setWhenDraft({
      value: meta.value,
      label: meta.label || '',
      evaluator: meta.evaluator || meta.value,
      default: meta.default ?? 0,
      description: meta.description || '',
      help: meta.help || '',
    });
    setWhenEditorOpen(true);
  };

  const closeWhenEditor = () => {
    setWhenEditorOpen(false);
  };

  const patchWhenDraft = (patch) => {
    setWhenDraft((current) => ({ ...current, ...patch }));
  };

  const saveWhenType = async () => {
    if (!canEdit) {
      return;
    }
    if (!String(whenDraft.label || '').trim()) {
      toast.error('Enter a label for the case.');
      return;
    }

    setWhenSaving(true);
    try {
      let response;
      if (whenEditorMode === 'edit' && whenDraft.value) {
        response = await api.put(
          `/admin/email-notification-rules/case-types/${encodeURIComponent(whenDraft.value)}`,
          {
            label: whenDraft.label.trim(),
            default: Number(whenDraft.default) || 0,
            description: whenDraft.description?.trim() || '',
            help: whenDraft.help?.trim() || '',
          },
        );
      } else {
        response = await api.post('/admin/email-notification-rules/case-types', {
          label: whenDraft.label.trim(),
          evaluator: whenDraft.evaluator,
          default: Number(whenDraft.default) || 0,
          description: whenDraft.description?.trim() || '',
          help: whenDraft.help?.trim() || '',
        });
      }

      const nextTypes = response.data?.data?.case_types;
      const created = response.data?.data?.case_type;
      if (Array.isArray(nextTypes)) {
        setCaseTypes(nextTypes);
      }
      if (created?.value) {
        setDraft((current) => ({
          ...current,
          case_type: created.value,
          case_value: created.default ?? current.case_value,
        }));
      }
      setSuccess(response.data?.message || 'Case saved.');
      toast.success(response.data?.message || 'Case saved.');
      closeWhenEditor();
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to save case.');
      setError(message);
      toast.error(message);
    } finally {
      setWhenSaving(false);
    }
  };

  const deleteWhenType = async (meta) => {
    if (!canEdit || !meta?.custom || !meta.value) {
      return;
    }
    if (!window.confirm(`Remove case \"${meta.label}" from the dropdown?`)) {
      return;
    }
    try {
      const response = await api.delete(
        `/admin/email-notification-rules/case-types/${encodeURIComponent(meta.value)}`,
      );
      const nextTypes = response.data?.data?.case_types;
      if (Array.isArray(nextTypes)) {
        setCaseTypes(nextTypes);
      }
      if (draft.case_type === meta.value) {
        const fallback = (Array.isArray(nextTypes) ? nextTypes : builtInCaseTypes)[0]
          || DEFAULT_CASE_TYPES[0];
        setDraft((current) => ({
          ...current,
          case_type: fallback.value,
          case_value: fallback.default ?? current.case_value,
        }));
      }
      setSuccess(response.data?.message || 'Case removed.');
      toast.success(response.data?.message || 'Case removed.');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to remove case.');
      setError(message);
      toast.error(message);
    }
  };

  const removeRule = async (index) => {
    const rule = rules[index];
    if (rule?.id) {
      if (!window.confirm(`Delete rule "${rule.label || 'this rule'}"?`)) {
        return;
      }
      try {
        await api.delete(`/admin/email-notification-rules/${rule.id}`);
        setRules((current) => current.filter((_, rowIndex) => rowIndex !== index));
        setOriginalRules((current) => current.filter((item) => item.id !== rule.id));
        setSuccess('Rule deleted.');
        toast.success('Rule deleted.');
      } catch (err) {
        const message = getApiErrorMessage(err, 'Unable to delete rule.');
        setError(message);
        toast.error(message);
      }
      return;
    }
    setRules((current) => current.filter((_, rowIndex) => rowIndex !== index));
  };

  const toggleRuleEnabled = async (index, enabled) => {
    if (!canEdit) {
      return;
    }
    const rule = rules[index];
    if (!rule) {
      return;
    }

    const previousEnabled = Boolean(rule.enabled);
    setRules((current) => current.map((entry, rowIndex) => (
      rowIndex === index ? { ...entry, enabled } : entry
    )));

    if (!rule.id) {
      setSuccess(enabled ? 'Rule activated — click Save to keep it.' : 'Rule deactivated — click Save to keep it.');
      return;
    }

    const payload = {
      code: deriveRuleCode(rule, index),
      label: String(rule.label || '').trim() || 'Untitled rule',
      description: rule.description?.trim() || '',
      case_type: rule.case_type,
      case_value: Number(rule.case_value) || 0,
      enabled: Boolean(enabled),
      in_app_enabled: Boolean(rule.in_app_enabled),
      email_enabled: Boolean(rule.email_enabled),
      recipient_role_ids: (rule.recipient_role_ids || []).map(Number).filter(Boolean),
      recipient_user_ids: (rule.recipient_user_ids || []).map(Number).filter(Boolean),
      sort_order: Number(rule.sort_order) || 0,
    };

    try {
      const response = await api.put(`/admin/email-notification-rules/${rule.id}`, payload);
      const saved = response.data?.data;
      setRules((current) => current.map((entry, rowIndex) => (
        rowIndex === index ? { ...entry, ...(saved || {}), enabled } : entry
      )));
      setOriginalRules((current) => current.map((entry) => (
        entry.id === rule.id ? { ...entry, ...(saved || {}), enabled } : entry
      )));
      const message = enabled ? 'Rule activated.' : 'Rule deactivated.';
      setSuccess(message);
      toast.success(message);
      setError('');
    } catch (err) {
      setRules((current) => current.map((entry, rowIndex) => (
        rowIndex === index ? { ...entry, enabled: previousEnabled } : entry
      )));
      const message = getApiErrorMessage(err, 'Unable to update rule status.');
      setError(message);
      toast.error(message);
    }
  };

  const applyEditor = () => {
    if (!canEdit) {
      return;
    }
    if (!String(draft.label || '').trim()) {
      setError('Each rule needs a name.');
      toast.error('Each rule needs a name.');
      return;
    }

    setRules((current) => {
      if (editingIndex == null) {
        return [...current, { ...draft, label: draft.label.trim() }];
      }
      return current.map((rule, index) => (
        index === editingIndex
          ? { ...rule, ...draft, label: draft.label.trim() }
          : rule
      ));
    });
    setError('');
    setSuccess(editingIndex == null ? 'Rule added — click Save to keep it.' : 'Rule updated — click Save to keep it.');
    closeEditor();
  };

  const saveAll = async () => {
    if (!canEdit) {
      return;
    }

    setSaving(true);
    setError('');
    setSuccess('');

    try {
      await api.post('/admin/email-notification-rules/settings', {
        email_enabled: emailEnabled,
        from_email: normalizeEmail(fromEmail) || null,
      });

      for (const [index, rule] of rules.entries()) {
        const payload = {
          code: deriveRuleCode(rule, index),
          label: rule.label.trim(),
          description: rule.description?.trim() || '',
          case_type: rule.case_type,
          case_value: Number(rule.case_value) || 0,
          enabled: Boolean(rule.enabled),
          in_app_enabled: Boolean(rule.in_app_enabled),
          email_enabled: Boolean(rule.email_enabled),
          recipient_role_ids: (rule.recipient_role_ids || []).map(Number).filter(Boolean),
          recipient_user_ids: (rule.recipient_user_ids || []).map(Number).filter(Boolean),
          sort_order: Number(rule.sort_order) || 0,
        };

        if (!payload.label) {
          throw new Error('Each rule needs a name.');
        }

        if (rule.id) {
          const original = originalRules.find((item) => item.id === rule.id);
          const fields = [
            'code',
            'label',
            'description',
            'case_type',
            'case_value',
            'enabled',
            'in_app_enabled',
            'email_enabled',
            'recipient_role_ids',
            'recipient_user_ids',
            'sort_order',
          ];
          const changed =
            !original
            || fields.some((field) => {
              const left = payload[field] ?? null;
              const right = original[field] ?? null;
              return JSON.stringify(left) !== JSON.stringify(right);
            });

          if (changed) {
            await api.put(`/admin/email-notification-rules/${rule.id}`, payload);
          }
        } else {
          await api.post('/admin/email-notification-rules', payload);
        }
      }

      await loadData();
      setSuccess('Email notification settings saved.');
      toast.success('Email notification settings saved.');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to save settings.');
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  if (loading) {
    return <TablePageSkeleton rows={6} cols={6} />;
  }

  return (
    <section className="email-notifications-page">
      <header className="page-header page-header-compact email-notifications-header">
        <div className="page-heading page-heading-row email-notifications-toolbar">
          <div className="page-heading-copy">
            <h2>Email Notifications</h2>
            <p className="email-notifications-description muted">
              Rules fire from task data (the Case). Use Send to roles/people to choose who gets the alert.
            </p>
          </div>
          {canEdit ? (
            <div className="page-header-actions email-notifications-toolbar-actions">
              <button
                type="button"
                className="btn btn-secondary btn-compact"
                onClick={openCreate}
                title="Open the form to create a new notification rule"
              >
                Create rule
              </button>
              <button
                type="button"
                className="btn btn-save btn-compact"
                onClick={saveAll}
                disabled={saving}
                title="Save global settings and all notification rules"
              >
                {saving ? 'Saving...' : 'Save'}
              </button>
            </div>
          ) : null}
        </div>
      </header>

      {error ? (
        <div className="alert alert-error" role="alert">
          {error}
        </div>
      ) : null}
      {success ? (
        <div className="alert alert-success" role="status">
          {success}
        </div>
      ) : null}

      <div className="card email-notifications-settings">
        <label className="email-notifications-toggle email-notifications-toggle-span">
          <input
            type="checkbox"
            checked={emailEnabled}
            disabled={!canEdit}
            onChange={(event) => setEmailEnabled(event.target.checked)}
          />
          <span>
            <strong>Enable email delivery</strong>
            <span className="muted">
              When off, rules can still send in-app notices. Requires SMTP settings on the server.
            </span>
          </span>
        </label>

        <div className="email-notifications-settings-grid">
          <div className="email-notifications-from-field">
            <label className="email-notifications-from-label" htmlFor="notification-from-email">
              <strong>Sender email</strong>
              <span className="muted">
                Address notifications are sent from
                {defaultFromEmail ? ` (default: ${defaultFromEmail})` : ''}.
              </span>
            </label>
            <input
              id="notification-from-email"
              className="email-notifications-input email-notifications-from-input"
              type="email"
              value={fromEmail}
              disabled={!canEdit}
              placeholder={defaultFromEmail || 'notifications@yourcompany.com'}
              onChange={(event) => setFromEmail(normalizeEmail(event.target.value))}
            />
          </div>

          {canEdit ? (
            <div className="email-notifications-test-field">
              <label className="email-notifications-from-label" htmlFor="notification-test-recipient">
                <strong>Test email</strong>
                <span className="muted">Verify SMTP using the sender address above.</span>
              </label>
              <div className="email-notifications-test-row">
                <input
                  id="notification-test-recipient"
                  className="email-notifications-input email-notifications-test-input"
                  type="email"
                  value={testRecipientEmail}
                  disabled={testing}
                  placeholder="recipient@example.com"
                  onChange={(event) => setTestRecipientEmail(normalizeEmail(event.target.value))}
                />
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={sendTestEmail}
                  disabled={testing || saving}
                >
                  {testing ? 'Sending...' : 'Send test'}
                </button>
              </div>
            </div>
          ) : null}
        </div>
      </div>

      <div className="email-notifications-rules-section">
        <div className="email-notifications-rules-heading-row">
          <h3 className="email-notifications-rules-heading">
            Notification rules
            <HelpTip text="Each rule fires when its Case matches, then notifies the selected roles/people." />
          </h3>
          <div className="email-notifications-rules-heading-actions">
            <label className="email-role-filter">
              <span className="muted">Filter by recipient role</span>
              <select
                className="email-notifications-select"
                value={roleFilter}
                onChange={(event) => setRoleFilter(event.target.value)}
                aria-label="Filter rules by role"
              >
                <option value="">All roles</option>
                {roles.map((role) => (
                  <option key={role.id} value={String(role.id)}>
                    {role.name}
                  </option>
                ))}
              </select>
            </label>
            {canEdit ? (
              <button
                type="button"
                className="btn btn-secondary btn-compact"
                onClick={openCreate}
                title="Create a new notification rule"
              >
                Create rule
              </button>
            ) : null}
          </div>
        </div>

        {rules.length === 0 ? (
          <div className="card email-notifications-empty">
            <p>No rules yet.</p>
            {canEdit ? (
              <button type="button" className="btn btn-secondary btn-compact" onClick={openCreate}>
                Create your first rule
              </button>
            ) : null}
          </div>
        ) : filteredRules.length === 0 ? (
          <div className="card email-notifications-empty">
            <p>No rules match this role filter.</p>
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              onClick={() => setRoleFilter('')}
            >
              Clear filter
            </button>
          </div>
        ) : (
          <div className="email-notifications-rules-list">
            {filteredRules.map(({ rule, index }) => (
              <RuleSummaryCard
                key={rule.id || `new-${index}`}
                rule={rule}
                index={index}
                canEdit={canEdit}
                users={users}
                roles={roles}
                caseTypes={caseTypes}
                onEdit={openEdit}
                onRemove={removeRule}
                onToggleEnabled={toggleRuleEnabled}
              />
            ))}
          </div>
        )}
      </div>

      <Modal open={editorOpen} title={editorTitle} onClose={closeEditor} size="wide">
        <div className="email-rule-editor-modal">
          <RuleEditorForm
            draft={draft}
            caseTypes={caseTypes}
            users={users}
            roles={roles}
            emailEnabled={emailEnabled}
            canEdit={canEdit}
            onChange={patchDraft}
            onAddWhenType={openAddWhenType}
            onEditWhenType={openEditWhenType}
            onDeleteWhenType={deleteWhenType}
          />
          <div className="modal-actions email-rule-editor-actions">
            <button type="button" className="btn btn-secondary" onClick={closeEditor}>
              Cancel
            </button>
            {canEdit ? (
              <button type="button" className="btn btn-save" onClick={applyEditor}>
                {editingIndex == null ? 'Add rule' : 'Apply changes'}
              </button>
            ) : null}
          </div>
        </div>
      </Modal>

      <Modal open={whenEditorOpen} title={whenEditorTitle} onClose={closeWhenEditor} size="default">
        <WhenTypeEditorForm
          draft={whenDraft}
          builtInCaseTypes={builtInCaseTypes}
          isEdit={whenEditorMode === 'edit'}
          onChange={patchWhenDraft}
        />
        <div className="modal-actions email-rule-editor-actions">
          <button type="button" className="btn btn-secondary" onClick={closeWhenEditor}>
            Cancel
          </button>
          <button
            type="button"
            className="btn btn-save"
            onClick={saveWhenType}
            disabled={whenSaving}
          >
            {whenSaving
              ? 'Saving...'
              : whenEditorMode === 'edit'
                ? 'Save case'
                : 'Add case'}
          </button>
        </div>
      </Modal>
    </section>
  );
}
