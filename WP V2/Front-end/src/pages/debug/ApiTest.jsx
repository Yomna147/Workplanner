import { useCallback, useMemo, useState } from 'react';
import api from '../../api/client';
import TtLoadStepsPanel from '../../components/TtLoadStepsPanel';
import { useAuth } from '../../context/AuthContext';
import {
  compareTtProjectsToWp,
  reportDurationHours,
  ttDiscoverUsers,
  ttForEachReportSlice,
  ttGetProjects,
  ttGetUsers,
  ttLogin,
  getCredentialsFromEnv,
} from '../../utils/timeTracking';
import {
  createInitialTtLoadSteps,
  formatStepError,
  patchTtLoadStep,
  resetTtLoadSteps,
  STEP_STATUS,
} from '../../utils/timeTracking/loadSteps';
import { formatDisplayDate } from '../../utils/dateFormat';
import '../../styles/tt-hours-page.css';

const sectionStyle = {
  marginTop: 24,
  border: '1px solid #ddd',
  borderRadius: 8,
  overflow: 'hidden',
};

const sectionHeaderStyle = {
  padding: '12px 16px',
  background: '#f5f5f5',
  fontWeight: 600,
  borderBottom: '1px solid #ddd',
};

const tableStyle = {
  width: '100%',
  borderCollapse: 'collapse',
};

const cellStyle = {
  padding: 8,
  borderBottom: '1px solid #eee',
  fontSize: 14,
};

/**
 * Debug page — same step flow as v1 apitest, with visible per-step status.
 * Route: /apitest
 */
export default function ApiTest() {
  const { user } = useAuth();
  const [token, setToken] = useState('');
  const [users, setUsers] = useState([]);
  const [ttProjects, setTtProjects] = useState([]);
  const [wpProjects, setWpProjects] = useState([]);
  const [comparison, setComparison] = useState(null);
  const [reports, setReports] = useState([]);
  const [loading, setLoading] = useState(false);
  const [usersSource, setUsersSource] = useState('');
  const [loadSteps, setLoadSteps] = useState(() => createInitialTtLoadSteps());

  const setStep = useCallback((id, patch) => {
    setLoadSteps((current) => patchTtLoadStep(current, id, patch));
  }, []);

  const totalReportHours = useMemo(
    () => reports.reduce((sum, row) => sum + reportDurationHours(row), 0),
    [reports],
  );

  const loadEverything = useCallback(async () => {
    setLoading(true);
    setLoadSteps(resetTtLoadSteps(createInitialTtLoadSteps()));
    setReports([]);
    setTtProjects([]);
    setWpProjects([]);
    setComparison(null);
    setUsers([]);
    setToken('');

    try {
      setStep('wp-session', { status: STEP_STATUS.running });
      if (!user) {
        throw new Error('Not logged into Work Planner — Sanctum session missing.');
      }
      setStep('wp-session', {
        status: STEP_STATUS.ok,
        detail: `Logged in as ${user.loginname || user.name || user.email || 'WP user'}`,
      });

      setStep('tt-login', { status: STEP_STATUS.running });
      const { loginname: ttLoginName, password: ttPassword } = getCredentialsFromEnv();
      const { token: sessionToken, raw: loginRaw } = await ttLogin(ttLoginName, ttPassword);
      setToken(sessionToken);
      localStorage.setItem('tt_token', sessionToken);
      setStep('tt-login', {
        status: STEP_STATUS.ok,
        detail: `Token for "${loginRaw?.loginname || 'yomna'}"${loginRaw?.base_url ? ` via ${loginRaw.base_url}` : ''}`,
      });

      const loginname = loginRaw?.loginname ?? 'yomna';
      setStep('tt-users', { status: STEP_STATUS.running });
      let discoveredUsers = [];
      try {
        discoveredUsers = await ttGetUsers(sessionToken, {
          id: 1,
          loginname,
          firstname: loginRaw?.firstname ?? loginname,
          lastname: loginRaw?.lastname ?? '',
        });
        setUsersSource('getuserlist');
        setUsers(discoveredUsers);
        setStep('tt-users', {
          status: STEP_STATUS.ok,
          detail: `${discoveredUsers.length} users via Getuserlist`,
        });
      } catch (listErr) {
        try {
          discoveredUsers = await ttDiscoverUsers(sessionToken);
          setUsersSource('individualSearch');
          setUsers(discoveredUsers);
          setStep('tt-users', {
            status: discoveredUsers.length ? STEP_STATUS.warn : STEP_STATUS.error,
            detail: discoveredUsers.length
              ? `Getuserlist failed; ${discoveredUsers.length} users via IndividualSearch (current year) (${formatStepError(listErr)})`
              : formatStepError(listErr),
          });
          if (!discoveredUsers.length) throw listErr;
        } catch (discoverErr) {
          setStep('tt-users', {
            status: STEP_STATUS.error,
            detail: `${formatStepError(listErr)} · ${formatStepError(discoverErr)}`,
          });
          throw discoverErr;
        }
      }

      setStep('tt-projects', { status: STEP_STATUS.running });
      const projects = await ttGetProjects(sessionToken);
      setTtProjects(projects);
      setStep('tt-projects', {
        status: STEP_STATUS.ok,
        detail: `${projects.length} TT projects`,
      });

      setStep('wp-projects', { status: STEP_STATUS.running });
      const wpResp = await api.get('/projects/tt-comparison', { params: { all: true } });
      const wpList = wpResp.data?.data ?? [];
      setWpProjects(wpList);
      setStep('wp-projects', {
        status: STEP_STATUS.ok,
        detail: `${wpList.length} WP projects`,
      });

      setStep('compare', { status: STEP_STATUS.running });
      const nextComparison = compareTtProjectsToWp(projects, wpList);
      setComparison(nextComparison);
      setStep('compare', {
        status: STEP_STATUS.ok,
        detail: `${nextComparison.stats.matchedCount} matched · ${nextComparison.stats.ttOnlyCount} TT only · ${nextComparison.stats.wpOnlyCount} WP only`,
      });

      setStep('report-slices', { status: STEP_STATUS.running, detail: 'Starting…' });
      setStep('summaries', { status: STEP_STATUS.skipped, detail: 'N/A on apitest page' });
      const allReports = [];
      await ttForEachReportSlice(sessionToken, {}, async ({
        reports: sliceReports,
        label,
        index,
        total,
      }) => {
        allReports.push(...sliceReports);
        setReports([...allReports]);
        setStep('report-slices', {
          status: STEP_STATUS.running,
          detail: `${label} (${index}/${total}) · ${allReports.length} rows`,
        });
      });
      setStep('report-slices', {
        status: STEP_STATUS.ok,
        detail: `${allReports.length} report rows loaded`,
      });
    } catch (err) {
      console.error(err);
      const message = formatStepError(err);
      setLoadSteps((current) => {
        const runningStep = current.find((step) => step.status === STEP_STATUS.running);
        if (!runningStep) return current;
        return patchTtLoadStep(current, runningStep.id, {
          status: STEP_STATUS.error,
          detail: message,
        });
      });
    } finally {
      setLoading(false);
    }
  }, [setStep, user]);

  const handleClear = () => {
    setToken('');
    localStorage.removeItem('tt_token');
    setUsers([]);
    setTtProjects([]);
    setWpProjects([]);
    setComparison(null);
    setReports([]);
    setLoadSteps(resetTtLoadSteps(createInitialTtLoadSteps()));
  };

  const formatDate = (isoDate) => {
    if (!isoDate) return '—';
    return formatDisplayDate(isoDate) || '—';
  };

  return (
    <div className="page tt-hours-page" style={{ padding: 20, maxWidth: 1400, margin: '0 auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', gap: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>Time Tracking API (Postman)</h1>
          <p style={{ color: '#666', fontSize: 14, marginTop: 8 }}>
            v1 apitest flow with step-by-step status — run each API call in order to find failures.
          </p>
        </div>
        <div style={{ display: 'flex', gap: 8 }}>
          <button type="button" className="btn btn-primary" onClick={loadEverything} disabled={loading}>
            {loading ? 'Running steps…' : 'Run all steps'}
          </button>
          <button type="button" className="btn" onClick={handleClear} disabled={loading}>
            Clear
          </button>
        </div>
      </div>

      <TtLoadStepsPanel steps={loadSteps} title="TT API steps" />

      {token ? (
        <>
          <p style={{ marginTop: 16 }}>
            <strong>{users.length}</strong>
            {' '}
            users (via
            {' '}
            {usersSource || 'IndividualSearch'}
            ) ·
            {' '}
            <strong>{ttProjects.length}</strong>
            {' '}
            TT projects ·
            {' '}
            <strong>{wpProjects.length}</strong>
            {' '}
            WP projects ·
            {' '}
            <strong>{reports.length}</strong>
            {' '}
            report rows ·
            {' '}
            <strong>{totalReportHours.toFixed(1)}</strong>
            {' '}
            total hours
          </p>

          <div style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              TT Users (
              {users.length}
              )
            </div>
            <div style={{ maxHeight: 220, overflow: 'auto' }}>
              <table style={tableStyle}>
                <thead>
                  <tr style={{ background: '#fafafa' }}>
                    <th style={cellStyle}>ID</th>
                    <th style={cellStyle}>First name</th>
                    <th style={cellStyle}>Last name</th>
                  </tr>
                </thead>
                <tbody>
                  {users.map((ttUser) => (
                    <tr key={ttUser.id}>
                      <td style={cellStyle}>{ttUser.id}</td>
                      <td style={cellStyle}>{ttUser.firstname || '—'}</td>
                      <td style={cellStyle}>{ttUser.lastname || '—'}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <div style={sectionStyle}>
            <div style={sectionHeaderStyle}>
              All Reports (
              {reports.length}
              )
            </div>
            <div style={{ maxHeight: 520, overflow: 'auto' }}>
              {reports.length > 0 ? (
                <table style={tableStyle}>
                  <thead>
                    <tr style={{ background: '#fafafa', position: 'sticky', top: 0 }}>
                      <th style={cellStyle}>Date</th>
                      <th style={cellStyle}>Project</th>
                      <th style={cellStyle}>Action</th>
                      <th style={cellStyle}>User</th>
                      <th style={cellStyle}>Hours</th>
                    </tr>
                  </thead>
                  <tbody>
                    {reports.map((row, index) => (
                      <tr key={index}>
                        <td style={cellStyle}>{formatDate(row.t?.date)}</td>
                        <td style={cellStyle}>{row.p?.name || '—'}</td>
                        <td style={cellStyle}>{row.a?.name || '—'}</td>
                        <td style={cellStyle}>
                          {row.u?.firstname}
                          {' '}
                          {row.u?.lastname}
                        </td>
                        <td style={cellStyle}>{reportDurationHours(row).toFixed(1)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              ) : (
                <p style={{ padding: 16 }}>No reports yet — complete step 8 above.</p>
              )}
            </div>
          </div>
        </>
      ) : (
        <p className="muted" style={{ marginTop: 16 }}>
          Click <strong>Run all steps</strong> to start the v1 apitest flow.
        </p>
      )}
    </div>
  );
}
