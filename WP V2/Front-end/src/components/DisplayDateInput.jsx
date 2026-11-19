import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatDisplayDate, formatCompactDisplayDate, parseToLocalDate, toYmd } from '../utils/dateFormat';

const WEEKDAY_LABELS = ['Mo', 'Tu', 'We', 'Th', 'Fr', 'Sa', 'Su'];

function startOfMonth(date) {
  return new Date(date.getFullYear(), date.getMonth(), 1);
}

function addMonths(date, delta) {
  return new Date(date.getFullYear(), date.getMonth() + delta, 1);
}

function buildMonthCells(viewMonth) {
  const first = startOfMonth(viewMonth);
  const startOffset = (first.getDay() + 6) % 7; // Monday-first
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - startOffset);

  return Array.from({ length: 42 }, (_, index) => {
    const date = new Date(gridStart);
    date.setDate(gridStart.getDate() + index);
    return {
      date,
      ymd: toYmd(date),
      inMonth: date.getMonth() === viewMonth.getMonth(),
    };
  });
}

export default function DisplayDateInput({
  value,
  onChange,
  className = '',
  placeholder = 'Select date',
  compact = false,
  min,
  max,
  title,
  isDateDisabled,
  invalid = false,
  disabled = false,
}) {
  const rootRef = useRef(null);
  const calendarRef = useRef(null);
  const inputRef = useRef(null);
  const [open, setOpen] = useState(false);
  const [anchorRect, setAnchorRect] = useState(null);

  const normalized = value ? toYmd(value) : '';
  const minYmd = min ? toYmd(min) : '';
  const maxYmd = max ? toYmd(max) : '';
  const emptyLabel = placeholder === '' ? '—' : placeholder;
  const fullLabel = formatDisplayDate(normalized) || emptyLabel;
  const buttonLabel = compact
    ? (formatCompactDisplayDate(normalized) || emptyLabel)
    : fullLabel;
  const useCustomCalendar = typeof isDateDisabled === 'function';

  const selectedDate = useMemo(() => parseToLocalDate(normalized), [normalized]);
  const [viewMonth, setViewMonth] = useState(() => startOfMonth(selectedDate || new Date()));

  useEffect(() => {
    if (selectedDate) {
      setViewMonth(startOfMonth(selectedDate));
    }
  }, [normalized]);

  const updateAnchorRect = useCallback(() => {
    const rect = rootRef.current?.getBoundingClientRect();
    if (rect) {
      setAnchorRect(rect);
    }
  }, []);

  useEffect(() => {
    if (!open || !useCustomCalendar) {
      return undefined;
    }

    updateAnchorRect();

    const handleReposition = () => updateAnchorRect();
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    const handlePointerDown = (event) => {
      if (
        rootRef.current?.contains(event.target)
        || calendarRef.current?.contains(event.target)
      ) {
        return;
      }
      setOpen(false);
    };

    const handleEscape = (event) => {
      if (event.key === 'Escape') {
        setOpen(false);
      }
    };

    document.addEventListener('mousedown', handlePointerDown);
    document.addEventListener('keydown', handleEscape);
    return () => {
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
      document.removeEventListener('mousedown', handlePointerDown);
      document.removeEventListener('keydown', handleEscape);
    };
  }, [open, updateAnchorRect, useCustomCalendar]);

  const isOutOfRange = (ymd) => {
    if (minYmd && ymd < minYmd) {
      return true;
    }
    if (maxYmd && ymd > maxYmd) {
      return true;
    }
    return false;
  };

  const isDisabledDay = (ymd) => {
    if (!ymd) {
      return true;
    }
    if (isOutOfRange(ymd)) {
      return true;
    }
    if (useCustomCalendar && isDateDisabled(ymd)) {
      return true;
    }
    return false;
  };

  const openPicker = () => {
    if (disabled) {
      return;
    }
    if (useCustomCalendar) {
      setViewMonth(startOfMonth(selectedDate || new Date()));
      const rect = rootRef.current?.getBoundingClientRect();
      if (rect) {
        setAnchorRect(rect);
      }
      setOpen((current) => !current);
      return;
    }

    const input = inputRef.current;
    if (!input) {
      return;
    }
    if (typeof input.showPicker === 'function') {
      input.showPicker();
    } else {
      input.click();
    }
  };

  const selectDay = (ymd) => {
    if (isDisabledDay(ymd)) {
      return;
    }
    onChange(ymd);
    setOpen(false);
  };

  const monthCells = useMemo(
    () => (open && useCustomCalendar ? buildMonthCells(viewMonth) : []),
    [open, useCustomCalendar, viewMonth],
  );

  const monthLabel = viewMonth.toLocaleDateString('en-GB', {
    month: 'long',
    year: 'numeric',
  });

  const calendarStyle = useMemo(() => {
    if (!anchorRect) {
      return null;
    }

    const calendarWidth = 260;
    const calendarHeight = 300;
    const spaceBelow = window.innerHeight - anchorRect.bottom;
    const openAbove = spaceBelow < calendarHeight && anchorRect.top > calendarHeight;
    const left = Math.max(8, Math.min(anchorRect.left, window.innerWidth - calendarWidth - 8));

    return {
      top: openAbove ? anchorRect.top - calendarHeight - 4 : anchorRect.bottom + 4,
      left,
    };
  }, [anchorRect]);

  const calendar = useCustomCalendar && open && calendarStyle ? (
    <div
      ref={calendarRef}
      className="display-date-calendar display-date-calendar--floating"
      style={calendarStyle}
      role="dialog"
      aria-label="Choose date"
    >
      <div className="display-date-calendar-head">
        <button
          type="button"
          className="display-date-calendar-nav"
          onClick={() => setViewMonth((current) => addMonths(current, -1))}
          aria-label="Previous month"
        >
          ‹
        </button>
        <strong>{monthLabel}</strong>
        <button
          type="button"
          className="display-date-calendar-nav"
          onClick={() => setViewMonth((current) => addMonths(current, 1))}
          aria-label="Next month"
        >
          ›
        </button>
      </div>

      <div className="display-date-calendar-weekdays" aria-hidden="true">
        {WEEKDAY_LABELS.map((label) => (
          <span key={label}>{label}</span>
        ))}
      </div>

      <div className="display-date-calendar-grid">
        {monthCells.map((cell, index) => {
          if (!cell.inMonth) {
            return (
              <span
                key={`outside-${index}`}
                className="display-date-calendar-day is-outside"
                aria-hidden="true"
              />
            );
          }

          const disabled = isDisabledDay(cell.ymd);
          const selected = cell.ymd === normalized;
          return (
            <button
              key={cell.ymd}
              type="button"
              className={[
                'display-date-calendar-day',
                selected ? 'is-selected' : '',
                disabled ? 'is-disabled' : 'is-available',
              ].filter(Boolean).join(' ')}
              disabled={disabled}
              onClick={() => selectDay(cell.ymd)}
              aria-label={formatDisplayDate(cell.ymd)}
              aria-current={selected ? 'date' : undefined}
              title={disabled ? 'Not available for selected operatives' : formatDisplayDate(cell.ymd)}
            >
              {cell.date.getDate()}
            </button>
          );
        })}
      </div>
    </div>
  ) : null;

  return (
    <div
      ref={rootRef}
      className={`display-date-input${useCustomCalendar ? ' has-custom-calendar' : ''}${invalid ? ' is-invalid' : ''} ${className}`.trim()}
    >
      <button
        type="button"
        className={`display-date-input-btn${invalid ? ' is-invalid' : ''}`.trim()}
        onClick={openPicker}
        disabled={disabled}
        title={title || fullLabel}
        aria-expanded={useCustomCalendar ? open : undefined}
        aria-haspopup={useCustomCalendar ? 'dialog' : undefined}
      >
        {buttonLabel}
      </button>

      {!useCustomCalendar ? (
        <input
          ref={inputRef}
          type="date"
          className="display-date-input-native"
          value={normalized}
          min={minYmd || undefined}
          max={maxYmd || undefined}
          onChange={(e) => onChange(e.target.value)}
          tabIndex={-1}
          aria-hidden="true"
        />
      ) : null}

      {calendar ? createPortal(calendar, document.body) : null}
    </div>
  );
}
