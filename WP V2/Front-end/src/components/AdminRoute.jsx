import { Navigate, Outlet } from 'react-router-dom';
import { AppLoadingSkeleton } from './PageSkeleton';
import { useAuth } from '../context/AuthContext';

export default function AdminRoute() {
  const { user, loading } = useAuth();

  if (loading) {
    return <AppLoadingSkeleton />;
  }

  if (!user?.is_admin) {
    return <Navigate to="/" replace />;
  }

  return <Outlet />;
}
