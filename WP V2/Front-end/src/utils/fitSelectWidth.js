const SKIP_SELECT_SELECTOR =
  '.task-employee-select, .project-task-table select, .create-project-task-table select, .create-project-fit-select, .user-availability-page .availability-toolbar select';

const WIDTH_PADDING = 34;

let measureNode = null;

function getMeasureNode() {
  if (!measureNode) {
    measureNode = document.createElement('span');
    measureNode.style.cssText =
      'position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none;top:-9999px;left:-9999px;';
    document.body.appendChild(measureNode);
  }

  return measureNode;
}

export function shouldAutoFitSelect(select) {
  return select instanceof HTMLSelectElement && !select.matches(SKIP_SELECT_SELECTOR);
}

export function measureTextWidth(text, referenceElement) {
  const span = getMeasureNode();
  if (referenceElement instanceof Element) {
    const style = window.getComputedStyle(referenceElement);
    span.style.font = style.font;
    span.style.letterSpacing = style.letterSpacing;
  }

  span.textContent = String(text ?? '');
  return span.offsetWidth;
}

export function fitSelectWidth(select) {
  if (!shouldAutoFitSelect(select)) {
    return;
  }

  const texts = Array.from(select.options, (option) => option.text);
  if (texts.length === 0) {
    return;
  }

  let max = 0;
  for (const text of texts) {
    max = Math.max(max, measureTextWidth(text, select));
  }

  select.style.width = 'auto';
  select.style.maxWidth = '100%';
  select.style.minWidth = `${Math.ceil(max) + WIDTH_PADDING}px`;
}

export function fitAllSelects(root = document) {
  root.querySelectorAll('select').forEach((select) => {
    fitSelectWidth(select);
  });
}
