import type { ActivityKind, AgentState, TownData, TownInfo } from './types';
import { plazaOf, stationOf } from './town';

/**
 * Demo mode: fake Claude Code sessions so the town can be tried without the live service.
 * It produces the same AgentState updates the service will send in milestone 4.
 */
const NAMES = ['Atlas', 'Byte', 'Cleo', 'Dex', 'Echo', 'Fern', 'Gus', 'Iris'];
/** What a demo robot does, by the folder of the building it's at. */
const TASKS: Record<string, string[]> = {
  'root files': ['Updating dependencies', 'Editing the README', 'Saving a commit', 'Installing packages'],
  'commands & tools': ['Running tests', 'Starting the dev server', 'Running the build', 'Deploying the app'],
  auth: ['Fixing the login flow', 'Rotating auth tokens', 'Reading the session code'],
  ui: ['Polishing the UI', 'Editing the login form', 'Styling the dashboard'],
  db: ['Syncing data', 'Changing the database'],
  docs: ['Writing docs', 'Reading the API docs'],
  analytics: ['Building the usage report', 'Reading analytics events'],
  ci: ['Running the build', 'Running tests', 'Deploying the app'],
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

/** Pretend towns in worlds of many sizes (1 to 12 repos, 36 towns), so the demo shows world boards of every size and a planet. Folders are filled in from each town's map. */
export const DEMO_TOWNS: TownInfo[] = [
  { id: 'demo:acme/api', name: 'api', world: 'Acme', map: 'frostpeak', spot: true, primary: true, folders: {}, names: {} },
  { id: 'demo:acme/web', name: 'web', world: 'Acme', map: 'maplewood', spot: true, primary: false, folders: {}, names: {} },
  { id: 'demo:acme/docs-site', name: 'docs-site', world: 'Acme', map: 'azure-harbor', spot: true, primary: false, folders: {}, names: {} },
  { id: 'demo:acme/admin', name: 'admin', world: 'Acme', map: 'frostpeak', spot: false, primary: false, folders: {}, names: {} },
  { id: 'demo:blog/site', name: 'site', world: 'Blog', map: 'frostpeak', spot: true, primary: true, folders: {}, names: {} },
  { id: 'demo:shop/store', name: 'store', world: 'Shop', map: 'azure-harbor', spot: true, primary: true, folders: {}, names: {} },
  { id: 'demo:notes/wiki', name: 'wiki', world: 'Notes', map: 'maplewood', spot: true, primary: true, folders: {}, names: {} },
  { id: 'demo:dunes/game', name: 'game', world: 'Dunes', map: 'sunreach-oasis', spot: true, primary: true, folders: {}, names: {} },
  ...sampleWorld('Duo', ['app', 'api']),
  ...sampleWorld('Studio', ['site', 'cms', 'api', 'shop', 'emails', 'assets']),
  ...sampleWorld('Platform', ['gateway', 'auth', 'billing', 'search', 'mobile', 'web', 'admin', 'docs']),
  ...sampleWorld('Enterprise', ['portal', 'identity', 'payments', 'ledger', 'orders', 'catalog', 'search', 'reviews', 'notifications', 'reports', 'shipping', 'support']),
];

/** A sample world: the first repo is its primary town; maps rotate like random picks do (a world uses every map before repeating). */
function sampleWorld(world: string, repos: string[]): TownInfo[] {
  const maps = ['frostpeak', 'maplewood', 'azure-harbor', 'sunreach-oasis'];
  const shift = [...world].reduce((a, c) => a + c.charCodeAt(0), 0);
  return repos.map((name, i) => ({
    id: `demo:${world.toLowerCase()}/${name}`, name, world, map: maps[(i + shift) % maps.length],
    spot: i < maps.length, primary: i === 0, folders: {}, names: {},
  }));
}
/** What a demo session was asked, and how it answered when done. */
const TALKS: { prompt: string; reply: string }[] = [
  { prompt: 'The login form accepts an empty password. Can you fix it and add a test?', reply: 'Fixed: the form now rejects empty passwords and shows "Enter your password". Added a test for it; all 48 tests pass.' },
  { prompt: 'Add a search box to the orders page that filters by customer name.', reply: 'The orders page has a search box now. It filters as you type and keeps the filter in the address, so a reload keeps it.' },
  { prompt: 'Why is the dashboard slow to load?', reply: 'It loaded every chart\'s data on start. Charts now load when they scroll into view, so the first paint is about 3 times faster. Want me to cache the totals too?' },
  { prompt: 'Update the README with the new setup steps.', reply: 'The README now covers installing, the .env values and running the tests. I left the deploy section as it was.' },
  { prompt: 'Rename the "client" table to "customer" everywhere.', reply: 'Renamed in the schema, the migration, the API and the UI labels. The migration is ready but not run yet.' },
];

/** What a waiting demo robot wants, as the live service words it. */
const ASKS: { task: string; ask: string }[] = [
  { task: 'Wants to run a command', ask: 'Run the unit tests: npm test' },
  { task: 'Wants to run a command', ask: 'Push the branch: git push origin feature/search' },
  { task: 'Has a question', ask: 'Should the search box also look through archived projects?' },
  { task: 'Wants to edit a file', ask: 'src/auth/session.ts' },
  { task: 'Wants to open a web page', ask: 'https://docs.example.com/api/rate-limits' },
  { task: 'Waiting for your reply', ask: 'The migration is ready. Do you want me to run it on staging first?' },
  { task: 'Wants you to approve a plan', ask: 'Move billing to the new invoices table in three steps' },
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
    if (a.status !== 'waiting') delete a.ask;
    if (!a.parentId) this.progress(a);
    this.service(a);
    const text = a.status === 'waiting' ? 'Needs you: approval' : a.status === 'idle' ? 'Finished' : a.task;
    if (text && a.recent?.[0]?.text !== text) a.recent = [{ t: a.lastActive, text }, ...(a.recent ?? [])].slice(0, 8);
    this.emit({ ...a });
  }

  /**
   * Pretend context and to-dos: each step fills the context a little (compacting near the top, then
   * starting over) and ticks off the to-do in progress, with a new list once one is done.
   */
  private progress(a: AgentState) {
    const MAX = 1_000_000;
    const c = (a.context ??= { used: Math.round(MAX * (0.05 + Math.random() * 0.6)), max: MAX });
    if (c.compacting) Object.assign(c, { compacting: false, used: 0, compactedAt: Date.now(), compactions: (c.compactions ?? 0) + 1 });
    else if (c.used / c.max > 0.92) c.compacting = true;
    else c.used = Math.min(c.max, c.used + Math.round(8000 + Math.random() * 30000) + (c.used ? 0 : 40000));
    if (a.status !== 'working') return;
    if (!a.todos || a.todos.every((t) => t.status === 'completed')) {
      const steps = [...new Set(Object.values(TASKS).flat())].sort(() => Math.random() - 0.5).slice(0, 3 + Math.floor(Math.random() * 3));
      a.todos = steps.map((t, i) => ({ text: t, status: i ? 'pending' : 'in_progress' }));
      return;
    }
    if (Math.random() < 0.5) return;
    const cur = a.todos.findIndex((t) => t.status === 'in_progress');
    if (cur >= 0) a.todos[cur].status = 'completed';
    const next = a.todos.findIndex((t) => t.status === 'pending');
    if (next >= 0) a.todos[next].status = 'in_progress';
  }

  /**
   * Pretend town services: a task like "Running tests" shows its badge; when the robot moves on, the
   * command ends (mostly passing), and a dev server is sometimes left running in the background.
   */
  private service(a: AgentState) {
    const kind = demoKind(a.status === 'working' ? a.task : undefined);
    if (a.activity && a.activity !== kind) {
      const ended = a.activity;
      delete a.activity;
      if (ended === 'server' && Math.random() < 0.5) a.background = [{ type: 'shell', kind: 'server', text: 'Start the dev server: npm run dev' }];
      else a.result = { kind: ended, ok: Math.random() < 0.8, at: Date.now() };
    }
    if (kind) { a.activity = kind; delete a.result; }
    if (a.background && Math.random() < 0.1) delete a.background;
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
    const talk = parent ? undefined : pick(TALKS);
    const s: AgentState = {
      id, name, color, building, status: 'working', task: this.task(town.id, building), parentId, project: town.name, town: town.id, startedAt: Date.now(),
      title: talk?.prompt.slice(0, 80), lastPrompt: talk?.prompt,
    };
    this.agents.set(id, s);
    this.send(s);
    this.timers.set(id, performance.now() + 7000 + Math.random() * 6000);
    this.log(parent ? `<b>${parent.name}</b> started a helper` : `<b>${name}</b> started a session`);
  }

  /** Your own name for a robot (its helpers follow). */
  rename(id: string, name: string) {
    const a = this.agents.get(id);
    if (!a) return;
    const old = a.name;
    a.name = name.replace(/[<>&"'`\\]/g, '').trim().slice(0, 24) || a.name;
    this.send(a);
    for (const h of this.agents.values()) if (h.parentId === id) { h.name = h.name.replace(/^.*·/, `${a.name}·`); this.send(h); }
    this.log(`<b>${old}</b> is now <b>${a.name}</b>`);
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
        a.lastReply = TALKS.find((t) => t.prompt === a.lastPrompt)?.reply;
        this.log(`<b>${a.name}</b> finished and went to the plaza`);
        this.timers.set(id, now + 8000 + Math.random() * 8000);
      } else if (r < 0.14) {
        a.status = 'waiting';
        Object.assign(a, pick(ASKS));
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

/** The town-services kind of a demo task. */
function demoKind(task?: string): ActivityKind | undefined {
  if (!task) return;
  if (/tests/i.test(task)) return 'test';
  if (/build|CI/i.test(task)) return 'build';
  if (/commit/i.test(task)) return 'git';
  if (/dependencies|packages/i.test(task)) return 'install';
  if (/dev server/i.test(task)) return 'server';
  if (/deploy/i.test(task)) return 'deploy';
}

