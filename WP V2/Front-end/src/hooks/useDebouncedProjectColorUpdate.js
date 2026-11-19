import { useCallback, useEffect, useRef } from 'react';
import api from '../api/client';

const DEFAULT_DEBOUNCE_MS = 500;

/**
 * Debounce project colour saves while the native picker is adjusted.
 * Avoids toast/API spam and keeps the input enabled (no picker flicker).
 */
export function useDebouncedProjectColorUpdate({
  selectedProjectId,
  setProjects,
  toast,
  debounceMs = DEFAULT_DEBOUNCE_MS,
  onError,
}) {
  const saveTimerRef = useRef(null);
  const rollbackColorRef = useRef(undefined);
  const latestProjectIdRef = useRef(selectedProjectId);

  useEffect(() => {
    latestProjectIdRef.current = selectedProjectId;
  }, [selectedProjectId]);

  useEffect(() => () => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
  }, []);

  const handleColorChange = useCallback((event) => {
    const nextColor = event.target.value;
    const projectId = latestProjectIdRef.current;
    if (!projectId) {
      return;
    }

    const startingNewBatch = !saveTimerRef.current;

    setProjects((current) => {
      if (startingNewBatch) {
        const project = current.find((entry) => String(entry.id) === String(projectId));
        rollbackColorRef.current = project?.color;
      }

      return current.map((entry) =>
        String(entry.id) === String(projectId)
          ? { ...entry, color: nextColor }
          : entry,
      );
    });

    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }

    saveTimerRef.current = setTimeout(async () => {
      saveTimerRef.current = null;
      const previousColor = rollbackColorRef.current;

      try {
        const response = await api.put(`/projects/${projectId}`, {
          color: nextColor,
        });
        setProjects((current) =>
          current.map((entry) =>
            String(entry.id) === String(projectId)
              ? response.data.data
              : entry,
          ),
        );
        toast?.success?.('Project color updated.');
        onError?.('');
      } catch {
        setProjects((current) =>
          current.map((entry) =>
            String(entry.id) === String(projectId)
              ? { ...entry, color: previousColor }
              : entry,
          ),
        );
        const message = 'Unable to update project color.';
        onError?.(message);
        toast?.error?.(message);
      }
    }, debounceMs);
  }, [debounceMs, onError, setProjects, toast]);

  return { handleColorChange };
}
