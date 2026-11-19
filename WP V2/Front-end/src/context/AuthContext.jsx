import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react';
import api from '../api/client';
import { DL_LOGIN_CONFIRM_KEY, DL_TRAINEE_HOURS_ALERT_KEY, INCOMPLETE_TRAINING_REMINDER_KEY, INCOMPLETE_TRAINING_REMINDER_SHOWN_KEY } from '../constants/dlLoginConfirm';
import { clearGapNotificationSessionState } from '../utils/trainingGapNotifyStorage';
import { isDlUser } from '../utils/userPermissions';

const AuthContext = createContext(null);

function applyAuthenticatedSessionFlags(freshUser, { fromLogin = false } = {}) {
  if (!isDlUser(freshUser)) {
    sessionStorage.removeItem(DL_LOGIN_CONFIRM_KEY);
    sessionStorage.removeItem(DL_TRAINEE_HOURS_ALERT_KEY);
  } else if (fromLogin) {
    sessionStorage.setItem(DL_LOGIN_CONFIRM_KEY, '1');
    sessionStorage.setItem(DL_TRAINEE_HOURS_ALERT_KEY, '1');
  }

  if (fromLogin) {
    sessionStorage.removeItem(INCOMPLETE_TRAINING_REMINDER_SHOWN_KEY);
    sessionStorage.setItem(INCOMPLETE_TRAINING_REMINDER_KEY, '1');
    clearGapNotificationSessionState();
  } else if (sessionStorage.getItem(INCOMPLETE_TRAINING_REMINDER_SHOWN_KEY) !== '1') {
    sessionStorage.setItem(INCOMPLETE_TRAINING_REMINDER_KEY, '1');
  }
}

function clearAuthenticatedSessionFlags() {
  sessionStorage.removeItem(DL_LOGIN_CONFIRM_KEY);
  sessionStorage.removeItem(DL_TRAINEE_HOURS_ALERT_KEY);
  sessionStorage.removeItem(INCOMPLETE_TRAINING_REMINDER_KEY);
  sessionStorage.removeItem(INCOMPLETE_TRAINING_REMINDER_SHOWN_KEY);
  clearGapNotificationSessionState();
}

function readStoredUser() {
  const stored = localStorage.getItem('wp2_user');
  if (!stored) {
    return null;
  }

  try {
    return JSON.parse(stored);
  } catch {
    localStorage.removeItem('wp2_user');
    localStorage.removeItem('wp2_token');
    return null;
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(readStoredUser);
  const [loading, setLoading] = useState(true);
  const authGeneration = useRef(0);

  useEffect(() => {
    const generation = authGeneration.current;
    const token = localStorage.getItem('wp2_token');
    if (!token) {
      setLoading(false);
      return;
    }

    api
      .get('/me')
      .then((response) => {
        if (generation !== authGeneration.current) {
          return;
        }
        setUser(response.data.user);
        localStorage.setItem('wp2_user', JSON.stringify(response.data.user));
        applyAuthenticatedSessionFlags(response.data.user);
      })
      .catch(() => {
        if (generation !== authGeneration.current) {
          return;
        }
        localStorage.removeItem('wp2_token');
        localStorage.removeItem('wp2_user');
        clearAuthenticatedSessionFlags();
        setUser(null);
      })
      .finally(() => {
        if (generation === authGeneration.current) {
          setLoading(false);
        }
      });
  }, []);

  const value = useMemo(
    () => ({
      user,
      loading,
      isAuthenticated: Boolean(user),
      async login(loginName, password) {
        const generation = ++authGeneration.current;
        const response = await api.post('/login', {
          login_name: loginName,
          password,
        });
        if (generation !== authGeneration.current) {
          return response.data;
        }
        localStorage.setItem('wp2_token', response.data.token);

        const meResponse = await api.get('/me');
        if (generation !== authGeneration.current) {
          return response.data;
        }
        const freshUser = meResponse.data.user;
        localStorage.setItem('wp2_user', JSON.stringify(freshUser));

        applyAuthenticatedSessionFlags(freshUser, { fromLogin: true });
        setUser(freshUser);
        return { ...response.data, user: freshUser };
      },
      async register({ name, login_name, email, password, password_confirmation }) {
        const response = await api.post('/register', {
          name,
          login_name,
          email: email || null,
          password,
          password_confirmation,
        });
        localStorage.setItem('wp2_token', response.data.token);
        localStorage.setItem('wp2_user', JSON.stringify(response.data.user));
        setUser(response.data.user);
        return response.data;
      },
      async logout() {
        const generation = ++authGeneration.current;
        try {
          await api.post('/logout');
        } finally {
          if (generation !== authGeneration.current) {
            return;
          }
          localStorage.removeItem('wp2_token');
          localStorage.removeItem('wp2_user');
          clearAuthenticatedSessionFlags();
          setUser(null);
        }
      },
    }),
    [user, loading],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within AuthProvider');
  }
  return context;
}
