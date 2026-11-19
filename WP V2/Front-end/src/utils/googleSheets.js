const API_KEY = import.meta.env.VITE_GOOGLE_SHEETS_API_KEY || '';

const EST_COLUMN_INDEX = 6;

export function extractSpreadsheetId(url) {
  const match = String(url || '').match(/\/spreadsheets\/d\/([a-zA-Z0-9-_]+)/);
  return match ? match[1] : null;
}

/** Drive file id from Sheets / file / open links (works for .xlsx opened in Drive too). */
export function extractDriveFileId(urlOrId) {
  const raw = String(urlOrId || '').trim();
  if (!raw) return null;
  if (/^[a-zA-Z0-9_-]{20,}$/.test(raw) && !raw.includes('/')) {
    return raw;
  }
  return extractSpreadsheetId(raw)
    || raw.match(/\/file\/d\/([a-zA-Z0-9-_]+)/)?.[1]
    || raw.match(/[?&]id=([a-zA-Z0-9-_]+)/)?.[1]
    || null;
}

function toColLabel(columnNumber) {
  let label = '';
  let n = columnNumber;
  while (n > 0) {
    n -= 1;
    label = String.fromCharCode(65 + (n % 26)) + label;
    n = Math.floor(n / 26);
  }
  return label;
}

function extractSheetTitle(input) {
  const raw = (input || '').trim();
  if (!raw) return '';
  const left = raw.includes('!') ? raw.split('!')[0] : raw;
  return left.replace(/^'+|'+$/g, '').trim();
}

function normalizeText(value) {
  return String(value ?? '')
    .trim()
    .toLowerCase();
}

/**
 * Build match needles from an NRM record.
 * v1 matches bill schedule rows using Name (e.g. "1 Substructure", "1 Frame").
 */
export function getNrmMatchNeedles(nrm) {
  const name = String(nrm?.name ?? nrm?.Name ?? '').trim();
  if (name) {
    return [name];
  }

  const scName = String(nrm?.sc_name ?? nrm?.Sc_Name ?? '').trim();
  if (!scName) {
    const number = String(nrm?.number ?? '').trim();
    return number ? [number] : [];
  }

  const withoutPrefix = scName.replace(/^\d+(?:\.\d+)?\s*[-–—]\s*/i, '').trim();
  return withoutPrefix && withoutPrefix !== scName
    ? [scName, withoutPrefix]
    : [scName];
}

function isLikelyHeaderRow(row) {
  const first = normalizeText(row?.[0]);
  if (['nrm', 'item', 'description', 'task', 'section'].some((token) => first.includes(token))) {
    return true;
  }

  const estHeader = normalizeText(row?.[EST_COLUMN_INDEX]);
  return ['est', 'estimate', 'hours', 'hr'].includes(estHeader);
}

function rowMatchesNrm(row, needles) {
  if (!needles.length) return false;

  return needles.some((needle) => {
    const normalizedNeedle = normalizeText(needle);
    if (!normalizedNeedle) return false;

    return (row ?? []).some((cell) => normalizeText(cell).includes(normalizedNeedle));
  });
}

/**
 * Match v1 Create_new_Project_Model / Update_Hours_Model conversion:
 * "12:30" -> 12 (hours component only).
 */
export function convertSheetEstToHours(value) {
  if (value === null || value === undefined || value === '') {
    return 0;
  }

  const text = String(value).trim();
  if (text.includes(':')) {
    const [hours, minutes] = text.split(':').map(Number);
    if (Number.isNaN(hours)) {
      return 0;
    }
    if (Number.isNaN(minutes) || minutes === 0) {
      return hours;
    }
    // Keep fractional hours when minutes are present.
    return hours + minutes / 60;
  }

  const numeric = parseFloat(text.replace(/,/g, ''));
  return Number.isNaN(numeric) ? 0 : numeric;
}

function formatHours(value) {
  if (value === null || value === undefined || value === '') {
    return '0';
  }

  const numeric = Number(value);
  if (!Number.isFinite(numeric)) {
    return '0';
  }

  return String(Math.round(numeric * 100) / 100);
}

async function buildSafeFullSheetRange(spreadsheetId, sheetNameOrRange) {
  const title = extractSheetTitle(sheetNameOrRange);
  if (!title) return '';

  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?key=${API_KEY}&fields=sheets(properties(title,gridProperties(rowCount,columnCount)))`;
  const metaResponse = await fetch(metaUrl);
  if (!metaResponse.ok) {
    const err = await metaResponse.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${metaResponse.status}`);
  }

  const metaData = await metaResponse.json();
  const sheet = metaData.sheets?.find(
    (item) => normalizeText(item.properties?.title) === normalizeText(title),
  );

  if (!sheet) {
    const available = (metaData.sheets ?? [])
      .map((item) => item.properties?.title)
      .filter(Boolean);
    throw new Error(
      `Sheet "${title}" not found.${available.length ? ` Available tabs: ${available.join(', ')}` : ''}`,
    );
  }

  const rowCount = sheet.properties?.gridProperties?.rowCount ?? 1000;
  const columnCount = sheet.properties?.gridProperties?.columnCount ?? 26;
  const endCol = toColLabel(columnCount);

  return `'${sheet.properties.title}'!A1:${endCol}${rowCount}`;
}

export async function fetchGoogleSheetRawRows(sheetUrl, sheetName) {
  if (!API_KEY) {
    throw new Error('Google Sheets API key is not configured (VITE_GOOGLE_SHEETS_API_KEY).');
  }

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  if (!spreadsheetId) {
    throw new Error('Invalid Google Sheets URL.');
  }

  if (!extractSheetTitle(sheetName)) {
    throw new Error('Please enter a valid sheet tab name.');
  }

  const safeRange = await buildSafeFullSheetRange(spreadsheetId, sheetName);
  const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(safeRange)}?key=${API_KEY}`;
  const response = await fetch(dataUrl);

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      err.error?.message ||
        'Failed to fetch sheet. Share the spreadsheet: Anyone with the link → Viewer.',
    );
  }

  const payload = await response.json();
  const rows = payload.values ?? [];

  if (!rows.length) {
    throw new Error('No data found in the sheet.');
  }

  return rows;
}

export async function fetchSpreadsheetSheetTitles(sheetUrl) {
  if (!API_KEY) {
    throw new Error('Google Sheets API key is not configured (VITE_GOOGLE_SHEETS_API_KEY).');
  }

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  if (!spreadsheetId) {
    throw new Error('Invalid Google Sheets URL.');
  }

  const metaUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}?key=${API_KEY}&fields=sheets(properties(title))`;
  const metaResponse = await fetch(metaUrl);

  if (!metaResponse.ok) {
    const err = await metaResponse.json().catch(() => ({}));
    throw new Error(err.error?.message || `HTTP ${metaResponse.status}`);
  }

  const metaData = await metaResponse.json();

  return (metaData.sheets ?? [])
    .map((item) => item.properties?.title)
    .filter(Boolean);
}

async function fetchSheetRows(spreadsheetId, sheetName) {
  const safeRange = await buildSafeFullSheetRange(spreadsheetId, sheetName);
  const dataUrl = `https://sheets.googleapis.com/v4/spreadsheets/${spreadsheetId}/values/${encodeURIComponent(safeRange)}?key=${API_KEY}`;
  const response = await fetch(dataUrl);

  if (!response.ok) {
    const err = await response.json().catch(() => ({}));
    throw new Error(
      err.error?.message ||
        'Failed to fetch sheet. Share the spreadsheet: Anyone with the link → Viewer.',
    );
  }

  const payload = await response.json();
  const rows = payload.values ?? [];

  if (!rows.length) {
    throw new Error('No data found in the sheet.');
  }

  return rows.filter((row) => !isLikelyHeaderRow(row));
}

function mapNrmTask(nrm, estValue = 0) {
  const scName = nrm.sc_name || nrm.Sc_Name || '';
  const pri = nrm.pri ?? nrm.Pri ?? '';
  const est = formatHours(estValue);

  return {
    task_name: scName,
    est,
    plan: est,
    rap: pri !== null && pri !== undefined ? String(pri) : '',
  };
}

function mapMatchedRowToTask(row, nrm) {
  const estRaw = row[EST_COLUMN_INDEX];
  const estValue = convertSheetEstToHours(estRaw);

  return mapNrmTask(nrm, estValue);
}

function dedupeImportedTasks(tasks) {
  const byName = new Map();

  tasks.forEach((task) => {
    if (!task.task_name) return;

    const existing = byName.get(task.task_name);
    if (!existing) {
      byName.set(task.task_name, task);
      return;
    }

    const nextEst = parseFloat(task.est || 0);
    const prevEst = parseFloat(existing.est || 0);
    if (nextEst >= prevEst) {
      byName.set(task.task_name, task);
    }
  });

  return [...byName.values()].sort((a, b) => a.task_name.localeCompare(b.task_name));
}

export async function importTasksFromSheetRows(rows, nrms) {
  if (!nrms?.length) {
    throw new Error('No NRM task names loaded. Run the NRM seeder or add NRM records first.');
  }

  const dataRows = (rows ?? []).filter((row) => !isLikelyHeaderRow(row));
  const imported = [];

  nrms.forEach((nrm) => {
    const scName = nrm.sc_name || nrm.Sc_Name || '';
    if (!scName) {
      return;
    }

    const needles = getNrmMatchNeedles(nrm);
    const matchedRows = needles.length
      ? dataRows.filter((row) => rowMatchesNrm(row, needles))
      : [];

    if (matchedRows.length) {
      imported.push(mapMatchedRowToTask(matchedRows[0], nrm));
      return;
    }

    imported.push(mapNrmTask(nrm, 0));
  });

  if (!imported.length) {
    throw new Error('No NRM task names are configured. Add NRM sections before importing.');
  }

  return dedupeImportedTasks(imported);
}

export async function importTasksFromGoogleSheet({ sheetUrl, sheetName, nrms }) {
  if (!API_KEY) {
    throw new Error('Google Sheets API key is not configured (VITE_GOOGLE_SHEETS_API_KEY).');
  }

  if (!nrms?.length) {
    throw new Error('No NRM task names loaded. Run the NRM seeder or add NRM records first.');
  }

  const spreadsheetId = extractSpreadsheetId(sheetUrl);
  if (!spreadsheetId) {
    throw new Error('Invalid Google Sheets URL.');
  }

  if (!extractSheetTitle(sheetName)) {
    throw new Error('Please enter a valid sheet tab name.');
  }

  const rows = await fetchSheetRows(spreadsheetId, sheetName);
  return importTasksFromSheetRows(rows, nrms);
}

export async function importHoursFromGoogleSheet(params) {
  const tasks = await importTasksFromGoogleSheet(params);
  return tasks.map((task) => ({
    taskName: task.task_name,
    est: task.est,
    rap: task.rap,
  }));
}
