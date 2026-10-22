import type { AgentState, TownData, TownInfo } from './types';
import { plazaOf, stationOf } from './town';

/**
 * Demo mode: fake Claude Code sessions so the town can be tried without the live service.
 * It produces the same AgentState updates the service will send in milestone 4.
 */
const NAMES = ['Atlas', 'Byte', 'Cleo', 'Dex', 'Echo', 'Fern', 'Gus', 'Iris'];
/** What a demo robot does, by the folder of the building it's at. */
const TASKS: Record<string, string[]> = {
  'root files': ['Updating dependencies', 'Editing the README', 'Changing project config'],
  'commands & tools': ['Running tests', 'Checking the page in the browser', 'Running the build'],
  auth: ['Fixing the login flow', 'Rotating auth tokens', 'Reading the session code'],
  ui: ['Polishing the UI', 'Editing the login form', 'Styling the dashboard'],
  db: ['Syncing data', 'Changing the database'],
  docs: ['Writing docs', 'Reading the API docs'],
  analytics: ['Building the usage report', 'Reading analytics events'],
  ci: ['Running the build', 'Fixing CI'],
  cache: ['Warming the cache', 'Running tests'],
  webhooks: ['Wiring a webhook', 'Retrying events'],
  prototypes: ['Prototyping an idea', 'Trying a new layout'],
  'crash-reports': ['Tracing a crash', 'Fixing a bug'],
};
const FOLDERS = ['auth', 'ui', 'db', 'docs', 'analytics', 'ci', 'cache', 'webhooks', 'prototypes', 'crash-reports'];

/** Pretend repo folders for a town map's buildings, so demo labels look like live ones. */
export function demoFolders(t: TownData): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  let i = 0;
  for (const [id, b] of Object.entries(t.buildings)) {
    if (b.role === 'root') out[id] = ['root files'];
    else if (b.role === 'commands') out[id] = ['commands & tools'];
    else if (!b.role && i < FOLDERS.length) out[id] = [FOLDERS[i++]];
  }
  return out;
}

/** Pretend towns in two worlds, so the demo has a world map. Folders are filled in from each town's map. */
export const DEMO_TOWNS: TownInfo[] = [
  { id: 'demo:acme/api', name: 'api', world: 'Acme', map: 'frostpeak', spot: true, folders: {}, names: {} },
  { id: 'demo:acme/web', name: 'web', world: 'Acme', map: 'maplewood', spot: true, folders: {}, names: {} },
  { id: 'demo:acme/docs-site', name: 'docs-site', world: 'Acme', map: 'azure-harbor', spot: true, folders: {}, names: {} },
  { id: 'demo:acme/admin', name: 'admin', world: 'Acme', map: 'frostpeak', spot: false, folders: {}, names: {} },
  { id: 'demo:blog/site', name: 'site', world: 'Blog', map: 'frostpeak', spot: true, folders: {}, names: {} },
];
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export class Demo {
  agents = new Map<string, AgentState>();
  private timers = new Map<string, number>();
  private n = 0;
  private colors: string[];
  private stopped = false;

  /** `mapOf`: the town map of a demo town id. */
  constructor(private mapOf: (town: string) => TownData, colors: string[], private emit: (s: AgentState) => void, private drop: (id: string) => void, private log: (html: string) => void, private arrived: (id: string) => boolean = () => true) {
    this.colors = colors;
  }

  start(count = 5) {
    for (let i = 0; i < count; i++) setTimeout(() => this.spawn(), i * 1400);
    this.loop();
  }
  stop() { this.stopped = true; }

  /** Emits an update, stamping the activity time and history the details panel shows (as the service does). */
  private send(a: AgentState) {
    a.lastActive = Date.now();
    const text = a.status === 'waiting' ? 'Needs you: approval' : a.status === 'idle' ? 'Finished' : a.task;
    if (text && a.recent?.[0]?.text !== text) a.recent = [{ t: a.lastActive, text }, ...(a.recent ?? [])].slice(0, 8);
    this.emit({ ...a });
  }

  /** Buildings a robot can work at in a town: those with a demo folder. */
  private buildings(town: string) {
    return Object.keys(DEMO_TOWNS.find((t) => t.id === town)?.folders ?? {});
  }

  private task(town: string, building: string) {
    const folder = DEMO_TOWNS.find((t) => t.id === town)?.folders[building]?.[0] ?? '';
    return pick(TASKS[folder] ?? ['Editing code']);
  }

  spawn(parentId?: string) {
    const id = `s${++this.n}`;
    const parent = parentId ? this.agents.get(parentId) : undefined;
    const used = new Set([...this.agents.values()].filter((a) => !a.parentId).map((a) => a.color));
    const color = parent?.color ?? this.colors.find((c) => !used.has(c)) ?? pick(this.colors);
    const name = parent ? `${parent.name}·2` : NAMES[(this.n - 1) % NAMES.length];
    const town = parent ? DEMO_TOWNS.find((t) => t.id === parent.town)! : pick(DEMO_TOWNS);
    const building = pick(this.buildings(town.id));
    const s: AgentState = { id, name, color, building, status: 'working', task: this.task(town.id, building), parentId, project: town.name, town: town.id, startedAt: Date.now() };
    this.agents.set(id, s);
    this.send(s);
    this.timers.set(id, performance.now() + 7000 + Math.random() * 6000);
    this.log(parent ? `<b>${parent.name}</b> started a helper` : `<b>${name}</b> started a session`);
  }

  approve(id: string) {
    const a = this.agents.get(id);
    if (!a || a.status !== 'waiting') return;
    a.status = 'working';
    a.task = 'Approved, continuing';
    this.send(a);
    this.timers.set(id, performance.now() + 4000 + Math.random() * 3000);
    this.log(`You approved <b>${a.name}</b>`);
  }

  private loop() {
    if (this.stopped) return;
    const now = performance.now();
    for (const [id, a] of this.agents) {
      if (a.status === 'waiting') continue; // waits for you (or times out below)
      // the dwell timer only starts once the robot has reached its building
      if (!this.arrived(id)) { this.timers.set(id, Math.max(this.timers.get(id) ?? 0, now + 6000 + Math.random() * 6000)); continue; }
      if ((this.timers.get(id) ?? 0) > now) continue;
      const r = Math.random();
      if (a.parentId && r < 0.3) { this.agents.delete(id); this.drop(id); this.log(`<b>${a.name}</b> finished`); continue; }
      const plaza = plazaOf(this.mapOf(a.town!));
      if (plaza && a.status !== 'idle' && !a.parentId && r > 0.82) {
        a.building = plaza; a.status = 'idle'; a.task = undefined;
        this.log(`<b>${a.name}</b> finished and went to the plaza`);
        this.timers.set(id, now + 8000 + Math.random() * 8000);
      } else if (r < 0.14) {
        a.status = 'waiting';
        this.log(`<b>${a.name}</b> needs your approval`);
        this.timers.set(id, now + 25000);
      } else if (r < 0.2 && !a.parentId && [...this.agents.values()].filter((x) => x.parentId === id).length < 1) {
        this.spawn(id);
        this.timers.set(id, now + 6000);
        continue;
      } else if (r < 0.26 && !a.parentId) {
        // work in another repo of the same world: off to that town
        const from = DEMO_TOWNS.find((t) => t.id === a.town)!;
        const to = pick(DEMO_TOWNS.filter((t) => t.world === from.world && t.id !== from.id).concat(from));
        a.town = to.id; a.project = to.name;
        a.building = pick(this.buildings(to.id)); a.status = 'working'; a.task = this.task(to.id, a.building);
        if (to !== from) this.log(`<b>${a.name}</b> went from ${from.name} to ${to.name}`);
        this.timers.set(id, now + 9000 + Math.random() * 9000);
      } else {
        a.building = pick(this.buildings(a.town!).filter((b) => b !== a.building));
        a.status = 'working';
        a.task = this.task(a.town!, a.building);
        this.timers.set(id, now + 9000 + Math.random() * 9000);
      }
      this.send(a);
    }
    // waiting too long: Claude gives up and continues
    for (const [id, a] of this.agents) if (a.status === 'waiting' && (this.timers.get(id) ?? 0) < now) { a.status = 'idle'; a.task = undefined; this.send(a); this.timers.set(id, now + 5000); }
    setTimeout(() => this.loop(), 500);
  }
}
