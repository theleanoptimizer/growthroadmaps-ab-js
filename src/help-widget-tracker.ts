import { EventBatcher } from './batcher';
import { getCurrentPagePath, getDeviceType, nowIso } from './session-context';
import type { SessionEvent } from './types';

const HELP_SELECTORS = [
  '[data-help-widget]',
  '[class*="help-widget" i]',
  '[class*="intercom" i]',
  '[id*="intercom" i]',
  '[class*="zendesk" i]',
  '[id*="launcher"]',
  '[aria-label*="help" i]',
  '[aria-label*="support" i]',
];

const HELP_SEARCH_QUERY_MAX_LEN = 120;

function truncateHelpSearchQuery(raw: string): string {
  return raw.trim().slice(0, HELP_SEARCH_QUERY_MAX_LEN);
}

export class HelpWidgetTracker {
  #batcher: EventBatcher;
  #userId: string;
  #sessionId: string;
  #consent: () => boolean;
  #enabled: () => boolean;
  #selectors: string[];
  #variantId?: string;
  #cleanups: (() => void)[] = [];
  #opened = false;
  #extraMeta?: () => Record<string, unknown>;

  constructor(
    batcher: EventBatcher,
    userId: string,
    sessionId: string,
    consent: () => boolean,
    enabled: () => boolean,
    extraMeta?: () => Record<string, unknown>,
    selectors?: string[],
  ) {
    this.#batcher = batcher;
    this.#userId = userId;
    this.#sessionId = sessionId;
    this.#consent = consent;
    this.#enabled = enabled;
    this.#extraMeta = extraMeta;
    const custom = (selectors ?? []).map((s) => s.trim()).filter(Boolean);
    this.#selectors = custom.length > 0 ? custom : HELP_SELECTORS;
  }

  setVariantId(vid: string): void {
    this.#variantId = vid;
  }

  #push(type: SessionEvent['type'], metadata: Record<string, unknown>): void {
    if (!this.#consent() || !this.#enabled()) return;
    const extra = this.#extraMeta?.() || {};
    const evt: SessionEvent = {
      type,
      user_id: this.#userId,
      session_id: this.#sessionId,
      variant_id: this.#variantId,
      timestamp: nowIso(),
      metadata: { ...extra, ...metadata, page_url: getCurrentPagePath(), device_type: getDeviceType() },
    };
    this.#batcher.push(evt);
  }

  start(): void {
    const onClick = (e: MouseEvent) => {
      const target = e.target;
      if (!(target instanceof Element)) return;
      for (const sel of this.#selectors) {
        const match = target.closest(sel);
        if (match) {
          if (!this.#opened) {
            this.#opened = true;
            this.#push('help_widget_open', { trigger_selector: sel });
          }
          return;
        }
      }
    };

    document.addEventListener('click', onClick, true);
    this.#cleanups.push(() => document.removeEventListener('click', onClick, true));

    const onSearchInput = (e: Event) => {
      const target = e.target;
      if (!(target instanceof HTMLInputElement)) return;
      if (!/search|help|support|faq/i.test(target.name + target.placeholder + (target.getAttribute('aria-label') ?? ''))) {
        return;
      }
      if (target.value.trim().length >= 3) {
        const queryText = truncateHelpSearchQuery(target.value);
        this.#push('help_widget_search', {
          query_length: queryText.length,
          query_text: queryText,
        });
      }
    };

    document.addEventListener('change', onSearchInput, true);
    this.#cleanups.push(() => document.removeEventListener('change', onSearchInput, true));
  }

  destroy(): void {
    for (const fn of this.#cleanups) fn();
    this.#cleanups = [];
  }
}

export default HelpWidgetTracker;
