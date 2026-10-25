// Which folder holds which building in each town, remembered across restarts in
// ~/.agentville/buildings.json: { "<repo root>": { "map": "<town map>", "areas": { "src/auth": ["library", <last used, ms>] } } }.
// A town's layout only counts for the map it was made on (another map has other buildings).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** A folder's building and when a robot last worked in it. */
export interface Area { building: string; used: number }

export interface BuildingStoreOptions {
  /** default process.env.AGENTVILLE_BUILDINGS ?? ~/.agentville/buildings.json */
  file?: string;
  /** how long to wait before writing changes (ms); 0 writes at once (tests) */
  delay?: number;
}

type Saved = Record<string, { map: string; areas: Record<string, [string, number]>; names?: Record<string, string> }>;

export class BuildingStore {
  private file: string;
  private data?: Saved;
  private delay: number;
  private timer?: NodeJS.Timeout;

  constructor(opts: BuildingStoreOptions = {}) {
    this.file = opts.file ?? process.env.AGENTVILLE_BUILDINGS ?? path.join(os.homedir(), '.agentville', 'buildings.json');
    this.delay = opts.delay ?? 2000;
  }

  /** A town's remembered layout on this map (empty if none, or if it was made on another map). */
  get(root: string, map: string): Map<string, Area> {
    const t = this.load()[root];
    const out = new Map<string, Area>();
    if (t?.map === map) for (const [area, [building, used]] of Object.entries(t.areas)) out.set(area, { building, used });
    return out;
  }

  /** Remembers a town's layout (written shortly after, so busy work doesn't write the file on every event). */
  set(root: string, map: string, areas: Map<string, Area>) {
    const was = this.load()[root];
    this.load()[root] = { map, areas: Object.fromEntries([...areas].map(([a, x]) => [a, [x.building, x.used]])), names: was?.map === map ? was.names : undefined };
    this.later();
  }

  /** Your own names for a town's buildings on this map (the Settings page), by building id. */
  names(root: string, map: string): Record<string, string> {
    const t = this.load()[root];
    return t?.map === map ? { ...(t.names ?? {}) } : {};
  }

  /** Names a building (an empty name goes back to the map's own). */
  setName(root: string, map: string, building: string, name: string) {
    const data = this.load();
    const t = data[root]?.map === map ? data[root] : (data[root] = { map, areas: {} });
    const names = { ...(t.names ?? {}) };
    const n = name.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (n) names[building] = n; else delete names[building];
    t.names = Object.keys(names).length ? names : undefined;
    this.later();
  }

  private later() {
    if (!this.delay) return this.save();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.save(); }, this.delay).unref();
  }

  private load(): Saved {
    if (this.data) return this.data;
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const ok: Saved = {};
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [root, t] of Object.entries<any>(raw)) {
        if (typeof t?.map !== 'string' || !t.areas || typeof t.areas !== 'object') continue;
        const areas: Record<string, [string, number]> = {};
        for (const [a, v] of Object.entries<any>(t.areas)) if (Array.isArray(v) && typeof v[0] === 'string' && typeof v[1] === 'number') areas[a] = [v[0], v[1]];
        const names: Record<string, string> = {};
        if (t.names && typeof t.names === 'object') for (const [b, n] of Object.entries<any>(t.names)) if (typeof n === 'string' && n.trim()) names[b] = n.slice(0, 40);
        ok[root] = { map: t.map, areas, names: Object.keys(names).length ? names : undefined };
      }
      this.data = ok;
    } catch { this.data = {}; }
    return this.data;
  }

  private save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data ?? {}, null, 1) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error(`Couldn't save ${this.file}: ${(err as Error).message}`); }
  }
}
