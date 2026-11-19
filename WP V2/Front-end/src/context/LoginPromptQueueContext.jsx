import { createContext, useCallback, useContext, useMemo, useState } from 'react';

export const LOGIN_PROMPT_IDS = {
  INCOMPLETE_TRAINING: 'incomplete-training',
  PROJECT_CONFIRM: 'project-confirm',
  TRAINEE_HOURS: 'trainee-hours',
};

const LOGIN_PROMPT_ORDER = [
  LOGIN_PROMPT_IDS.INCOMPLETE_TRAINING,
  LOGIN_PROMPT_IDS.PROJECT_CONFIRM,
  LOGIN_PROMPT_IDS.TRAINEE_HOURS,
];

const LoginPromptQueueContext = createContext(null);

export function LoginPromptQueueProvider({ children }) {
  const [queued, setQueued] = useState({});

  const enqueue = useCallback((id) => {
    setQueued((current) => (current[id] ? current : { ...current, [id]: true }));
  }, []);

  const dequeue = useCallback((id) => {
    setQueued((current) => {
      if (!current[id]) {
        return current;
      }

      const next = { ...current };
      delete next[id];
      return next;
    });
  }, []);

  const activeId = LOGIN_PROMPT_ORDER.find((id) => queued[id]) ?? null;

  const value = useMemo(
    () => ({
      enqueue,
      dequeue,
      isActive: (id) => activeId === id,
    }),
    [enqueue, dequeue, activeId],
  );

  return (
    <LoginPromptQueueContext.Provider value={value}>
      {children}
    </LoginPromptQueueContext.Provider>
  );
}

export function useLoginPrompt(id) {
  const context = useContext(LoginPromptQueueContext);
  if (!context) {
    throw new Error('useLoginPrompt must be used within LoginPromptQueueProvider');
  }

  const { enqueue, dequeue, isActive } = context;
  const request = useCallback(() => enqueue(id), [enqueue, id]);
  const release = useCallback(() => dequeue(id), [dequeue, id]);

  return {
    open: isActive(id),
    request,
    release,
  };
}
