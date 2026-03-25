import { ABEvent } from './types';

const FLUSH_INTERVAL_MS = 2000;
const FLUSH_THRESHOLD = 20;
const RETRY_DELAY_MS = 5000;

export class EventBatcher {
  private queue: ABEvent[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;
  private apiHost: string;
  private clientKey: string;

  constructor(apiHost: string, clientKey: string) {
    this.apiHost = apiHost;
    this.clientKey = clientKey;
    this.setupUnloadHandler();
  }

  start(): void {
    if (!this.timer) {
      this.startTimer();
    }
  }

  push(event: ABEvent): void {
    if (!this.timer) {
      this.startTimer();
    }
    this.queue.push(event);
    if (this.queue.length >= FLUSH_THRESHOLD) {
      this.flush();
    }
  }

  private startTimer(): void {
    this.timer = setInterval(() => {
      if (this.queue.length > 0) {
        this.flush();
      }
    }, FLUSH_INTERVAL_MS);
  }

  private async flush(): Promise<void> {
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0);
    const url = this.apiHost + '/api/ab/events/batch';
    const body = JSON.stringify({ events });

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.clientKey,
        },
        body,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch {
      setTimeout(() => {
        this.retryFlush(url, body);
      }, RETRY_DELAY_MS);
    }
  }

  private async retryFlush(url: string, body: string): Promise<void> {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + this.clientKey,
        },
        body,
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
    } catch {
      console.warn('[ABTesting] Failed to send events after retry, discarding batch.');
    }
  }

  private beaconFlush(): void {
    if (this.queue.length === 0) return;
    const events = this.queue.splice(0);
    const url = this.apiHost + '/api/ab/events/batch';
    const blob = new Blob(
      [JSON.stringify({ events, clientKey: this.clientKey })],
      { type: 'application/json' }
    );
    try {
      navigator.sendBeacon(url, blob);
    } catch {
      console.warn('[ABTesting] sendBeacon failed.');
    }
  }

  private setupUnloadHandler(): void {
    if (typeof document !== 'undefined') {
      document.addEventListener('visibilitychange', () => {
        if (document.hidden) {
          this.beaconFlush();
        }
      });
    }
  }

  destroy(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    this.beaconFlush();
  }
}
