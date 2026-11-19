import { employeeMatchesName } from './employeeNames';

const ASSIGNMENT_FIELDS = [
  'algorithm_1',
  'algorithm_2',
  'algorithm_3',
  'override_1',
  'override_2',
  'override_3',
];

export function taskAssignedToEmployee(task, employee) {
  if (!task || !employee) {
    return false;
  }

  return ASSIGNMENT_FIELDS.some((field) => employeeMatchesName(employee, task[field]));
}
