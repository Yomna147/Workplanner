import { extractSpreadsheetId, fetchGoogleSheetRawRows } from './googleSheets';
import {
  employeeDisplayName,
  employeeMatchesName,
  employeeNameKey,
  isBTeamSlotName,
  listWpBTeamSlotEmployees,
  resolveWpEmployeeForTtName,
} from './employeeNames';

const SHEET_EMPLOYEE_ALIASES = {
  'rauno r': 'Rauno R',
  'todor t': 'Todor Tanev',
  'shaimaa m': 'Shaimaa Mohamed',
  nora: 'Nora Keshk',
  'gabriel g': 'Gabriel Giurca',
  'manu v': 'Manu Vijay',
  'khaled m': 'Khaled Maged',
  'fouad d': 'Faouad Diaa',
  'valeria d': 'Valeriya Dramalieva',
  'veselina m': 'Veselina Milanova',
  'amro h': 'Amro Mahmoud',
  'mina t': 'Mina Tawfik',
  'rehaf h': 'Rehaf Hamed',
  'stanley p': 'Stanley Prospere',
  'nour el khatib': 'Nour El Khatib',
  nour: 'Nour El Khatib',
  'mayar n': 'Mayar Nashaat',
  maya: 'Maya Wacily',
  amal: 'Amal Nagi',
  nataliia: 'Nataliia Markitan',
  'angela l': 'Angela L',
  'alexander s': 'Alexander Suvoroff',
};

function formatHourValue(value) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return '';
  }
  return `${String(value).padStart(2, '0')}:00`;
}

function formatTotalHours(hours) {
  const safe = Math.max(0, Math.round(hours));
  return formatHourValue(safe);
}

function parseSheetDateHeader(header, year) {
  const text = String(header ?? '').trim();
  if (!text) return null;

  const date = new Date(`${text} ${year}`);
  if (Number.isNaN(date.getTime())) {
    return null;
  }

  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function extractYearFromSheetName(sheetName) {
  const match = String(sheetName).match(/\b(19|20)\d{2}\b/);
  return match ? parseInt(match[0], 10) : new Date().getFullYear();
}

function resolveSheetEmployeeLabel(row) {
  const colB = String(row[1] ?? '').trim();
  const colA = String(row[0] ?? '').trim();

  for (const candidate of [colB, colA]) {
    // Keep B-team slot labels as-is so they match WP slot employees (KM1/AH1…),
    // never rewrite them onto Faouad/Mina aliases.
    if (isBTeamSlotName(candidate)) {
      return candidate;
    }

    const alias = SHEET_EMPLOYEE_ALIASES[employeeNameKey(candidate)];
    if (alias) {
      return alias;
    }
  }

  return colA || colB;
}

function isEmptySheetRow(row) {
  return !(row ?? []).some((cell) => String(cell ?? '').trim() !== '');
}

/**
 * B-team sheet rows must land on WP slot employees (B-team (KM1), …),
 * not on the people those slots alias to (Faouad, Mina, …).
 */
function findEmployeesForSheetLabel(employees, label) {
  const normalized = employeeNameKey(label);

  if (normalized === 'b-team km') {
    return listWpBTeamSlotEmployees(employees, 'KM');
  }

  if (normalized === 'b-team ah') {
    return listWpBTeamSlotEmployees(employees, 'AH');
  }

  if (isBTeamSlotName(label)) {
    const slot = resolveWpEmployeeForTtName(label, employees);
    return slot ? [slot] : [];
  }

  const aliasTarget = SHEET_EMPLOYEE_ALIASES[normalized];
  if (aliasTarget) {
    const match = employees.find((emp) => employeeMatchesName(emp, aliasTarget));
    return match ? [match] : [];
  }

  const match = employees.find((emp) => employeeMatchesName(emp, label));
  return match ? [match] : [];
}

function parseDayAvailability(header, row, index, year) {
  const date = parseSheetDateHeader(header, year);
  if (!date) {
    return null;
  }

  const col1 = row[index * 2 + 1] || '';
  const col2 = row[index * 2 + 2] || '';
  const combined = `${col1} ${col2}`.trim();
  const intValues = [...combined.matchAll(/\d+/g)].map((match) => parseInt(match[0], 10));

  const [start1, end1, start2, end2] = intValues;
  const hours1 = start1 && end1 && !Number.isNaN(start1) && !Number.isNaN(end1)
    ? Math.max(end1 - start1, 0)
    : 0;
  const hours2 = start2 && end2 && !Number.isNaN(start2) && !Number.isNaN(end2)
    ? Math.max(end2 - start2, 0)
    : 0;
  const totalHours = hours1 + hours2;

  // Skip blank day cells so empty sheet columns do not overwrite availability.
  if (
    (start1 === undefined || Number.isNaN(start1))
    && (end1 === undefined || Number.isNaN(end1))
    && (start2 === undefined || Number.isNaN(start2))
    && (end2 === undefined || Number.isNaN(end2))
  ) {
    return null;
  }

  return {
    date,
    values: {
      start1: formatHourValue(start1),
      end1: formatHourValue(end1),
      start2: formatHourValue(start2),
      end2: formatHourValue(end2),
      formattedTotal: formatTotalHours(totalHours),
    },
  };
}

function parseAvailabilitySheet(rows, sheetName, employees) {
  if (!rows?.length) {
    throw new Error('No data found in the specified range.');
  }

  const year = extractYearFromSheetName(sheetName);
  const headers = rows[0]
    .slice(1)
    .filter((header) => String(header ?? '').trim() !== '');

  const payload = [];

  for (const row of rows.slice(1)) {
    if ((row ?? []).some((cell) => String(cell).includes('Do not touch the table below'))) {
      break;
    }

    if (isEmptySheetRow(row)) {
      continue;
    }

    const label = resolveSheetEmployeeLabel(row);
    if (!label) {
      continue;
    }

    const matchedEmployees = findEmployeesForSheetLabel(employees, label);
    if (matchedEmployees.length === 0) {
      continue;
    }

    const dayRows = headers
      .map((header, index) => parseDayAvailability(header, row, index, year))
      .filter(Boolean);

    if (dayRows.length === 0) {
      continue;
    }

    matchedEmployees.forEach((employee) => {
      payload.push({
        employee_id: employee.id,
        first_name: employeeDisplayName(employee),
        rows: dayRows.map((day) => ({
          date: day.date,
          strt1: day.values.start1 || null,
          end1: day.values.end1 || null,
          strt2: day.values.start2 || null,
          end2: day.values.end2 || null,
          strt3: null,
          end3: null,
          strt4: null,
          end4: null,
          total: day.values.formattedTotal,
          total_ava: day.values.formattedTotal,
        })),
      });
    });
  }

  if (payload.length === 0) {
    throw new Error('No matching employees found in the spreadsheet.');
  }

  return payload;
}

export async function importAvailabilityFromGoogleSheet({ sheetUrl, sheetName, employees }) {
  if (!employees?.length) {
    throw new Error('Employee list is not loaded.');
  }

  if (!extractSpreadsheetId(sheetUrl)) {
    throw new Error('Invalid Google Sheets URL.');
  }

  const rows = await fetchGoogleSheetRawRows(sheetUrl, sheetName);
  return parseAvailabilitySheet(rows, sheetName, employees);
}
