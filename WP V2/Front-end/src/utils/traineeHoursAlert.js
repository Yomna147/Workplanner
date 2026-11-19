import {
  buildDailyHoursFromBars,
  buildGapOnlyDayCell,
  buildDayColumns,
  dayCapacityForRow,
  lookupDayHoursForRow,
  parseYmd,
} from '../components/gantt/ganttUtils';
import { employeeDisplayName } from './employeeNames';
import { isTrainee } from './employeeTrainee';

function sumBookedAndCapacityInRange({
  rowName,
  startYmd,
  endYmd,
  dailyHours,
  availabilityHours,
  employeeHolidays,
  employees,
}) {
  let bookedHours = 0;
  let capacityHours = 0;

  buildDayColumns(startYmd, endYmd).forEach((day) => {
    const cell = buildGapOnlyDayCell({
      rowName,
      day,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });
    if (cell.kind === 'weekend' || cell.kind === 'holiday' || cell.kind === 'none') {
      return;
    }

    const booked = lookupDayHoursForRow(dailyHours, rowName, day, employees) ?? 0;
    const capacity = dayCapacityForRow(rowName, day, availabilityHours, employeeHolidays, employees) ?? 0;
    bookedHours += booked;
    capacityHours += capacity;
  });

  return { bookedHours, capacityHours };
}

/**
 * Trainee/junior operatives whose scheduled hours exceed available capacity
 * in the given date range (histogram data).
 */
export function findTraineesExceedingCapacity({
  employees = [],
  bars = [],
  availabilityHours = {},
  employeeHolidays = {},
  startYmd,
  endYmd,
}) {
  if (!startYmd || !endYmd || employees.length === 0) {
    return [];
  }

  const dailyHours = buildDailyHoursFromBars(bars);
  const alerts = [];

  employees.forEach((employee) => {
    if (!isTrainee(employee)) {
      return;
    }

    const name = employeeDisplayName(employee);
    if (!name) {
      return;
    }

    const load = sumBookedAndCapacityInRange({
      rowName: name,
      startYmd,
      endYmd,
      dailyHours,
      availabilityHours,
      employeeHolidays,
      employees,
    });

    if (load.capacityHours <= 0.05) {
      return;
    }

    const overBy = load.bookedHours - load.capacityHours;
    if (overBy <= 0.05) {
      return;
    }

    alerts.push({
      employeeId: employee.id,
      name,
      bookedHours: load.bookedHours,
      capacityHours: load.capacityHours,
      overBy: Math.round(overBy * 10) / 10,
    });
  });

  return alerts.sort((left, right) => (
    right.overBy - left.overBy
    || String(left.name).localeCompare(String(right.name))
  ));
}

export function currentWeekAlertRange() {
  const todayYmd = parseYmd(new Date());
  const today = new Date(`${todayYmd}T00:00:00`);
  if (Number.isNaN(today.getTime())) {
    return { start: todayYmd, end: todayYmd };
  }

  const day = today.getDay();
  const mondayOffset = day === 0 ? -6 : 1 - day;
  const monday = new Date(today);
  monday.setDate(today.getDate() + mondayOffset);
  const friday = new Date(monday);
  friday.setDate(monday.getDate() + 4);

  const format = (date) => {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, '0');
    const d = String(date.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}`;
  };

  return {
    start: format(monday),
    end: format(friday),
  };
}
