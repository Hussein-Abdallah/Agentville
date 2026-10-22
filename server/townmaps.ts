// Which town map (Frostpeak, Maplewood, Azure Harbor…) each repo gets, remembered across restarts in
// ~/.agentville/towns.json ({ "<repo root>": "<map id>" }, in the order repos got their map).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface TownMapsOptions {
  /** default process.env.AGENTVILLE_TOWNS ?? ~/.agentville/towns.json */
  file?: string;
}

export class TownMaps {
  private file: string;
  private data?: Record<string, string>;

  /** `maps`: the available map ids, preferred first. */
  constructor(readonly maps: string[], opts: TownMapsOptions = {}) {
    this.file = opts.file ?? process.env.AGENTVILLE_TOWNS ?? path.join(os.homedir(), '.agentville', 'towns.json');
  }

  /**
   * The map for a repo: the one remembered for it, else the first map no other repo in its world
   * has (`sameWorld` tells which remembered repos share its world), else the least used one.
   */
  mapFor(root: string, sameWorld: (otherRoot: string) => boolean): string {
    const data = this.load();
    const known = data[root];
    if (known && this.maps.includes(known)) return known;
    const used = new Map(this.maps.map((m) => [m, 0]));
    for (const [r, m] of Object.entries(data)) if (r !== root && used.has(m) && sameWorld(r)) used.set(m, used.get(m)! + 1);
    const map = this.maps.find((m) => used.get(m) === 0) ?? [...used].sort((a, b) => a[1] - b[1])[0][0];
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
