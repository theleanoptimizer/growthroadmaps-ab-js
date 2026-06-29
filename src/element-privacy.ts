const SENSITIVE_SELECTOR_RE =
  /input\[type=(?:password|email|tel|hidden)\]|autocomplete=["']cc-|data-gr-mask/i;

function privacySelector(el: Element): string {
  if (el.id) return '#' + el.id;
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList).slice(0, 3).join('.');
  return cls ? `${tag}.${cls}` : tag;
}

export function isSensitiveElement(el: Element | null): boolean {
  if (!el) return false;
  if (el.matches('input[type=password],input[type=email],input[type=tel],input[type=hidden],[autocomplete^="cc-"],[data-gr-mask]')) {
    return true;
  }
  return SENSITIVE_SELECTOR_RE.test(privacySelector(el));
}

export function sanitizeVisibleText(el: Element | null): string | undefined {
  if (!el || isSensitiveElement(el)) return undefined;
  const text = (el.textContent || '').trim().replace(/\s+/g, ' ');
  return text.slice(0, 120) || undefined;
}
