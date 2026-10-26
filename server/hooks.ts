// Installs / removes the Agentville hooks in ~/.claude/settings.json (user level, so every
// Claude Code session on this computer is covered: terminal, VS Code, desktop app).
// macOS (and Linux): a curl line run by the shell. Windows: Claude Code runs `node hook.mjs` directly,
// with no shell (hooks there run in Git Bash or PowerShell, which disagree on almost everything).
// Usage: tsx server/hooks.ts install | uninstall | status | debug on [minutes] | debug off
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Auth, HEADER } from './auth';
import { debugUntil, setDebug } from './debug';

const PORT = Number(process.env.AGENTVILLE_PORT ?? 4917);
const MARK = 'agentville';
const DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const FILE = path.join(DIR, 'settings.json');

// One curl per event: forward Claude Code's JSON to the local service. Short timeout, no output,
// always succeeds, so it can never block or slow Claude down. The "#agentville" tag marks our entries.
// Two headers say which app the session runs in (for Go to session): the bundle id macOS gives
// the app that started Claude Code, and the terminal program.
const APP = `-H "X-Agentville-App: $__CFBundleIdentifier" -H "X-Agentville-Term: $TERM_PROGRAM"`;
// Agentville's token comes from a file only your user can read (see auth.ts), so it never sits in settings.json.
const TOKEN = `-H "@$HOME/.agentville/hook-header"`;
const command = (extra = '') =>
  `curl -s -m 1 -X POST -H 'Content-Type: application/json' ${TOKEN} ${APP}${extra} --data-binary @- http://127.0.0.1:${PORT}/events >/dev/null 2>&1 || true #${MARK}`;
const COMMAND = command();
// At the start of a session and of each request, also Claude Code's terminal (its parent's tty),
// so Terminal and iTerm can select the right tab. Only then, to keep the other hooks as light as possible.
const TTY_COMMAND = command(` -H "X-Agentville-Tty: $(ps -o tty= -p $PPID 2>/dev/null)"`);
const TTY_EVENTS = ['SessionStart', 'UserPromptSubmit'];

// PostToolUseFailure: a tool call that failed (e.g. a command exiting with an error) ends there, not in PostToolUse.
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'];
// CwdChanged is only logged for now (worlds: a session moving to another repo). PreCompact: the context meter.
const OTHER_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'CwdChanged', 'PreCompact'];

type HookCmd = { type: 'command'; command: string; args?: string[]; timeout?: number };
type Matcher = { matcher?: string; hooks: HookCmd[] };

// Windows: `node <app>/server/hook.mjs #agentville`, spawned directly (exec form: an `args` list, no shell)
const WINDOWS = process.platform === 'win32';
const HOOK_SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'hook.mjs');
const winHook = (): HookCmd => ({ type: 'command', command: 'node', args: [HOOK_SCRIPT, `#${MARK}`], timeout: 2 });

const isOurs = (m: Matcher) => m.hooks?.some((h) => h.command?.includes(`#${MARK}`) || h.args?.includes(`#${MARK}`));
/** The hook entry this version installs for an event. */
const expected = (ev: string): HookCmd => (WINDOWS ? winHook() : { type: 'command', command: TTY_EVENTS.includes(ev) ? TTY_COMMAND : COMMAND, timeout: 2 });
const same = (a: HookCmd, b: HookCmd) => a.command === b.command && JSON.stringify(a.args ?? null) === JSON.stringify(b.args ?? null);

function read(): any {
  if (!fs.existsSync(FILE)) return {};
  const raw = fs.readFileSync(FILE, 'utf8');
  try { return raw.trim() ? JSON.parse(raw) : {}; } catch {
    console.error(`Couldn't read ${FILE} (it isn't valid JSON). Nothing was changed.`);
    process.exit(1);
  }
}

function write(settings: any) {
  fs.mkdirSync(DIR, { recursive: true });
  if (fs.existsSync(FILE)) {
    const backup = `${FILE}.agentville-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`;
    fs.copyFileSync(FILE, backup);
    console.log(`Backup saved: ${backup}`);
  }
  const tmp = `${FILE}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(settings, null, 2) + '\n');
  fs.renameSync(tmp, FILE); // atomic replace
}

function strip(settings: any) {
  const hooks = settings.hooks ?? {};
  for (const ev of Object.keys(hooks)) {
    hooks[ev] = (hooks[ev] as Matcher[]).filter((m) => !isOurs(m));
    if (!hooks[ev].length) delete hooks[ev];
  }
  if (!Object.keys(hooks).length) delete settings.hooks;
  else settings.hooks = hooks;
  return settings;
}

function install() {
  new Auth(); // make sure the token exists before the hooks start sending it
  const s = strip(read());
  s.hooks ??= {};
  for (const ev of [...TOOL_EVENTS, ...OTHER_EVENTS]) {
    const entry: Matcher = { hooks: [expected(ev)] };
    if (TOOL_EVENTS.includes(ev)) entry.matcher = '*';
    (s.hooks[ev] ??= []).push(entry);
  }
  write(s);
  console.log(`Agentville hooks installed in ${FILE}`);
  console.log('New Claude Code sessions will now appear in Agentville. Already-running sessions show up on their next action.');
}

function uninstall() {
  const s = read();
  const before = JSON.stringify(s);
  strip(s);
  if (JSON.stringify(s) === before) return console.log('No Agentville hooks found. Nothing to remove.');
  write(s);
  console.log(`Agentville hooks removed from ${FILE}`);
}

/**
 * Everything between Claude Code and the town, checked in order: the hooks (all events, this version),
 * the token, the service (running, accepts the token), the events it got, and hook debugging.
 */
async function status() {
  const ok = (good: boolean, text: string, fix?: string) => console.log(`${good ? '✓' : '✗'} ${text}${!good && fix ? `\n    → ${fix}` : ''}`);
  const s = read();
  const all = [...TOOL_EVENTS, ...OTHER_EVENTS];
  const ours = Object.entries<Matcher[]>(s.hooks ?? {}).filter(([, ms]) => ms.some(isOurs));
  const missing = all.filter((ev) => !ours.some(([e]) => e === ev));
  const old = ours.filter(([ev, ms]) => ms.filter(isOurs).some((m) => m.hooks.some((h) => !same(h, expected(ev))))).map(([e]) => e);
  if (!ours.length) ok(false, `Hooks: not installed in ${FILE}`, 'npm run hooks:install');
  else {
    ok(!missing.length, missing.length ? `Hooks: missing for ${missing.join(', ')}` : `Hooks: installed for all ${all.length} events`, 'npm run hooks:install (adds the new ones)');
    ok(!old.length, old.length ? `Hooks: an older version for ${old.join(', ')}` : 'Hooks: this version', 'npm run hooks:install (updates them)');
  }
  const dir = path.join(os.homedir(), '.agentville');
  const tokenOk = fs.existsSync(path.join(dir, 'token')) && fs.existsSync(path.join(dir, 'hook-header'));
  ok(tokenOk, tokenOk ? 'Token: ~/.agentville/token and the hook header file are there' : 'Token: missing', 'npm run hooks:install (makes it)');
  const base = `http://127.0.0.1:${PORT}`;
  let up = false;
  try { up = (await fetch(`${base}/health`, { signal: AbortSignal.timeout(1500) })).ok; } catch { /* not running */ }
  ok(up, up ? `Service: running at http://localhost:${PORT}` : `Service: not answering on port ${PORT}`, 'npm start');
  if (!up || !tokenOk) return;
  const token = new Auth(dir).token;
  let st: any;
  try {
    const r = await fetch(`${base}/status`, { headers: { [HEADER]: token }, signal: AbortSignal.timeout(1500) });
    if (r.status === 401) return ok(false, 'Service: refuses this token (it was renewed since the service started?)', 'restart the service');
    st = await r.json();
  } catch { return ok(false, 'Service: its status page didn\'t answer', 'restart the service (an older version is running?)'); }
  const ago = (t: number) => { const s = Math.round((Date.now() - t) / 1000); return s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ago`; };
  ok(true, `Service: accepts the token; up since ${ago(st.startedAt)} (pid ${st.pid})`);
  ok(st.events > 0, st.lastEvent ? `Events: ${st.events} since it started; last ${st.lastEvent.name} ${ago(st.lastEvent.at)} (session ${st.lastEvent.session})`
    : 'Events: none since it started', 'send a message in any Claude Code session; still nothing? npm run hooks:debug on, then watch the service\'s output');
  console.log(`  Robots: ${st.sessions} session${st.sessions === 1 ? '' : 's'}, ${st.helpers} helper${st.helpers === 1 ? '' : 's'}; ${st.pages} open page${st.pages === 1 ? '' : 's'}`);
  const until = debugUntil();
  console.log(`  Hook debugging: ${until ? `on until ${new Date(until).toLocaleTimeString()} (logs/hooks-debug-*.jsonl)` : 'off (npm run hooks:debug on)'}`);
}

/** debug on [minutes] | off */
function debug(arg?: string, minutesArg?: string) {
  if (arg === 'off') { setDebug(0); return console.log('Hook debugging is off.'); }
  if (arg !== 'on') return console.log('Usage: npm run hooks:debug on [minutes] | off');
  const minutes = Math.min(24 * 60, Math.max(1, Number(minutesArg) || 60));
  setDebug(minutes);
  console.log(`Hook debugging is on for ${minutes} minutes: every event is written in full to app/logs/hooks-debug-<date>.jsonl`);
  console.log('and a line per event is printed by the service. These logs can hold file contents and command output;');
  console.log('they stay on this Mac (logs/ is git-ignored). Turn it off sooner with: npm run hooks:debug off');
}

const cmd = process.argv[2];
if (cmd === 'install') install();
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'status') status().catch((e) => { console.error(e); process.exit(1); });
else if (cmd === 'debug') debug(process.argv[3], process.argv[4]);
else console.log('Usage: npm run hooks:install | hooks:uninstall | hooks:status | hooks:debug on [minutes] | off');
