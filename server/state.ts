// Turns Claude Code hook events into robot states (AgentState) for the town.
import fs from 'node:fs';
import path from 'node:path';
import type { AgentState, TownInfo } from '../src/types';
import { friendlyTask, isPlanTool, lastWords, plainText, waitingFor } from './friendly';
import { SessionStore, type SavedSession } from './sessionstore';
import { applyTodos, currentTodo } from './todos';
import { contextUsage, contextWindow, readHead, safeTranscript, sessionLabels, taskFiles } from './transcript';
import { appName, hostFrom, type Host } from './focus';
import { RESULT_TEXT, activityOf } from './activity';
import type { ActivityKind, BackgroundTask } from '../src/types';
import { Worlds } from './worlds';
import { TownMaps } from './townmaps';
import { BuildingStore, type Area } from './buildings';

export interface HookEvent {
  hook_event_name: string;
  session_id: string;
  cwd?: string;
  transcript_path?: string;
  tool_name?: string;
  tool_input?: Record<string, any>;
  tool_use_id?: string;
  prompt?: string;
  message?: string;
  notification_type?: string;
  source?: string;
  [k: string]: unknown;
}

interface Building { id: string; name?: string; role?: string }

/** One town map's buildings by job: folder slots (most prominent first) and the special buildings. */
interface Layout { slots: string[]; root: string; misc: string; plaza?: string; commands?: string; ids: Map<string, string> }

/** One repo (a town): which folder holds which building. */
interface Project {
  /** the town map it uses (Frostpeak, Maplewood…) */
  townMap: string;
  /** folder ("server", "src/auth") -> its building and when robots last worked in it; remembered in ~/.agentville */
  areas: Map<string, Area>;
  config: Config;
  configStamp: string; // agentville.json mtime ('' when absent), to reload on change
}

/** agentville.json at the repo root: pin folders to buildings, rename buildings, name the world, pick the town map. */
interface Config { folders: Record<string, string>; names: Record<string, string>; world?: string; town?: string }

const NAMES = ['Atlas', 'Byte', 'Cleo', 'Dex', 'Echo', 'Fern', 'Gus', 'Iris', 'Juno', 'Kit', 'Lumen', 'Milo'];
const STALE_MS = 30 * 60 * 1000;
const STICKY_MS = 12_000;
const HELPER_STALE_MS = 10 * 60 * 1000;
const PENDING_MS = 60_000; // an Agent call's subagent normally starts within seconds
const ENDED_MS = 10 * 60 * 1000; // late events after SessionEnd are ignored this long
const MAX_SESSIONS = 100; // robots in town at once; more sessions are ignored until some end
const MAX_HELPERS = 30; // helper robots per session
const MAX_DEPTH = 2; // a building's folder is at most two levels deep ("src/auth")
/** folders that never hold a building's worth of work themselves (skipped when deciding depth) */
const SKIP_DIRS = new Set(['node_modules', 'dist', 'build', 'out', 'coverage', 'target', 'vendor', '__pycache__']);
const CONTEXT_MS = 2000; // read the transcript for the context meter at most this often (and always on Stop)
/** events that may bring a robot into town; others (Stop, PostToolUse…) only update one that exists */
const STARTS = new Set(['SessionStart', 'UserPromptSubmit', 'PreToolUse', 'PermissionRequest', 'SubagentStart']);

interface Session {
  state: AgentState;
  /** the town (repo root) it's working in now */
  root: string;
  project: string;
  lastSeen: number;
  lastMove: number;
  /** last building it worked at (not the plaza), to return to on a new prompt */
  lastWork?: string;
  todo?: string;
  /** task before it started waiting, so "Failed: …" names the real step */
  preWait?: string;
  /** the end of Claude's last reply (Stop), shown when it waits for yours */
  lastSaid?: string;
  /** you gave it its name */
  customName?: boolean;
  helpers: Map<string, string>; // subagent id (agent_id in hook events) -> helper robot id
  /** Agent/Task calls whose subagent hasn't shown up yet (oldest first) */
  pending: Pending[];
  helperSeq: number;
  /** subagents that already stopped: late events for them are dropped */
  endedAgents: Set<string>;
  /** the folder it started in (editors open it for Go to session) */
  home: string;
  /** its transcript (inside the Claude folder), for the context meter */
  transcript?: string;
  /** when the context was last read from the transcript */
  readAt: number;
  /** the app it runs in, as the hooks report it */
  host: Host;
  /** status and task before a compaction, to go back to afterwards */
  preCompact?: { status: AgentState['status']; task?: string };
  /** meaningful commands running now, by tool call id */
  running: Running;
}

/** Town services: meaningful commands running, by tool call id (bg: started in the background). */
type Running = Map<string, { kind?: ActivityKind; bg: boolean; text: string }>;

interface Pending { toolUseId?: string; type?: string; desc: string; t: number }

/** A subagent's robot: like a session robot, but its events carry the parent's session id plus an agent_id. */
interface Helper { state: AgentState; session: string; root: string; agentType?: string; lastSeen: number; lastMove: number; preWait?: string; running: Running }

export type Emit = (msg: { type: 'agent'; state: AgentState } | { type: 'remove'; id: string } | { type: 'log'; html: string }
  | { type: 'needs'; state: AgentState; project: string }) => void;

export class Sessions {
  private sessions = new Map<string, Session>();
  private endedSessions = new Map<string, number>(); // session id -> when it ended
  private helpers = new Map<string, Helper>(); // helper robot id -> helper
  private projects = new Map<string, Project>(); // project root -> layout
  private nameIdx = 0;
  private gitRoots = new Map<string, string>();
  private layouts = new Map<string, Layout>();
  /** each town map's landscape (town.json "land"), shown to the page for the planet */
  lands: Record<string, string> = {};

  /**
   * `maps`: every town map's buildings, by map id (in preference order). Each repo (town) uses one;
   * `townMaps` remembers which. Buildings in robot states are ids in their own town's map.
   */
  constructor(private maps: Record<string, Building[]>, private colors: string[], private emit: Emit,
    readonly worlds = new Worlds(), private townMaps = new TownMaps(Object.keys(maps)), private store = new BuildingStore(),
    private saved = new SessionStore()) {
    setInterval(() => this.sweep(), 60_000).unref();
  }

  /** A town map's buildings by job. */
  private layout(mapId: string): Layout {
    let l = this.layouts.get(mapId);
    if (l) return l;
    const buildings = this.maps[mapId] ?? Object.values(this.maps)[0];
    const slots = buildings.filter((b) => !b.role).map((b) => b.id);
    const role = (r: string) => buildings.find((b) => b.role === r)?.id;
    l = {
      slots, root: role('root') ?? slots[0], misc: role('misc') ?? slots[slots.length - 1], plaza: role('plaza'), commands: role('commands'),
      // agentville.json may name any building except the station and the plaza, by id or name
      ids: new Map(buildings.filter((b) => b.role !== 'station' && b.role !== 'plaza')
        .flatMap((b) => [[b.id.toLowerCase(), b.id], ...(b.name ? [[b.name.toLowerCase(), b.id]] : [])] as [string, string][])),
    };
    this.layouts.set(mapId, l);
    return l;
  }

  /** The layout of the map a town (repo root) uses. */
  private L(root: string) { return this.layout(this.project(root).townMap); }

  snapshot(): AgentState[] {
    return [...[...this.sessions.values()].map((s) => s.state), ...[...this.helpers.values()].map((h) => h.state)];
  }

  /** Applies one event; returns the resulting robot state (for the log). */
  handle(e: HookEvent): AgentState | { removed: string } | undefined {
    if (!e?.session_id || !e.hook_event_name) return;
    const ev = e.hook_event_name;
    if (ev === 'SessionEnd') { this.end(e.session_id); return { removed: e.session_id }; }
    let s = this.sessions.get(e.session_id);
    if (!s) {
      // late events after SessionEnd (e.g. from a background subagent) must not bring it back,
      // unless the session is resumed; and a stray Stop or PostToolUse doesn't start a robot
      const ended = this.endedSessions.get(e.session_id);
      const resumed = ev === 'SessionStart' || ev === 'UserPromptSubmit';
      // one we knew before a restart comes back on any event, as itself
      const saved = this.saved.get(e.session_id);
      const known = !ended && saved && Date.now() - saved.seen < STALE_MS;
      if ((ended && Date.now() - ended < ENDED_MS && !resumed) || (!STARTS.has(ev) && !known) || this.sessions.size >= MAX_SESSIONS) return;
      s = this.start(e, saved);
    }
    s.lastSeen = Date.now();
    this.noteHost(s, e);
    // a subagent's own events: they move its helper robot, not the parent
    if (typeof e.agent_id === 'string' && e.agent_id) return this.handleHelper(s, e, e.agent_id);
    const st = s.state;
    const was = st.status;
    const before = st.task;

    switch (ev) {
      case 'SessionStart':
        if (e.source === 'compact') this.compacted(s);
        break;
      case 'PreCompact':
        // the conversation is being summarised to free up context; back to what it was doing afterwards
        s.preCompact ??= { status: st.status, task: st.task };
        st.status = 'working';
        st.task = 'Compacting the conversation';
        if (st.context) st.context.compacting = true;
        break;
      case 'UserPromptSubmit':
        if (typeof e.session_title === 'string' && e.session_title) st.title = e.session_title.slice(0, 80);
        else if (typeof e.prompt === 'string' && e.prompt && !st.title) st.title = e.prompt.replace(/\s+/g, ' ').slice(0, 80);
        if (typeof e.prompt === 'string' && e.prompt.trim()) { st.lastPrompt = plainText(e.prompt, 600); delete st.lastReply; }
        s.todo = undefined; // new request: forget the previous plan's current step
        if (st.todos?.every((t) => t.status === 'completed')) st.todos = undefined; // and a finished list
        st.status = 'working';
        st.task = s.todo ?? 'Thinking…';
        // back to work: leave the plaza for the last building, or the commands building
        if (st.building === this.L(s.root).plaza) this.moveTo(s, s.lastWork ?? this.L(s.root).commands);
        break;
      case 'PreToolUse': {
        const todos = applyTodos(st.todos, e.tool_name, e.tool_input);
        if (todos) { st.todos = todos.length ? todos : undefined; s.todo = currentTodo(todos); }
        st.status = 'working';
        st.task = isPlanTool(e.tool_name) ? s.todo ?? 'Planning' : s.todo && !isQuick(e.tool_name) ? s.todo : friendlyTask(e);
        // a command description or action summary stays visible even with an active to-do
        if (ownWords(e)) st.task = friendlyTask(e);
        // Edits always move the robot. Quick look-ups (Read/Grep/Glob) and work that touches no file
        // (commands, browser, web → the commands building) only move it if it has stayed put for a
        // while, so a quick command between edits doesn't make it run back and forth.
        // work in another repo: the robot goes to that town (edits at once, other work once it has stayed put)
        const town = this.townOf(s.root, e);
        const settled = Date.now() - s.lastMove > STICKY_MS || st.building === this.L(s.root).plaza;
        if (town && (isEdit(e.tool_name) || settled)) this.changeTown(s, town);
        const L = this.L(s.root);
        // a folder without a building claims one on an edit, or once the robot has stayed put a while
        const file = this.buildingFor(s.root, e, isEdit(e.tool_name) || Date.now() - s.lastMove > STICKY_MS);
        const b = file ?? (touchesNoFile(e) ? L.commands : undefined);
        const sticky = isQuick(e.tool_name) || (!file && st.building !== L.plaza);
        if (b && b !== st.building && (!sticky || Date.now() - s.lastMove > STICKY_MS)) this.moveTo(s, b);
        // its helper robot appears when the subagent starts (SubagentStart or its first event)
        if (e.tool_name === 'Task' || e.tool_name === 'Agent') this.expectHelper(s, e);
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure': // failed calls (e.g. a command exiting with an error) end here instead
        // (not the end of a helper: background subagents keep working after the Agent call returns)
        if (st.status === 'waiting') { st.status = 'working'; }
        if (ev === 'PostToolUseFailure') this.dropPending(s, e);
        // Claude Code's task tools keep the list in files: read it once the call is done
        if (/^Task(Create|Update)$/.test(e.tool_name ?? '')) {
          const tasks = taskFiles(s.state.id);
          if (tasks) { st.todos = tasks.length ? tasks : undefined; s.todo = currentTodo(tasks); }
        }
        break;
      case 'PermissionDenied':
        this.dropPending(s, e);
        st.status = 'working';
        st.task = s.todo ?? 'Trying another way';
        break;
      case 'PermissionRequest':
        st.status = 'waiting';
        Object.assign(st, waitingFor(e));
        break;
      case 'Notification': {
        const t = e.notification_type ?? '';
        const text = typeof e.message === 'string' ? e.message : '';
        const msg = text.toLowerCase();
        if (t === 'permission_prompt' || msg.includes('permission')) {
          // the PermissionRequest just before already said exactly what it wants
          if (st.status !== 'waiting' || !st.ask) {
            st.status = 'waiting';
            const tool = /permission to use (\S+)/i.exec(text)?.[1];
            Object.assign(st, waitingFor({ tool_name: tool }));
          }
        } else if (t === 'idle_prompt' || msg.includes('waiting for your input')) {
          st.status = 'waiting'; st.task = 'Waiting for your reply'; st.ask = s.lastSaid;
        }
        break;
      }
      case 'Stop':
        // finished: gather at the plaza (watching the tree) until the next prompt
        st.status = 'idle';
        st.task = undefined;
        s.lastSaid = lastWords(e.last_assistant_message);
        if (typeof e.last_assistant_message === 'string') st.lastReply = plainText(e.last_assistant_message, 1200);
        delete st.activity; s.running.clear(); // background commands (st.background) keep running
        // Claude Code lists what's still running when a turn ends: that's the true background list
        if (Array.isArray(e.background_tasks)) { const bg = backgroundOf(e.background_tasks); if (bg.length) st.background = bg; else delete st.background; }
        st.building = this.L(s.root).plaza ?? st.building;
        break;
      case 'SubagentStop': // without an agent_id: the oldest helper finished
        this.endHelper(s, s.helpers.keys().next().value);
        break;
      default:
        return;
    }
    this.readContext(s, ev);
    const note = this.service(st, s.running, e);
    const out = this.settle(st, s, s.project, e, was, before, note);
    this.keep(s);
    return out;
  }

  /** Saves what a robot needs to come back as itself after a restart. */
  private keep(s: Session) {
    const st = s.state;
    this.saved.set(st.id, {
      name: st.name, custom: s.customName || undefined, color: st.color, title: st.title, root: s.root, building: st.building,
      startedAt: st.startedAt ?? Date.now(), seen: s.lastSeen, lastPrompt: st.lastPrompt, lastReply: st.lastReply,
    });
  }

  /** Writes remembered sessions now (the service is stopping). */
  flush() { this.saved.flush(); }

  /** Gives a session's robot your own name (kept across restarts). Its helpers follow ("Nova·2"). */
  rename(id: string, name: unknown): boolean {
    const s = this.sessions.get(id);
    if (!s || typeof name !== 'string') return false;
    // names show in many places (some as HTML): plain letters, digits, spaces and simple punctuation only
    const n = name.replace(/[<>&"'`\\]/g, '').replace(/\s+/g, ' ').trim().slice(0, 24);
    if (!n || n === s.state.name) return false;
    const old = s.state.name;
    s.state.name = n;
    s.customName = true;
    this.keep(s);
    this.emit({ type: 'agent', state: { ...s.state } });
    for (const hid of s.helpers.values()) {
      const h = this.helpers.get(hid);
      if (!h) continue;
      h.state.name = h.state.name.replace(/^.*·/, `${n}·`);
      this.emit({ type: 'agent', state: { ...h.state } });
    }
    this.emit({ type: 'log', html: `<b>${esc(old)}</b> is now <b>${esc(n)}</b>` });
    return true;
  }

  /**
   * Town services: a badge while a meaningful command runs (tests, a build, git…), a pass/fail flag
   * when it ends, a lamp while ones started in the background run. Returns a line for the history.
   */
  private service(st: AgentState, running: Running, e: HookEvent): string | undefined {
    const ev = e.hook_event_name, id = String(e.tool_use_id ?? '');
    if (ev === 'PreToolUse') {
      // stopping a background command or monitor (Claude Code's KillShell / TaskStop): that one, else the oldest
      if (/^(KillShell|KillBash|TaskStop)$/.test(e.tool_name ?? '') && st.background?.length) {
        const which = e.tool_input?.shell_id ?? e.tool_input?.task_id ?? e.tool_input?.bash_id;
        const i = st.background.findIndex((b) => b.id && b.id === which);
        st.background = st.background.filter((_, j) => j !== (i >= 0 ? i : 0));
        if (!st.background.length) delete st.background;
      }
      if (e.tool_name !== 'Bash') return;
      const cmd = e.tool_input?.command;
      const kind = activityOf(cmd), bg = e.tool_input?.run_in_background === true;
      if (!kind && !bg) return;
      running.set(id, { kind, bg, text: clipText(e.tool_input?.description || String(cmd ?? ''), 80) });
      if (kind) { st.activity = kind; delete st.result; }
      return;
    }
    if (ev !== 'PostToolUse' && ev !== 'PostToolUseFailure') return;
    // a monitor watching something in the background
    if (e.tool_name === 'Monitor' && ev === 'PostToolUse') {
      st.background = [...(st.background ?? []), { type: 'monitor', id: idIn(e.tool_response), text: clipText(e.tool_input?.description || String(e.tool_input?.command ?? 'Watching'), 80) }];
      return 'Watching in the background';
    }
    const r = running.get(id);
    if (!r) return;
    running.delete(id);
    const still = [...running.values()].filter((x) => x.kind).at(-1);
    if (still) st.activity = still.kind; else delete st.activity;
    if (ev === 'PostToolUse' && r.bg) {
      st.background = [...(st.background ?? []), { type: 'shell', id: idIn(e.tool_response), kind: r.kind, text: r.text }];
      return 'Left running in the background';
    }
    if (!r.kind) return;
    if (ev === 'PostToolUseFailure' && e.is_interrupt === true) return 'Stopped';
    const ok = ev === 'PostToolUse';
    st.result = { kind: r.kind, ok, at: Date.now() };
    return RESULT_TEXT[r.kind][ok ? 0 : 1];
  }

  /** The app the session runs in (sent by the hook as headers) and its transcript. */
  private noteHost(s: Session, e: HookEvent) {
    const h = hostFrom(e.agentville_app, e.agentville_term, e.agentville_tty);
    if (h.bundle || h.term) s.host = { ...h, tty: h.tty ?? s.host.tty };
    else if (h.tty) s.host.tty = h.tty;
    s.state.app = appName(s.host);
    if (!e.agent_id) s.transcript = safeTranscript(e.transcript_path) ?? s.transcript;
  }

  /** Updates the context meter from the transcript's latest reply (throttled; always after a reply ends). */
  private readContext(s: Session, ev: string) {
    if (!s.transcript || !['PostToolUse', 'PostToolUseFailure', 'Stop', 'SessionStart', 'UserPromptSubmit'].includes(ev)) return;
    const now = Date.now();
    if (ev !== 'Stop' && ev !== 'SessionStart' && now - s.readAt < CONTEXT_MS) return;
    s.readAt = now;
    const u = contextUsage(s.transcript);
    if (!u) return;
    const c = s.state.context;
    // right after a compaction there's no new reply yet: keep the window size we knew
    const max = u.used ? contextWindow(u.model, u.used) : c?.max ?? contextWindow(undefined, 0);
    s.state.context = { ...c, used: u.used, max };
    if (u.used) delete s.state.context.compacting;
  }

  /** The conversation was compacted (SessionStart with source "compact"): the meter starts over. */
  private compacted(s: Session) {
    const st = s.state;
    const c = st.context;
    st.context = { used: 0, max: c?.max ?? contextWindow(undefined, 0), compactedAt: Date.now(), compactions: (c?.compactions ?? 0) + 1 };
    if (s.preCompact) { st.status = s.preCompact.status; st.task = s.preCompact.task; s.preCompact = undefined; }
  }

  /** Where to send Go to session for a robot (a helper goes to its parent's session). */
  hostOf(id: string): { host: Host; folder: string; name: string } | undefined {
    const s = this.sessions.get(this.helpers.get(id)?.session ?? id);
    return s && { host: { ...s.host }, folder: s.home, name: s.state.name };
  }

  /** The other town (repo root) a tool call works in, if it isn't `current` and is inside a repo (nested repos count). */
  private townOf(current: string, e: HookEvent): string | undefined {
    const p = toolPath(e);
    if (!p) return;
    const abs = path.isAbsolute(p) ? p : path.resolve(e.cwd ?? current, p);
    if (abs === current) return;
    // inside this repo's folder it's still another town if it's in a repo nested in it
    const dir = e.tool_name === 'Bash' || !path.extname(abs) ? abs : path.dirname(abs);
    const root = this.repoRoot(dir);
    return root && root !== current ? root : undefined;
  }

  /** A session robot moves to another town. */
  private changeTown(s: Session, root: string) {
    const from = s.project;
    this.visit(root);
    s.root = root;
    s.project = this.townName(root);
    s.lastWork = undefined;
    s.lastMove = Date.now();
    const L = this.L(root);
    Object.assign(s.state, { town: root, project: s.project, building: L.commands ?? L.root });
    this.emit({ type: 'log', html: `<b>${s.state.name}</b> went from ${esc(from)} to ${esc(s.project)}` });
  }

  /** After an event: needs-you alert, history entry for the details panel, broadcast. */
  private settle(st: AgentState, t: { preWait?: string }, project: string, e: HookEvent, was: string, before?: string, service?: string) {
    const ev = e.hook_event_name;
    if (st.status !== 'waiting') delete st.ask;
    if (st.status === 'waiting' && was !== 'waiting') {
      t.preWait = before;
      this.emit({ type: 'log', html: `<b>${st.name}</b> needs you${project ? ` in ${esc(project)}` : ''}` });
      this.emit({ type: 'needs', state: { ...st }, project });
    }
    st.lastActive = Date.now();
    // history: new requests, changed tasks, needs-you, failed / not allowed, finished
    const step = (was === 'waiting' ? t.preWait : before) ?? e.tool_name ?? 'a step';
    const note = st.status === 'waiting' && was !== 'waiting' ? `Needs you: ${st.task ?? 'waiting'}`
      : service ? service
      : ev === 'Stop' ? 'Finished' : ev === 'UserPromptSubmit' ? 'New request'
      : ev === 'PostToolUseFailure' ? `Failed: ${step}`
      : ev === 'PermissionDenied' ? `Not allowed: ${e.tool_name ?? 'a step'}`
      : st.task !== before && st.task && st.status !== 'waiting' ? st.task : undefined;
    if (note && st.recent?.[0]?.text !== note) st.recent = [{ t: st.lastActive, text: note }, ...(st.recent ?? [])].slice(0, 8);
    this.emit({ type: 'agent', state: { ...st } });
    return { ...st };
  }

  /** Events from a subagent: its helper robot works, waits and moves on its own. */
  private handleHelper(s: Session, e: HookEvent, agentId: string): AgentState | { removed: string } | undefined {
    const ev = e.hook_event_name;
    if (s.endedAgents.has(agentId)) return; // late event from a subagent that already stopped
    if (ev === 'SubagentStop') {
      const id = s.helpers.get(agentId);
      this.endHelper(s, agentId);
      s.endedAgents.add(agentId);
      return id ? { removed: id } : undefined;
    }
    let h = this.helpers.get(s.helpers.get(agentId) ?? '');
    if (!h) {
      if (!['SubagentStart', 'PreToolUse', 'PermissionRequest'].includes(ev) || s.helpers.size >= MAX_HELPERS) return;
      h = this.spawnHelper(s, agentId, typeof e.agent_type === 'string' ? e.agent_type : undefined);
    }
    h.lastSeen = Date.now();
    const st = h.state, was = st.status, before = st.task;
    switch (ev) {
      case 'SubagentStart':
        break;
      case 'PreToolUse': {
        if (BOOKKEEPING.test(e.tool_name ?? '')) break;
        st.status = 'working';
        st.task = friendlyTask(e);
        const town = this.townOf(h.root, e);
        if (town && (isEdit(e.tool_name) || Date.now() - h.lastMove > STICKY_MS)) {
          this.visit(town);
          h.root = town;
          const L = this.L(town);
          Object.assign(st, { town, project: this.townName(town), building: L.commands ?? L.root });
          h.lastMove = Date.now();
        }
        const file = this.buildingFor(h.root, e, isEdit(e.tool_name) || Date.now() - h.lastMove > STICKY_MS);
        const b = file ?? (touchesNoFile(e) ? this.L(h.root).commands : undefined);
        const sticky = isQuick(e.tool_name) || !file;
        if (b && b !== st.building && (!sticky || Date.now() - h.lastMove > STICKY_MS)) { st.building = b; h.lastMove = Date.now(); }
        break;
      }
      case 'PostToolUse':
      case 'PostToolUseFailure':
        if (st.status === 'waiting') st.status = 'working';
        break;
      case 'PermissionRequest':
        st.status = 'waiting';
        Object.assign(st, waitingFor(e));
        break;
      case 'PermissionDenied':
        st.status = 'working';
        break;
      default:
        return;
    }
    return this.settle(st, h, st.project ?? s.project, e, was, before, this.service(st, h.running, e));
  }

  private moveTo(s: Session, b?: string) {
    if (!b || b === s.state.building) return;
    s.state.building = b;
    s.lastMove = Date.now();
    if (b !== this.L(s.root).plaza) s.lastWork = b;
  }

  private start(e: HookEvent, saved?: SavedSession): Session {
    // the folder the session started in: the transcript knows it even if the first event we see
    // (e.g. after the service restarts) comes from a different current folder
    const dir = startFolder(e) ?? e.cwd ?? process.cwd();
    const root = this.repoRoot(dir) ?? dir; // a folder outside any repo is a town of its own
    this.visit(root);
    const used = new Set([...this.sessions.values()].map((s) => s.state.color));
    // a session we knew before (the service restarted, or it was resumed) comes back as itself
    const color = saved && this.colors.includes(saved.color) ? saved.color : this.colors.find((c) => !used.has(c)) ?? this.colors[this.sessions.size % this.colors.length];
    const name = saved?.name ?? NAMES[this.nameIdx++ % NAMES.length];
    const project = this.townName(root);
    const L = this.L(root);
    const building = saved?.root === root && saved.building && this.maps[this.project(root).townMap]?.some((b) => b.id === saved.building) ? saved.building : L.plaza ?? L.root;
    // showing up mid-session with nothing saved (or no title yet): its transcript has the title and your last prompt
    const told = e.hook_event_name !== 'UserPromptSubmit' && !saved?.title ? sessionLabels(safeTranscript(e.transcript_path)) : {};
    const s: Session = {
      state: {
        id: e.session_id, name, color, building, status: 'idle', project, town: root, startedAt: saved?.startedAt ?? Date.now(),
        title: (saved?.title ?? told.title)?.replace(/\s+/g, ' ').slice(0, 80),
        lastPrompt: saved?.lastPrompt ?? (told.lastPrompt ? plainText(told.lastPrompt, 600) : undefined), lastReply: saved?.lastReply,
      },
      root, project, lastSeen: Date.now(), lastMove: 0, helpers: new Map(), pending: [], helperSeq: 1, endedAgents: new Set(),
      home: dir, readAt: 0, host: {}, running: new Map(), customName: saved?.custom,
    };
    if (building !== L.plaza) s.lastWork = building;
    this.sessions.set(e.session_id, s);
    this.emit({ type: 'log', html: saved ? `<b>${esc(name)}</b> is back in ${esc(project)}` : `<b>${esc(name)}</b> started in ${esc(project)}` });
    return s;
  }

  private end(id: string) {
    const s = this.sessions.get(id);
    if (!s) return;
    for (const h of s.helpers.values()) this.removeHelper(h);
    this.sessions.delete(id);
    this.endedSessions.set(id, Date.now());
    this.emit({ type: 'remove', id });
    this.emit({ type: 'log', html: `<b>${s.state.name}</b> finished` });
  }

  /** A helper robot for a subagent, named after its Agent/Task description. Starts where the parent is. */
  /** An Agent/Task call: remember its description for the subagent, or name a helper that started first. */
  private expectHelper(s: Session, e: HookEvent) {
    const type = typeof e.tool_input?.subagent_type === 'string' ? e.tool_input.subagent_type : undefined;
    const desc = typeof e.tool_input?.description === 'string' && e.tool_input.description.trim() ? e.tool_input.description.trim() : 'Helping out';
    // hooks are separate requests, so SubagentStart can arrive before this call
    const early = [...this.helpers.values()].find((h) => h.session === s.state.id && !h.state.title && (!type || !h.agentType || h.agentType === type));
    if (early) { early.state.title = desc.slice(0, 80); early.state.task = desc.slice(0, 42); this.emit({ type: 'agent', state: { ...early.state } }); return; }
    s.pending.push({ toolUseId: e.tool_use_id, type, desc, t: Date.now() });
  }

  /** The Agent/Task call failed or wasn't allowed: no subagent will come for it. */
  private dropPending(s: Session, e: HookEvent) {
    if (e.tool_name === 'Task' || e.tool_name === 'Agent') s.pending = s.pending.filter((p) => p.toolUseId !== e.tool_use_id);
  }

  /** The description for a new subagent: oldest recent call of the same type, else the oldest recent call. */
  private takePending(s: Session, type?: string) {
    s.pending = s.pending.filter((p) => Date.now() - p.t < PENDING_MS);
    let i = type ? s.pending.findIndex((p) => p.type === type) : -1;
    if (i < 0) i = s.pending.length ? 0 : -1;
    return i >= 0 ? s.pending.splice(i, 1)[0] : undefined;
  }

  private spawnHelper(s: Session, agentId: string, agentType?: string): Helper {
    const id = `${s.state.id}:${agentId}`;
    const desc = this.takePending(s, agentType)?.desc;
    const state: AgentState = {
      id, name: `${s.state.name}·${++s.helperSeq}`, color: s.state.color, building: s.state.building, status: 'working',
      task: (desc ?? 'Helping out').slice(0, 42), title: desc?.slice(0, 80), parentId: s.state.id, project: s.project, town: s.root, startedAt: Date.now(),
    };
    const h: Helper = { state, session: s.state.id, root: s.root, agentType, lastSeen: Date.now(), lastMove: 0, running: new Map() };
    s.helpers.set(agentId, id);
    this.helpers.set(id, h);
    this.emit({ type: 'log', html: `<b>${s.state.name}</b> started helper <b>${state.name}</b>` });
    return h;
  }

  private endHelper(s: Session, agentId?: string) {
    const id = agentId && s.helpers.get(agentId);
    if (!id) return;
    s.helpers.delete(agentId);
    this.removeHelper(id);
  }

  private removeHelper(id: string) {
    if (this.helpers.delete(id)) this.emit({ type: 'remove', id });
  }

  private sweep() {
    const now = Date.now();
    for (const [id, s] of this.sessions) if (now - s.lastSeen > STALE_MS) this.end(id);
    // a helper whose SubagentStop never came (e.g. the service restarted): gone after 10 quiet minutes
    for (const [id, t] of this.endedSessions) if (now - t > ENDED_MS) this.endedSessions.delete(id);
    for (const [id, h] of this.helpers) if (now - h.lastSeen > HELPER_STALE_MS && h.state.status !== 'waiting') {
      const s = this.sessions.get(h.session);
      for (const [aid, hid] of s?.helpers ?? []) if (hid === id) s!.helpers.delete(aid);
      this.removeHelper(id);
    }
  }

  /**
   * Which building a tool call belongs to: root files go to the root building; otherwise the
   * building of the folder it works in (see areaOf). A folder without a building only gets one
   * when `claim` is set (an edit, or the robot has stayed put a while); else undefined.
   */
  private buildingFor(root: string, e: HookEvent, claim: boolean): string | undefined {
    const i = e.tool_input ?? {};
    const p = toolPath(e);
    if (!p) return;
    const abs = path.isAbsolute(p) ? p : path.resolve(e.cwd ?? root, p);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return; // outside the project: stay put
    const parts = rel.split(path.sep).filter(Boolean);
    const isDir = !path.extname(abs) && (i.path !== undefined || e.tool_name === 'Bash');
    // a repo nested inside this one is a town of its own, never one of this town's folders
    // (the robot goes there once it edits or stays a while; until then it stays put)
    const owner = this.repoRoot(isDir ? abs : path.dirname(abs));
    if (owner && owner !== root) return;
    // commands run from the project root don't move the robot; root files go to the root building
    if (parts.length === 0 && e.tool_name === 'Bash') return;
    const folder = isDir ? parts : parts.slice(0, -1);
    if (!folder.length) return this.L(root).root;
    return this.claim(root, this.areaOf(root, folder), claim);
  }

  /**
   * The folder a building stands for: the top-level folder, or one level deeper when the top-level
   * folder is just a container of folders (like src/ holding auth/, ui/, db/), so the work spreads
   * over buildings. A folder pinned in agentville.json (at any depth) is always its own.
   */
  private areaOf(root: string, folder: string[]): string {
    const p = this.project(root);
    for (let n = folder.length; n > 0; n--) { const a = folder.slice(0, n).join('/'); if (a in p.config.folders) return a; }
    let n = 1;
    while (n < MAX_DEPTH && folder.length > n && this.isContainer(path.join(root, ...folder.slice(0, n)))) n++;
    return folder.slice(0, n).join('/');
  }

  /** A folder that mostly holds other folders: at least 2 of them, and no more files than folders. */
  private isContainer(dir: string): boolean {
    let v = this.containers.get(dir);
    if (v !== undefined) return v;
    try {
      const list = fs.readdirSync(dir, { withFileTypes: true }).filter((d) => !d.name.startsWith('.'));
      const dirs = list.filter((d) => d.isDirectory() && !SKIP_DIRS.has(d.name)).length;
      v = dirs >= 2 && list.filter((d) => d.isFile()).length <= dirs;
    } catch { v = false; }
    this.containers.set(dir, v);
    return v;
  }
  private containers = new Map<string, boolean>();
  /** pinned folders robots have worked in (repo root + NUL + folder), so their labels show */
  private used = new Set<string>();

  /**
   * A folder's building: pinned in agentville.json, or the one it holds (noting the robot worked
   * there). With `claim`, a folder without one takes the most prominent free building; when every
   * building is taken, the one whose folder has been quiet longest (and has no robot at it) is
   * handed over; if every building has robots at it, the shared (misc) building.
   */
  private claim(root: string, area: string, claim: boolean): string | undefined {
    const p = this.project(root);
    const pinned = p.config.folders[area];
    if (pinned) { this.used.add(`${root}\0${area}`); return pinned; }
    const now = Date.now();
    const held = p.areas.get(area);
    if (held) { held.used = now; this.remember(root, p); return held.building; }
    if (!claim) return;
    const L = this.layout(p.townMap);
    const reserved = new Set(Object.values(p.config.folders));
    const auto = L.slots.filter((b) => !reserved.has(b));
    const taken = new Set([...p.areas.values()].map((x) => x.building));
    let building = auto.find((b) => !taken.has(b));
    if (!building) {
      const quiet = [...p.areas].filter(([, x]) => auto.includes(x.building) && !this.occupied(root, x.building)).sort((a, b) => a[1].used - b[1].used)[0];
      if (!quiet) return L.misc;
      p.areas.delete(quiet[0]);
      building = quiet[1].building;
    }
    p.areas.set(area, { building, used: now });
    this.remember(root, p);
    return building;
  }

  /** A robot (session or helper) is at this building in this town. */
  private occupied(root: string, building: string) {
    return [...this.sessions.values()].some((s) => s.root === root && s.state.building === building)
      || [...this.helpers.values()].some((h) => h.root === root && h.state.building === building);
  }

  private remember(root: string, p: Project) { this.store.set(root, p.townMap, p.areas); }

  /** The layout for a repo; reloads agentville.json (and starts the layout over) when it changes. */
  private project(root: string): Project {
    const file = path.join(root, 'agentville.json');
    let stamp = '';
    try { stamp = String(fs.statSync(file).mtimeMs); } catch { /* no override file */ }
    let p = this.projects.get(root);
    if (!p || p.configStamp !== stamp) {
      const raw = readJson(file, stamp);
      // the town map: picked in agentville.json, else remembered/assigned (a map no other town in its world has yet)
      const pinned = typeof raw?.town === 'string' && raw.town in this.maps ? raw.town : undefined;
      if (typeof raw?.town === 'string' && !pinned) console.error(`${file}: unknown town map "${raw.town}" (maps: ${Object.keys(this.maps).join(', ')}).`);
      const world = this.worlds.worldOf(root, typeof raw?.world === 'string' ? raw.world : undefined);
      const townMap = pinned ?? this.townMaps.mapFor(root, (other) => this.worldOfRoot(other) === world);
      const config = this.readConfig(file, raw, this.layout(townMap));
      // the remembered layout (on this map), minus buildings that agentville.json now pins to other folders
      const pinnedTo = new Set(Object.values(config.folders));
      const areas = p && p.townMap === townMap ? p.areas : this.store.get(root, townMap);
      const valid = new Set(this.layout(townMap).slots);
      for (const [a, x] of areas) if (pinnedTo.has(x.building) || a in config.folders || !valid.has(x.building)) areas.delete(a);
      p = { townMap, areas, config, configStamp: stamp };
      this.projects.set(root, p);
    }
    return p;
  }

  /** A known town's world (with its agentville.json "world"); for other repos, the automatic one. */
  private worldOfRoot(root: string) {
    return this.worlds.worldOf(root, this.projects.get(root)?.config.world);
  }

  private readConfig(file: string, raw: any, L: Layout): Config {
    const config: Config = { folders: {}, names: {} };
    if (!raw) return config;
    const building = (v: unknown, what: string) => {
      const id = typeof v === 'string' ? L.ids.get(v.toLowerCase()) : undefined;
      if (!id) console.error(`${file}: unknown building "${v}" for ${what} (ignored).`);
      return id;
    };
    for (const [f, v] of Object.entries(raw?.folders ?? {})) {
      const id = building(v, `folder "${f}"`);
      if (id) config.folders[f.replace(/^\/+|\/+$/g, '')] = id;
    }
    for (const [k, v] of Object.entries(raw?.names ?? {})) {
      const id = building(k, 'a name');
      if (id && typeof v === 'string' && v.trim()) config.names[id] = v.trim().slice(0, 40);
    }
    if (typeof raw?.world === 'string' && raw.world.trim()) config.world = raw.world.trim().slice(0, 40);
    if (typeof raw?.town === 'string') config.town = raw.town;
    return config;
  }

  /** Every town seen so far, with its world and building labels (folder names, renamed buildings). */
  towns(): TownInfo[] {
    const list = [...this.projects.keys()].map((root) => {
      const p = this.project(root);
      const folders: Record<string, string[]> = {};
      const add = (b: string, f: string) => (folders[b] ??= []).includes(f) || folders[b].push(f);
      const L = this.layout(p.townMap);
      add(L.root, 'root files');
      if (L.commands) add(L.commands, 'commands & tools');
      for (const [f, b] of Object.entries(p.config.folders)) if (this.used.has(`${root}\0${f}`)) add(b, f);
      for (const [a, x] of p.areas) add(x.building, a);
      return { id: root, name: path.basename(root), world: this.worlds.worldOf(root, p.config.world), map: p.townMap, spot: false, primary: false,
        land: this.lands[p.townMap], folders, names: { ...p.config.names } };
    });
    // on the world map, each town map's spot goes to the town that got that map first in its world
    // and each world's first town (got its map earliest) is its primary town
    const holder = new Map<string, TownInfo>(), first = new Set<string>();
    for (const t of [...list].sort((a, b) => this.townMaps.order(a.id) - this.townMaps.order(b.id) || a.name.localeCompare(b.name))) {
      const k = `${t.world}\0${t.map}`;
      if (!holder.has(k)) { holder.set(k, t); t.spot = true; }
      if (!first.has(t.world)) { first.add(t.world); t.primary = true; }
    }
    // two towns in one world with the same folder name: add the parent folder
    for (const t of list) if (list.some((o) => o !== t && o.world === t.world && path.basename(o.id) === path.basename(t.id)))
      t.name = `${path.basename(path.dirname(t.id))}/${t.name}`;
    return list.sort((a, b) => a.world.localeCompare(b.world) || a.name.localeCompare(b.name));
  }

  /** A town comes into being when a robot first works there. */
  private visit(root: string) {
    if (this.projects.has(root)) return;
    this.worlds.addRepo(root);
    this.project(root);
  }

  private townName(root: string) {
    return this.towns().find((t) => t.id === root)?.name ?? path.basename(root);
  }

  /** The repo root (folder holding .git) that contains dir, or undefined outside any repo. */
  repoRoot(dir: string): string | undefined {
    if (this.gitRoots.has(dir)) return this.gitRoots.get(dir) || undefined;
    let d = dir, found: string | undefined;
    while (true) {
      if (fs.existsSync(path.join(d, '.git'))) { found = d; break; }
      const up = path.dirname(d);
      if (up === d) break;
      d = up;
    }
    this.gitRoots.set(dir, found ?? '');
    return found;
  }
}

/** agentville.json's contents ('' stamp: no file), or undefined when it's missing or not valid JSON. */
function readJson(file: string, stamp: string): any {
  if (!stamp) return undefined;
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
    console.error(`Ignoring ${file}: it isn't valid JSON.`);
    return undefined;
  }
}

/** The file or folder a tool call works on (for Bash: its current folder). MCP tools may send other types. */
function toolPath(e: HookEvent): string | undefined {
  const i = e.tool_input ?? {};
  const str = (v: unknown) => (typeof v === 'string' && v ? v : undefined);
  return str(i.file_path) ?? str(i.notebook_path) ?? str(i.path) ?? (e.tool_name === 'Bash' ? str(e.cwd) : undefined);
}

const isEdit = (t?: string) => t === 'Edit' || t === 'MultiEdit' || t === 'Write' || t === 'NotebookEdit';

/** Tools that don't do work in the town: planning, the app's own UI, loading tools, subagents. */
const BOOKKEEPING = /^(TodoWrite|ToolSearch|Skill|AskUserQuestion|EnterPlanMode|ExitPlanMode|Task|Agent|SendMessage|ListAgents|Task[A-Z]\w*)$|^mcp__ccd_/;

/** Real work that touches no project file: shell commands, browser, terminal, web, other MCP tools. */
function touchesNoFile(e: HookEvent) {
  const t = e.tool_name ?? '';
  return !!t && !isQuick(t) && !BOOKKEEPING.test(t) && !['Read', 'Edit', 'MultiEdit', 'Write', 'NotebookEdit'].includes(t);
}

/** The tool call carries Claude's own words for what it's doing. */
const ownWords = (e: HookEvent) => !!(e.tool_input?.description && e.tool_name === 'Bash') || typeof e.tool_input?.action_summary === 'string';

/** Where the session started, from the first "cwd" in its transcript (only files under ~/.claude). */
function startFolder(e: HookEvent): string | undefined {
  const t = safeTranscript(e.transcript_path);
  const head = t && readHead(t, 256 * 1024);
  const m = head?.match(/"cwd":("(?:[^"\\]|\\.)*")/);
  try {
    const dir = m ? JSON.parse(m[1]) : undefined;
    return typeof dir === 'string' && path.isAbsolute(dir) && fs.existsSync(dir) ? dir : undefined;
  } catch { return; }
}

const isQuick = (t?: string) => t === 'Read' || t === 'Grep' || t === 'Glob' || t === 'LS';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

/** Claude Code's list of what's still running at the end of a turn, as background lamps. */
function backgroundOf(tasks: unknown[]): BackgroundTask[] {
  const out: BackgroundTask[] = [];
  for (const t of tasks as any[]) {
    if (!t || typeof t !== 'object' || (typeof t.status === 'string' && !/^(running|starting|pending)$/.test(t.status))) continue;
    const id = typeof t.id === 'string' ? t.id : undefined;
    const text = (v: unknown) => (typeof v === 'string' && v.trim() ? clipText(v, 80) : undefined);
    if (t.type === 'shell') out.push({ type: 'shell', id, kind: activityOf(t.command), text: text(t.description) ?? text(t.command) ?? 'A command' });
    else if (t.type === 'subagent') out.push({ type: 'agent', id, text: text(t.description) ?? text(t.agent_type) ?? 'A helper' });
    else out.push({ type: /monitor/i.test(String(t.type)) ? 'monitor' : 'other', id, text: text(t.description) ?? text(t.command) ?? text(t.type) ?? 'Something' });
  }
  return out.slice(0, 20);
}

/** A background task's id in a tool's response, if it gives one. */
function idIn(resp: unknown): string | undefined {
  if (!resp || typeof resp !== 'object') return;
  for (const [k, v] of Object.entries(resp)) if (typeof v === 'string' && /^(background_?task_?id|bash_?id|shell_?id|task_?id|monitor_?id)$/i.test(k)) return v;
}

const clipText = (s: string, n: number) => { const t = s.replace(/\s+/g, ' ').trim(); return t.length > n ? t.slice(0, n - 1).trimEnd() + '…' : t; };
