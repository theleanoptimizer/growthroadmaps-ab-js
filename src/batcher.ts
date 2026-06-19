import { ABEvent } from './types';

// Task #1218 — strip metadata fields that haven't changed since the previous
// event in the same batch. The server back-fills the dropped values from the
// most recent event in the same payload, so analytics see identical input
// while the wire payload shrinks (device_type/attributes/page_url are the
// fattest repeating fields). Returns a NEW array; original events are not
// mutated so retries serialize from the same dedup state.
export function dedupeBatchMetadata(events: ABEvent[]): ABEvent[] {
  let lastDevice: string | undefined;
  let lastAttrsJson: string | undefined;
  let lastUrl: string | undefined;
  return events.map(evt => {
    const md = (evt as { metadata?: Record<string, unknown> }).metadata;
    if (!md || typeof md !== 'object') return evt;
    const next: Record<string, unknown> = { ...md };
    if (typeof next.device_type === 'string') {
      if (next.device_type === lastDevice) {
        delete next.device_type;
      } else {
        lastDevice = next.device_type;
      }
    }
    if (next.attributes && typeof next.attributes === 'object' && !Array.isArray(next.attributes)) {
      const j = JSON.stringify(next.attributes);
      if (j === lastAttrsJson) {
        delete next.attributes;
      } else {
        lastAttrsJson = j;
      }
    }
    if (typeof next.page_url === 'string') {
      if (next.page_url === lastUrl) {
        delete next.page_url;
      } else {
        lastUrl = next.page_url;
      }
    }
    return { ...evt, metadata: next } as ABEvent;
  });
}

const scheduleIdle =
  typeof requestIdleCallback !== 'undefined'
    ? (cb: () => void) => requestIdleCallback(cb, { timeout: 2000 })
    : (cb: () => void) => setTimeout(cb, 0);

export class EventBatcher {
  #q: ABEvent[] = [];
  #t: ReturnType<typeof setInterval> | null = null;
  #h: string;
  #k: string;
  #debug: boolean;
  #idleFlushScheduled = false;

  constructor(host: string, key: string, debug = false) {
    this.#h = host;
    this.#k = key;
    this.#debug = debug;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.#beacon(); });
    }
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', () => { this.#beacon(); });
    }
  }

  start(): void { if (!this.#t) this.#t = setInterval(() => { if (this.#q.length) this.#flush(); }, 2000); }

  push(e: ABEvent): void {
    if (!this.#t) this.start();
    this.#q.push(e);
    if (this.#q.length >= 20) this.#scheduleIdleFlush();
  }

  #scheduleIdleFlush(): void {
    if (this.#idleFlushScheduled) return;
    this.#idleFlushScheduled = true;
    scheduleIdle(() => {
      this.#idleFlushScheduled = false;
      this.#flush();
    });
  }

  async #flush(): Promise<void> {
    if (!this.#q.length) return;
    const evts = dedupeBatchMetadata(this.#q.splice(0));
    if (this.#debug) console.log('[GR Debug] Flushing', evts.length, 'events', evts.map(e => e.type));
    const url = this.#h + '/api/ab/events/batch';
    const body = JSON.stringify({ events: evts });
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.#k },
        body,
        keepalive: true,
      });
      if (!r.ok) { if (this.#debug) console.log('[GR Debug] Batch flush failed:', r.status); throw 0; }
      if (this.#debug) console.log('[GR Debug] Batch flush success:', evts.length, 'events sent');
    } catch { setTimeout(() => this.#retry(url, body), 5000); }
  }

  async #retry(url: string, body: string): Promise<void> {
    try {
      const r = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.#k },
        body,
        keepalive: true,
      });
      if (!r.ok) throw 0;
    } catch {}
  }

  #beacon(): void {
    if (!this.#q.length) return;
    const evts = dedupeBatchMetadata(this.#q.splice(0));
    try { navigator.sendBeacon(this.#h + '/api/ab/events/batch', new Blob([JSON.stringify({ events: evts, clientKey: this.#k })], { type: 'application/json' })); } catch {}
  }

  flushBeacon(): void { this.#beacon(); }

  destroy(): void {
    if (this.#t) { clearInterval(this.#t); this.#t = null; }
    this.#beacon();
  }
}
