import { useEffect, useMemo, useRef, useState } from 'react';
import {
  buildTimeDropdownOptions,
  formatTimeInputValue,
  normalizeTimeInput,
} from '../utils/availabilityTime';

export default function AvailabilityTimeInput({
  value,
  onChange,
  className = '',
  stepMinutes = 15,
}) {
  const rootRef = useRef(null);
  const listRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => formatTimeInputValue(value));
  const selected = formatTimeInputValue(value);
  const options = useMemo(() => buildTimeDropdownOptions(stepMinutes), [stepMinutes]);

  useEffect(() => {
    setDraft(formatTimeInputValue(value));
  }, [value]);

  const filteredOptions = useMemo(() => {
    const query = draft.replace(/[^\d:]/g, '').trim();
    if (!query) {
      return options;
    }
    return options.filter((time) => time.startsWith(query) || time.includes(query));
  }, [draft, options]);

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    const handlePointerDown = (event) => {
      if (rootRef.current?.contains(event.target)) {
        return;
      }
      setOpen(false);
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
        inputRef.current?.blur();
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open]);

  useEffect(() => {
    if (!open || !listRef.current || !selected) {
      return;
    }
    const active = listRef.current.querySelector('[data-selected="true"]');
    active?.scrollIntoView({ block: 'nearest' });
  }, [open, selected]);

  const commitDraft = (raw) => {
    const trimmed = String(raw).trim();
    if (!trimmed) {
      onChange('');
      setDraft('');
      return;
    }

    const normalized = normalizeTimeInput(trimmed);
    if (normalized === null) {
      setDraft(formatTimeInputValue(value));
      return;
    }

    onChange(normalized);
    setDraft(normalized);
  };

  const selectTime = (time) => {
    onChange(time);
    setDraft(formatTimeInputValue(time));
    setOpen(false);
    inputRef.current?.blur();
  };

  return (
    <div ref={rootRef} className={`availability-time-dropdown ${className}`.trim()}>
      <div className="availability-time-dropdown-control">
        <input
          ref={inputRef}
          type="text"
          inputMode="numeric"
          className="availability-time-dropdown-input"
          value={draft}
          placeholder="--:--"
          maxLength={5}
          aria-label="Time"
          aria-expanded={open}
          aria-haspopup="listbox"
          onChange={(event) => {
            let next = event.target.value.replace(/[^\d:]/g, '');
            if (next.length === 2 && !next.includes(':') && draft.length < 2) {
              next = `${next}:`;
            }
            setDraft(next);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={(event) => commitDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              commitDraft(draft);
              setOpen(false);
            }
            if (event.key === 'ArrowDown') {
              event.preventDefault();
              setOpen(true);
            }
          }}
        />
        <button
          type="button"
          className="availability-time-dropdown-toggle"
          aria-label="Open time list"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            setOpen((current) => !current);
            inputRef.current?.focus();
          }}
        >
          ▾
        </button>
      </div>

      {open ? (
        <div className="availability-time-dropdown-panel" role="listbox" aria-label="Select time">
          <button
            type="button"
            className="availability-time-dropdown-option is-clear"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => selectTime('')}
          >
            Clear
          </button>
          <div ref={listRef} className="availability-time-dropdown-list">
            {filteredOptions.length === 0 ? (
              <div className="availability-time-dropdown-empty">No matching times</div>
            ) : (
              filteredOptions.map((time) => {
                const isSelected = time === selected;
                return (
                  <button
                    key={time}
                    type="button"
                    role="option"
                    data-selected={isSelected ? 'true' : undefined}
                    aria-selected={isSelected}
                    className={`availability-time-dropdown-option${isSelected ? ' is-selected' : ''}`}
                    onMouseDown={(event) => event.preventDefault()}
                    onClick={() => selectTime(time)}
                  >
                    {time}
                  </button>
                );
              })
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}
