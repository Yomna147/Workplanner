import { toStorageDate } from './dateFormat';

/** Monday–Sunday range for the week containing today. */
export function getCurrentWeekRange(referenceDate = new Date()) {
  const date = new Date(referenceDate);
  const day = date.getDay();
  const diffToMonday = day === 0 ? -6 : 1 - day;

  const monday = new Date(date);
  monday.setDate(date.getDate() + diffToMonday);

  const sunday = new Date(monday);
  sunday.setDate(monday.getDate() + 6);

  return {
    start: toStorageDate(monday),
    end: toStorageDate(sunday),
  };
}
