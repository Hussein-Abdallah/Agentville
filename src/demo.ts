import type { AgentState, TownData } from './types';
import { plazaOf, stationOf } from './town';

/**
 * Demo mode: fake Claude Code sessions so the town can be tried without the live service.
 * It produces the same AgentState updates the service will send in milestone 4.
 */
const NAMES = ['Atlas', 'Byte', 'Cleo', 'Dex', 'Echo', 'Fern', 'Gus', 'Iris'];
const TASKS: Record<string, string[]> = {
  'grand-lodge': ['Updating dependencies', 'Editing the README', 'Changing project config'],
  church: ['Fixing the login flow', 'Rotating auth tokens', 'Reading the session code'],
  observatory: ['Building the usage report', 'Reading analytics events'],
  'weather-station': ['Running tests', 'Checking the page in the browser', 'Running the build'],
  'train-station': ['Checking the deploy script'],
  'timber-workshop': ['Refactoring helpers', 'Writing a script'],
  greenhouse: ['Prototyping an idea', 'Trying a new layout'],
  'gear-shop': ['Running the build', 'Fixing CI'],
  'rescue-station': ['Tracing a crash', 'Fixing a bug'],
  'skating-pavilion': ['Wiring a webhook', 'Retrying events'],
  library: ['Writing docs', 'Reading the API docs'],
  cafe: ['Polishing the UI', 'Editing the login form', 'Styling the dashboard'],
  'ski-lift': ['Syncing data', 'Changing the database'],
  'hot-springs': ['Warming the cache', 'Running tests'],
};
/** Pretend repo folders per building, so demo labels look like live ones (folder names, not town names). */
export const DEMO_FOLDERS: Record<string, string[]> = {
  'grand-lodge': ['root files'], church: ['auth'], observatory: ['analytics'], 'weather-station': ['commands & tools'],
  greenhouse: ['prototypes'], 'gear-shop': ['ci'], 'rescue-station': ['crash-reports'], 'skating-pavilion': ['webhooks'],
  library: ['docs'], cafe: ['ui'], 'ski-lift': ['db'], 'hot-springs': ['cache'],
};
const pick = <T>(a: T[]) => a[Math.floor(Math.random() * a.length)];

export class Demo {
  agents = new Map<string, AgentState>();
  private timers = new Map<string, number>();
  private n = 0;
  private colors: string[];
  private stopped = false;

  constructor(private town: TownData, colors: string[], private emit: (s: AgentState) => void, private drop: (id: string) => void, private log: (html: string) => void, private arrived: (id: string) => boolean = () => true) {
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

  private buildings() {
    return Object.keys(this.town.buildings).filter((k) => !this.town.buildings[k].role || this.town.buildings[k].role === 'root' || this.town.buildings[k].role === 'commands');
  }

  spawn(parentId?: string) {
    const id = `s${++this.n}`;
    const parent = parentId ? this.agents.get(parentId) : undefined;
    const used = new Set([...this.agents.values()].filter((a) => !a.parentId).map((a) => a.color));
    const color = parent?.color ?? this.colors.find((c) => !used.has(c)) ?? pick(this.colors);
    const building = pick(this.buildings());
    const name = parent ? `${parent.name}·2` : NAMES[(this.n - 1) % NAMES.length];
    const s: AgentState = { id, name, color, building, status: 'working', task: pick(TASKS[building] ?? ['Editing code']), parentId, project: 'demo-repo', startedAt: Date.now() };
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
      const plaza = plazaOf(this.town);
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
      } else {
        a.building = pick(this.buildings().filter((b) => b !== a.building));
        a.status = 'working';
        a.task = pick(TASKS[a.building] ?? ['Editing code']);
        this.timers.set(id, now + 9000 + Math.random() * 9000);
      }
      this.send(a);
    }
    // waiting too long: Claude gives up and continues
    for (const [id, a] of this.agents) if (a.status === 'waiting' && (this.timers.get(id) ?? 0) < now) { a.status = 'idle'; a.task = undefined; this.send(a); this.timers.set(id, now + 5000); }
    setTimeout(() => this.loop(), 500);
  }
}
