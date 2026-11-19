import { useEffect } from 'react';
import { useLocation } from 'react-router-dom';
import { DL_LOGIN_CONFIRM_KEY } from '../constants/dlLoginConfirm';
import { useAuth } from '../context/AuthContext';
import { LOGIN_PROMPT_IDS, useLoginPrompt } from '../context/LoginPromptQueueContext';
import { isDlUser } from '../utils/userPermissions';
import DlWeeklyProjectsConfirmModal from './DlWeeklyProjectsConfirmModal';

function isDlPagePath(pathname) {
  return pathname === '/dl-input-hours' || pathname.startsWith('/dl-input-hours/');
}

export default function DlLoginProjectConfirm() {
  const { user, loading } = useAuth();
  const { pathname } = useLocation();
  const { open, request, release } = useLoginPrompt(LOGIN_PROMPT_IDS.PROJECT_CONFIRM);
  const onDlPage = isDlPagePath(pathname);

  useEffect(() => {
    if (loading || !user) {
      return;
    }

    if (!isDlUser(user)) {
      return;
    }

    if (sessionStorage.getItem(DL_LOGIN_CONFIRM_KEY) !== '1') {
      return;
    }

    // DL Input Hours already surfaces project status — skip the popup there.
    if (onDlPage) {
      release();
      return;
    }

    request();
  }, [loading, user, request, release, onDlPage]);

  const handleDismiss = () => {
    sessionStorage.removeItem(DL_LOGIN_CONFIRM_KEY);
    release();
  };

  return (
    <DlWeeklyProjectsConfirmModal
      open={open}
      onDismiss={handleDismiss}
    />
  );
}
