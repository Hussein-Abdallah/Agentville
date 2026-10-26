// Hook debugging: while it's on, every hook event is written in full (not just the summary the event log
// keeps) to logs/hooks-debug-YYYY-MM-DD.jsonl, and a line per event is printed. Raw events can hold file
// contents and command output, so it turns itself off after a while (60 minutes by default).
// Switched with `npm run hooks:debug on [minutes] | off`: a file in ~/.agentville holding when it ends,
// which the running service notices within a couple of seconds (no restart).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const DEBUG_FILE = () => process.env.AGENTVILLE_DEBUG_FILE ?? path.join(os.homedir(), '.agentville', 'debug-hooks');
const MAX_STR = 4000;

/** When debugging ends (ms since epoch), or undefined when it's off or over. */
export function debugUntil(file = DEBUG_FILE(), now = Date.now()): number | undefined {
  try {
    const until = Number(fs.readFileSync(file, 'utf8').trim());
    return Number.isFinite(until) && until > now ? until : undefined;
  } catch { return undefined; }
}

/** Turns debugging on for `minutes` (or off with 0). */
export function setDebug(minutes: number, file = DEBUG_FILE()) {
  if (minutes <= 0) { fs.rmSync(file, { force: true }); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  fs.writeFileSync(file, String(Date.now() + minutes * 60_000), { mode: 0o600 });
}

export class HookDebug {
  private checked = 0;
  private until?: number;

  constructor(private dir: string, private file = DEBUG_FILE()) {}

  /** On right now? (the file is read at most every 2 s) */
  get on(): boolean {
    const now = Date.now();
    if (now - this.checked > 2000) { this.checked = now; this.until = debugUntil(this.file, now); }
    return !!this.until && this.until > now;
  }

  get endsAt() { return this.on ? this.until : undefined; }

  /** Writes one raw event (long strings cut) and prints a line for it. */
  write(e: Record<string, any>, result: unknown) {
    const now = new Date();
    const line = JSON.stringify({ t: now.toISOString(), event: e, result }, (_k, v) => (typeof v === 'string' && v.length > MAX_STR ? v.slice(0, MAX_STR) + `…(+${v.length - MAX_STR})` : v));
    fs.mkdirSync(this.dir, { recursive: true });
    fs.appendFile(path.join(this.dir, `hooks-debug-${now.toISOString().slice(0, 10)}.jsonl`), line + '\n', () => {});
    const who = String(e.session_id ?? '').slice(0, 8);
    console.log(`[hook] ${e.hook_event_name ?? '?'}${e.tool_name ? ` ${e.tool_name}` : ''} ${who}${e.agent_id ? ` (helper ${String(e.agent_id).slice(0, 6)})` : ''}`);
  }
}
