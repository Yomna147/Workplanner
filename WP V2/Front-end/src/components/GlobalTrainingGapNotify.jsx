import { useCallback, useEffect, useMemo, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { useAuth } from '../context/AuthContext';
import { useTrainingGapOpportunities } from '../hooks/useTrainingGapOpportunities';
import {
  countUnreadGapNotifications,
  dismissGapNotification,
  isGapNotificationDismissed,
  markGapNotificationsRead,
} from '../utils/trainingGapNotifications';
import { subscribeGapReadStateChanged } from '../utils/trainingGapNotifyStorage';
import {
  canEditNotifications,
  canViewNotifications,
  isDlUser,
  isTrainerUser,
} from '../utils/userPermissions';
import TrainingGapNotifyBanner from './TrainingGapNotifyBanner';

export default function GlobalTrainingGapNotify() {
  const { user } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [toastDismissed, setToastDismissed] = useState(false);
  const [readTick, setReadTick] = useState(0);
  const isHome = location.pathname === '/' || location.pathname === '';
  const canPlannerNotify = canViewNotifications(user);
  const dlOnlyNotify = isDlUser(user) && !canPlannerNotify;
  const trainerUser = isTrainerUser(user);
  // Bell + gap list on every page (including Home). Closest-gap toast stays off on Home.
  const enabled = canPlannerNotify || dlOnlyNotify;
  const gapEnabled = canPlannerNotify;
  const canAssign = canEditNotifications(user);
  const userId = user?.id ?? null;

  const {
    opportunities,
    fingerprint,
  } = useTrainingGapOpportunities({ enabled: gapEnabled });

  useEffect(() => {
    if (!user) {
      setToastDismissed(false);
      return;
    }
    setToastDismissed(isGapNotificationDismissed(fingerprint));
  }, [fingerprint, user]);

  useEffect(() => subscribeGapReadStateChanged(() => {
    setReadTick((value) => value + 1);
  }), []);

  const unreadCount = useMemo(
    () => countUnreadGapNotifications(opportunities, fingerprint, userId),
    [opportunities, fingerprint, readTick, userId],
  );

  const handleDismissToast = useCallback(() => {
    setToastDismissed(true);
    dismissGapNotification(fingerprint);
  }, [fingerprint]);

  const handleOpenBell = useCallback(() => {
    markGapNotificationsRead(
      fingerprint,
      opportunities.map((row) => row.employeeId),
      userId,
    );
  }, [fingerprint, opportunities, userId]);

  const handleAssign = useCallback((opportunity) => {
    if (!opportunity) {
      return;
    }

    markGapNotificationsRead(fingerprint, [opportunity.employeeId], userId);

    const window = opportunity.gapWindow;
    const params = new URLSearchParams();
    params.set('gapAssign', String(opportunity.employeeId));
    params.set('view', 'gaps');
    if (window?.start_date) {
      params.set('gapStart', window.start_date);
    }
    if (window?.end_date) {
      params.set('gapEnd', window.end_date);
    }
    navigate(`/trainings?${params.toString()}`);
  }, [fingerprint, navigate, userId]);

  if (!enabled) {
    return null;
  }

  return (
    <TrainingGapNotifyBanner
      className="navbar-gap-notify"
      opportunities={gapEnabled ? opportunities : []}
      unreadCount={gapEnabled ? unreadCount : 0}
      onDismiss={handleDismissToast}
      onOpenBell={handleOpenBell}
      onAssignOne={canAssign ? handleAssign : undefined}
      showBell
      showClosestPopup={gapEnabled && !isHome && !toastDismissed && opportunities.length > 0}
      defaultTab={dlOnlyNotify || trainerUser ? 'system' : 'trainings'}
      showTrainingTab
      gapsInSystemTab={trainerUser}
    />
  );
}
