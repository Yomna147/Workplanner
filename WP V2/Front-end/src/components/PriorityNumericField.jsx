import { useCallback, useEffect, useId, useRef, useState } from 'react';
import {
  clampPriorityValue,
  formatPriorityValue,
  parsePriorityValue,
} from '../utils/priorityFormat';

export default function PriorityNumericField({
  value,
  onChange,
  readOnly = false,
  computed = false,
  disabled = false,
  min = 0,
  max = 999.99,
  title,
  ariaLabel,
  instantCommit = false,
}) {
  const inputId = useId();
  const inputRef = useRef(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const committedRef = useRef(value ?? '');

  useEffect(() => {
    const next = value ?? '';
    if (next !== committedRef.current) {
      committedRef.current = next;
      if (!editing) {
        setDraft('');
      }
    }
  }, [value, editing]);

  const commitDraft = useCallback(
    (raw) => {
      const parsed = parsePriorityValue(raw);
      if (parsed === '') {
        committedRef.current = '';
        onChange?.('');
        return;
      }
      const num = clampPriorityValue(parseFloat(parsed), { min, max });
      const next = String(num);
      committedRef.current = next;
      onChange?.(next);
    },
    [max, min, onChange],
  );

  const handleFocus = () => {
    if (readOnly || disabled || computed) {
      return;
    }
    setEditing(true);
    if (value === null || value === undefined || value === '') {
      setDraft('');
    } else {
      setDraft(String(value));
    }
  };

  const handleBlur = () => {
    if (readOnly || disabled || computed) {
      return;
    }
    setEditing(false);
    commitDraft(draft);
  };

  const handleKeyDown = (event) => {
    if (readOnly || disabled || computed) {
      return;
    }

    if (event.key === 'Enter') {
      event.preventDefault();
      commitDraft(draft);
      setEditing(false);
      inputRef.current?.blur();
      return;
    }

    if (event.key === 'Escape') {
      event.preventDefault();
      setEditing(false);
      setDraft('');
      inputRef.current?.blur();
    }
  };

  const handleChange = (event) => {
    if (readOnly || disabled || computed) {
      return;
    }

    const next = event.target.value;
    setDraft(next);

    if (instantCommit) {
      committedRef.current = next;
      onChange?.(next);
    }
  };

  const displayValue = editing ? draft : formatPriorityValue(value);

  const rootClass = [
    'pde-priority-field',
    computed ? 'pde-priority-field--computed' : '',
    readOnly ? 'pde-priority-field--readonly' : '',
    disabled ? 'pde-priority-field--disabled' : '',
    editing ? 'is-editing' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className={rootClass} title={title}>
      <input
        ref={inputRef}
        id={inputId}
        type="text"
        inputMode="decimal"
        className="pde-priority-field__input"
        value={displayValue}
        readOnly={readOnly || computed}
        disabled={disabled}
        aria-label={ariaLabel}
        onFocus={handleFocus}
        onBlur={instantCommit ? () => {
          setEditing(false);
          commitDraft(draft);
        } : handleBlur}
        onChange={handleChange}
        onKeyDown={handleKeyDown}
      />
    </div>
  );
}
