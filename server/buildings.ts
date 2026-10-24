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

type Saved = Record<string, { map: string; areas: Record<string, [string, number]> }>;

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
    this.load()[root] = { map, areas: Object.fromEntries([...areas].map(([a, x]) => [a, [x.building, x.used]])) };
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
        ok[root] = { map: t.map, areas };
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
