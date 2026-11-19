/**
 * Detect raw technical messages that should not be shown to end users.
 */
function isTechnicalApiMessage(message) {
  if (typeof message !== 'string' || !message.trim()) {
    return false;
  }

  return [
    /SQLSTATE/i,
    /\bSQL:\s/i,
    /PDOException/i,
    /QueryException/i,
    /Connection:\s*mysql/i,
    /Host:\s*127\.0\.0\.1/i,
    /Integrity constraint violation/i,
    /could not be made because the target machine actively refused/i,
    /Connection refused/i,
    /ECONNREFUSED/i,
    /Access denied for user/i,
    /Unknown database/i,
    /cURL error/i,
    /Connection timed out/i,
    /ConnectionException/i,
  ].some((pattern) => pattern.test(message));
}

/**
 * Map technical failures to short, user-safe copy.
 */
export function sanitizeApiMessage(message, { status, context } = {}) {
  if (!isTechnicalApiMessage(message)) {
    return message;
  }

  if (/actively refused|Connection refused|ECONNREFUSED|could not be made/i.test(message)) {
    return context === 'login'
      ? 'The application is temporarily unavailable. Please try again in a few minutes or contact your administrator.'
      : 'Unable to reach the server database. Please try again later or contact an administrator.';
  }

  if (/cURL error|Connection timed out|ConnectionException/i.test(message)) {
    return 'Time Tracking is unreachable. Check the network, VPN, or firewall and try again.';
  }

  if (/Unknown database|Access denied for user/i.test(message)) {
    return 'The application is not fully configured yet. Please contact your administrator.';
  }

  if (status === 503 || status >= 500) {
    return context === 'login'
      ? 'Sign-in is temporarily unavailable. Please try again in a few minutes.'
      : 'A server error occurred. Please try again or contact an administrator.';
  }

  return context === 'login'
    ? 'Unable to sign in right now. Please check your details and try again.'
    : 'Something went wrong. Please try again.';
}

/**
 * Extract structured error metadata (code, conflicts) from client or API errors.
 */
export function getApiErrorDetails(error) {
  if (!error) {
    return { code: null, message: null, conflicts: [] };
  }

  if (error.code) {
    return {
      code: error.code,
      message: error.message ?? null,
      conflicts: Array.isArray(error.conflicts) ? error.conflicts : [],
    };
  }

  const data = error?.response?.data;
  return {
    code: typeof data?.code === 'string' ? data.code : null,
    message: typeof data?.message === 'string' ? data.message : (error.message ?? null),
    conflicts: Array.isArray(data?.conflicts) ? data.conflicts : [],
  };
}

/**
 * Extract a user-facing message from an axios/API error.
 */
export function getApiErrorMessage(error, fallback = 'Something went wrong. Please try again.', options = {}) {
  if (!error) {
    return fallback;
  }

  if (!error.response) {
    if (error.message === 'Network Error') {
      return options.context === 'login'
        ? 'Cannot reach the application server. Check that the backend is running and try again.'
        : 'Unable to reach the server. Check your connection and try again.';
    }
    return sanitizeApiMessage(error.message, options) || fallback;
  }

  const { data, status } = error.response;

  if (typeof data?.message === 'string' && data.message.trim()) {
    return sanitizeApiMessage(data.message.trim(), { status, ...options }) || fallback;
  }

  if (typeof data?.error === 'string' && data.error.trim()) {
    return sanitizeApiMessage(data.error.trim(), { status, ...options }) || fallback;
  }

  if (data?.errors && typeof data.errors === 'object') {
    const firstField = Object.values(data.errors).flat()[0];
    if (typeof firstField === 'string' && firstField.trim()) {
      return sanitizeApiMessage(firstField.trim(), { status, ...options }) || fallback;
    }
  }

  if (status === 401 || status === 403) {
    return options.context === 'login'
      ? 'Invalid username or password.'
      : 'You do not have permission to perform this action.';
  }

  if (status === 404) {
    return 'The requested resource was not found.';
  }

  if (status === 419) {
    return 'Your session expired. Refresh the page and try again.';
  }

  if (status === 422) {
    return options.context === 'login'
      ? 'Invalid username or password.'
      : 'Please check your input and try again.';
  }

  if (status === 503 || status >= 500) {
    return options.context === 'login'
      ? 'Sign-in is temporarily unavailable. Please try again in a few minutes.'
      : 'A server error occurred. Please try again or contact an administrator.';
  }

  return fallback;
}
