import { EventBatcher } from './batcher';
import { registerClickHandler } from './click-delegate';
import { isInteractiveControl, resolveInteractiveClickTarget } from './click-interactivity';
import { getCurrentPagePath, getDeviceType, nowIso } from './session-context';
import { isSensitiveElement, sanitizeVisibleText } from './element-privacy';

const MODAL_DETECT_MS = 500;
const MODAL_OBSERVER_MS = 8000;
const MAX_MODAL_STEPS = 12;

function getSelector(el: Element): string {
  if (el.id) return '#' + el.id;
  const tag = el.tagName.toLowerCase();
  const cls = Array.from(el.classList).slice(0, 3).join('.');
  if (cls) return `${tag}.${cls}`;
  const parent = el.parentElement;
  if (!parent) return tag;
  const siblings = Array.from(parent.children).filter((c) => c.tagName === el.tagName);
  if (siblings.length > 1) {
    const idx = Array.from(parent.children).indexOf(el) + 1;
    return `${tag}.${cls || tag}:nth-child(${idx})`;
  }
  return tag;
}

function isVisible(el: Element): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }
  const rect = el.getBoundingClientRect();
  return rect.width > 40 && rect.height > 40;
}

function looksLikeModal(el: Element): boolean {
  if (!isVisible(el)) return false;
  if (el.matches('[role="dialog"], [aria-modal="true"]')) return true;
  if (!(el instanceof HTMLElement)) return false;
  const style = window.getComputedStyle(el);
  const z = parseInt(style.zIndex, 10);
  if (!Number.isFinite(z) || z < 100) return false;
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const coversViewport =
    rect.width >= vw * 0.35 && rect.height >= vh * 0.25;
  const fixedOverlay =
    (style.position === 'fixed' || style.position === 'absolute') && coversViewport;
  return fixedOverlay;
}

function findModalContainer(root: Document | Element = document): Element | null {
  const candidates = root.querySelectorAll(
    '[role="dialog"], [aria-modal="true"], [class*="modal" i], [class*="dialog" i], [class*="overlay" i], [class*="popup" i]',
  );
  for (const el of Array.from(candidates)) {
    if (looksLikeModal(el)) return el;
  }
  return null;
}

function stepSignature(container: Element): string {
  const heading = container.querySelector('h1, h2, h3, [role="heading"]');
  const headingText = heading ? sanitizeVisibleText(heading) : undefined;
  if (headingText) return headingText;

  const labels: string[] = [];
  container.querySelectorAll('label, legend, [role="tab"], button').forEach((el) => {
    const t = sanitizeVisibleText(el);
    if (t && labels.length < 4) labels.push(t);
  });
  if (labels.length > 0) return labels.join(' · ');

  const aria = container.getAttribute('aria-label');
  if (aria) return aria.slice(0, 120);

  return `step-${container.textContent?.trim().slice(0, 60) || 'unknown'}`;
}

function flowKeyFromTrigger(pageUrl: string, triggerSelector: string): string {
  return `${pageUrl}::${triggerSelector}`;
}

interface ActiveModalFlow {
  flowKey: string;
  triggerSelector: string;
  triggerText?: string;
  containerSelector: string;
  container: Element;
  stepIndex: number;
  lastSignature: string;
  openedAt: number;
}

export class ModalTracker {
  #batcher: EventBatcher;
  #userId: string;
  #sessionId: string;
  #consent: () => boolean;
  #enabled: () => boolean;
  #variantId?: string;
  #cleanups: (() => void)[] = [];
  #active: ActiveModalFlow | null = null;
  #observer: MutationObserver | null = null;
  #pendingClick: { target: Element; selector: string; text?: string } | null = null;
  #detectTimer: ReturnType<typeof setTimeout> | null = null;
  #extraMeta?: () => Record<string, unknown>;

  constructor(
    batcher: EventBatcher,
    userId: string,
    sessionId: string,
    consent: () => boolean,
    enabled: () => boolean,
    extraMeta?: () => Record<string, unknown>,
  ) {
    this.#batcher = batcher;
    this.#userId = userId;
    this.#sessionId = sessionId;
    this.#consent = consent;
    this.#enabled = enabled;
    this.#extraMeta = extraMeta;
  }

  setVariantId(id: string | undefined): void {
    this.#variantId = id;
  }

  start(): void {
    if (typeof window === 'undefined' || typeof document === 'undefined') return;

    const onClick = (e: MouseEvent) => {
      if (!this.#canTrack()) return;
      const raw = e.target;
      if (!(raw instanceof Element)) return;
      const target = resolveInteractiveClickTarget(raw);
      if (!isInteractiveControl(target) || isSensitiveElement(target)) return;

      const anchor = target.closest('a');
      if (anchor) {
        const href = anchor.getAttribute('href');
        if (href && !href.startsWith('#')) return;
      }

      if (this.#active?.container.contains(target)) {
        this.#scheduleStepCheck();
        return;
      }

      const title = target.getAttribute('title')?.trim().replace(/\s+/g, ' ').slice(0, 120);
      this.#pendingClick = {
        target,
        selector: getSelector(target),
        text: sanitizeVisibleText(target) || title,
      };
      if (this.#detectTimer !== null) clearTimeout(this.#detectTimer);
      this.#detectTimer = setTimeout(() => this.#tryDetectOpen(), MODAL_DETECT_MS);
    };

    const unregister = registerClickHandler(onClick);
    this.#cleanups.push(unregister);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && this.#active) this.#closeActive('escape');
    };
    document.addEventListener('keydown', onKey, true);
    this.#cleanups.push(() => document.removeEventListener('keydown', onKey, true));

    const onVis = () => {
      if (document.hidden && this.#active) this.#closeActive('visibility');
    };
    document.addEventListener('visibilitychange', onVis);
    this.#cleanups.push(() => document.removeEventListener('visibilitychange', onVis));

    const onUnload = () => {
      if (this.#active) this.#closeActive('unload');
    };
    window.addEventListener('beforeunload', onUnload);
    this.#cleanups.push(() => window.removeEventListener('beforeunload', onUnload));
  }

  destroy(): void {
    if (this.#detectTimer !== null) {
      clearTimeout(this.#detectTimer);
      this.#detectTimer = null;
    }
    this.#stopObserver();
    if (this.#active) this.#closeActive('destroy');
    for (const c of this.#cleanups) c();
    this.#cleanups = [];
  }

  #canTrack(): boolean {
    return this.#consent() && this.#enabled();
  }

  #baseMeta(pageUrl: string): Record<string, unknown> {
    return {
      ...(this.#extraMeta?.() || {}),
      page_url: pageUrl,
      device_type: getDeviceType(),
    };
  }

  #push(type: 'session_modal_open' | 'session_modal_step' | 'session_modal_close', metadata: Record<string, unknown>): void {
    this.#batcher.push({
      type,
      user_id: this.#userId,
      session_id: this.#sessionId,
      variant_id: this.#variantId,
      timestamp: nowIso(),
      metadata: {
        ...this.#baseMeta(getCurrentPagePath()),
        ...metadata,
      },
    });
  }

  #tryDetectOpen(): void {
    this.#detectTimer = null;
    const pending = this.#pendingClick;
    this.#pendingClick = null;
    if (!pending || !this.#canTrack()) return;

    const container = findModalContainer();
    if (!container) return;

    const pageUrl = getCurrentPagePath();
    const flowKey = flowKeyFromTrigger(pageUrl, pending.selector);
    const signature = stepSignature(container);
    const containerSelector = getSelector(container);

    this.#active = {
      flowKey,
      triggerSelector: pending.selector,
      triggerText: pending.text,
      containerSelector,
      container,
      stepIndex: 0,
      lastSignature: signature,
      openedAt: Date.now(),
    };

    this.#push('session_modal_open', {
      flow_key: flowKey,
      trigger_selector: pending.selector,
      trigger_text: pending.text,
      container_selector: containerSelector,
      step_index: 0,
      step_signature: signature,
    });

    this.#push('session_modal_step', {
      flow_key: flowKey,
      trigger_selector: pending.selector,
      container_selector: containerSelector,
      step_index: 0,
      step_signature: signature,
    });

    this.#startObserver();
  }

  #startObserver(): void {
    this.#stopObserver();
    if (!this.#active) return;

    const container = this.#active.container;
    this.#observer = new MutationObserver(() => this.#scheduleStepCheck());
    this.#observer.observe(container, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['class', 'style', 'hidden', 'aria-hidden'],
    });

    setTimeout(() => {
      if (this.#active?.container === container && !document.body.contains(container)) {
        this.#closeActive('removed');
      }
    }, MODAL_OBSERVER_MS);
  }

  #stopObserver(): void {
    if (this.#observer) {
      this.#observer.disconnect();
      this.#observer = null;
    }
  }

  #scheduleStepCheck(): void {
    if (!this.#active) return;
    requestAnimationFrame(() => this.#checkStepTransition());
  }

  #checkStepTransition(): void {
    const flow = this.#active;
    if (!flow || !this.#canTrack()) return;

    if (!document.body.contains(flow.container) || !isVisible(flow.container)) {
      this.#closeActive('dismissed');
      return;
    }

    const signature = stepSignature(flow.container);
    if (signature === flow.lastSignature) return;
    if (flow.stepIndex >= MAX_MODAL_STEPS - 1) return;

    flow.stepIndex += 1;
    flow.lastSignature = signature;

    this.#push('session_modal_step', {
      flow_key: flow.flowKey,
      trigger_selector: flow.triggerSelector,
      container_selector: flow.containerSelector,
      step_index: flow.stepIndex,
      step_signature: signature,
    });
  }

  #closeActive(reason: string): void {
    const flow = this.#active;
    if (!flow) return;

    this.#push('session_modal_close', {
      flow_key: flow.flowKey,
      trigger_selector: flow.triggerSelector,
      container_selector: flow.containerSelector,
      step_index: flow.stepIndex,
      close_reason: reason,
      duration_ms: Date.now() - flow.openedAt,
    });

    this.#stopObserver();
    this.#active = null;
  }
}
