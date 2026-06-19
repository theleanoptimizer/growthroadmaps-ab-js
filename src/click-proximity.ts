export const PROXIMITY_RADIUS = 30;
export const DEAD_COUNT = 2;
export const DEAD_WINDOW = 800;
export const RAGE_COUNT = 3;
export const RAGE_WINDOW = 1000;

const RING_CAP = 10;

export interface ClickRecord {
  x: number;
  y: number;
  t: number;
}

export interface ProximityFlags {
  isDeadClick: boolean;
  isRageClick: boolean;
}

export class ClickProximityTracker {
  #ring: ClickRecord[] = [];

  record(clientX: number, clientY: number, t: number): ProximityFlags {
    this.#ring.push({ x: clientX, y: clientY, t });
    if (this.#ring.length > RING_CAP) this.#ring.shift();

    let nearbyDead = 0;
    let nearbyRage = 0;
    for (const r of this.#ring) {
      if (Math.abs(r.x - clientX) > PROXIMITY_RADIUS || Math.abs(r.y - clientY) > PROXIMITY_RADIUS) {
        continue;
      }
      const age = t - r.t;
      if (age <= DEAD_WINDOW) nearbyDead++;
      if (age <= RAGE_WINDOW) nearbyRage++;
    }

    return {
      isDeadClick: nearbyDead >= DEAD_COUNT,
      isRageClick: nearbyRage >= RAGE_COUNT,
    };
  }

  reset(): void {
    this.#ring = [];
  }
}
