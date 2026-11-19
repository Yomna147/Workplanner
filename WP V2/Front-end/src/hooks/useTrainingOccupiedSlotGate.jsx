import { useCallback, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import TrainingOccupiedSlotModal from '../components/TrainingOccupiedSlotModal';
import { getApiErrorDetails } from '../utils/apiErrors';
import { collectOccupiedSlotConflicts, trainingFreedProjectHours } from '../utils/trainingSaveGuard';

function cancelledOverrideError() {
  const error = new Error('Override cancelled');
  error.code = 'TRAINING_OVERRIDE_CANCELLED';
  return error;
}

export function useTrainingOccupiedSlotGate() {
  const [modalState, setModalState] = useState(null);
  const [phase, setPhase] = useState('confirm');
  const [busy, setBusy] = useState(false);
  const [statusMessage, setStatusMessage] = useState('');
  const modalStateRef = useRef(null);
  modalStateRef.current = modalState;

  const resetModal = useCallback(() => {
    setModalState(null);
    setPhase('confirm');
    setBusy(false);
    setStatusMessage('');
  }, []);

  const closeModal = useCallback(() => {
    if (busy || phase !== 'confirm') {
      return;
    }
    modalStateRef.current?.onCancel?.();
    resetModal();
  }, [busy, phase, resetModal]);

  const promptOverride = useCallback((conflicts, onConfirm, successMessage, onCancel) => {
    setPhase('confirm');
    setStatusMessage('');
    setModalState({
      conflicts,
      onConfirm,
      successMessage,
      onCancel,
    });
  }, []);

  const runWithOccupiedSlotGuard = useCallback(async ({
    rows = [],
    context = null,
    originalsById = new Map(),
    save,
    showSaveFeedback = false,
    successMessage = 'Training schedule saved.',
    onBusy,
    alreadyConfirmed = false,
  }) => {
    const conflicts = (context
      ? collectOccupiedSlotConflicts(rows, context, originalsById)
      : []
    ).filter((entry) => !entry?.holiday && entry?.kind !== 'holiday');

    const executeSave = async (confirmOverride, { withFeedback = false, overrideConflicts = conflicts } = {}) => {
      const activeMessage = modalStateRef.current?.successMessage ?? successMessage;

      if (withFeedback) {
        setModalState(null);
        setPhase('saving');
        setStatusMessage('Saving…');
      }

      setBusy(true);
      onBusy?.(true);
      try {
        const result = await save(confirmOverride, overrideConflicts);
        if (withFeedback) {
          const freed = trainingFreedProjectHours(result);
          setPhase('saved');
          setStatusMessage(
            freed > 0
              ? `Saved. Project hours reduced by ${freed.toFixed(1)}h — re-run the algorithm.`
              : activeMessage,
          );
          window.setTimeout(() => {
            resetModal();
          }, freed > 0 ? 4500 : 1600);
        } else {
          resetModal();
        }
        return result;
      } catch (error) {
        resetModal();
        throw error;
      } finally {
        setBusy(false);
        onBusy?.(false);
      }
    };

    if (alreadyConfirmed && conflicts.length === 0) {
      return executeSave(true, { withFeedback: true, overrideConflicts: conflicts });
    }

    // Always prompt for confirmation when there is a training or project conflict.
    if (conflicts.length > 0) {
      return new Promise((resolve, reject) => {
        promptOverride(
          conflicts,
          async () => {
            try {
              const result = await executeSave(true, {
                withFeedback: true,
                overrideConflicts: conflicts,
              });
              resolve(result);
            } catch (error) {
              reject(error);
            }
          },
          successMessage,
          () => reject(cancelledOverrideError()),
        );
      });
    }

    if (showSaveFeedback) {
      return executeSave(false, { withFeedback: true });
    }

    try {
      return await executeSave(false);
    } catch (error) {
      const details = getApiErrorDetails(error);
      if (details.code === 'TRAINING_HOLIDAY_SLOT') {
        throw error;
      }
      if (details.code !== 'TRAINING_OCCUPIED_SLOT' && details.code !== 'TRAINING_TRAINING_CONFLICT') {
        throw error;
      }

      const apiConflicts = Array.isArray(details.conflicts) ? details.conflicts : [];

      return new Promise((resolve, reject) => {
        promptOverride(
          apiConflicts,
          async () => {
            try {
              const result = await executeSave(true, {
                withFeedback: true,
                overrideConflicts: apiConflicts,
              });
              resolve(result);
            } catch (retryError) {
              reject(retryError);
            }
          },
          successMessage,
          () => reject(cancelledOverrideError()),
        );
      });
    }
  }, [promptOverride, resetModal]);

  const modal = (
    <>
      <TrainingOccupiedSlotModal
        open={Boolean(modalState) && phase === 'confirm'}
        phase="confirm"
        conflicts={modalState?.conflicts ?? []}
        busy={busy}
        successMessage={modalState?.successMessage ?? 'Training schedule saved.'}
        onCancel={closeModal}
        onConfirm={() => modalState?.onConfirm?.()}
      />
      {statusMessage
        ? createPortal(
          <div
            className={`trainings-save-status-chip${phase === 'saved' ? ' is-saved' : ''}`}
            role="status"
            aria-live="polite"
          >
            {phase === 'saving' ? (
              <span className="trainings-save-status-spinner" aria-hidden="true" />
            ) : (
              <span className="trainings-save-status-check" aria-hidden="true">✓</span>
            )}
            <span>{statusMessage}</span>
          </div>,
          document.body,
        )
        : null}
    </>
  );

  return {
    runWithOccupiedSlotGuard,
    modal,
    busy,
    awaitingOverride: Boolean(modalState) && phase === 'confirm',
  };
}
