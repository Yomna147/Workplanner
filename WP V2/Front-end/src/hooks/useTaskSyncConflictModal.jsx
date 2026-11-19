import { useCallback, useRef, useState } from 'react';
import TaskSyncConflictModal from '../components/TaskSyncConflictModal';
import {
  getTaskSyncConflict,
  isTaskSyncConflict,
  syncPartTasks,
  TaskSyncCancelledError,
} from '../utils/taskSync';

export function useTaskSyncConflictModal() {
  const [conflict, setConflict] = useState(null);
  const waiterRef = useRef(null);

  const settleWaiter = useCallback((handler) => {
    const waiter = waiterRef.current;
    waiterRef.current = null;
    if (waiter) {
      handler(waiter);
    }
  }, []);

  const closeConflict = useCallback(() => {
    setConflict(null);
    settleWaiter((waiter) => waiter.reject(new TaskSyncCancelledError()));
  }, [settleWaiter]);

  const confirmConflict = useCallback((resolutions) => {
    setConflict(null);
    settleWaiter((waiter) => waiter.resolve(resolutions ?? {}));
  }, [settleWaiter]);

  const waitForResolutions = useCallback((nextConflict) => (
    new Promise((resolve, reject) => {
      settleWaiter((waiter) => waiter.reject(new TaskSyncCancelledError()));
      waiterRef.current = { resolve, reject };
      setConflict(nextConflict);
    })
  ), [settleWaiter]);

  const syncPartTasksWithConflict = useCallback(async (api, partId, options = {}) => {
    let resolutions = options.conflictResolutions;
    while (true) {
      try {
        return await syncPartTasks(api, partId, {
          ...options,
          conflictResolutions: resolutions,
        });
      } catch (err) {
        if (!isTaskSyncConflict(err)) {
          throw err;
        }
        resolutions = await waitForResolutions(getTaskSyncConflict(err));
      }
    }
  }, [waitForResolutions]);

  const modal = (
    <TaskSyncConflictModal
      open={Boolean(conflict)}
      conflict={conflict}
      onCancel={closeConflict}
      onConfirm={confirmConflict}
    />
  );

  return {
    syncPartTasksWithConflict,
    taskSyncConflictModal: modal,
  };
}
