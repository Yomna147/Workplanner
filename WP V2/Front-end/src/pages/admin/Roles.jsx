import { useEffect, useMemo, useState } from 'react';
import api from '../../api/client';
import { RolesPageSkeleton } from '../../components/PageSkeleton';
import { useAuth } from '../../context/AuthContext';
import { useToast } from '../../context/ToastContext';
import usePageTitle from '../../hooks/usePageTitle';
import { getApiErrorMessage } from '../../utils/apiErrors';
import {
  isActivePermissionPage,
  prepareActivePermissionPages,
} from '../../utils/activePermissionPages';
import {
  ACTION_GROUP_LABELS,
  PAGE_PERMISSION_CATALOG,
  getCatalogEntry,
  legacyPageActions,
} from '../../constants/pagePermissionCatalog';
import { canPageAction } from '../../utils/userPermissions';

const ACTION_GROUP_ORDER = ['editing', 'additional', 'notifications'];

function emptyPermissionRow(page, catalogEntry) {
  return {
    id: null,
    page: page.name,
    permission: 0,
    notification_permission: 0,
    actions: [],
    description: catalogEntry?.description || '',
  };
}

function normalizeRoleActions(existing, catalogEntry) {
  const pagePermission = Number(existing.permission) || 0;
  let notificationPermission = Number(existing.notification_permission);
  if (!Number.isFinite(notificationPermission) || notificationPermission < 0) {
    notificationPermission = 0;
  }
  if (
    existing.page === 'Trainings'
    && notificationPermission <= 0
    && pagePermission >= 2
  ) {
    notificationPermission = pagePermission;
  }

  const actions = Array.isArray(existing.actions)
    ? existing.actions
    : legacyPageActions(existing.page, pagePermission, {
      notification_permission: notificationPermission,
    });

  const allowed = new Set((catalogEntry?.actions || []).map((action) => action.key));
  return {
    id: existing.id,
    page: existing.page,
    permission: pagePermission >= 2 ? 2 : 0,
    notification_permission: notificationPermission,
    actions: actions.filter((key) => allowed.has(key)),
    description: catalogEntry?.description || '',
  };
}

function groupedCatalogActions(catalogEntry) {
  const groups = new Map();
  (catalogEntry?.actions || []).forEach((action) => {
    const group = action.group || 'editing';
    if (!groups.has(group)) {
      groups.set(group, []);
    }
    groups.get(group).push(action);
  });
  return ACTION_GROUP_ORDER
    .filter((key) => groups.has(key))
    .map((key) => ({ key, label: ACTION_GROUP_LABELS[key] || key, actions: groups.get(key) }));
}

function pageAccessMeta(row, catalogEntry) {
  const total = (catalogEntry?.actions || []).length;
  if ((Number(row.permission) || 0) < 2) {
    return { tone: 'none', label: 'No access', count: 0, total };
  }
  const count = (row.actions || []).length;
  if (total === 0 || count === 0) {
    return { tone: 'view', label: 'View only', count, total };
  }
  if (count >= total) {
    return { tone: 'full', label: 'Full access', count, total };
  }
  return { tone: 'partial', label: `${count} of ${total} actions`, count, total };
}

function summarizePermissionRow(row, catalogEntry) {
  const meta = pageAccessMeta(row, catalogEntry);
  if (meta.tone === 'none' || meta.tone === 'view' || meta.tone === 'full') {
    return meta.label;
  }
  const labels = (catalogEntry?.actions || [])
    .filter((action) => (row.actions || []).includes(action.key))
    .map((action) => action.label);
  return `View · ${labels.join(' · ')}`;
}

function ChevronIcon({ open }) {
  return (
    <svg className={`roles-chevron${open ? ' is-open' : ''}`} width="14" height="14" viewBox="0 0 20 20" aria-hidden="true">
      <path d="M5 7.5 10 12.5 15 7.5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function catalogMapFromApi(catalog) {
  const list = Array.isArray(catalog) && catalog.length ? catalog : PAGE_PERMISSION_CATALOG;
  return new Map(list.map((entry) => [entry.page, entry]));
}

export default function Roles() {
  const { user } = useAuth();
  const toast = useToast();
  const canEdit = canPageAction(user, 'Role', 'manage_roles');
  const [roles, setRoles] = useState([]);
  const [pages, setPages] = useState([]);
  const [catalogByPage, setCatalogByPage] = useState(() => catalogMapFromApi());
  const [editing, setEditing] = useState(false);
  const [roleForm, setRoleForm] = useState({ id: null, name: '' });
  const [permissionRows, setPermissionRows] = useState([]);
  const [expandedRoleId, setExpandedRoleId] = useState(null);
  const [expandedPages, setExpandedPages] = useState(() => new Set());
  const [pageFilter, setPageFilter] = useState('all');
  const [pageQuery, setPageQuery] = useState('');
  const [newPage, setNewPage] = useState({ name: '', route: '' });
  const [showNewPageForm, setShowNewPageForm] = useState(false);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);

  usePageTitle(editing ? 'Role Add/Edit' : 'Roles');

  const loadRoles = async () => {
    const response = await api.get('/roles');
    setRoles(response.data.data);
    if (response.data.catalog) {
      setCatalogByPage(catalogMapFromApi(response.data.catalog));
    }
  };

  const loadPages = async () => {
    const response = await api.get('/pages');
    const activePages = prepareActivePermissionPages(response.data.data);
    setPages(activePages);
    if (response.data.catalog) {
      setCatalogByPage(catalogMapFromApi(response.data.catalog));
    }
    return activePages;
  };

  const loadData = async () => {
    setLoading(true);
    try {
      await Promise.all([loadRoles(), loadPages()]);
      setError('');
    } catch {
      setError('Unable to load roles.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    loadData();
  }, []);

  const startCreate = async () => {
    try {
      const pageList = pages.length ? pages : await loadPages();
      setRoleForm({ id: null, name: '' });
      setPermissionRows(pageList.map((page) => emptyPermissionRow(page, catalogByPage.get(page.name))));
      setExpandedPages(new Set());
      setPageFilter('all');
      setPageQuery('');
      setShowNewPageForm(false);
      setEditing(true);
      setError('');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to load pages.');
      setError(message);
      toast.error(message);
    }
  };

  const startEdit = async (role) => {
    try {
      const [roleRes, pageList] = await Promise.all([
        api.get(`/roles/${role.id}`),
        pages.length ? Promise.resolve({ data: { data: pages } }) : api.get('/pages'),
      ]);

      if (roleRes.data.catalog) {
        setCatalogByPage(catalogMapFromApi(roleRes.data.catalog));
      }

      const permissions = roleRes.data.data.permissions || [];
      const allPages = prepareActivePermissionPages(pageList.data.data);
      const catalog = roleRes.data.catalog
        ? catalogMapFromApi(roleRes.data.catalog)
        : catalogByPage;

      const merged = allPages.map((page) => {
        const existing = permissions.find((item) => item.page === page.name);
        const entry = catalog.get(page.name) || getCatalogEntry(page.name);
        if (!existing) {
          return emptyPermissionRow(page, entry);
        }
        return normalizeRoleActions(existing, entry);
      });

      setRoleForm({ id: role.id, name: roleRes.data.data.role.name });
      setPermissionRows(merged);
      setExpandedPages(new Set());
      setPageFilter('all');
      setPageQuery('');
      setShowNewPageForm(false);
      setEditing(true);
      setError('');
    } catch {
      setError('Unable to load role details.');
    }
  };

  const handleSave = async () => {
    if (!roleForm.name.trim()) {
      setError('Role name is required.');
      return;
    }

    setSaving(true);
    setSuccess('');
    try {
      const payload = {
        id: roleForm.id,
        name: roleForm.name.trim(),
        permissions: permissionRows
          .filter((row) => isActivePermissionPage(row.page))
          .map((row) => ({
            id: row.id,
            page: row.page,
            permission: (Number(row.permission) || 0) < 2 ? 0 : ((row.actions || []).length ? 3 : 2),
            notification_permission: row.page === 'Trainings'
              ? ((row.actions || []).includes('assign_from_gaps')
                ? 3
                : ((row.actions || []).includes('receive_gap_alerts') ? 2 : 0))
              : 0,
            actions: (Number(row.permission) || 0) < 2 ? [] : (row.actions || []),
          })),
      };

      if (roleForm.id) {
        await api.put(`/roles/${roleForm.id}`, payload);
      } else {
        await api.post('/roles', payload);
      }

      setSuccess('Role saved successfully.');
      toast.success('Role saved successfully.');
      setEditing(false);
      await loadRoles();
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to save role.');
      setError(message);
      toast.error(message);
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (roleId) => {
    if (!window.confirm('Are you sure you want to delete this role?')) {
      return;
    }

    try {
      await api.delete(`/roles/${roleId}`);
      setRoles((current) => current.filter((role) => role.id !== roleId));
      setSuccess('Role deleted successfully.');
      toast.success('Role deleted successfully.');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to delete role.');
      setError(message);
      toast.error(message);
    }
  };

  const handleAddPage = async () => {
    if (!newPage.name.trim()) {
      setError('Page name is required.');
      return;
    }

    try {
      const response = await api.post('/pages', {
        name: newPage.name.trim(),
        route: newPage.route.trim() || null,
      });
      const created = response.data.data;
      if (!isActivePermissionPage(created.name)) {
        setSuccess('Page added to the catalogue. Enable it in navigation before assigning permissions.');
        toast.success('Page saved. Add it to the nav menu to use it in role permissions.');
        setNewPage({ name: '', route: '' });
        setShowNewPageForm(false);
        return;
      }
      setPages((current) => prepareActivePermissionPages([...current, created]));
      setPermissionRows((current) => [...current, emptyPermissionRow(created, catalogByPage.get(created.name))]);
      setNewPage({ name: '', route: '' });
      setShowNewPageForm(false);
      setSuccess('Page added successfully.');
      toast.success('Page added successfully.');
    } catch (err) {
      const message = getApiErrorMessage(err, 'Unable to add page.');
      setError(message);
      toast.error(message);
    }
  };

  const setPageAccess = (index, access) => {
    const nextAccess = Number(access);
    setPermissionRows((current) =>
      current.map((row, rowIndex) => {
        if (rowIndex !== index) {
          return row;
        }
        if (nextAccess < 2) {
          return { ...row, permission: 0, actions: [] };
        }
        return { ...row, permission: 2 };
      }),
    );
    setExpandedPages((current) => {
      const next = new Set(current);
      const pageName = permissionRows[index]?.page;
      if (!pageName) {
        return current;
      }
      if (nextAccess < 2) {
        next.delete(pageName);
      } else {
        next.add(pageName);
      }
      return next;
    });
  };

  const toggleAction = (index, actionKey, checked) => {
    setPermissionRows((current) =>
      current.map((row, rowIndex) => {
        if (rowIndex !== index) {
          return row;
        }
        const catalogEntry = catalogByPage.get(row.page) || getCatalogEntry(row.page);
        const allowed = new Set((catalogEntry?.actions || []).map((action) => action.key));
        let next = new Set(row.actions || []);
        if (checked) {
          next.add(actionKey);
          if (actionKey === 'assign_from_gaps') {
            next.add('receive_gap_alerts');
          }
        } else {
          next.delete(actionKey);
          if (actionKey === 'receive_gap_alerts') {
            next.delete('assign_from_gaps');
          }
        }
        const actions = [...next].filter((key) => allowed.has(key));
        return {
          ...row,
          permission: 2,
          actions,
        };
      }),
    );
  };

  const setAllActions = (index, enabled) => {
    setPermissionRows((current) =>
      current.map((row, rowIndex) => {
        if (rowIndex !== index) {
          return row;
        }
        const catalogEntry = catalogByPage.get(row.page) || getCatalogEntry(row.page);
        return {
          ...row,
          permission: 2,
          actions: enabled ? (catalogEntry?.actions || []).map((action) => action.key) : [],
        };
      }),
    );
  };

  const editorStats = useMemo(() => {
    const granted = permissionRows.filter((row) => Number(row.permission) >= 2);
    return {
      total: permissionRows.length,
      granted: granted.length,
      withActions: granted.filter((row) => (row.actions || []).length > 0).length,
    };
  }, [permissionRows]);

  const visiblePermissionRows = useMemo(() => {
    const query = pageQuery.trim().toLowerCase();
    return permissionRows
      .map((row, index) => ({ row, index }))
      .filter(({ row }) => {
        const canView = Number(row.permission) >= 2;
        if (pageFilter === 'granted' && !canView) {
          return false;
        }
        if (pageFilter === 'blocked' && canView) {
          return false;
        }
        if (!query) {
          return true;
        }
        const haystack = `${row.page} ${row.description || ''}`.toLowerCase();
        return haystack.includes(query);
      });
  }, [pageFilter, pageQuery, permissionRows]);

  const togglePageExpanded = (pageName) => {
    setExpandedPages((current) => {
      const next = new Set(current);
      if (next.has(pageName)) {
        next.delete(pageName);
      } else {
        next.add(pageName);
      }
      return next;
    });
  };

  const expandAllPages = () => {
    setExpandedPages(new Set(visiblePermissionRows.map(({ row }) => row.page)));
  };

  const collapseAllPages = () => {
    setExpandedPages(new Set());
  };

  const roleSummaries = useMemo(() => (
    roles.map((role) => {
      const rows = (role.permissions || [])
        .filter((item) => isActivePermissionPage(item.page) && Number(item.permission) >= 2)
        .map((item) => {
          const entry = catalogByPage.get(item.page) || getCatalogEntry(item.page);
          const normalized = normalizeRoleActions(item, entry);
          return {
            page: item.page,
            summary: summarizePermissionRow(normalized, entry),
          };
        });
      return { role, pages: rows };
    })
  ), [roles, catalogByPage]);

  if (loading) {
    return <RolesPageSkeleton />;
  }

  return (
    <section className={`roles-page${editing ? ' is-editing' : ''}`}>
      <header className="page-header page-header-compact roles-header">
        <div className="page-heading page-heading-row roles-toolbar">
          <div className="page-heading-copy">
            <h2>{editing ? (roleForm.id ? 'Edit role' : 'New role') : 'Roles'}</h2>
            <p className="roles-description">
              {editing
                ? 'Turn on a page, then choose the actions this role may use there.'
                : 'Review each role, then open it to set page access and actions.'}
            </p>
          </div>
          <div className="page-header-actions roles-toolbar-actions">
            {editing ? (
              <>
                <button
                  type="button"
                  className="btn btn-secondary btn-compact"
                  onClick={() => setEditing(false)}
                >
                  Back
                </button>
                <button
                  type="button"
                  className="btn btn-save btn-compact"
                  onClick={handleSave}
                  disabled={!canEdit || saving}
                >
                  {saving ? 'Saving...' : 'Save'}
                </button>
              </>
            ) : (
              <button
                type="button"
                className="btn btn-secondary btn-compact"
                onClick={startCreate}
                disabled={!canEdit}
              >
                Add role
              </button>
            )}
          </div>
        </div>
      </header>

      {error && <div className="alert alert-error">{error}</div>}
      {success && <div className="alert alert-success">{success}</div>}

      {!editing ? (
        <div className="roles-home-grid">
          {roleSummaries.map(({ role, pages: pageRows }) => {
            const expanded = expandedRoleId === role.id;
            const preview = pageRows.slice(0, 5);
            const extra = pageRows.length - preview.length;
            return (
              <article key={role.id} className={`roles-home-card${expanded ? ' is-expanded' : ''}`}>
                <div className="roles-home-card-head">
                  <div className="roles-home-identity">
                    <span className="roles-home-avatar" aria-hidden="true">
                      {String(role.name || '?').slice(0, 1).toUpperCase()}
                    </span>
                    <div>
                      <h3>{role.name}</h3>
                      <p className="muted">
                        {pageRows.length === 0
                          ? 'No pages'
                          : `${pageRows.length} page${pageRows.length === 1 ? '' : 's'} enabled`}
                      </p>
                    </div>
                  </div>
                  <div className="roles-row-actions">
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => setExpandedRoleId(expanded ? null : role.id)}
                    >
                      {expanded ? 'Hide' : 'Details'}
                    </button>
                    <button
                      type="button"
                      className="btn btn-secondary btn-sm"
                      onClick={() => startEdit(role)}
                    >
                      Edit
                    </button>
                    <button
                      type="button"
                      className="btn btn-danger btn-sm"
                      disabled={!canEdit}
                      onClick={() => handleDelete(role.id)}
                    >
                      Delete
                    </button>
                  </div>
                </div>
                {pageRows.length > 0 ? (
                  <div className="roles-home-chips">
                    {preview.map((row) => (
                      <span key={row.page} className="roles-home-chip">{row.page}</span>
                    ))}
                    {extra > 0 ? <span className="roles-home-chip is-more">+{extra}</span> : null}
                  </div>
                ) : (
                  <p className="roles-home-empty muted">This role cannot open any pages yet.</p>
                )}
                {expanded ? (
                  <ul className="roles-capability-details">
                    {pageRows.length === 0 ? (
                      <li className="muted">Assign pages from Edit.</li>
                    ) : pageRows.map((row) => (
                      <li key={row.page}>
                        <strong>{row.page}</strong>
                        <span>{row.summary}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </article>
            );
          })}
        </div>
      ) : (
        <div className="roles-editor">
          <div className="card roles-editor-meta">
            <label className="roles-name-field">
              Role name
              <input
                value={roleForm.name}
                disabled={!canEdit}
                placeholder="e.g. Trainer"
                onChange={(e) => setRoleForm({ ...roleForm, name: e.target.value })}
              />
            </label>
            <div className="roles-editor-stats" aria-live="polite">
              <span><strong>{editorStats.granted}</strong> of {editorStats.total} pages</span>
              <span><strong>{editorStats.withActions}</strong> with actions</span>
            </div>
            <label className="roles-editor-search">
              <span className="visually-hidden">Search pages</span>
              <input
                value={pageQuery}
                placeholder="Search pages"
                onChange={(e) => setPageQuery(e.target.value)}
              />
            </label>
            <div className="roles-filter-toggle" role="group" aria-label="Filter pages">
              {[
                { id: 'all', label: 'All' },
                { id: 'granted', label: 'Enabled' },
                { id: 'blocked', label: 'Off' },
              ].map((option) => (
                <button
                  key={option.id}
                  type="button"
                  className={pageFilter === option.id ? 'is-active' : ''}
                  onClick={() => setPageFilter(option.id)}
                >
                  {option.label}
                </button>
              ))}
            </div>
            <div className="roles-editor-meta-actions">
              <button type="button" className="roles-text-btn" onClick={expandAllPages}>
                Expand all
              </button>
              <button type="button" className="roles-text-btn" onClick={collapseAllPages}>
                Collapse all
              </button>
              {!showNewPageForm ? (
                <button
                  type="button"
                  className="btn btn-secondary btn-sm"
                  disabled={!canEdit}
                  onClick={() => setShowNewPageForm(true)}
                >
                  Add page
                </button>
              ) : (
                <div className="roles-inline-form">
                  <input
                    value={newPage.name}
                    placeholder="Page name"
                    onChange={(e) => setNewPage({ ...newPage, name: e.target.value })}
                  />
                  <input
                    value={newPage.route}
                    placeholder="/route"
                    onChange={(e) => setNewPage({ ...newPage, route: e.target.value })}
                  />
                  <button type="button" className="btn btn-secondary btn-sm" onClick={() => setShowNewPageForm(false)}>
                    Cancel
                  </button>
                  <button
                    type="button"
                    className="btn btn-save btn-sm"
                    disabled={!canEdit}
                    onClick={handleAddPage}
                  >
                    Save page
                  </button>
                </div>
              )}
            </div>
          </div>

          <div className="card roles-page-list">
            {visiblePermissionRows.length === 0 ? (
              <p className="roles-editor-empty muted">No pages match this filter.</p>
            ) : visiblePermissionRows.map(({ row, index }) => {
              const catalogEntry = catalogByPage.get(row.page) || getCatalogEntry(row.page);
              const canView = (Number(row.permission) || 0) >= 2;
              const groups = groupedCatalogActions(catalogEntry);
              const meta = pageAccessMeta(row, catalogEntry);
              const open = expandedPages.has(row.page);
              return (
                <article
                  key={`${row.page}-${index}`}
                  className={`roles-page-card${canView ? ' is-enabled' : ' is-disabled'}${open ? ' is-open' : ''}`}
                >
                  <header className="roles-page-card-head">
                    <button
                      type="button"
                      className="roles-page-card-toggle"
                      onClick={() => togglePageExpanded(row.page)}
                      aria-expanded={open}
                    >
                      <ChevronIcon open={open} />
                      <span>
                        <h3>{row.page}</h3>
                        <p className="muted">{row.description || catalogEntry?.description || 'Page access for this role.'}</p>
                      </span>
                    </button>
                    <div className="roles-page-card-controls">
                      <span className={`roles-status-pill tone-${meta.tone}`}>{meta.label}</span>
                      <div className="roles-access-toggle" role="group" aria-label={`${row.page} access`}>
                        <button
                          type="button"
                          className={!canView ? 'is-active' : ''}
                          disabled={!canEdit}
                          aria-pressed={!canView}
                          onClick={() => setPageAccess(index, 0)}
                        >
                          Off
                        </button>
                        <button
                          type="button"
                          className={canView ? 'is-active is-view' : ''}
                          disabled={!canEdit}
                          aria-pressed={canView}
                          onClick={() => setPageAccess(index, 2)}
                        >
                          View
                        </button>
                      </div>
                    </div>
                  </header>

                  {open ? (
                    groups.length === 0 ? (
                      <p className="roles-page-view-only muted">
                        {canView ? 'This page is view-only. There are no extra actions to assign.' : 'Turn on View to grant access.'}
                      </p>
                    ) : (
                      <div className="roles-page-card-body">
                        <div className="roles-page-card-tools">
                          <button
                            type="button"
                            className="roles-text-btn"
                            disabled={!canEdit || !canView}
                            onClick={() => setAllActions(index, true)}
                          >
                            Select all
                          </button>
                          <button
                            type="button"
                            className="roles-text-btn"
                            disabled={!canEdit || !canView}
                            onClick={() => setAllActions(index, false)}
                          >
                            View only
                          </button>
                        </div>
                        {groups.map((group) => (
                          <fieldset key={group.key} className="roles-action-group" disabled={!canEdit || !canView}>
                            <legend>{group.label}</legend>
                            <ul className="roles-action-list">
                              {group.actions.map((action) => {
                                const checked = (row.actions || []).includes(action.key);
                                return (
                                  <li key={action.key}>
                                    <label className={`roles-action-item${checked ? ' is-checked' : ''}`}>
                                      <input
                                        type="checkbox"
                                        checked={checked}
                                        disabled={!canEdit || !canView}
                                        onChange={(e) => toggleAction(index, action.key, e.target.checked)}
                                      />
                                      <span>
                                        <strong>{action.label}</strong>
                                        <small>{action.description}</small>
                                      </span>
                                    </label>
                                  </li>
                                );
                              })}
                            </ul>
                          </fieldset>
                        ))}
                      </div>
                    )
                  ) : null}
                </article>
              );
            })}
          </div>
        </div>
      )}
    </section>
  );
}
