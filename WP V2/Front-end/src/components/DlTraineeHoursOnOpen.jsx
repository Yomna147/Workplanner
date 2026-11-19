import { useEffect, useState } from 'react';
import api from '../api/client';
import { DL_TRAINEE_HOURS_ALERT_KEY } from '../constants/dlLoginConfirm';
import { useAuth } from '../context/AuthContext';
import { LOGIN_PROMPT_IDS, useLoginPrompt } from '../context/LoginPromptQueueContext';
import { currentWeekAlertRange, findTraineesExceedingCapacity } from '../utils/traineeHoursAlert';
import { isDlUser } from '../utils/userPermissions';
import DlTraineeHoursExceededModal from './DlTraineeHoursExceededModal';

export default function DlTraineeHoursOnOpen() {
  const { user, loading } = useAuth();
  const { open, request, release } = useLoginPrompt(LOGIN_PROMPT_IDS.TRAINEE_HOURS);
  const [alerts, setAlerts] = useState([]);
  const [weekRange, setWeekRange] = useState(null);
  const [fetching, setFetching] = useState(false);

  useEffect(() => {
    if (loading || !user || !isDlUser(user)) {
      return;
    }

    if (sessionStorage.getItem(DL_TRAINEE_HOURS_ALERT_KEY) !== '1') {
      return;
    }

    let cancelled = false;
    const range = currentWeekAlertRange();

    const load = async () => {
      setFetching(true);
      try {
        const response = await api.get('/resource-histogram', {
          params: { start: range.start, end: range.end },
        });
        if (cancelled) {
          return;
        }

        const data = response.data?.data ?? {};
        const employees = Array.isArray(data.employees) ? data.employees : [];
        const bars = Array.isArray(data.bars) ? data.bars : [];
        const found = findTraineesExceedingCapacity({
          employees,
          bars,
          availabilityHours: data.availability_hours ?? {},
          employeeHolidays: data.employee_holidays ?? {},
          startYmd: range.start,
          endYmd: range.end,
        });

        setWeekRange(range);
        setAlerts(found);
        if (found.length > 0) {
          request();
        } else {
          sessionStorage.removeItem(DL_TRAINEE_HOURS_ALERT_KEY);
        }
      } catch {
        if (!cancelled) {
          sessionStorage.removeItem(DL_TRAINEE_HOURS_ALERT_KEY);
        }
      } finally {
        if (!cancelled) {
          setFetching(false);
        }
      }
    };

    load();

    return () => {
      cancelled = true;
    };
  }, [loading, user, request]);

  const handleDismiss = () => {
    sessionStorage.removeItem(DL_TRAINEE_HOURS_ALERT_KEY);
    release();
  };

  if (fetching && !open) {
    return null;
  }

  return (
    <DlTraineeHoursExceededModal
      open={open}
      alerts={alerts}
      weekRange={weekRange}
      onClose={handleDismiss}
    />
  );
}
