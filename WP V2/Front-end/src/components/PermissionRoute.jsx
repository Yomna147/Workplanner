import { Navigate } from 'react-router-dom';
import { AppLoadingSkeleton } from './PageSkeleton';
import { useAuth } from '../context/AuthContext';
import { canViewPage, getDefaultAccessibleRoute } from '../utils/userPermissions';

export default function PermissionRoute({ page, children }) {
  const { user, loading } = useAuth();

  if (loading) {
    return <AppLoadingSkeleton />;
  }

  if (canViewPage(user, page)) {
    return children;
  }

  const fallback = getDefaultAccessibleRoute(user);
  if (fallback) {
    return <Navigate to={fallback} replace />;
  }

  return (
    <section className="access-denied-page card">
      <h1 className="section-title">Access denied</h1>
      <p className="muted">
        You do not have permission to view any pages. Contact an administrator.
      </p>
    </section>
  );
}
