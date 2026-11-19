import { useCallback, useEffect, useRef, useSyncExternalStore } from 'react';
import api from '../api/client';
import {
  buildDailyHoursFromBars,
  filterBarsByDateRange,
  filterLiteralHistogramBars,
} from '../components/gantt/ganttUtils';
import { normalizeTrainingRecords } from '../utils/trainingForm';
import { mergeTrainingHoursIntoDailyHours } from '../utils/trainingOccupancy';
import {
  buildGapNotificationFingerprint,
  buildTrainingGapOpportunities,
  mergeHistogramEmployees,
  nextWeeksDateRange,
  TRAINING_GAP_NOTIFY_MIN_HOURS,
} from '../utils/trainingGapNotifications';

const STALE_MS = 60_000;
const listeners = new Set();

let snapshot = {
  opportunities: [],
  fingerprint: '',
  upcomingGapRange: nextWeeksDateRange(),
};

let inFlight = null;
let loadedAt = 0;
let loadedKey = '';

function emit() {
  listeners.forEach((listener) => listener());
}

function subscribe(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getSnapshot() {
  return snapshot;
}

function scheduleIdle(run) {
  if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
    const id = window.requestIdleCallback(run, { timeout: 1500 });
    return () => window.cancelIdleCallback(id);
  }

  const id = window.setTimeout(run, 400);
  return () => window.clearTimeout(id);
}

async function fetchGapOpportunityData(range) {
  const key = `${range.start}|${range.end}`;
  if (loadedKey === key && Date.now() - loadedAt < STALE_MS) {
    return;
  }

  if (!inFlight) {
    inFlight = (async () => {
      const [histRes, trainingRes, employeesRes] = await Promise.all([
        api.get('/resource-histogram', {
          params: { start: range.start, end: range.end },
        }),
        api.get('/trainings', {
          params: { start: range.start, end: range.end },
        }),
        api.get('/employees'),
      ]);

      const histogram = histRes.data?.data ?? null;
      const trainings = normalizeTrainingRecords(
        Array.isArray(trainingRes.data?.data) ? trainingRes.data.data : [],
      );
      const employees = Array.isArray(employeesRes.data?.data) ? employeesRes.data.data : [];

      await new Promise((resolve) => {
        if (typeof window !== 'undefined' && typeof window.requestIdleCallback === 'function') {
          window.requestIdleCallback(() => resolve(), { timeout: 1500 });
          return;
        }
        window.setTimeout(resolve, 0);
      });

      let opportunities = [];
      if (histogram) {
        const histogramEmployees = Array.isArray(histogram.employees) ? histogram.employees : [];
        const bars = filterBarsByDateRange(
          filterLiteralHistogramBars(Array.isArray(histogram.bars) ? histogram.bars : []),
          range.start,
          range.end,
        );
        const mergedEmployees = mergeHistogramEmployees(histogramEmployees, employees);
        const dailyHours = mergeTrainingHoursIntoDailyHours(
          buildDailyHoursFromBars(bars),
          trainings,
          mergedEmployees,
          { employeeHolidays: histogram.employee_holidays ?? {} },
        );

        opportunities = buildTrainingGapOpportunities({
          employees: mergedEmployees,
          trainings,
          dailyHours,
          availabilityHours: histogram.availability_hours ?? {},
          employeeHolidays: histogram.employee_holidays ?? {},
          startYmd: range.start,
          endYmd: range.end,
          minGapHours: TRAINING_GAP_NOTIFY_MIN_HOURS,
        });
      }

      loadedKey = key;
      loadedAt = Date.now();
      snapshot = {
        opportunities,
        fingerprint: buildGapNotificationFingerprint(opportunities, range),
        upcomingGapRange: range,
      };
      emit();
    })().finally(() => {
      inFlight = null;
    });
  }

  await inFlight;
}

export function useTrainingGapOpportunities({ enabled = true } = {}) {
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;

  const store = useSyncExternalStore(subscribe, getSnapshot, getSnapshot);

  const reload = useCallback(() => {
    if (!enabledRef.current) {
      return Promise.resolve();
    }
    loadedKey = '';
    return fetchGapOpportunityData(nextWeeksDateRange());
  }, []);

  useEffect(() => {
    if (!enabled) {
      return undefined;
    }

    return scheduleIdle(() => {
      if (!enabledRef.current) {
        return;
      }
      fetchGapOpportunityData(nextWeeksDateRange()).catch(() => {
        snapshot = {
          opportunities: [],
          fingerprint: '',
          upcomingGapRange: nextWeeksDateRange(),
        };
        emit();
      });
    });
  }, [enabled]);

  return {
    opportunities: store.opportunities,
    upcomingGapRange: store.upcomingGapRange,
    fingerprint: store.fingerprint,
    reload,
  };
}
