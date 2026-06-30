import { sanitizeVisibleText } from './element-privacy';

const SECTION_PATTERNS: Array<{ pattern: RegExp; category: string }> = [
  { pattern: /\b(pricing|plans?|tiers?|cost|subscription|billing)\b/i, category: 'pricing' },
  { pattern: /\b(faq|frequently asked|questions?)\b/i, category: 'faq' },
  {
    pattern:
      /\b(testimonials?|reviews?|case stud(?:y|ies)|customer stor|trusted by|social proof|press|as seen in|logos?)\b/i,
    category: 'social proof',
  },
  { pattern: /\b(features?|benefits?|how (?:it )?works|capabilit)\b/i, category: 'features' },
  { pattern: /\b(comparison|compare|alternative|vs\.?)\b/i, category: 'comparison' },
  { pattern: /\b(guarantee|refund|money[- ]back)\b/i, category: 'guarantee' },
  { pattern: /\b(security|compliance|trust)\b/i, category: 'trust & security' },
];

function inferCategoryFromText(text: string): string | undefined {
  for (const { pattern, category } of SECTION_PATTERNS) {
    if (pattern.test(text)) return category;
  }
  return undefined;
}

export function nearestSectionHeading(el: Element): string | undefined {
  let node: Element | null = el;
  while (node && node !== document.body) {
    if (node.matches('[data-section]')) {
      const label = node.getAttribute('data-section-label') || node.getAttribute('aria-label');
      if (label?.trim()) {
        const t = label.trim().replace(/\s+/g, ' ').slice(0, 120);
        return t;
      }
      const dataText = sanitizeVisibleText(node);
      if (dataText) return dataText.slice(0, 120);
    }
    if (node.matches('h1, h2, h3, h4')) {
      const text = sanitizeVisibleText(node);
      if (text) return text.slice(0, 120);
    }
    node = node.parentElement;
  }

  const headings = document.querySelectorAll('h1, h2, h3, h4');
  const rect = el.getBoundingClientRect();
  const elTop = rect.top + window.scrollY;
  let best: { heading: string; dist: number } | null = null;
  for (const h of Array.from(headings)) {
    const hRect = h.getBoundingClientRect();
    const hTop = hRect.top + window.scrollY;
    if (hTop > elTop + 40) continue;
    const dist = elTop - hTop;
    const text = sanitizeVisibleText(h);
    if (!text) continue;
    if (!best || dist < best.dist) best = { heading: text.slice(0, 120), dist };
  }
  return best?.heading;
}

export function inferClientSectionCategory(heading: string | undefined): string | undefined {
  if (!heading) return undefined;
  return inferCategoryFromText(heading);
}

const PII_QUERY_KEYS = /^(utm_|fbclid|gclid|msclkid|email|token|session|user|password|phone)/i;

export function sanitizeClickHref(raw: string | null | undefined): string | undefined {
  if (!raw?.trim()) return undefined;
  try {
    const url = new URL(raw, window.location.origin);
    for (const key of [...url.searchParams.keys()]) {
      if (PII_QUERY_KEYS.test(key)) url.searchParams.delete(key);
    }
    const out = url.href;
    return out.length > 500 ? out.slice(0, 500) : out;
  } catch {
    return raw.slice(0, 500);
  }
}

export function clickElementHref(el: Element): string | undefined {
  const anchor = el.closest('a');
  if (anchor instanceof HTMLAnchorElement && anchor.href) {
    return sanitizeClickHref(anchor.href);
  }
  if (el instanceof HTMLButtonElement && el.formAction) {
    return sanitizeClickHref(el.formAction);
  }
  const formaction = el.getAttribute('formaction');
  if (formaction) return sanitizeClickHref(formaction);
  return undefined;
}
