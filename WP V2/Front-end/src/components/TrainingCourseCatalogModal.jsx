import { useEffect, useMemo, useState } from 'react';
import api from '../api/client';
import { getApiErrorMessage } from '../utils/apiErrors';
import {
  isTrainingCourseColorTaken,
  normalizeProjectColor,
  pickNextTrainingCourseColor,
} from '../utils/projectColor';
import DeleteConfirmModal from './DeleteConfirmModal';
import {
  TRAINING_PRIORITY_OPTIONS,
  TRAINING_URGENCY_OPTIONS,
  durationToTotalHours,
  normalizeTrainingCourseUrl,
  syncTrainingHoursFromDuration,
  trainingDurationDisplayLabel,
  trainingTotalHours,
} from '../utils/trainingForm';

const DEFAULT_COURSE_COLOR = '#2563EB';

function emptyCourseForm(existingCourses = []) {
  return syncTrainingHoursFromDuration({
    title: '',
    course_link: '',
    description: '',
    duration: '1-2 hours',
    hours_per_day: durationToTotalHours('1-2 hours'),
    priority: 'P2',
    urgency: 'U1',
    is_active: true,
    color: pickNextTrainingCourseColor(existingCourses),
  });
}

function formSnapshot(form) {
  return {
    title: String(form?.title || '').trim(),
    course_link: String(form?.course_link || '').trim(),
    description: String(form?.description || '').trim(),
    duration: String(form?.duration || ''),
    hours_per_day: Number(trainingTotalHours(form)),
    priority: String(form?.priority || ''),
    urgency: String(form?.urgency || ''),
    is_active: form?.is_active !== false,
    color: normalizeProjectColor(form?.color || DEFAULT_COURSE_COLOR).toUpperCase(),
  };
}

function formsEqual(left, right) {
  if (!left || !right) {
    return false;
  }
  return (
    left.title === right.title
    && left.course_link === right.course_link
    && left.description === right.description
    && left.duration === right.duration
    && left.hours_per_day === right.hours_per_day
    && left.priority === right.priority
    && left.urgency === right.urgency
    && left.is_active === right.is_active
    && left.color === right.color
  );
}

export default function TrainingCourseCatalogModal({ open, onClose, onSaved }) {
  const [courses, setCourses] = useState([]);
  const [form, setForm] = useState(() => emptyCourseForm());
  const [formBaseline, setFormBaseline] = useState(() => formSnapshot(emptyCourseForm()));
  const [editingId, setEditingId] = useState(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [courseToDelete, setCourseToDelete] = useState(null);
  const [deletingCourse, setDeletingCourse] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);

  const applyNewForm = (nextForm) => {
    setForm(nextForm);
    setFormBaseline(formSnapshot(nextForm));
    setEditingId(null);
  };

  const resetToNewCourse = (courseList = courses) => {
    applyNewForm(emptyCourseForm(courseList));
  };

  const loadCourses = async () => {
    setLoading(true);
    try {
      const { data } = await api.get('/training-courses');
      const list = Array.isArray(data.data) ? data.data : [];
      setCourses(list);
      setError('');
      return list;
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to load training courses.'));
      return courses;
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (!open) {
      return;
    }

    let cancelled = false;
    (async () => {
      const list = await loadCourses();
      if (cancelled) {
        return;
      }
      applyNewForm(emptyCourseForm(list));
      setError('');
      setCourseToDelete(null);
      setDeletingCourse(false);
      setDiscardOpen(false);
    })();

    return () => {
      cancelled = true;
    };
    // Reset draft only when the modal opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  const setField = (key, value) => {
    setForm((current) => ({ ...current, [key]: value }));
  };

  const handleSave = async () => {
    const title = form.title.trim();
    const courseLink = String(form.course_link || '').trim();
    const description = String(form.description || '').trim();
    const missing = [
      !title ? 'course title' : null,
      !courseLink ? 'course link' : null,
      !description ? 'description' : null,
    ].filter(Boolean);

    if (missing.length > 0) {
      setError(`Course title, course link, and description are required. Fill in ${missing.join(', ')}.`);
      return;
    }

    if (isTrainingCourseColorTaken(form.color, courses, editingId)) {
      setError('This colour is already used by another course. Pick a different colour.');
      return;
    }

    setSaving(true);
    setError('');
    try {
      const payload = {
        title,
        course_link: normalizeTrainingCourseUrl(courseLink),
        description,
        duration: form.duration,
        hours_per_day: trainingTotalHours(form),
        priority: form.priority,
        urgency: form.urgency,
        is_active: form.is_active,
        color: normalizeProjectColor(form.color || DEFAULT_COURSE_COLOR),
      };

      let savedCourse = null;
      if (editingId) {
        const { data } = await api.put(`/training-courses/${editingId}`, payload);
        savedCourse = data?.data ?? { id: editingId, ...payload };
      } else {
        const { data } = await api.post('/training-courses', payload);
        savedCourse = data?.data ?? null;
      }

      const list = await loadCourses();
      applyNewForm(emptyCourseForm(list));
      onSaved?.(savedCourse);
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to save training course.'));
    } finally {
      setSaving(false);
    }
  };

  const handleEdit = (course) => {
    setEditingId(course.id);
    const nextForm = syncTrainingHoursFromDuration({
      title: course.title || '',
      course_link: course.course_link || '',
      description: course.description || '',
      duration: course.duration || '1-2 hours',
      hours_per_day: course.hours_per_day ?? durationToTotalHours(course.duration || '1-2 hours'),
      total_hours: Number(course.hours_per_day) || undefined,
      priority: course.priority || 'P2',
      urgency: course.urgency || 'U1',
      is_active: course.is_active !== false,
      color: normalizeProjectColor(course.color || DEFAULT_COURSE_COLOR),
    });
    setForm(nextForm);
    setFormBaseline(formSnapshot(nextForm));
  };

  const totalHours = useMemo(() => trainingTotalHours(form), [form]);

  const titleValue = form.title.trim();
  const courseLinkValue = String(form.course_link || '').trim();
  const descriptionValue = String(form.description || '').trim();
  const requiredFilledCount = [titleValue, courseLinkValue, descriptionValue].filter(Boolean).length;
  const highlightEmptyRequired = requiredFilledCount > 0 && requiredFilledCount < 3;
  const titleInvalid = highlightEmptyRequired && !titleValue;
  const courseLinkInvalid = highlightEmptyRequired && !courseLinkValue;
  const descriptionInvalid = highlightEmptyRequired && !descriptionValue;
  const canSaveCourse = requiredFilledCount === 3;

  const formIsDirty = !formsEqual(formSnapshot(form), formBaseline);

  const closeAndReset = () => {
    setDiscardOpen(false);
    resetToNewCourse(courses);
    onClose?.();
  };

  const requestClose = () => {
    if (formIsDirty) {
      setDiscardOpen(true);
      return;
    }
    closeAndReset();
  };

  const handleDelete = (course) => {
    setCourseToDelete(course);
  };

  const confirmDiscard = () => {
    closeAndReset();
  };

  const confirmDeleteCourse = async () => {
    if (!courseToDelete) {
      return;
    }

    setDeletingCourse(true);
    try {
      await api.delete(`/training-courses/${courseToDelete.id}`);
      const list = await loadCourses();
      if (String(editingId) === String(courseToDelete.id)) {
        applyNewForm(emptyCourseForm(list));
      }
      setCourseToDelete(null);
      onSaved?.();
    } catch (err) {
      setError(getApiErrorMessage(err, 'Unable to delete training course.'));
    } finally {
      setDeletingCourse(false);
    }
  };

  const deleteAssignmentCount = Number(courseToDelete?.assignment_count) || 0;

  if (!open) {
    return null;
  }

  return (
    <>
    <div className="modal-overlay" role="presentation" onDoubleClick={requestClose}>
      <div
        className="modal-card modal-card-xwide training-course-catalog-modal"
        role="dialog"
        onClick={(e) => e.stopPropagation()}
        onDoubleClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>{editingId ? 'Edit training course' : 'Training course catalog'}</h3>
          <button type="button" className="modal-close" onClick={requestClose} aria-label="Close">
            ×
          </button>
        </div>
        <div className="modal-body">
          {error ? <div className="alert alert-error">{error}</div> : null}

          <div className="training-course-form-grid">
            <label>
              Course title *
              <input
                value={form.title}
                onChange={(e) => setField('title', e.target.value)}
                placeholder="e.g. BIM Level 2 Fundamentals"
                disabled={saving}
                required
                aria-required="true"
                aria-invalid={titleInvalid}
                className={titleInvalid ? 'is-invalid' : undefined}
              />
              <span className={`training-course-field-hint${titleInvalid ? ' is-invalid' : ''}`}>
                Course title is required.
              </span>
            </label>
            <label>
              Course link *
              <input
                type="url"
                value={form.course_link}
                onChange={(e) => setField('course_link', e.target.value)}
                placeholder="https://learn.example.com/course"
                disabled={saving}
                required
                aria-required="true"
                aria-invalid={courseLinkInvalid}
                className={courseLinkInvalid ? 'is-invalid' : undefined}
              />
              <span className={`training-course-field-hint${courseLinkInvalid ? ' is-invalid' : ''}`}>
                Course link is required.
              </span>
            </label>
            <label className="training-course-form-span">
              Description *
              <textarea
                rows={2}
                value={form.description}
                onChange={(e) => setField('description', e.target.value)}
                disabled={saving}
                required
                aria-required="true"
                aria-invalid={descriptionInvalid}
                className={descriptionInvalid ? 'is-invalid' : undefined}
              />
              <span className={`training-course-field-hint${descriptionInvalid ? ' is-invalid' : ''}`}>
                Description is required.
              </span>
            </label>
            {/* Duration, defaults, colour and status share one compact row. */}
            <div className="training-course-form-row">
              <div
                className="training-course-form-field"
                title="Course duration is fixed and cannot be changed."
              >
                <span>Duration</span>
                <span className="training-duration-fixed">{totalHours} h</span>
              </div>
              <label>
                Default priority
                <select
                  value={form.priority}
                  onChange={(e) => setField('priority', e.target.value)}
                  disabled={saving}
                >
                  {TRAINING_PRIORITY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label>
                Default urgency
                <select
                  value={form.urgency}
                  onChange={(e) => setField('urgency', e.target.value)}
                  disabled={saving}
                >
                  {TRAINING_URGENCY_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </label>
              <label className="training-course-color-field">
                Course color
                <input
                  type="color"
                  className="project-color-input training-course-color-input"
                  value={normalizeProjectColor(form.color || DEFAULT_COURSE_COLOR)}
                  onChange={(e) => setField('color', normalizeProjectColor(e.target.value))}
                  disabled={saving}
                  title="Distinguished colour for this course"
                  aria-label="Course color"
                />
              </label>
              <label className="training-course-form-active">
                <input
                  type="checkbox"
                  className="training-course-active-checkbox"
                  checked={form.is_active}
                  onChange={(e) => setField('is_active', e.target.checked)}
                  disabled={saving}
                />
                Active course
              </label>
            </div>
          </div>

          <div className="table-card" style={{ marginTop: 16 }}>
            <table>
              <thead>
                <tr>
                  <th>Color</th>
                  <th>Course</th>
                  <th>Duration</th>
                  <th>Active</th>
                  <th>Actions</th>
                </tr>
              </thead>
              <tbody>
                {loading ? (
                  <tr>
                    <td colSpan={5}>Loading courses…</td>
                  </tr>
                ) : courses.length === 0 ? (
                  <tr>
                    <td colSpan={5}>No courses in the catalog yet.</td>
                  </tr>
                ) : (
                  courses.map((course) => (
                    <tr key={course.id}>
                      <td>
                        <span
                          className="training-course-table-swatch"
                          style={{ backgroundColor: normalizeProjectColor(course.color || DEFAULT_COURSE_COLOR) }}
                          title={normalizeProjectColor(course.color || DEFAULT_COURSE_COLOR)}
                          aria-label={`Course color ${normalizeProjectColor(course.color || DEFAULT_COURSE_COLOR)}`}
                        />
                      </td>
                      <td>{course.title}</td>
                      <td>{trainingDurationDisplayLabel(course)}</td>
                      <td>{course.is_active ? 'Yes' : 'No'}</td>
                      <td className="table-row-actions">
                        <button
                          type="button"
                          className="btn btn-secondary btn-sm"
                          disabled={saving}
                          onClick={() => handleEdit(course)}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn-danger btn-sm"
                          disabled={saving}
                          onClick={() => handleDelete(course)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
        <div className="modal-actions" style={{ padding: '0 24px 24px' }}>
          <button type="button" className="btn btn-secondary" onClick={requestClose} disabled={saving}>
            Close
          </button>
          <button type="button" className="btn btn-save" onClick={handleSave} disabled={saving || loading || !canSaveCourse}>
            {saving ? 'Saving…' : editingId ? 'Update course' : 'Add course'}
          </button>
        </div>
      </div>
    </div>
    <DeleteConfirmModal
      open={Boolean(courseToDelete)}
      title="Delete course"
      message={`Delete “${courseToDelete?.title || 'this training course'}” from the catalog?`}
      details={[
        { label: 'Course', value: courseToDelete?.title || '—' },
        {
          label: 'Assignments',
          value: deleteAssignmentCount === 1
            ? '1 assignment'
            : `${deleteAssignmentCount} assignments`,
        },
      ]}
      warning={deleteAssignmentCount > 0
        ? `This also removes ${deleteAssignmentCount} assignment${deleteAssignmentCount === 1 ? '' : 's'} from the roster, histogram, and Gap view. This cannot be undone.`
        : 'This action cannot be undone.'}
      confirmLabel="Delete course"
      onClose={() => {
        if (!deletingCourse) {
          setCourseToDelete(null);
        }
      }}
      onConfirm={confirmDeleteCourse}
      busy={deletingCourse}
    />
    <DeleteConfirmModal
      open={discardOpen}
      title="Discard unsaved course?"
      message="Nothing will be saved unless you click Add course or Update course."
      warning="Unsaved title, link, and description will be lost."
      confirmLabel="Discard"
      onClose={() => setDiscardOpen(false)}
      onConfirm={confirmDiscard}
    />
    </>
  );
}
