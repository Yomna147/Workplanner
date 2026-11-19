import { useState } from 'react';
import { Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { getDefaultAccessibleRoute } from '../../utils/userPermissions';
import tsaLogo from '../../assets/tsa-logo.png';

export default function Login() {
  const { login, isAuthenticated, user } = useAuth();
  const [loginName, setLoginName] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) {
    const target = getDefaultAccessibleRoute(user) || '/';
    return <Navigate to={target} replace />;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!loginName.trim() || !password) {
      setError('Please enter both username and password');
      return;
    }

    setSubmitting(true);
    setError('');
    try {
      await login(loginName.trim(), password);
    } catch (err) {
      setError(getApiErrorMessage(
        err,
        'Invalid username or password.',
        { context: 'login' },
      ));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="login-container">
          <div className="login-logo">
            <img src={tsaLogo} alt="TSA Trevor Sadd Associates" />
          </div>

          <form className="login-form" onSubmit={handleSubmit}>
            <div className="login-heading">
              <h1>Login</h1>
              <p>Welcome to TSA - Workplanner</p>
            </div>

            <div className="login-fields">
              <div className="login-field">
                <input
                  id="loginname"
                  type="text"
                  value={loginName}
                  onChange={(e) => setLoginName(e.target.value)}
                  placeholder=" "
                  autoComplete="username"
                />
                <label htmlFor="loginname">Login Name</label>
              </div>

              <div className="login-field">
                <input
                  id="password"
                  type="password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder=" "
                  autoComplete="current-password"
                />
                <label htmlFor="password">Password</label>
              </div>
            </div>

            {error ? (
              <div className="login-error-banner" role="alert" aria-live="polite">
                <span className="login-error-banner-icon" aria-hidden="true">!</span>
                <div className="login-error-banner-copy">
                  <strong>Unable to sign in</strong>
                  <p>{error}</p>
                </div>
              </div>
            ) : null}

            <button type="submit" className="login-submit" disabled={submitting}>
              {submitting ? 'Logging in…' : 'Login'}
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
