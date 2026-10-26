// Groups towns (repo roots) into worlds (projects): from worlds.json, a repo's agentville.json, or by folder.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export interface WorldsOptions {
  /** user override file; default process.env.AGENTVILLE_WORLDS ?? ~/.agentville/worlds.json */
  configFile?: string;
  /** Claude's config folder; default process.env.CLAUDE_CONFIG_DIR ?? ~/.claude */
  claudeDir?: string;
  /** home folder; default os.homedir() (tests pass a temp folder) */
  home?: string;
}

/** One worlds.json pattern: that repo root exactly, or (deep, `/**`) any repo root inside that folder. */
interface Pattern { dir: string; deep: boolean }

/** What worlds.json says: an optional dev folder and world patterns, in file order. */
interface Overrides { root?: string; worlds: [string, Pattern[]][] }

const MAX_READ = 64 * 1024; // per transcript, when seeding
const TEMPS = [os.tmpdir(), '/tmp', '/private/tmp', '/var/folders', '/private/var/folders'];

/** p is dir or inside it. */
const within = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith(path.sep) ? dir : dir + path.sep);
/** p is strictly inside dir. */
const inside = (p: string, dir: string) => p !== dir && within(p, dir);
const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);

/** Absolute path with symlinks resolved as far as it exists (macOS /var → /private/var). */
function real(p: string): string {
  const abs = path.resolve(p);
  let head = abs, tail = '';
  for (;;) {
    try { return path.join(fs.realpathSync(head), tail); } catch { /* go up */ }
    const up = path.dirname(head);
    if (up === head) return abs;
    tail = path.join(path.basename(head), tail);
    head = up;
  }
}

/** Deepest folder holding both a and b. */
function common(a: string, b: string): string {
  const x = a.split(path.sep), y = b.split(path.sep);
  let i = 0;
  while (i < x.length && i < y.length && x[i] === y[i]) i++;
  return x.slice(0, i).join(path.sep) || path.sep;
}

/** First "cwd" in the newest .jsonl transcript of a Claude projects/<dir> folder (first 64 KB only). */
async function firstCwd(dir: string): Promise<string | undefined> {
  let newest: string | undefined, newestT = -Infinity;
  for (const f of await fsp.readdir(dir)) {
    if (!f.endsWith('.jsonl')) continue;
    const st = await fsp.stat(path.join(dir, f)).catch(() => undefined);
    if (st?.isFile() && st.mtimeMs > newestT) { newest = f; newestT = st.mtimeMs; }
  }
  if (!newest) return;
  const fh = await fsp.open(path.join(dir, newest), 'r');
  try {
    const buf = Buffer.alloc(MAX_READ);
    const { bytesRead } = await fh.read(buf, 0, MAX_READ, 0);
    // a regex, not JSON.parse per line: the first line may be cut off at 64 KB
    const m = /(?<!\\)"cwd"\s*:\s*("(?:[^"\\]|\\.)*")/.exec(buf.toString('utf8', 0, bytesRead));
    const cwd = m ? JSON.parse(m[1]) : undefined;
    return typeof cwd === 'string' ? cwd : undefined;
  } finally {
    await fh.close();
  }
}

export class Worlds {
  private home: string;
  private configFile: string;
  private claudeDir: string;
  private temps: string[];
  private repos = new Set<string>();
  private overrides: Overrides = { worlds: [] };
  private stamp?: string; // worlds.json mtime and size ('' when absent), to reload on change

  constructor(opts: WorldsOptions = {}) {
    this.home = real(opts.home ?? os.homedir());
    this.configFile = opts.configFile ?? process.env.AGENTVILLE_WORLDS ?? path.join(this.home, '.agentville', 'worlds.json');
    this.claudeDir = real(opts.claudeDir ?? process.env.CLAUDE_CONFIG_DIR ?? path.join(this.home, '.claude'));
    this.temps = [...new Set([...TEMPS, ...TEMPS.map(real)])];
  }

  /** Learn a repo root (a town). Ignored for temp folders and the Claude folder. */
  addRepo(root: string): void {
    this.add(root);
  }

  /** The world a repo belongs to. repoWorld = the "world" field of that repo's agentville.json, if any. */
  worldOf(root: string, repoWorld?: string): string {
    const r = real(root);
    const o = this.load();
    // a repo listed by itself wins over a folder pattern (the Settings page lists repos by themselves)
    for (const [name, pats] of o.worlds) if (pats.some((p) => !p.deep && r === p.dir)) return name;
    for (const [name, pats] of o.worlds) if (pats.some((p) => p.deep && inside(r, p.dir))) return name;
    if (typeof repoWorld === 'string' && repoWorld.trim()) return repoWorld.trim();
    return this.byFolder(r, o.root);
  }

  /** Best-effort: learn repos used with Claude before, from the first "cwd" in the newest transcript of each
   *  <claudeDir>/projects/<dir>/. gitRoot(dir) returns the repo root holding dir, or undefined if dir isn't in a repo.
   *  Reads at most 64 KB per transcript and only that field; never throws; returns how many repos were added. */
  async seedFromClaudeHistory(gitRoot: (dir: string) => string | undefined): Promise<number> {
    let added = 0;
    try {
      const projects = path.join(this.claudeDir, 'projects');
      for (const d of await fsp.readdir(projects, { withFileTypes: true })) {
        if (!d.isDirectory()) continue;
        try {
          const cwd = await firstCwd(path.join(projects, d.name));
          if (!cwd || !path.isAbsolute(cwd) || !fs.existsSync(cwd)) continue;
          const root = gitRoot(cwd);
          if (root && this.add(root)) added++;
        } catch { /* skip this folder */ }
      }
    } catch { /* no history */ }
    return added;
  }

  /** Adds a repo root; false when ignored or already known. */
  private add(root: string): boolean {
    const r = real(root);
    if (within(r, this.claudeDir)) return false;
    // tests keep their fake home (and its repos) in the temp folder
    if (this.temps.some((t) => within(r, t)) && !within(r, this.home)) return false;
    if (this.repos.has(r)) return false;
    this.repos.add(r);
    return true;
  }

  /** The automatic world: the first folder below the repo's dev folder (or the repo's own name if directly in it).
   *  Without "root" in worlds.json, the dev folder is the deepest common ancestor of the parent folders of known
   *  repos in the same top-level folder (e.g. ~/Dev). A lone repo in a group is then its own world (~/Dev/Acme/api
   *  → "api"); setting "root": "~/Dev" in worlds.json fixes that (→ "Acme"). */
  private byFolder(r: string, root?: string): string {
    let dev: string;
    if (root && inside(r, root)) dev = root;
    else {
      const group = this.group(r);
      dev = [r, ...this.repos].filter((x) => this.group(x) === group).map((x) => path.dirname(x)).reduce(common);
    }
    return path.relative(dev, r).split(path.sep)[0] || path.basename(r) || r;
  }

  /** The top-level folder a repo is in: under home (~/Dev), else under the root of its drive (/srv, D:\work). */
  private group(p: string): string {
    if (within(p, this.home)) {
      const rel = path.relative(this.home, p);
      return rel ? path.join(this.home, rel.split(path.sep)[0]) : this.home;
    }
    const { root } = path.parse(p);
    return path.join(root, p.slice(root.length).split(path.sep).find(Boolean) ?? '');
  }

  /**
   * Puts repos in a world (the Settings page): worlds.json lists each by itself under that world and
   * no longer under any other; folder patterns and "root" stay as you wrote them. Renaming a world is
   * moving all its repos to the new name.
   */
  assign(roots: string[], world: string): boolean {
    const name = world.replace(/\s+/g, ' ').trim().slice(0, 40);
    if (!name || !roots.length) return false;
    let data: any = {};
    try { data = JSON.parse(fs.readFileSync(this.configFile, 'utf8')); } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') { console.error(`agentville: not changing ${this.configFile}: ${(e as Error).message}`); return false; }
    }
    if (!isObject(data)) return false;
    const worlds: Record<string, unknown[]> = isObject(data.worlds) ? (data.worlds as Record<string, unknown[]>) : {};
    const moving = new Set(roots.map((r) => real(r)));
    for (const [w, list] of Object.entries(worlds)) {
      if (!Array.isArray(list)) continue;
      worlds[w] = list.filter((s) => typeof s !== 'string' || s.endsWith('/**') || s.endsWith('\\**') || !moving.has(this.expand(s) ?? ''));
      if (!worlds[w].length) delete worlds[w];
    }
    const short = (r: string) => (within(r, this.home) && r !== this.home ? '~/' + path.relative(this.home, r) : r);
    worlds[name] = [...(worlds[name] ?? []), ...[...moving].map(short)];
    data.worlds = worlds;
    try {
      fs.mkdirSync(path.dirname(this.configFile), { recursive: true });
      const tmp = `${this.configFile}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
      fs.renameSync(tmp, this.configFile);
    } catch (err) { console.error(`Couldn't save ${this.configFile}: ${(err as Error).message}`); return false; }
    this.stamp = undefined; // read it again
    return true;
  }

  /** Absolute or ~/ path → real path; undefined for anything else. */
  private expand(p: string): string | undefined {
    if (p === '~') return this.home;
    if (p.startsWith('~/')) return real(path.join(this.home, p.slice(2)));
    return path.isAbsolute(p) ? real(p) : undefined;
  }

  /** worlds.json, reloaded when it changes; bad parts are reported once per change and ignored. */
  private load(): Overrides {
    let stamp = '';
    try { const st = fs.statSync(this.configFile); stamp = `${st.mtimeMs}:${st.size}`; } catch { /* missing */ }
    if (stamp === this.stamp) return this.overrides;
    this.stamp = stamp;
    this.overrides = { worlds: [] };
    if (!stamp) return this.overrides;
    let data: unknown;
    try {
      data = JSON.parse(fs.readFileSync(this.configFile, 'utf8'));
    } catch (e) {
      console.error(`agentville: ignoring ${this.configFile}: ${(e as Error).message}`);
      return this.overrides;
    }
    const bad: string[] = [];
    if (!isObject(data)) bad.push('it should be a JSON object');
    else {
      if (data.root !== undefined) {
        const root = typeof data.root === 'string' ? this.expand(data.root) : undefined;
        if (root) this.overrides.root = root;
        else bad.push('"root" should be an absolute or ~/ path');
      }
      if (data.worlds !== undefined && !isObject(data.worlds)) bad.push('"worlds" should be an object');
      else for (const [name, list] of Object.entries(data.worlds ?? {})) {
        if (!name.trim() || !Array.isArray(list)) { bad.push(`world "${name}" should be a name with a list of paths`); continue; }
        const pats: Pattern[] = [];
        for (const s of list) {
          const deep = typeof s === 'string' && (s === '/**' || s.endsWith('/**') || s.endsWith('\\**'));
          const dir = typeof s === 'string' ? this.expand(deep ? s.slice(0, -3) || '/' : s) : undefined;
          if (dir) pats.push({ dir, deep });
          else bad.push(`world "${name}": ${JSON.stringify(s)} should be an absolute or ~/ path`);
        }
        this.overrides.worlds.push([name, pats]);
      }
    }
    if (bad.length) console.error(`agentville: ignoring parts of ${this.configFile}: ${bad.join('; ')}`);
    return this.overrides;
  }
}
