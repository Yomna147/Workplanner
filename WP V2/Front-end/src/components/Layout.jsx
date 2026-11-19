import { Outlet } from 'react-router-dom';
import { LoginPromptQueueProvider } from '../context/LoginPromptQueueContext';
import { useGlobalSelectAutoWidth } from '../hooks/useGlobalSelectAutoWidth';
import DlLoginProjectConfirm from './DlLoginProjectConfirm';
import DlTraineeHoursOnOpen from './DlTraineeHoursOnOpen';
import GlobalTtNewProjectNotify from './GlobalTtNewProjectNotify';
import IncompleteTrainingReminder from './IncompleteTrainingReminder';
import Navbar from './Navbar';

export default function Layout() {
  useGlobalSelectAutoWidth();

  return (
    <div className="app-shell">
      <Navbar />
      <main className="app-main">
        <Outlet />
      </main>
      <GlobalTtNewProjectNotify />
      <LoginPromptQueueProvider>
        <DlLoginProjectConfirm />
        <DlTraineeHoursOnOpen />
        <IncompleteTrainingReminder />
      </LoginPromptQueueProvider>
    </div>
  );
}
