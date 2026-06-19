const CLICKABLE_TAGS = new Set([
  'A', 'BUTTON', 'INPUT', 'SELECT', 'TEXTAREA', 'SUMMARY', 'DETAILS', 'LABEL', 'OPTION',
]);

const CLICKABLE_ROLES = new Set([
  'button', 'link', 'tab', 'menuitem', 'checkbox', 'radio', 'switch',
  'option', 'menuitemcheckbox', 'menuitemradio', 'treeitem', 'slider',
]);

const CLICKABLE_DATA_ATTRS = ['data-action', 'data-click'];

const CLOSEST_SELECTOR =
  'a, button, label, input, select, textarea, [role="button"], [role="link"], [contenteditable]';

function hasClickableDataAttr(el: Element): boolean {
  for (const attr of CLICKABLE_DATA_ATTRS) {
    if (el.hasAttribute(attr)) return true;
  }
  return false;
}

/** Whether the element looks clickable (DOM-only heuristics — no getComputedStyle). */
export function looksClickable(el: Element): boolean {
  if (CLICKABLE_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute('role');
  if (role && CLICKABLE_ROLES.has(role)) return true;
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
  if (el.hasAttribute('contenteditable')) return true;
  if (hasClickableDataAttr(el)) return true;
  if (el.closest(CLOSEST_SELECTOR)) return true;
  return false;
}
