import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import api from '../api/client';
import { buildDailyHoursFromBars, filterLiteralHistogramBars } from '../components/gantt/ganttUtils';
import { INCOMPLETE_TRAINING_REMINDER_KEY, INCOMPLETE_TRAINING_REMINDER_SHOWN_KEY } from '../constants/dlLoginConfirm';
import { useAuth } from '../context/AuthContext';
import { LOGIN_PROMPT_IDS, useLoginPrompt } from '../context/LoginPromptQueueContext';
import { useToast } from '../context/ToastContext';
import { getApiErrorMessage, getApiErrorDetails } from '../utils/apiErrors';
import {
  employeeDisplayName,
  employeeMatchesName,
  findEmployeeForAuthUser,
} from '../utils/employeeNames';
import {
  findDueIncompleteTrainings,
  suggestRescheduleWindow,
} from '../utils/incompleteTrainingReminder';
import { persistTrainingRecord } from '../utils/trainingSaveGuard';
import { canPageAction } from '../utils/userPermissions';
import { useTrainingOccupiedSlotGate } from '../hooks/useTrainingOccupiedSlotGate.jsx';
import { formatDisplayDate } from '../utils/dateFormat';
import Modal from './Modal';

function formatTrainingLabel(training) {
  const title = training?.title || 'Untitled training';
  const date = formatDisplayDate(training?.start_date);
  return date ? `${title} (${date})` : title;
}

function trainingBelongsToAuthUser(training, user) {
  if (!training || !user) {
    return false;
  }

  const labels = [
    user.name,
    [user.first_name, user.last_name].filter(Boolean).join(' '),
    user.first_name,
    user.login_name,
  ].filter(Boolean);

  const employee = training.employee || {
    first_name: training.employee_first_name,
    last_name: training.employee_last_name,
    name: training.employee_name,
  };

  return labels.some((label) => employeeMatchesName(employee, label));
}

export default function IncompleteTrainingReminder() {
  const { user, loading } = useAuth();
  const canUpdateOwnTraining = canPageAction(user, 'Trainings', 'assign')
    || canPageAction(user, 'DL Input Hours', 'edit_own_trainings');
  const toast = useToast();
  const navigate = useNavigate();
  const { open, request, release } = useLoginPrompt(LOGIN_PROMPT_IDS.INCOMPLETE_TRAINING);
  const { runWithOccupiedSlotGuard, modal: occupiedSlotModal } = useTrainingOccupiedSlotGate();
  const [trainings, setTrainings] = useState([]);
  const [employee, setEmployee] = useState(null);
  const [histogramContext, setHistogramContext] = useState(null);
  const [busy, setBusy] = useState(false);
  const [activeTraining, setActiveTraining] = useState(null);

  useEffect(() => {
    if (loading || !user) {
      return undefined;
    }

    // Once per browser session — never again on route changes.
    if (sessionStorage.getItem(INCOMPLETE_TRAINING_REMINDER_SHOWN_KEY) === '1') {
      sessionStorage.removeItem(INCOMPLETE_TRAINING_REMINDER_KEY);
      return undefined;
    }

    if (sessionStorage.getItem(INCOMPLETE_TRAINING_REMINDER_KEY) !== '1') {
      return undefined;
    }

    let cancelled = false;

    const markHandled = () => {
      sessionStorage.setItem(INCOMPLETE_TRAINING_REMINDER_SHOWN_KEY, '1');
      sessionStorage.removeItem(INCOMPLETE_TRAINING_REMINDER_KEY);
    };

    const load = async () => {
      try {
        let employees = [];
        try {
          const employeesRes = await api.get('/employees');
          if (cancelled) {
            return;
          }
          employees = Array.isArray(employeesRes.data?.data) ? employeesRes.data.data : [];
        } catch {
          // Some roles cannot list employees — fall back to trainings payload matching.
          employees = [];
        }

        if (cancelled) {
          return;
        }

        let linkedEmployee = findEmployeeForAuthUser(user, employees);
        let rows = [];

        if (linkedEmployee?.id) {
          const trainingsRes = await api.get('/trainings', {
            params: { employee_id: linkedEmployee.id },
          });
          if (cancelled) {
            return;
          }
          rows = Array.isArray(trainingsRes.data?.data) ? trainingsRes.data.data : [];
        } else {
          const trainingsRes = await api.get('/trainings');
          if (cancelled) {
            return;
          }
          const allRows = Array.isArray(trainingsRes.data?.data) ? trainingsRes.data.data : [];
          rows = allRows.filter((row) => trainingBelongsToAuthUser(row, user));
          if (rows[0]?.employee) {
            linkedEmployee = rows[0].employee;
          } else if (rows[0]?.employee_id) {
            linkedEmployee = {
              id: rows[0].employee_id,
              first_name: rows[0].employee?.first_name || user.first_name || user.name || '',
              last_name: rows[0].employee?.last_name || user.last_name || '',
            };
          }
        }

        if (cancelled) {
          return;
        }

        if (!linkedEmployee?.id && rows.length === 0) {
          markHandled();
          return;
        }

        const due = findDueIncompleteTrainings(rows);
        if (due.length === 0) {
          markHandled();
          return;
        }

        if (!linkedEmployee?.id && due[0]?.employee_id) {
          linkedEmployee = {
            id: due[0].employee_id,
            ...(due[0].employee || {}),
          };
        }

        setEmployee(linkedEmployee);
        setTrainings(due);
        setActiveTraining(due[0]);
        setHistogramContext({
          employees: employees.length > 0
            ? employees
            : (linkedEmployee ? [linkedEmployee] : []),
          dailyHours: {},
          availabilityHours: {},
          employeeHolidays: {},
          trainings: rows,
        });
        // Enqueue first, then mark shown — Strict Mode remounts must not skip the prompt
        // after a cancelled in-flight request left SHOWN set with an empty queue.
        request();
        if (!cancelled) {
          markHandled();
        }
      } catch {
        // Keep the login flag so a later remount / navigation can retry.
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [loading, user, request]);

  const handleDismiss = () => {
    sessionStorage.setItem(INCOMPLETE_TRAINING_REMINDER_SHOWN_KEY, '1');
    sessionStorage.removeItem(INCOMPLETE_TRAINING_REMINDER_KEY);
    release();
  };

  const handleMarkComplete = async () => {
    if (!activeTraining?.id) {
      return;
    }

    setBusy(true);
    try {
      await persistTrainingRecord({
        training: activeTraining,
        overrides: { status: 'completed' },
      });
      toast.success('Training marked as complete.');

      const remaining = trainings.filter((row) => String(row.id) !== String(activeTraining.id));
      if (remaining.length === 0) {
        handleDismiss();
        return;
      }

      setTrainings(remaining);
      setActiveTraining(remaining[0]);
    } catch (err) {
      toast.error(getApiErrorMessage(err, 'Failed to update training.'));
    } finally {
      setBusy(false);
    }
  };

  const handleReschedule = async () => {
    if (!activeTraining || !employee || !histogramContext) {
      return;
    }

    setBusy(true);
    try {
      let context = histogramContext;
      if (!context.dailyHours || Object.keys(context.dailyHours).length === 0) {
        try {
          const histRes = await api.get('/resource-histogram');
          const data = histRes.data?.data ?? {};
          context = {
            ...context,
            dailyHours: buildDailyHoursFromBars(data.bars ?? []),
            availabilityHours: data.availability_hours ?? {},
            employeeHolidays: data.employee_holidays ?? {},
            bars: filterLiteralHistogramBars(Array.isArray(data.bars) ? data.bars : []),
          };
          setHistogramContext(context);
        } catch {
          // Keep empty hours — suggestRescheduleWindow will fall back.
        }
      }

      const window = suggestRescheduleWindow({
        training: activeTraining,
        employee,
        employees: context.employees,
        dailyHours: context.dailyHours,
        availabilityHours: context.availabilityHours,
        employeeHolidays: context.employeeHolidays,
        trainings: context.trainings,
      });

      if (!window?.start_date) {
        toast.error('No nearby available slot was found. Open My trainings to reschedule manually.');
        navigate(`/dl-input-hours?view=trainings&training=${activeTraining.id}`);
        handleDismiss();
        return;
      }

      const conflictContext = {
        employees: context.employees,
        dailyHours: context.dailyHours,
        availabilityHours: context.availabilityHours,
        employeeHolidays: context.employeeHolidays,
        bars: Array.isArray(context.bars) ? context.bars : [],
        trainings: context.trainings,
      };

      await runWithOccupiedSlotGuard({
        rows: [{
          ...activeTraining,
          start_date: window.start_date,
          end_date: window.end_date || window.start_date,
          status: 'scheduled',
        }],
        context: conflictContext,
        originalsById: new Map([[String(activeTraining.id), activeTraining]]),
        save: (confirmOverride, overrideConflicts = []) => persistTrainingRecord({
          training: activeTraining,
          overrides: {
            start_date: window.start_date,
            end_date: window.end_date || window.start_date,
            status: 'scheduled',
            // Keep the original slot length (do not stretch to 2h/8h).
            hours_per_day: activeTraining.hours_per_day,
            duration: activeTraining.duration,
          },
          confirmOverride,
          previous: activeTraining,
          context: conflictContext,
          overrideConflicts,
        }),
      });
      toast.success('Training rescheduled to the nearest available slot.');

      const remaining = trainings.filter((row) => String(row.id) !== String(activeTraining.id));
      if (remaining.length === 0) {
        handleDismiss();
        return;
      }

      setTrainings(remaining);
      setActiveTraining(remaining[0]);
    } catch (err) {
      const details = getApiErrorDetails(err);
      toast.error(details.code === 'TRAINING_OCCUPIED_SLOT' || details.code === 'TRAINING_TRAINING_CONFLICT'
        ? 'No override was confirmed. Open My trainings to reschedule manually.'
        : getApiErrorMessage(err, 'Failed to reschedule training.'));
    } finally {
      setBusy(false);
    }
  };

  const handleOpenTrainings = () => {
    const params = activeTraining?.id ? `?view=trainings&training=${activeTraining.id}` : '?view=trainings';
    navigate(`/dl-input-hours${params}`);
    handleDismiss();
  };

  if (!open || !activeTraining) {
    return null;
  }

  const operativeName = employeeDisplayName(employee);
  const moreCount = trainings.length - 1;

  return (
    <>
      <Modal
        open={open}
        title="Training not marked complete"
        onClose={busy ? () => {} : handleDismiss}
        size="compact"
      >
      <div className="incomplete-training-reminder">
        <p>
          {operativeName ? (
            <>
              <strong>{operativeName}</strong>
              , you have a training session that has started but is not marked complete.
            </>
          ) : (
            'You have a training session that has started but is not marked complete.'
          )}
        </p>

        <div className="incomplete-training-reminder-card card">
          <strong>{formatTrainingLabel(activeTraining)}</strong>
          {moreCount > 0 ? (
            <p className="muted incomplete-training-reminder-more">
              {moreCount}
              {' more incomplete training'}
              {moreCount === 1 ? '' : 's'}
              {' after this one.'}
            </p>
          ) : null}
        </div>

        <p className="muted incomplete-training-reminder-hint">
          Mark it complete, or move it to the nearest available slot.
        </p>

        <div className="modal-actions">
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleDismiss}
            disabled={busy}
          >
            Later
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleOpenTrainings}
            disabled={busy}
          >
            Open trainings
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={handleReschedule}
            disabled={busy || !canUpdateOwnTraining}
          >
            {busy ? 'Working…' : 'Reschedule'}
          </button>
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleMarkComplete}
            disabled={busy || !canUpdateOwnTraining}
          >
            {busy ? 'Saving…' : 'Mark complete'}
          </button>
        </div>
      </div>
      </Modal>
      {occupiedSlotModal}
    </>
  );
}
