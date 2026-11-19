import { useEffect, useState } from 'react';
import api from '../../api/client';
import { TablePageSkeleton } from '../../components/PageSkeleton';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import { getApiErrorMessage } from '../../utils/apiErrors';
import { canPageAction } from '../../utils/userPermissions';

const emptyUser = () => ({
  first_name: '',
  last_name: '',
  login_name: '',
  email: '',
  password: '',
  active: true,
  role_id: '',
});

import { compareTeamNames } from '../../utils/teamOrder';

function sortUsersByTeam(users) {
  const newUsers = users.filter((user) => !user.id);
  const existing = [...users.filter((user) => user.id)].sort((a, b) => {
    if (a.is_admin !== b.is_admin) {
      return a.is_admin ? -1 : 1;
    }

    const teamCmp = compareTeamNames(a.team, b.team);
    if (teamCmp !== 0) {
      return teamCmp;
    }

    const first = (a.first_name || '').localeCompare(b.first_name || '', undefined, { sensitivity: 'base' });
    if (first !== 0) return first;

    return (a.last_name || '').localeCompare(b.last_name || '', undefined, { sensitivity: 'base' });
  });

  return [...newUsers, ...existing];
}

export default function AccessPermissions() {
  const { user } = useAuth();
  const toast = useToast();
  const canEdit = canPageAction(user, 'Access Permissions', 'manage_users');
  const [rows, setRows] = useState([]);
  const [originalRows, setOriginalRows] = useState([]);
  const [roles, setRoles] = useState([]);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  const loadData = async () => {
    setLoading(true);
    try {
      const [usersRes, rolesRes] = await Promise.all([
        api.get('/admin/users'),
        api.get('/roles'),
      ]);
      setRows(sortUsersByTeam(usersRes.data.data));
      setOriginalRows(sortUsersByTeam(usersRes.data.data));
      setRoles(rolesRes.data.data);
      setError('');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to load users.');
      setError(message);
      toast.error(message);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const setRow = (index, patch) => {
    setRows((current) =>
      current.map((row, rowIndex) => (rowIndex === index ? { ...row, ...patch } : row)),
    );
  };

  const addRow = () => {
    setRows((current) => [emptyUser(), ...current]);
  };

  const handleSave = async () => {
    const changedUsers = rows.filter((row) => {
      if (!row.id) {
        return true;
      }

      const original = originalRows.find((item) => item.id === row.id);
      if (!original) {
        return true;
      }

      return (
        row.first_name !== original.first_name ||
        row.last_name !== original.last_name ||
        row.login_name !== original.login_name ||
        (row.email || '') !== (original.email || '') ||
        (row.password || '') !== (original.password || '') ||
        row.active !== original.active ||
        String(row.role_id || '') !== String(original.role_id || '')
      );
    });

    if (changedUsers.length === 0) {
      setSuccess('No changes to save.');
      toast.info('No changes to save.');
      return;
    }

    for (const row of changedUsers) {
      if (!row.id && !row.password) {
        setError('Password is required for new users.');
        return;
      }
    }

    setSaving(true);
    setSuccess('');
    try {
      await api.post('/admin/users/sync', { users: changedUsers });
      setSuccess('Users saved successfully.');
      toast.success('Users saved successfully.');
      await loadData();
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to save users.');
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id) => {
    if (!window.confirm('Are you sure you want to delete this user?')) {
      return;
    }

    try {
      await api.delete(`/admin/users/${id}`);
      setRows((current) => sortUsersByTeam(current.filter((row) => row.id !== id)));
      setSuccess('User deleted successfully.');
      toast.success('User deleted successfully.');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to delete user.');
      setError(message);
      toast.error(message);
    }
  };

  if (loading) {
    return <TablePageSkeleton rows={8} cols={8} withActions className="skeleton-page--access-permissions" />;
  }

  return (
    <section className="access-permissions-page">
      <header className="page-header page-header-compact access-permissions-header">
        <div className="page-heading page-heading-row access-permissions-toolbar">
          <div className="page-heading-copy">
            <h2>Access Permissions</h2>
          </div>
          <div className="page-header-actions access-permissions-toolbar-actions">
            <button
              type="button"
              className="btn btn-secondary btn-compact"
              onClick={addRow}
              disabled={!canEdit}
            >
              Add user
            </button>
            <button
              type="button"
              className="btn btn-save btn-compact"
              onClick={handleSave}
              disabled={!canEdit || saving}
            >
              {saving ? 'Saving...' : 'Save'}
            </button>
          </div>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      <div className="table-card admin-table-wrap access-permissions-table-wrap">
        <table className="access-permissions-table">
          <thead>
            <tr>
              <th>First name</th>
              <th>Last name</th>
              <th>Login name</th>
              <th>Email</th>
              <th>Password</th>
              <th>Active</th>
              <th>Role</th>
              <th>Delete</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((row, index) => (
              <tr key={row.id ?? `new-${index}`}>
                <td>
                  <input
                    value={row.first_name || ''}
                    disabled={!canEdit}
                    onChange={(e) => setRow(index, { first_name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    value={row.last_name || ''}
                    disabled={!canEdit}
                    onChange={(e) => setRow(index, { last_name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    value={row.login_name || ''}
                    disabled={!canEdit}
                    onChange={(e) => setRow(index, { login_name: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type="email"
                    value={row.email || ''}
                    disabled={!canEdit}
                    placeholder="Notifications"
                    onChange={(e) => setRow(index, { email: e.target.value })}
                  />
                </td>
                <td>
                  <input
                    type={canEdit ? 'text' : 'password'}
                    value={row.password || ''}
                    placeholder={row.id ? 'Leave blank to keep' : 'Required'}
                    disabled={!canEdit}
                    autoComplete="off"
                    onChange={(e) => setRow(index, { password: e.target.value })}
                  />
                </td>
                <td className="text-center">
                  <input
                    type="checkbox"
                    checked={Boolean(row.active)}
                    disabled={!canEdit}
                    onChange={(e) => setRow(index, { active: e.target.checked })}
                  />
                </td>
                <td>
                  <select
                    value={row.role_id || ''}
                    disabled={!canEdit}
                    onChange={(e) => setRow(index, { role_id: e.target.value || null })}
                  >
                    <option value="">Select role</option>
                    {roles.map((role) => (
                      <option key={role.id} value={role.id}>
                        {role.name}
                      </option>
                    ))}
                  </select>
                </td>
                <td>
                  <button
                    type="button"
                    className="btn btn-danger btn-sm"
                    disabled={!canEdit || !row.id || row.is_admin}
                    onClick={() => handleDelete(row.id)}
                  >
                    Delete
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
