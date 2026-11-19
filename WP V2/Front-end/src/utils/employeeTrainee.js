function parsePerformanceNumber(value) {
  const raw = String(value ?? '').trim().replace(/%$/, '');
  if (!raw) {
    return null;
  }
  const num = Number(raw);
  return Number.isFinite(num) ? num : null;
}

/**
 * Trainees are operatives with any NRM performance below 100% (same rule as OAP).
 */
export function isTrainee(employee) {
  if (!employee) {
    return false;
  }

  if (typeof employee.is_trainee === 'boolean') {
    return employee.is_trainee;
  }

  return (employee?.nrms ?? []).some((nrm) => {
    const performance = parsePerformanceNumber(nrm?.pivot?.performance_percentage);
    return performance !== null && performance < 100;
  });
}

export function findEmployeeById(employees, employeeId) {
  if (employeeId == null || !Array.isArray(employees)) {
    return null;
  }

  return employees.find((employee) => String(employee.id) === String(employeeId)) ?? null;
}

export function isTraineeById(employees, employeeId) {
  return isTrainee(findEmployeeById(employees, employeeId));
}

export function operativeNameClassName(employee, baseClass = 'resource-histogram-operative-name') {
  return isTrainee(employee)
    ? `${baseClass} ${baseClass}--trainee`
    : baseClass;
}
