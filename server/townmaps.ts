// Which town map (Frostpeak, Maplewood, Azure Harbor…) each repo gets, remembered across restarts in
// ~/.agentville/towns.json ({ "<repo root>": "<map id>" }, in the order repos got their map).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TownMapsOptions {
  /** default process.env.AGENTVILLE_TOWNS ?? ~/.agentville/towns.json */
  file?: string;
  /** returns a number in [0, 1); default Math.random (tests pass a fixed one) */
  random?: () => number;
}

export class TownMaps {
  private file: string;
  private data?: Record<string, string>;
  private random: () => number;

  /** `maps`: the available map ids. */
  constructor(readonly maps: string[], opts: TownMapsOptions = {}) {
    this.file = opts.file ?? process.env.AGENTVILLE_TOWNS ?? path.join(os.homedir(), '.agentville', 'towns.json');
    this.random = opts.random ?? Math.random;
  }

  /**
   * The map for a repo: the one remembered for it, else a random one among the maps used least in
   * its world (`sameWorld` tells which remembered repos share it), so a world's towns look different
   * where they can. The choice is remembered, so a repo keeps its look.
   */
  mapFor(root: string, sameWorld: (otherRoot: string) => boolean): string {
    const data = this.load();
    const known = data[root];
    if (known && this.maps.includes(known)) return known;
    const inWorld = new Map(this.maps.map((m) => [m, 0]));
    for (const [r, m] of Object.entries(data)) if (r !== root && inWorld.has(m) && sameWorld(r)) inWorld.set(m, inWorld.get(m)! + 1);
    const least = Math.min(...inWorld.values());
    const choices = this.maps.filter((m) => inWorld.get(m) === least);
    const map = choices[Math.min(choices.length - 1, Math.floor(this.random() * choices.length))];
    data[root] = map;
    this.save(data);
    return map;
  }

  /** Position of a repo in the order repos got their maps (earlier holds its map's spot on the world map). */
  order(root: string): number {
    const i = Object.keys(this.load()).indexOf(root);
    return i < 0 ? Infinity : i;
  }

  private load(): Record<string, string> {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = raw && typeof raw === 'object' && !Array.isArray(raw)
        ? Object.fromEntries(Object.entries(raw).filter(([, v]) => typeof v === 'string')) as Record<string, string> : {};
    } catch { this.data = {}; }
    return this.data!;
  }

  private save(data: Record<string, string>) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error(`Couldn't save ${this.file}: ${(err as Error).message}`); }
  }
}
