import type { TownData } from './types';

export async function loadTown(id: string): Promise<TownData> {
  const res = await fetch(`towns/${id}/town.json`);
  if (!res.ok) throw new Error(`Couldn't load town "${id}"`);
  const t = (await res.json()) as TownData;
  t.image = `towns/${id}/${t.image}`;
  return t;
}

/** Road path from one building's door to another's, in image px. */
export function pathBetween(t: TownData, from: string, to: string): [number, number][] {
  if (from === to) return [t.buildings[to].door];
  const fwd = t.paths[`${from}|${to}`];
  if (fwd) return fwd;
  const back = t.paths[`${to}|${from}`];
  if (back) return [...back].reverse();
  return [t.buildings[from].door, t.buildings[to].door];
}

/** Where finished robots gather (the plaza), if the town has one. */
export function plazaOf(t: TownData) {
  return Object.keys(t.buildings).find((k) => t.buildings[k].role === 'plaza');
}

export function stationOf(t: TownData) {
  return Object.keys(t.buildings).find((k) => t.buildings[k].role === 'station') ?? Object.keys(t.buildings)[0];
}

/** A train's (or ferry's) phases: off the picture, coming in, stopped at the station, going out. */
export type Phase = 'away' | 'arriving' | 'dwell' | 'leaving';
export const TRAVEL = 3.2; // s from the edge of the picture to the stop (and back)
export const DWELL = 1.6; // s at the stop at least
export const MAX_DWELL = 9; // s at most, waiting for robots still walking to the station

/**
 * The train's next phase, `t` seconds into this one. `need`: robots are waiting to get on or off;
 * `walking`: robots are still on their way to the station (it waits for them, up to MAX_DWELL).
 */
export function nextPhase(phase: Phase, t: number, need: boolean, walking: boolean): Phase {
  if (phase === 'away') return need ? 'arriving' : 'away';
  if (phase === 'arriving') return t >= TRAVEL ? 'dwell' : 'arriving';
  if (phase === 'dwell') return t >= DWELL && !need && (!walking || t >= MAX_DWELL) ? 'leaving' : 'dwell';
  return t >= TRAVEL ? 'away' : 'leaving';
}

export function routeLength(r: [number, number][]) {
  return r.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - r[i][0], p[1] - r[i][1]), 0);
}

/** The point `d` px along a route, with the direction it runs there (radians); past the end, the end. */
export function pointAt(r: [number, number][], d: number): [number, number, number] {
  for (let i = 0; i < r.length - 1; i++) {
    const [x1, y1] = r[i], [x2, y2] = r[i + 1], seg = Math.hypot(x2 - x1, y2 - y1);
    if (d <= seg || i === r.length - 2) {
      const f = seg ? Math.min(d, seg) / seg : 0;
      return [x1 + (x2 - x1) * f, y1 + (y2 - y1) * f, Math.atan2(y2 - y1, x2 - x1)];
    }
    d -= seg;
  }
  return [r[0][0], r[0][1], 0];
}
