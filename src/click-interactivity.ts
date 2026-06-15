export const DEAD_CLICK_VERIFY_MS = 500;

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

const ARIA_STATE_ATTRS = ['aria-expanded', 'aria-pressed', 'aria-checked'] as const;

const POINTER_WALK_MAX = 5;

export interface ClickOutcomeBaseline {
  href: string;
  hash: string;
  activeElement: Element | null;
  ariaStates: string[];
  childElementCount: number;
  textContentLength: number;
  className: string;
  bodyDialogCount: number;
}

function hasClickableDataAttr(el: Element): boolean {
  for (const attr of CLICKABLE_DATA_ATTRS) {
    if (el.hasAttribute(attr)) return true;
  }
  return false;
}

function hasPointerCursor(el: Element): boolean {
  let node: Element | null = el;
  for (let depth = 0; node && depth < POINTER_WALK_MAX; depth++, node = node.parentElement) {
    if (node.tagName === 'BODY') break;
    try {
      if (window.getComputedStyle(node).cursor === 'pointer') return true;
    } catch {
      break;
    }
  }
  return false;
}

function collectAriaStates(el: Element): string[] {
  const states: string[] = [];
  let node: Element | null = el;
  for (let depth = 0; node && depth < POINTER_WALK_MAX; depth++, node = node.parentElement) {
    for (const attr of ARIA_STATE_ATTRS) {
      states.push(node.getAttribute(attr) ?? '');
    }
  }
  return states;
}

function countBodyDialogs(): number {
  let count = 0;
  for (const child of Array.from(document.body.children)) {
    if (!(child instanceof Element)) continue;
    const role = child.getAttribute('role');
    if (role === 'dialog' || role === 'alertdialog') count++;
  }
  return count;
}

/** Whether the element looks clickable to a user (broad DOM + visual heuristics). */
export function looksClickable(el: Element): boolean {
  if (CLICKABLE_TAGS.has(el.tagName)) return true;
  const role = el.getAttribute('role');
  if (role && CLICKABLE_ROLES.has(role)) return true;
  if (el.hasAttribute('onclick') || el.hasAttribute('tabindex')) return true;
  if (el.hasAttribute('contenteditable')) return true;
  if (hasClickableDataAttr(el)) return true;
  if (el.closest(CLOSEST_SELECTOR)) return true;
  if (hasPointerCursor(el)) return true;
  return false;
}

/** Snapshot DOM/navigation state at click time for outcome comparison. */
export function captureClickBaseline(el: Element): ClickOutcomeBaseline {
  return {
    href: location.href,
    hash: location.hash,
    activeElement: document.activeElement instanceof Element ? document.activeElement : null,
    ariaStates: collectAriaStates(el),
    childElementCount: el.childElementCount,
    textContentLength: el.textContent?.length ?? 0,
    className: el.className,
    bodyDialogCount: countBodyDialogs(),
  };
}

/**
 * True if the page responded to the click within the verification window.
 * Checks navigation, focus, ARIA state, subtree mutation, and new dialogs.
 */
export function hadMeaningfulResponse(before: ClickOutcomeBaseline, el: Element): boolean {
  if (location.href !== before.href || location.hash !== before.hash) return true;

  const active = document.activeElement instanceof Element ? document.activeElement : null;
  if (active !== before.activeElement) return true;

  const currentAria = collectAriaStates(el);
  if (
    currentAria.length !== before.ariaStates.length ||
    currentAria.some((v, i) => v !== before.ariaStates[i])
  ) {
    return true;
  }

  if (el.childElementCount !== before.childElementCount) return true;
  if ((el.textContent?.length ?? 0) !== before.textContentLength) return true;
  if (el.className !== before.className) return true;

  if (countBodyDialogs() > before.bodyDialogCount) return true;

  return false;
}
