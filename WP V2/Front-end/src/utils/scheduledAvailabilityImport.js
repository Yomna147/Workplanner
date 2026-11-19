import api from '../api/client';
import { importAvailabilityFromGoogleSheet } from './availabilityImport';
import { extractSpreadsheetId, fetchSpreadsheetSheetTitles } from './googleSheets';

const MONTH_NAMES = [
  'January',
  'February',
  'March',
  'April',
  'May',
  'June',
  'July',
  'August',
  'September',
  'October',
  'November',
  'December',
];

export const DEFAULT_AVAILABILITY_SPREADSHEET_URL =
  'https://docs.google.com/spreadsheets/d/1Tb09YWWG-w8V4QCYZyrmz-uXvYeRl-ZJa5DW5C1QAf8/edit?gid=1676381914#gid=1676381914';

export const SCHEDULED_IMPORT_MONTH_COUNT = 3;

export function buildScheduledMonthLabels(monthCount = SCHEDULED_IMPORT_MONTH_COUNT, startDate = new Date()) {
  const labels = [];
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  for (let offset = 0; offset < monthCount; offset += 1) {
    const month = new Date(start.getFullYear(), start.getMonth() + offset, 1);
    labels.push(`${MONTH_NAMES[month.getMonth()]} ${month.getFullYear()}`);
  }

  return labels;
}

export function createScheduledImportSteps(monthCount = SCHEDULED_IMPORT_MONTH_COUNT) {
  return buildScheduledMonthLabels(monthCount).map((label) => ({
    label,
    status: 'pending',
    detail: '',
  }));
}

/** Options for the multi-select month picker (current month + ahead). */
export function buildScheduledMonthOptions(monthCount = SCHEDULED_IMPORT_MONTH_COUNT, startDate = new Date()) {
  const options = [];
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), 1);

  for (let offset = 0; offset < monthCount; offset += 1) {
    const month = new Date(start.getFullYear(), start.getMonth() + offset, 1);
    options.push({
      offset,
      label: `${MONTH_NAMES[month.getMonth()]} ${month.getFullYear()}`,
      value: `${month.getFullYear()}-${String(month.getMonth() + 1).padStart(2, '0')}`,
    });
  }

  return options;
}

export function createImportStepsFromOffsets(offsets = [], startDate = new Date()) {
  const start = new Date(startDate.getFullYear(), startDate.getMonth(), 1);
  return [...offsets]
    .map((offset) => Number(offset))
    .filter((offset) => Number.isInteger(offset) && offset >= 0)
    .sort((a, b) => a - b)
    .map((offset) => {
      const month = new Date(start.getFullYear(), start.getMonth() + offset, 1);
      return {
        offset,
        label: `${MONTH_NAMES[month.getMonth()]} ${month.getFullYear()}`,
        status: 'pending',
        detail: '',
      };
    });
}

function normalizeTabTitle(title) {
  return String(title ?? '').trim().toLowerCase();
}

const MONTH_TAB_PATTERN = new RegExp(
  `^(?:${MONTH_NAMES.map((name) => name.slice(0, 3)).join('|')})[a-z]*\\s+(\\d{4})$`,
  'i',
);

const MONTH_INDEX_BY_PREFIX = new Map(
  MONTH_NAMES.flatMap((name, index) => ([
    [name.slice(0, 3).toLowerCase(), index],
    [name.toLowerCase(), index],
  ])),
);

export function parseMonthSheetTab(tab) {
  const title = String(tab ?? '').trim();
  const match = title.match(MONTH_TAB_PATTERN);
  if (!match) return null;

  const monthToken = title.split(/\s+/)[0].toLowerCase();
  const monthIndex = MONTH_INDEX_BY_PREFIX.get(monthToken)
    ?? MONTH_INDEX_BY_PREFIX.get(monthToken.slice(0, 3));
  const year = Number(match[1]);

  if (monthIndex == null || !Number.isFinite(year)) return null;

  return { title, year, monthIndex };
}

/**
 * Keep only month sheet tabs (e.g. "January 2026").
 * When titles include a year, only return months for one year:
 * prefer the current calendar year, otherwise the latest year present.
 */
export function filterMonthSheetTabs(tabs = [], { year = null } = {}) {
  const parsed = (tabs ?? [])
    .map(parseMonthSheetTab)
    .filter(Boolean);

  if (!parsed.length) return [];

  const years = [...new Set(parsed.map((item) => item.year))].sort((a, b) => b - a);
  const preferredYear = year != null && Number.isFinite(Number(year))
    ? Number(year)
    : (years.includes(new Date().getFullYear()) ? new Date().getFullYear() : years[0]);

  return parsed
    .filter((item) => item.year === preferredYear)
    .sort((a, b) => a.monthIndex - b.monthIndex)
    .map((item) => item.title);
}

export function resolveSheetTabForMonth(availableTabs, monthDate) {
  const month = new Date(monthDate.getFullYear(), monthDate.getMonth(), 1);
  const fullMonth = MONTH_NAMES[month.getMonth()];
  const shortMonth = month.toLocaleString('en-US', { month: 'short' });
  const year = month.getFullYear();

  const candidates = [
    `${fullMonth} ${year}`,
    `${shortMonth} ${year}`,
  ];

  const normalizedTabs = new Map(
    availableTabs.map((tab) => [normalizeTabTitle(tab), tab]),
  );

  for (const candidate of candidates) {
    const match = normalizedTabs.get(normalizeTabTitle(candidate));
    if (match) {
      return match;
    }
  }

  for (const tab of availableTabs) {
    if (new RegExp(`\\b${year}\\b`).test(tab)) {
      if (tab.toLowerCase().includes(shortMonth.toLowerCase())
        || tab.toLowerCase().includes(fullMonth.toLowerCase())) {
        return tab;
      }
    }
  }

  return null;
}

/**
 * Import selected months (or current month + ahead) using the same browser-side sheet fetch as manual import.
 */
export async function runScheduledAvailabilityImport({
  sheetUrl = DEFAULT_AVAILABILITY_SPREADSHEET_URL,
  employees,
  monthCount = SCHEDULED_IMPORT_MONTH_COUNT,
  monthOffsets = null,
  onProgress,
}) {
  if (!employees?.length) {
    throw new Error('Employee list is not loaded.');
  }

  if (!extractSpreadsheetId(sheetUrl)) {
    throw new Error('Invalid Google Sheets URL.');
  }

  const start = new Date();
  start.setDate(1);
  start.setHours(0, 0, 0, 0);

  const offsets = Array.isArray(monthOffsets) && monthOffsets.length
    ? [...new Set(monthOffsets.map((offset) => Number(offset)).filter((offset) => Number.isInteger(offset) && offset >= 0))]
      .sort((a, b) => a - b)
    : Array.from({ length: monthCount }, (_, offset) => offset);

  if (!offsets.length) {
    throw new Error('Select at least one month to import.');
  }

  const availableTabs = await fetchSpreadsheetSheetTitles(sheetUrl);
  let totalRows = 0;
  let maxEmployees = 0;
  const sheetResults = [];

  for (let stepIndex = 0; stepIndex < offsets.length; stepIndex += 1) {
    const offset = offsets[stepIndex];
    const monthDate = new Date(start.getFullYear(), start.getMonth() + offset, 1);
    const label = `${MONTH_NAMES[monthDate.getMonth()]} ${monthDate.getFullYear()}`;
    const tabName = resolveSheetTabForMonth(availableTabs, monthDate);

    if (!tabName) {
      throw new Error(
        `No matching sheet tab for ${label}. Available tabs: ${availableTabs.join(', ')}`,
      );
    }

    onProgress?.({
      index: stepIndex,
      label,
      status: 'running',
      detail: 'Fetching sheet…',
    });

    const imports = await importAvailabilityFromGoogleSheet({
      sheetUrl,
      sheetName: tabName,
      employees,
    });

    const { data } = await api.post('/availabilities/import', { imports });
    const importedRows = data.imported_rows ?? 0;
    const employeeCount = new Set(imports.map((item) => item.employee_id)).size;

    totalRows += importedRows;
    maxEmployees = Math.max(maxEmployees, employeeCount);

    const result = {
      sheet: tabName,
      month: label,
      imported_rows: importedRows,
      employees: employeeCount,
    };
    sheetResults.push(result);

    onProgress?.({
      index: stepIndex,
      label,
      status: 'done',
      detail: `${importedRows} rows from ${tabName}`,
      result,
    });
  }

  return {
    imported_rows: totalRows,
    employees: maxEmployees,
    sheet_results: sheetResults,
  };
}
