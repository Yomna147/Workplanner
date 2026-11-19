import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import Modal from './Modal';
import DisplayDateInput from './DisplayDateInput';
import { formatProjectDropdownLabel } from '../utils/projectSort';

const copyTypeLabels = {
  without_data: 'Without Data',
  with_all_data: 'With All Data',
  with_allocation: 'With Operative Selection Only',
};

function monthBounds() {
  const now = new Date();
  const start = new Date(now.getFullYear(), now.getMonth(), 1);
  const end = new Date(now.getFullYear(), now.getMonth() + 1, 0);
  const fmt = (date) => date.toISOString().slice(0, 10);
  return { start: fmt(start), end: fmt(end) };
}

export default function DuplicateProjectModal({
  open,
  onClose,
  copyType,
  sourceProjectId,
  sourcePartId,
  sourceProjectName,
  projects = [],
  existingParts = [],
  onSuccess,
}) {
  const bounds = monthBounds();
  const [addToSameProject, setAddToSameProject] = useState(false);
  const [projectName, setProjectName] = useState('');
  const [partName, setPartName] = useState('');
  const [pp, setPp] = useState('');
  const [startDate, setStartDate] = useState(bounds.start);
  const [endDate, setEndDate] = useState(bounds.end);
  const [color, setColor] = useState('#6b7280');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  useEffect(() => {
    if (!open) {
      return;
    }

    setAddToSameProject(false);
    setProjectName('');
    setPartName('');
    setPp('');
    setStartDate(bounds.start);
    setEndDate(bounds.end);
    setColor('#6b7280');
    setError('');
    setSubmitting(false);
  }, [open, bounds.end, bounds.start]);

  const resolvedProjectName = addToSameProject
    ? String(sourceProjectName || '').trim()
    : projectName.trim();

  const matchedProject = useMemo(
    () => projects.find((project) => project.name === resolvedProjectName) ?? null,
    [projects, resolvedProjectName],
  );

  const usesExistingProject = addToSameProject || Boolean(matchedProject);

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');

    if (!resolvedProjectName) {
      setError('Enter a project name or choose to add to the same project.');
      setSubmitting(false);
      return;
    }

    try {
      const response = await api.post('/projects/copy', {
        type: copyType,
        source_project_id: Number(sourceProjectId),
        source_part_id: sourcePartId ? Number(sourcePartId) : null,
        project_name: resolvedProjectName,
        part_name: partName.trim(),
        color: usesExistingProject ? undefined : color,
        pp: pp === '' ? null : pp,
        start_date: startDate || null,
        end_date: endDate || null,
      });

      onSuccess(response.data.data);
      onClose();
    } catch (err) {
      const message =
        err.response?.data?.message ||
        err.response?.data?.errors?.part_name?.[0] ||
        err.response?.data?.errors?.project_name?.[0] ||
        'Unable to duplicate project.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <Modal
      open={open}
      title={`Duplicate Project — ${copyTypeLabels[copyType] || copyType}`}
      onClose={onClose}
    >
      <p className="muted duplicate-project-intro">
        Copying from <strong>{sourceProjectName}</strong>.{' '}
        {copyType === 'with_allocation' &&
          'Only task names, dates, RAP, and assignee fields (algorithm/override) are copied.'}
        {copyType === 'without_data' &&
          'Only task names, dates, and RAP are copied — no hours or assignees.'}
        {copyType === 'with_all_data' && 'All task data is copied into the destination part.'}
      </p>

      {error && <div className="alert alert-error">{error}</div>}

      <form className="duplicate-project-form modal-form" onSubmit={handleSubmit}>
        <fieldset className="duplicate-project-destination">
          <legend>Destination</legend>
          <div className="duplicate-project-destination-options">
            <label className="duplicate-project-destination-option">
              <input
                type="radio"
                name="duplicate-project-destination"
                checked={addToSameProject}
                onChange={() => setAddToSameProject(true)}
              />
              <span>
                Add new part to same project
                {sourceProjectName ? (
                  <span className="duplicate-project-destination-detail">{sourceProjectName}</span>
                ) : null}
              </span>
            </label>
            <label className="duplicate-project-destination-option">
              <input
                type="radio"
                name="duplicate-project-destination"
                checked={!addToSameProject}
                onChange={() => setAddToSameProject(false)}
              />
              <span>New or other project</span>
            </label>
          </div>
        </fieldset>

        {!addToSameProject ? (
          <label className="duplicate-project-field">
            Project name
            <input
              list="duplicate-project-names"
              value={projectName}
              onChange={(e) => setProjectName(e.target.value)}
              required
              autoFocus
              placeholder="Type a new name or pick an existing project"
            />
            <datalist id="duplicate-project-names">
              {projects.map((project) => (
                <option key={project.id} value={project.name}>
                  {formatProjectDropdownLabel(project)}
                </option>
              ))}
            </datalist>
            {matchedProject ? (
              <span className="muted duplicate-project-hint">
                Adds a new part to the existing project <strong>{matchedProject.name}</strong>.
              </span>
            ) : null}
          </label>
        ) : null}

        <label className="duplicate-project-field">
          New part name
          <input
            list={addToSameProject ? 'duplicate-part-names' : undefined}
            value={partName}
            onChange={(e) => setPartName(e.target.value)}
            required
            autoFocus={addToSameProject}
            placeholder="Name for the copied part"
          />
          {addToSameProject ? (
            <datalist id="duplicate-part-names">
              {existingParts.map((part) => (
                <option key={part.id} value={part.name} />
              ))}
            </datalist>
          ) : null}
        </label>

        <div
          className={`duplicate-project-meta-grid${usesExistingProject ? ' duplicate-project-meta-grid--no-color' : ''}`}
        >
          <label className="duplicate-project-meta-field">
            PP
            <input
              type="number"
              value={pp}
              onChange={(e) => setPp(e.target.value)}
              placeholder="Optional"
            />
          </label>
          {!usesExistingProject ? (
            <label className="duplicate-project-meta-field duplicate-project-meta-field--color">
              Color
              <input type="color" value={color} onChange={(e) => setColor(e.target.value)} />
            </label>
          ) : null}
          <label className="duplicate-project-meta-field">
            Start date (Doc Supply)
            <DisplayDateInput value={startDate} onChange={setStartDate} />
          </label>
          <label className="duplicate-project-meta-field">
            End date (Completion)
            <DisplayDateInput value={endDate} onChange={setEndDate} />
          </label>
        </div>

        <div className="duplicate-project-actions modal-actions">
          <button type="button" className="btn btn-secondary" onClick={onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-save" disabled={submitting}>
            {submitting
              ? 'Copying...'
              : addToSameProject
                ? 'Add part'
                : 'Duplicate'}
          </button>
        </div>
      </form>
    </Modal>
  );
}
