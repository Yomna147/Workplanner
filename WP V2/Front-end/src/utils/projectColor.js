export function normalizeProjectColor(value) {
  if (!value) {
    return '#ffffff';
  }

  const hex = String(value).trim();
  if (/^#[0-9A-Fa-f]{6}$/.test(hex)) {
    return hex;
  }
  if (/^[0-9A-Fa-f]{6}$/.test(hex)) {
    return `#${hex}`;
  }

  return '#ffffff';
}

export function displayProjectColor(project) {
  return project?.color ? normalizeProjectColor(project.color) : '#ffffff';
}

function hexToRgb(hex) {
  const value = normalizeProjectColor(hex);
  return [1, 3, 5].map((offset) => parseInt(value.slice(offset, offset + 2), 16));
}

function relativeLuminance(hex) {
  const [r, g, b] = hexToRgb(hex).map((channel) => {
    const c = channel / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

function hslToHex(hue, saturation, lightness) {
  const k = (n) => (n + hue / 30) % 12;
  const a = saturation * Math.min(lightness, 1 - lightness);
  const channel = (n) => Math.round(
    (lightness - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))) * 255,
  ).toString(16).padStart(2, '0');
  return `#${channel(0)}${channel(8)}${channel(4)}`.toUpperCase();
}

const randomInt = (min, max) => min + Math.floor(Math.random() * (max - min + 1));

/** Random mid-dark colour that keeps >= 3.5:1 contrast with white bar labels. */
function randomReadableColor() {
  let color;
  do {
    color = hslToHex(randomInt(0, 359), randomInt(55, 85) / 100, randomInt(30, 50) / 100);
  } while (relativeLuminance(color) > 0.25);
  return color;
}

/** True when another course (other than `ignoreId`) already uses `color`. */
export function isTrainingCourseColorTaken(color, courses = [], ignoreId = null) {
  const target = normalizeProjectColor(color).toUpperCase();
  return (courses || []).some((course) => (
    String(course?.id) !== String(ignoreId)
    && normalizeProjectColor(course?.color).toUpperCase() === target
  ));
}

/**
 * A freshly generated colour for a new training course: never one an existing course
 * uses, and (while possible) not visually close to any of them. Mirrors the backend's
 * TrainingCourseColors::randomUnused.
 */
export function pickNextTrainingCourseColor(existingCourses = []) {
  const used = (existingCourses || [])
    .map((course) => normalizeProjectColor(course?.color).toUpperCase())
    .filter((color) => color !== '#FFFFFF');
  const usedSet = new Set(used);
  const usedRgb = used.map(hexToRgb);

  for (const minDistance of [60, 30, 1]) {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      const color = randomReadableColor();
      if (usedSet.has(color)) {
        continue;
      }
      const rgb = hexToRgb(color);
      const closest = usedRgb.reduce(
        (min, other) => Math.min(min, Math.hypot(rgb[0] - other[0], rgb[1] - other[1], rgb[2] - other[2])),
        Infinity,
      );
      if (closest >= minDistance) {
        return color;
      }
    }
  }
  return randomReadableColor();
}
