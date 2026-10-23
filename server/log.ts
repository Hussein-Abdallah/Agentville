// Event log for debugging and improving Agentville: one JSON line per hook event, with what the
// service decided. Files: logs/events-YYYY-MM-DD.jsonl in this repo (kept 7 days, git-ignored).
// Turn off with AGENTVILLE_LOG=0. Everything stays on this Mac.
import fs from 'node:fs';
import path from 'node:path';

const KEEP_DAYS = 7;
const MAX_STR = 300;

export class EventLog {
  readonly enabled = process.env.AGENTVILLE_LOG !== '0';
  constructor(readonly dir: string) {
    if (!this.enabled) return;
    fs.mkdirSync(dir, { recursive: true });
    const ignore = path.join(dir, '.gitignore');
    if (!fs.existsSync(ignore)) fs.writeFileSync(ignore, '*\n');
    this.cleanup();
  }

  write(entry: Record<string, unknown>) {
    if (!this.enabled) return;
    const now = new Date();
    const line = JSON.stringify({ t: now.toISOString(), ...entry }, (_k, v) => (typeof v === 'string' && v.length > MAX_STR ? v.slice(0, MAX_STR) + `…(+${v.length - MAX_STR})` : v));
    fs.appendFile(path.join(this.dir, `events-${localDate(now)}.jsonl`), line + '\n', () => {});
  }

  private cleanup() {
    const cutoff = Date.now() - KEEP_DAYS * 86400_000;
    for (const f of fs.readdirSync(this.dir)) {
      const m = f.match(/^events-(\d{4}-\d{2}-\d{2})\.jsonl$/);
      if (m && new Date(m[1]).getTime() < cutoff) fs.rmSync(path.join(this.dir, f), { force: true });
    }
  }
}

const localDate = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

/** Keeps the useful parts of a hook event; drops big blobs (file contents, tool output). */
export function summarizeEvent(e: Record<string, any>) {
  const i = e.tool_input ?? {};
  const input: Record<string, unknown> = {};
  for (const k of ['file_path', 'notebook_path', 'path', 'pattern', 'command', 'description', 'url', 'query', 'subagent_type']) if (i[k] !== undefined) input[k] = i[k];
  if (Array.isArray(i.todos)) input.todos = i.todos.map((t: any) => `[${t.status}] ${t.activeForm ?? t.content}`);
  // unknown tools: record the input shape so we can learn how to describe them
  if (!Object.keys(input).length && Object.keys(i).length) input.raw = JSON.stringify(i).slice(0, 600);
  return {
    event: e.hook_event_name,
    session: String(e.session_id ?? '').slice(0, 8),
    cwd: e.cwd,
    tool: e.tool_name,
    input: Object.keys(input).length ? input : undefined,
    tool_use_id: e.tool_use_id,
    prompt: e.prompt,
    message: e.message,
    notification_type: e.notification_type,
    source: e.source,
    reason: e.reason,
    agent_id: e.agent_id,
    agent_type: e.agent_type,
    session_title: e.session_title,
    trigger: e.trigger,
    app: [e.agentville_app, e.agentville_term, e.agentville_tty].filter(Boolean).join(' ') || undefined,
    extra_keys: Object.keys(e).filter((k) => !['hook_event_name', 'session_id', 'cwd', 'transcript_path', 'tool_name', 'tool_input', 'tool_response', 'tool_use_id', 'prompt', 'message', 'notification_type', 'source', 'reason', 'permission_mode', 'agent_id', 'agent_type', 'trigger', 'agentville_app', 'agentville_term', 'agentville_tty'].includes(k)),
  };
}
