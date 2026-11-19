/**
 * Pick dark or light text for a given background hex color.
 * Bright backgrounds → dark text; dark backgrounds → light text.
 */
export function contrastTextForBackground(hexColor, {
  brightThreshold = 0.62,
  darkText = '#0f172a',
  lightText = '#ffffff',
} = {}) {
  const raw = String(hexColor || '').trim();
  const hex = raw.startsWith('#') ? raw.slice(1) : raw;
  if (!/^[0-9a-fA-F]{6}$/.test(hex)) {
    return lightText;
  }

  const r = parseInt(hex.slice(0, 2), 16);
  const g = parseInt(hex.slice(2, 4), 16);
  const b = parseInt(hex.slice(4, 6), 16);
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255;
  return luminance > brightThreshold ? darkText : lightText;
}
