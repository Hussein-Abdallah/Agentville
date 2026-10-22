// Installs / removes the Agentville hooks in ~/.claude/settings.json (user level, so every
// Claude Code session on this Mac is covered: terminal, VS Code, desktop app).
// Usage: tsx server/hooks.ts install | uninstall | status
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const PORT = Number(process.env.AGENTVILLE_PORT ?? 4917);
const MARK = 'agentville';
const DIR = process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude');
const FILE = path.join(DIR, 'settings.json');

// One curl per event: forward Claude Code's JSON to the local service. Short timeout, no output,
// always succeeds, so it can never block or slow Claude down. The "#agentville" tag marks our entries.
const COMMAND = `curl -s -m 1 -X POST -H 'Content-Type: application/json' --data-binary @- http://127.0.0.1:${PORT}/events >/dev/null 2>&1 || true #${MARK}`;

// PostToolUseFailure: a tool call that failed (e.g. a command exiting with an error) ends there, not in PostToolUse.
const TOOL_EVENTS = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure', 'PermissionRequest', 'PermissionDenied'];
// CwdChanged is only logged for now (worlds: a session moving to another repo).
const OTHER_EVENTS = ['SessionStart', 'SessionEnd', 'UserPromptSubmit', 'Notification', 'Stop', 'SubagentStart', 'SubagentStop', 'CwdChanged'];

type HookCmd = { type: 'command'; command: string; timeout?: number };
type Matcher = { matcher?: string; hooks: HookCmd[] };

const isOurs = (m: Matcher) => m.hooks?.some((h) => h.command?.includes(`#${MARK}`));

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
  const s = strip(read());
  s.hooks ??= {};
  for (const ev of [...TOOL_EVENTS, ...OTHER_EVENTS]) {
    const entry: Matcher = { hooks: [{ type: 'command', command: COMMAND, timeout: 2 }] };
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

function status() {
  const s = read();
  const evs = Object.entries<Matcher[]>(s.hooks ?? {}).filter(([, ms]) => ms.some(isOurs)).map(([e]) => e);
  console.log(evs.length ? `Installed for: ${evs.join(', ')}` : 'Not installed.');
}

const cmd = process.argv[2];
if (cmd === 'install') install();
else if (cmd === 'uninstall') uninstall();
else if (cmd === 'status') status();
else console.log('Usage: npm run hooks:install | hooks:uninstall | hooks:status');
