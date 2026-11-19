import { useState } from 'react';
import { Link, Navigate } from 'react-router-dom';
import { useAuth } from '../../context/AuthContext';

export default function Register() {
  const { register, isAuthenticated } = useAuth();
  const [form, setForm] = useState({
    name: '',
    login_name: '',
    email: '',
    password: '',
    password_confirmation: '',
  });
  const [error, setError] = useState('');
  const [submitting, setSubmitting] = useState(false);

  if (isAuthenticated) {
    return <Navigate to="/" replace />;
  }

  const handleSubmit = async (event) => {
    event.preventDefault();
    setSubmitting(true);
    setError('');
    try {
      await register({
        ...form,
        login_name: form.login_name.trim(),
        name: form.name.trim(),
        email: form.email.trim() || null,
      });
    } catch (err) {
      const fieldError = err.response?.data?.errors
        ? Object.values(err.response.data.errors).flat()[0]
        : null;
      const message = fieldError
        || err.response?.data?.message
        || (err.response?.status === 419
          ? 'Session expired. Refresh the page and try again.'
          : null)
        || (err.request && !err.response
          ? 'Cannot reach the API. Make sure the backend is running on port 8000.'
          : null)
        || 'Unable to register. Check your details and try again.';
      setError(message);
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="auth-page">
      <form className="auth-card" onSubmit={handleSubmit}>
        <p className="eyebrow">Workplanner</p>
        <h1>Create account</h1>

        {error && (
          <div className="alert alert-error" role="alert">
            {error}
          </div>
        )}

        <label>
          Display name
          <input
            value={form.name}
            onChange={(e) => setForm({ ...form, name: e.target.value })}
            required
          />
        </label>

        <label>
          Username
          <input
            value={form.login_name}
            onChange={(e) => setForm({ ...form, login_name: e.target.value })}
            autoComplete="username"
            required
          />
        </label>

        <label>
          Email (optional)
          <input
            type="email"
            value={form.email}
            onChange={(e) => setForm({ ...form, email: e.target.value })}
            placeholder="Used for email notifications only"
            autoComplete="email"
          />
        </label>

        <label>
          Password
          <input
            type="password"
            value={form.password}
            onChange={(e) => setForm({ ...form, password: e.target.value })}
            required
          />
        </label>

        <label>
          Confirm password
          <input
            type="password"
            value={form.password_confirmation}
            onChange={(e) =>
              setForm({ ...form, password_confirmation: e.target.value })
            }
            required
          />
        </label>

        <button type="submit" className="btn btn-secondary" disabled={submitting}>
          {submitting ? 'Creating account...' : 'Register'}
        </button>

        <p className="auth-footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </form>
    </div>
  );
}
