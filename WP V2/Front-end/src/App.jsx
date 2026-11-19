import { BrowserRouter, Navigate, Route, Routes } from 'react-router-dom';
import DocumentTitle from './components/DocumentTitle';
import Layout from './components/Layout';
import ProtectedRoute from './components/ProtectedRoute';
import AdminRoute from './components/AdminRoute';
import PermissionRoute from './components/PermissionRoute';
import { AuthProvider } from './context/AuthContext';
import { ToastProvider } from './context/ToastContext';
import Dashboard from './pages/views/Dashboard';
import ResourceHistogram from './pages/views/ResourceHistogram';
import Projects from './pages/work-planning-data/Projects';
import Trainings from './pages/work-planning-data/Trainings';
import OperativesAllocation from './pages/work-planning-data/OperativesAllocation';
import TtProjectHours from './pages/work-planning-data/TtProjectHours';
import ApiTest from './pages/debug/ApiTest';
import UserAvailability from './pages/user-data-entry/UserAvailability';
import DlInputHours from './pages/user-data-entry/DlInputHours';
import ProjectProgress from './pages/user-data-entry/ProjectProgress';
import SystemMonitor from './pages/admin/SystemMonitor';
import OutlookEmails from './pages/admin/OutlookEmails';
import AccessPermissions from './pages/admin/AccessPermissions';
import ActivityLog from './pages/admin/ActivityLog';
import Roles from './pages/admin/Roles';
import EmailNotifications from './pages/admin/EmailNotifications';
import Login from './pages/auth/Login';
import Register from './pages/auth/Register';

export default function App() {
  return (
    <AuthProvider>
      <ToastProvider>
        <BrowserRouter>
        <DocumentTitle />
        <Routes>
          <Route path="/login" element={<Login />} />
          <Route path="/register" element={<Register />} />
          <Route element={<ProtectedRoute />}>
            <Route element={<Layout />}>
              <Route
                index
                element={(
                  <PermissionRoute page="Dashboard">
                    <Dashboard />
                  </PermissionRoute>
                )}
              />
              <Route
                path="operatives-allocation"
                element={(
                  <PermissionRoute page="Operatives Allocation">
                    <OperativesAllocation />
                  </PermissionRoute>
                )}
              />
              <Route
                path="tt-project-hours"
                element={(
                  <PermissionRoute page="TT Project Hours">
                    <TtProjectHours />
                  </PermissionRoute>
                )}
              />
              <Route element={<AdminRoute />}>
                <Route path="apitest" element={<ApiTest />} />
              </Route>
              <Route
                path="projects"
                element={(
                  <PermissionRoute page="Project Data Entry">
                    <Projects />
                  </PermissionRoute>
                )}
              />
              <Route
                path="dl-input-hours"
                element={(
                  <PermissionRoute page="DL Input Hours">
                    <DlInputHours />
                  </PermissionRoute>
                )}
              />
              <Route
                path="project-progress"
                element={(
                  <PermissionRoute page="Project Progress">
                    <ProjectProgress />
                  </PermissionRoute>
                )}
              />
              <Route
                path="user-availability"
                element={(
                  <PermissionRoute page="User Availability">
                    <UserAvailability />
                  </PermissionRoute>
                )}
              />
              <Route
                path="resource-histogram"
                element={(
                  <PermissionRoute page="Resource Histogram">
                    <ResourceHistogram />
                  </PermissionRoute>
                )}
              />
              <Route
                path="trainings"
                element={(
                  <PermissionRoute page="Trainings">
                    <Trainings />
                  </PermissionRoute>
                )}
              />
              <Route
                path="admin/system-monitor"
                element={(
                  <PermissionRoute page="System Monitor">
                    <SystemMonitor />
                  </PermissionRoute>
                )}
              />
              <Route
                path="admin/outlook-emails"
                element={(
                  <PermissionRoute page="Outlook Emails">
                    <OutlookEmails />
                  </PermissionRoute>
                )}
              />
              <Route
                path="admin/access-permissions"
                element={(
                  <PermissionRoute page="Access Permissions">
                    <AccessPermissions />
                  </PermissionRoute>
                )}
              />
              <Route
                path="admin/activity-log"
                element={(
                  <PermissionRoute page="Activity Log">
                    <ActivityLog />
                  </PermissionRoute>
                )}
              />
              <Route
                path="admin/roles"
                element={(
                  <PermissionRoute page="Role">
                    <Roles />
                  </PermissionRoute>
                )}
              />
              <Route
                path="admin/email-notifications"
                element={(
                  <PermissionRoute page="Email Notifications">
                    <EmailNotifications />
                  </PermissionRoute>
                )}
              />
            </Route>
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
        </BrowserRouter>
      </ToastProvider>
    </AuthProvider>
  );
}
