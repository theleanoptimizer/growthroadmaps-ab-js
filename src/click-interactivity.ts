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

/** Class tokens like `btn`, `btn--red` — not `buttonhole`. */
const BTN_CLASS_RE = /^btn($|--)/i;

const DEFAULT_RESOLVE_DEPTH = 6;

function hasClickableDataAttr(el: Element): boolean {
  for (const attr of CLICKABLE_DATA_ATTRS) {
    if (el.hasAttribute(attr)) return true;
  }
  return false;
}

function hasBtnClass(el: Element): boolean {
  for (const c of Array.from(el.classList)) {
    if (BTN_CLASS_RE.test(c)) return true;
  }
  return false;
}

/** Semantic / explicit control (not class-only faux buttons). */
function isSemanticControl(el: Element): boolean {
  if (CLICKABLE_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute('role');
  if (role && CLICKABLE_ROLES.has(role)) return true;
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
  if (el.hasAttribute('contenteditable')) return true;
  if (hasClickableDataAttr(el)) return true;
  return false;
}

/** Element itself is a semantic / explicit / faux-button control (not ancestors). */
export function isInteractiveControl(el: Element): boolean {
  return isSemanticControl(el) || hasBtnClass(el);
}

/**
 * Walk up from the event target and return the best interactive control.
 * Semantic controls win over faux `btn--*` class buttons.
 */
export function resolveInteractiveClickTarget(
  el: Element,
  maxDepth = DEFAULT_RESOLVE_DEPTH,
): Element {
  let faux: Element | undefined;
  let node: Element | null = el;
  let depth = 0;
  while (node && depth <= maxDepth) {
    if (isSemanticControl(node)) return node;
    if (!faux && hasBtnClass(node)) faux = node;
    node = node.parentElement;
    depth++;
  }
  return faux ?? el;
}

/** Whether the element looks clickable (DOM-only heuristics — no getComputedStyle). */
export function looksClickable(el: Element): boolean {
  if (isInteractiveControl(el)) return true;
  if (el.closest(CLOSEST_SELECTOR)) return true;
  let node: Element | null = el.parentElement;
  let depth = 0;
  while (node && depth < DEFAULT_RESOLVE_DEPTH) {
    if (hasBtnClass(node)) return true;
    node = node.parentElement;
    depth++;
  }
  return false;
}
