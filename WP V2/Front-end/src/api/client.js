import axios from 'axios';
import { getApiErrorMessage } from '../utils/apiErrors';
import { globalToastError } from '../utils/toastBridge';
import { clearGapNotificationSessionState } from '../utils/trainingGapNotifyStorage';

const API_BASE_URL = import.meta.env.VITE_API_BASE_URL || '/api';

const api = axios.create({
  baseURL: API_BASE_URL,
  headers: {
    Accept: 'application/json',
    'Content-Type': 'application/json',
  },
});

api.interceptors.request.use((config) => {
  config.headers = config.headers || {};

  // Callers that set Authorization explicitly (e.g. legacy) — do not replace with WP token.
  if (config.headers.Authorization || config.headers.authorization) {
    return config;
  }

  const token = localStorage.getItem('wp2_token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    const status = error.response?.status;

    if (status === 401) {
      localStorage.removeItem('wp2_token');
      localStorage.removeItem('wp2_user');
      clearGapNotificationSessionState();
      if (window.location.pathname !== '/login') {
        window.location.href = '/login';
      }
    } else if (status === 403) {
      globalToastError(getApiErrorMessage(error, 'You do not have permission to perform this action.'));
    } else if (!error.response && error.message === 'Network Error') {
      globalToastError('Unable to reach the server. Check your connection and try again.');
    }

    return Promise.reject(error);
  },
);

export default api;
