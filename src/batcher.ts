import { ABEvent } from './types';

export class EventBatcher {
  #q: ABEvent[] = [];
  #t: ReturnType<typeof setInterval> | null = null;
  #h: string;
  #k: string;
  #debug: boolean;

  constructor(host: string, key: string, debug = false) {
    this.#h = host;
    this.#k = key;
    this.#debug = debug;
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => { if (document.hidden) this.#beacon(); });
    }
  }

  start(): void { if (!this.#t) this.#t = setInterval(() => { if (this.#q.length) this.#flush(); }, 2000); }

  push(e: ABEvent): void {
    if (!this.#t) this.start();
    this.#q.push(e);
    if (this.#q.length >= 20) this.#flush();
  }

  async #flush(): Promise<void> {
    if (!this.#q.length) return;
    const evts = this.#q.splice(0);
    if (this.#debug) console.log('[GR Debug] Flushing', evts.length, 'events', evts.map(e => e.type));
    const url = this.#h + '/api/ab/events/batch';
    const body = JSON.stringify({ events: evts });
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.#k }, body });
      if (!r.ok) { if (this.#debug) console.log('[GR Debug] Batch flush failed:', r.status); throw 0; }
      if (this.#debug) console.log('[GR Debug] Batch flush success:', evts.length, 'events sent');
    } catch { setTimeout(() => this.#retry(url, body), 5000); }
  }

  async #retry(url: string, body: string): Promise<void> {
    try {
      const r = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + this.#k }, body });
      if (!r.ok) throw 0;
    } catch {}
  }

  #beacon(): void {
    if (!this.#q.length) return;
    try { navigator.sendBeacon(this.#h + '/api/ab/events/batch', new Blob([JSON.stringify({ events: this.#q.splice(0), clientKey: this.#k })], { type: 'application/json' })); } catch {}
  }

  destroy(): void {
    if (this.#t) { clearInterval(this.#t); this.#t = null; }
    this.#beacon();
  }
}
