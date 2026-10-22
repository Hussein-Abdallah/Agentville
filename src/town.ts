import type { TownData } from './types';

export async function loadTown(id: string): Promise<TownData> {
  const res = await fetch(`towns/${id}/town.json`);
  if (!res.ok) throw new Error(`Couldn't load town "${id}"`);
  const t: TownData = await res.json();
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
