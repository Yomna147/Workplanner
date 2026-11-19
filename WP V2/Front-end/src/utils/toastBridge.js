let handlers = null;

export function registerToastHandlers(next) {
  handlers = next;
}

export function globalToastError(message) {
  handlers?.error?.(message);
}

export function globalToastInfo(message) {
  handlers?.info?.(message);
}

export function globalToastSuccess(message) {
  handlers?.success?.(message);
}
