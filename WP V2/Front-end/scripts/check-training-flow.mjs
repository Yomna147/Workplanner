/**
 * End-to-end smoke checks for training create + display shaping.
 * Run from Front-end: node scripts/check-training-flow.mjs
 *
 * Uses VITE_API_BASE_URL from .env when present (default http://127.0.0.1:8000/api).
 */
import { readFileSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = resolve(__dirname, '..');

function loadEnv() {
  try {
    const text = readFileSync(resolve(root, '.env'), 'utf8');
    const map = {};
    text.split(/\r?\n/).forEach((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return;
      const idx = trimmed.indexOf('=');
      if (idx < 0) return;
      map[trimmed.slice(0, idx)] = trimmed.slice(idx + 1).trim();
    });
    return map;
  } catch {
    return {};
  }
}

const env = loadEnv();
const API = (env.VITE_API_BASE_URL || 'http://127.0.0.1:8000/api').replace(/\/$/, '');

let passed = 0;
let failed = 0;

function assert(condition, label) {
  if (condition) {
    passed += 1;
    console.log(`  PASS  ${label}`);
    return;
  }
  failed += 1;
  console.error(`  FAIL  ${label}`);
}

function toYmd(value) {
  if (value == null || value === '') return '';
  const raw = String(value).trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(raw)) return raw.slice(0, 10);
  return '';
}

function normalizeTrainingRecord(training) {
  return {
    ...training,
    start_date: toYmd(training.start_date) || training.start_date,
    end_date: toYmd(training.end_date) || training.end_date || toYmd(training.start_date),
  };
}

function isYmdWithinRange(day, start, end) {
  if (!day || !start || !end) return false;
  const dayYmd = String(day).slice(0, 10);
  const startYmd = String(start).slice(0, 10);
  const endYmd = String(end).slice(0, 10);
  return dayYmd >= startYmd && dayYmd <= endYmd;
}

function trainingWorkingDayCount(training) {
  const start = toYmd(training?.start_date);
  const end = toYmd(training?.end_date) || start;
  if (!start || !end || end < start) return 0;
  let count = 0;
  const cursor = new Date(`${start}T00:00:00`);
  const last = new Date(`${end}T00:00:00`);
  while (cursor <= last) {
    const day = cursor.getDay();
    if (day !== 0 && day !== 6) count += 1;
    cursor.setDate(cursor.getDate() + 1);
  }
  return count;
}

function hoursPerDayFromTotal(total, training) {
  const days = Math.max(1, trainingWorkingDayCount(training) || 1);
  return Math.min(24, Math.max(0.25, Math.round((total / days) * 100) / 100));
}

console.log('\nTraining flow checks');
console.log(`API: ${API}\n`);

// --- Pure display/date cases (always run) ---
console.log('Display / date shaping');
const isoTraining = {
  id: 1,
  title: 'ISO date training',
  start_date: '2026-07-21T00:00:00.000000Z',
  end_date: '2026-07-23T00:00:00.000000Z',
  duration: 'Multi-day',
  hours_per_day: '8.00',
};
const normalized = normalizeTrainingRecord(isoTraining);
assert(normalized.start_date === '2026-07-21', 'Normalize ISO start_date → Y-m-d');
assert(normalized.end_date === '2026-07-23', 'Normalize ISO end_date → Y-m-d');
assert(
  isYmdWithinRange('2026-07-21', isoTraining.start_date, isoTraining.end_date),
  'Day compare works against ISO start/end after slice',
);
assert(
  !('2026-07-21' >= '2026-07-21T00:00:00.000000Z'),
  'Raw string compare against ISO would fail (documents the bug)',
);

const multi = {
  start_date: '2026-07-20',
  end_date: '2026-07-23',
  duration: 'Multi-day',
};
assert(trainingWorkingDayCount(multi) === 4, 'Mon–Thu working days = 4');
assert(hoursPerDayFromTotal(16, multi) === 4, '16h over 4 days → 4 h/day');

// --- Live API cases ---
console.log('\nLive API');

async function api(path, options = {}) {
  const response = await fetch(`${API}${path}`, {
    ...options,
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await response.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    body = text;
  }
  return { ok: response.ok, status: response.status, body };
}

try {
  const health = await fetch(API.replace(/\/api$/, '') + '/up').catch(() => null);
  if (!health || !health.ok) {
    // Try login anyway — some installs don't expose /up
  }

  const login = await api('/login', {
    method: 'POST',
    body: JSON.stringify({
      login_name: process.env.TRAINING_TEST_LOGIN || 'admin',
      password: process.env.TRAINING_TEST_PASSWORD || 'password',
    }),
  });

  if (!login.ok) {
    console.log(`  SKIP  Live API (login ${login.status}: ${JSON.stringify(login.body?.errors || login.body?.message || login.body)}).`);
  } else {
    const token = login.body?.token || login.body?.data?.token;
    assert(Boolean(token), 'Login returns token');

    const auth = { Authorization: `Bearer ${token}` };
    const employeesRes = await api('/employees', { headers: auth });
    assert(employeesRes.ok, 'GET /employees');
    const employees = employeesRes.body?.data || [];
    assert(employees.length > 0, 'At least one employee exists');

    const employee = employees[0];
    const start = '2026-08-03';
    const end = '2026-08-04';
    const title = `[Check] Flow test ${Date.now()}`;
    const hoursPerDay = hoursPerDayFromTotal(16, { start_date: start, end_date: end });

    const create = await api('/trainings', {
      method: 'POST',
      headers: auth,
      body: JSON.stringify({
        employee_id: employee.id,
        title,
        duration: 'Multi-day',
        status: 'scheduled',
        priority: 'P2',
        urgency: 'U1',
        start_date: start,
        end_date: end,
        hours_per_day: hoursPerDay,
        description: 'Automated flow check',
        confirm_override: true,
      }),
    });
    assert(create.ok || create.status === 201 || create.status === 200, `POST /trainings (${create.status})`);
    const created = normalizeTrainingRecord(create.body?.data || {});
    assert(created.id != null, 'Created training has id');
    assert(created.start_date === start, `Created start_date is Y-m-d (${created.start_date})`);
    assert(created.end_date === end, `Created end_date is Y-m-d (${created.end_date})`);
    assert(Number(created.hours_per_day) === hoursPerDay, `hours_per_day saved as ${hoursPerDay}`);

    const list = await api(`/trainings?start=2026-07-14&end=2026-09-10`, { headers: auth });
    assert(list.ok, 'GET /trainings?start&end');
    const rows = (list.body?.data || []).map(normalizeTrainingRecord);
    const found = rows.find((row) => String(row.id) === String(created.id));
    assert(Boolean(found), 'Created training appears in ranged list (Trainings + Histogram fetch)');
    assert(
      found && isYmdWithinRange(start, found.start_date, found.end_date),
      'Created training overlaps view day for chart paint',
    );

    // Cleanup
    if (created.id) {
      const del = await api(`/trainings/${created.id}`, {
        method: 'DELETE',
        headers: auth,
      });
      assert(del.ok, 'DELETE created training (cleanup)');
    }
  }
} catch (err) {
  failed += 1;
  console.error(`  FAIL  Live API exception: ${err.message}`);
}

console.log(`\n${passed} passed, ${failed} failed\n`);
process.exit(failed > 0 ? 1 : 0);
