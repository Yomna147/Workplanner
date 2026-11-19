import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { displayProjectColor } from '../utils/projectColor';
import { measureTextWidth } from '../utils/fitSelectWidth';

export default function ProjectColorSelect({
  projects,
  value,
  onChange,
  placeholder = 'Choose a project...',
  disabled = false,
  allowEmpty = false,
  disableAutoWidth = false,
  formatProjectLabel = (project) => project.name || '',
}) {
  const [open, setOpen] = useState(false);
  const ref = useRef(null);
  const triggerRef = useRef(null);
  const panelRef = useRef(null);
  const [panelStyle, setPanelStyle] = useState(null);

  const selected = projects.find((project) => String(project.id) === String(value));

  const updatePanelPosition = () => {
    const trigger = triggerRef.current;
    if (!trigger) {
      return;
    }

    const rect = trigger.getBoundingClientRect();
    const panelWidth = disableAutoWidth
      ? Math.min(Math.max(rect.width, 220), 320)
      : Math.max(rect.width, 260);
    const viewportPadding = 8;
    let left = rect.left;
    const maxLeft = window.innerWidth - panelWidth - viewportPadding;

    if (left > maxLeft) {
      left = Math.max(viewportPadding, maxLeft);
    }

    setPanelStyle({
      position: 'fixed',
      top: rect.bottom + 4,
      left,
      width: panelWidth,
      zIndex: 1400,
    });
  };

  useEffect(() => {
    if (!open) {
      return undefined;
    }

    updatePanelPosition();

    const handleClickOutside = (event) => {
      const target = event.target;
      if (
        ref.current?.contains(target)
        || panelRef.current?.contains(target)
      ) {
        return;
      }
      setOpen(false);
    };

    const handleReposition = () => {
      updatePanelPosition();
    };

    document.addEventListener('mousedown', handleClickOutside);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);

    return () => {
      document.removeEventListener('mousedown', handleClickOutside);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open]);

  useEffect(() => {
    if (disableAutoWidth) {
      return;
    }

    const trigger = triggerRef.current;
    const root = ref.current;
    if (!trigger || !root) {
      return;
    }

    const labels = [placeholder, ...projects.map((project) => formatProjectLabel(project))];
    let max = 0;
    for (const label of labels) {
      max = Math.max(max, measureTextWidth(label, trigger));
    }

    const minWidth = Math.ceil(max) + 46;
    trigger.style.minWidth = `${minWidth}px`;
    root.style.width = 'auto';
    root.style.minWidth = `${minWidth}px`;
    root.style.maxWidth = '100%';
  }, [projects, value, placeholder, formatProjectLabel, disableAutoWidth]);

  const handleSelect = (nextValue) => {
    onChange(nextValue);
    setOpen(false);
  };

  const panel = open && panelStyle ? (
    <div
      ref={panelRef}
      className="project-color-select-panel"
      role="listbox"
      style={panelStyle}
    >
      {allowEmpty ? (
        <button
          type="button"
          role="option"
          aria-selected={!value}
          className={`project-color-select-option${!value ? ' is-selected' : ''}`}
          onClick={() => handleSelect('')}
        >
          <span
            className="project-color-select-swatch project-color-select-swatch-empty"
            aria-hidden="true"
          />
          <span className="project-color-select-option-label project-color-select-placeholder">
            {placeholder}
          </span>
        </button>
      ) : null}
      {projects.map((project) => {
        const isSelected = String(project.id) === String(value);
        const label = formatProjectLabel(project);

        return (
          <button
            key={project.id}
            type="button"
            role="option"
            aria-selected={isSelected}
            className={`project-color-select-option${isSelected ? ' is-selected' : ''}`}
            onClick={() => handleSelect(String(project.id))}
          >
            <span
              className="project-color-select-swatch"
              style={{ backgroundColor: displayProjectColor(project) }}
              aria-hidden="true"
            />
            <span className="project-color-select-option-label">{label}</span>
          </button>
        );
      })}
    </div>
  ) : null;

  return (
    <div
      className={`project-color-select${open ? ' is-open' : ''}${disabled ? ' is-disabled' : ''}`}
      ref={ref}
    >
      <button
        ref={triggerRef}
        type="button"
        className="project-color-select-trigger"
        aria-haspopup="listbox"
        aria-expanded={open}
        disabled={disabled}
        onClick={() => {
          if (!disabled) {
            setOpen((current) => !current);
          }
        }}
      >
        {selected ? (
          <>
            <span
              className="project-color-select-swatch"
              style={{ backgroundColor: displayProjectColor(selected) }}
              aria-hidden="true"
            />
            <span className="project-color-select-label" title={formatProjectLabel(selected)}>
              {formatProjectLabel(selected)}
            </span>
          </>
        ) : (
          <span className="project-color-select-placeholder">{placeholder}</span>
        )}
        <span className="project-color-select-chevron" aria-hidden="true" />
      </button>

      {panel ? createPortal(panel, document.body) : null}
    </div>
  );
}
