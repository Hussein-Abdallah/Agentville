// Turns raw Claude Code tool calls into short, friendly bubble text (plan section 7).
// Priority: Claude's own words (todo progress, command/subagent descriptions) > rules.

const clip = (s: string, n = 42) => (s.length > n ? s.slice(0, n - 1).trimEnd() + '…' : s);

/** "LoginForm.tsx" -> "login form", "user_settings.py" -> "user settings" */
/** The last part of a path (Windows paths too). */
const baseName = (p: string) => p.split(/[\\/]/).pop() ?? p;

export function humanizeFile(path: string) {
  const base = baseName(path);
  const stem = base.replace(/\.(test|spec|stories|d)\.[^.]+$/, '').replace(/\.[^.]+$/, '');
  const words = stem
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[_\-.]+/g, ' ')
    .toLowerCase()
    .trim();
  return words || base;
}

function fileKind(path: string): string | null {
  const p = path.toLowerCase().replace(/\\/g, '/');
  const base = p.split('/').pop() ?? p;
  if (/(^|\/)(package\.json|package-lock\.json|pnpm-lock\.yaml|yarn\.lock|requirements\.txt|pyproject\.toml|cargo\.toml|go\.mod|gemfile)$/.test(p)) return 'dependencies';
  if (/(\.test\.|\.spec\.|_test\.|(^|\/)tests?\/|__tests__)/.test(p)) return `the ${humanizeFile(path)} tests`;
  if (/(^|\/)migrations?\//.test(p) || /\.sql$/.test(p)) return 'the database';
  if (/\.(md|mdx|rst|txt)$/.test(p)) return base === 'readme.md' ? 'the README' : `the ${humanizeFile(path)} docs`;
  if (/\.(css|scss|sass|less)$/.test(p)) return `the ${humanizeFile(path)} styles`;
  if (/(\.config\.|\.env|\.ya?ml$|\.toml$|tsconfig|eslint|prettier|dockerfile)/.test(p)) return 'project config';
  return null;
}

function bashText(cmd: string): string {
  const c = cmd.trim();
  const rules: [RegExp, string][] = [
    [/^(npm|pnpm|yarn|bun)\s+(run\s+)?test|^(pytest|jest|vitest|go test|cargo test|rspec)/, 'Running tests'],
    [/^(npm|pnpm|yarn|bun)\s+(i|install|add|ci)\b|^pip3? install|^poetry (add|install)|^cargo add/, 'Installing packages'],
    [/^(npm|pnpm|yarn|bun)\s+(run\s+)?build|^(make|cargo build|go build|tsc)\b/, 'Building'],
    [/^(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|format)|^(eslint|prettier|ruff|black)\b/, 'Tidying the code'],
    [/^(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start)|^(vite|next dev)\b/, 'Starting the app'],
    [/^git commit/, 'Saving a commit'],
    [/^git push/, 'Pushing changes'],
    [/^git (pull|fetch)/, 'Pulling changes'],
    [/^git (status|diff|log|show)/, 'Checking changes'],
    [/^git (checkout|switch|branch)/, 'Switching branches'],
    [/^(ls|find|tree)\b/, 'Looking around'],
    [/^(cat|head|tail|less)\b/, 'Reading files'],
    [/^(grep|rg|ag)\b/, 'Searching the code'],
    [/^(curl|wget|http)\b/, 'Calling a web service'],
    [/^(docker|docker-compose|kubectl)\b/, 'Managing containers'],
    [/^(mkdir|mv|cp|rm|touch)\b/, 'Organizing files'],
  ];
  for (const [re, t] of rules) if (re.test(c)) return t;
  return 'Running a command';
}

/** "the login form" for descriptive names, but "hello.js" when the name is a single short word */
function fileRef(path: string) {
  const h = humanizeFile(path);
  return h.includes(' ') ? `the ${h}` : baseName(path);
}

/** Plan step currently in progress, from TodoWrite or a plan tool (Claude desktop's update_plan). */
export function activeStep(input: Record<string, any> | undefined): string | undefined {
  if (!input) return;
  for (const v of Object.values(input)) {
    if (!Array.isArray(v)) continue;
    const cur = v.find((x: any) => x && typeof x === 'object' && /in[_ ]?progress|active|current/i.test(String(x.status ?? '')));
    const text = cur && (cur.activeForm ?? cur.step ?? cur.content ?? cur.title ?? cur.text ?? cur.description);
    if (text) return clip(String(text));
  }
}

export interface ToolCall {
  tool_name?: string;
  tool_input?: Record<string, any>;
}

/** Friendly text for one tool call. */
export function friendlyTask(t: ToolCall): string {
  const name = t.tool_name ?? '';
  const i = t.tool_input ?? {};
  const f = i.file_path ?? i.notebook_path;
  const file: string | undefined = typeof f === 'string' ? f : undefined;
  switch (name) {
    case 'Read':
      return file ? `Reading ${fileKind(file) ?? fileRef(file)}` : 'Reading';
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit': {
      if (!file) return 'Editing';
      const k = fileKind(file);
      if (k === 'dependencies') return 'Updating dependencies';
      if (k === 'the database') return 'Changing the database';
      if (k === 'project config') return 'Changing project config';
      return `Editing ${k ?? fileRef(file)}`;
    }
    case 'Write':
      return file ? `Writing ${fileKind(file) ?? fileRef(file)}` : 'Writing a file';
    case 'Grep':
      return i.pattern ? clip(`Searching for "${i.pattern}"`) : 'Searching the code';
    case 'Glob':
      return 'Looking for files';
    case 'Bash':
      return i.description ? clip(String(i.description)) : bashText(String(i.command ?? ''));
    case 'WebFetch':
      return host(i.url) ? `Reading ${host(i.url)}` : 'Reading a web page';
    case 'ToolSearch':
      return 'Loading tools';
    case 'Skill':
      return i.skill ? clip(`Using the ${i.skill} skill`) : 'Using a skill';
    case 'WebSearch':
      return i.query ? clip(`Searching the web for "${i.query}"`) : 'Searching the web';
    case 'Task':
    case 'Agent':
      return i.description ? clip(`Delegating: ${i.description}`) : 'Starting a helper';
    case 'TodoWrite': {
      const active = (i.todos ?? []).find((t: any) => t.status === 'in_progress');
      return active?.activeForm ? clip(active.activeForm) : 'Planning';
    }
    default:
      if (/__update_plan$/.test(name)) return activeStep(i) ?? 'Planning';
      if (/__wrap_up$/.test(name)) return 'Wrapping up';
      if (name.startsWith('mcp__')) return mcpText(name, i);
      return name ? `Using ${name}` : 'Working';
  }
}

const host = (url: unknown) => { try { return new URL(String(url)).host; } catch { return ''; } };

/** MCP tools: the tool's own summary if it gives one, else wording for well-known servers. */
function mcpText(name: string, i: Record<string, any>) {
  const own = i.action_summary ?? i.description;
  if (typeof own === 'string' && own.trim()) return clip(own.trim());
  const [, server = '', tool = ''] = name.split('__');
  if (/browser|chrome|devtools|playwright|puppeteer/i.test(server)) {
    if (/navigate|open|new_page|preview_start/.test(tool)) return host(i.url) ? `Opening ${host(i.url)}` : 'Opening a page';
    if (/screenshot|snapshot|zoom/.test(tool) || /screenshot|zoom/.test(String(i.action))) return 'Looking at the page';
    if (/read_page|get_page_text|find/.test(tool)) return 'Reading the page';
    if (/console|network/.test(tool)) return 'Checking the page for errors';
    if (/javascript|evaluate/.test(tool)) return 'Checking the page';
    if (i.action === 'scroll') return 'Scrolling the page';
    if (i.action === 'wait') return 'Waiting for the page';
    return 'Using the browser';
  }
  if (/terminal/i.test(server)) {
    if (/run/.test(tool)) return i.command ? clip(`Running ${i.command} in a terminal`) : 'Running a command in a terminal';
    if (/read/.test(tool)) return 'Reading the terminal';
    if (/stop/.test(tool)) return 'Stopping a terminal command';
    return 'Using the terminal';
  }
  return `Using ${server.replace(/[_-]+/g, ' ').trim() || 'a tool'}`;
}

/** Current to-do progress phrase (Claude's own words), if any. */
export function activeTodo(t: ToolCall): string | undefined {
  if (!isPlanTool(t.tool_name)) return;
  return activeStep(t.tool_input);
}

/** Tools that carry Claude's plan: TodoWrite (Claude Code) and update_plan (Claude desktop's Code tab). */
export const isPlanTool = (name?: string) => name === 'TodoWrite' || /__update_plan$/.test(name ?? '');

/** What a permission request is waiting on: a short task for the bubble, and the exact thing (the question, the command, the file) for the needs-you board. */
export function waitingFor(t: ToolCall): { task: string; ask?: string } {
  const name = t.tool_name ?? '';
  const i = t.tool_input ?? {};
  const f = i.file_path ?? i.notebook_path;
  const file = typeof f === 'string' ? f.split(/[\\/]/).slice(-2).join('/') : undefined;
  const long = (s: unknown) => (typeof s === 'string' && s.trim() ? clip(s.replace(/\s+/g, ' ').trim(), 200) : undefined);
  switch (name) {
    case 'AskUserQuestion': {
      const qs = Array.isArray(i.questions) ? i.questions.map((q: any) => q?.question).filter((q: unknown) => typeof q === 'string') : [];
      return { task: qs.length > 1 ? `Has ${qs.length} questions` : 'Has a question', ask: long(qs.join(' · ')) };
    }
    case 'ExitPlanMode':
      return { task: 'Wants you to approve a plan', ask: long(String(i.plan ?? '').split('\n').find((l) => l.trim())?.replace(/^#+\s*/, '')) };
    case 'Bash': {
      const cmd = long(String(i.command ?? '').split('\n')[0]);
      return { task: 'Wants to run a command', ask: i.description && cmd ? clip(`${i.description}: ${cmd}`, 200) : cmd ?? long(i.description) };
    }
    case 'Edit':
    case 'MultiEdit':
    case 'NotebookEdit':
      return { task: 'Wants to edit a file', ask: file };
    case 'Write':
      return { task: 'Wants to write a file', ask: file };
    case 'WebFetch':
      return { task: 'Wants to open a web page', ask: long(i.url) };
    case 'WebSearch':
      return { task: 'Wants to search the web', ask: long(i.query) };
    case 'Task':
    case 'Agent':
      return { task: 'Wants to start a helper', ask: long(i.description) };
    default: {
      if (!name) return { task: 'Needs permission' };
      const server = name.startsWith('mcp__') ? name.split('__')[1].replace(/[_-]+/g, ' ').trim() : '';
      const what = friendlyTask(t);
      return { task: `Wants to use ${server || name}`, ask: what.startsWith('Using ') ? undefined : what };
    }
  }
}

/** The end of Claude's last reply, for "Waiting for your reply": its last question(s), else its last paragraph. */
export function lastWords(text: unknown): string | undefined {
  if (typeof text !== 'string') return;
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[`*_>#|]/g, '')
    .split(/\n\s*\n/).map((p) => p.replace(/\s+/g, ' ').trim()).filter(Boolean);
  if (!plain.length) return;
  const tail = plain.slice(-3).join(' ');
  const asks = tail.match(/[^.!?]*\?/g)?.map((s) => s.trim()).filter((s) => s.length > 3);
  return clip(asks?.length ? asks.slice(-2).join(' ') : plain[plain.length - 1], 200);
}

/** A prompt or reply as plain text for the details panel: code blocks become "[code]", markdown marks go, whitespace collapses; at most `max` characters. */
export function plainText(text: string, max: number): string {
  const t = text
    .replace(/```[\s\S]*?```/g, ' [code] ')
    .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/^#+\s*/gm, '')
    .replace(/[*_`>|]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return clip(t, max);
}
