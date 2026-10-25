// Sessions remembered across restarts in ~/.agentville/sessions.json, so a robot whose session was
// already running comes back as itself (name, colour, title, town, building, last prompt and reply)
// on its next event, and a name you gave it sticks. Only this user can read the file.
// Kept 7 days after a session was last seen (30 days for one you renamed), at most 300 sessions.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface SavedSession {
  name: string;
  /** you renamed it */
  custom?: boolean;
  color: string;
  title?: string;
  /** its town (repo root) and building there */
  root: string;
  building?: string;
  startedAt: number;
  /** last event, ms */
  seen: number;
  lastPrompt?: string;
  lastReply?: string;
}

export interface SessionStoreOptions {
  /** default process.env.AGENTVILLE_SESSIONS ?? ~/.agentville/sessions.json */
  file?: string;
  /** how long to wait before writing changes (ms); 0 writes at once (tests) */
  delay?: number;
}

const KEEP_MS = 7 * 86400_000;
const KEEP_RENAMED_MS = 30 * 86400_000;
const MAX = 300;

export class SessionStore {
  private file: string;
  private data?: Record<string, SavedSession>;
  private delay: number;
  private timer?: NodeJS.Timeout;

  constructor(opts: SessionStoreOptions = {}) {
    this.file = opts.file ?? process.env.AGENTVILLE_SESSIONS ?? path.join(os.homedir(), '.agentville', 'sessions.json');
    this.delay = opts.delay ?? 2000;
  }

  get(id: string): SavedSession | undefined { return this.load()[id]; }

  /** Remembers a session (written shortly after, so busy work doesn't write the file on every event). */
  set(id: string, s: SavedSession) {
    this.load()[id] = s;
    if (!this.delay) return this.save();
    if (!this.timer) this.timer = setTimeout(() => { this.timer = undefined; this.save(); }, this.delay).unref();
  }

  /** Writes pending changes now (on shutdown). */
  flush() {
    if (!this.timer) return;
    clearTimeout(this.timer); this.timer = undefined;
    this.save();
  }

  private load(): Record<string, SavedSession> {
    if (this.data) return this.data;
    const ok: Record<string, SavedSession> = {};
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      const str = (v: unknown) => (typeof v === 'string' ? v : undefined);
      if (raw && typeof raw === 'object' && !Array.isArray(raw)) for (const [id, s] of Object.entries<any>(raw)) {
        if (typeof s?.name !== 'string' || typeof s.color !== 'string' || typeof s.root !== 'string' || typeof s.seen !== 'number') continue;
        ok[id] = {
          name: s.name.slice(0, 24), custom: s.custom === true || undefined, color: s.color, title: str(s.title), root: s.root, building: str(s.building),
          startedAt: typeof s.startedAt === 'number' ? s.startedAt : s.seen, seen: s.seen, lastPrompt: str(s.lastPrompt), lastReply: str(s.lastReply),
        };
      }
    } catch { /* missing or unreadable: start empty */ }
    this.data = prune(ok);
    return this.data;
  }

  private save() {
    try {
      this.data = prune(this.data ?? {});
      fs.mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 1) + '\n', { mode: 0o600 });
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error(`Couldn't save ${this.file}: ${(err as Error).message}`); }
  }
}

/** Drops sessions not seen for a while, and the oldest beyond MAX. */
function prune(all: Record<string, SavedSession>) {
  const now = Date.now();
  const kept = Object.entries(all).filter(([, s]) => now - s.seen < (s.custom ? KEEP_RENAMED_MS : KEEP_MS));
  kept.sort((a, b) => b[1].seen - a[1].seen);
  return Object.fromEntries(kept.slice(0, MAX));
}
