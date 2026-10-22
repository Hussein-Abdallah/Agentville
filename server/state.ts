// Turns Claude Code hook events into robot states (AgentState) for the town.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { AgentState, TownInfo } from '../src/types';
import { activeTodo, friendlyTask, isPlanTool } from './friendly';
import { Worlds } from './worlds';

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

/** One repo (a town): its folder → building layout. */
interface Project {
  map: Map<string, string>; // folder -> building, in first-used order
  rank: string[]; // top-level folders, busiest first (git history)
  config: Config;
  configStamp: string; // agentville.json mtime ('' when absent), to reload on change
}

/** agentville.json at the repo root: pin folders to buildings, rename buildings, name the world. */
interface Config { folders: Record<string, string>; names: Record<string, string>; world?: string }

const NAMES = ['Atlas', 'Byte', 'Cleo', 'Dex', 'Echo', 'Fern', 'Gus', 'Iris', 'Juno', 'Kit', 'Lumen', 'Milo'];
const STALE_MS = 30 * 60 * 1000;
const STICKY_MS = 12_000;
const HELPER_STALE_MS = 10 * 60 * 1000;
const PENDING_MS = 60_000; // an Agent call's subagent normally starts within seconds
const ENDED_MS = 10 * 60 * 1000; // late events after SessionEnd are ignored this long
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
  helpers: Map<string, string>; // subagent id (agent_id in hook events) -> helper robot id
  /** Agent/Task calls whose subagent hasn't shown up yet (oldest first) */
  pending: Pending[];
  helperSeq: number;
  /** subagents that already stopped: late events for them are dropped */
  endedAgents: Set<string>;
}

interface Pending { toolUseId?: string; type?: string; desc: string; t: number }

/** A subagent's robot: like a session robot, but its events carry the parent's session id plus an agent_id. */
interface Helper { state: AgentState; session: string; root: string; agentType?: string; lastSeen: number; lastMove: number; preWait?: string }

export type Emit = (msg: { type: 'agent'; state: AgentState } | { type: 'remove'; id: string } | { type: 'log'; html: string }
  | { type: 'needs'; state: AgentState; project: string }) => void;

export class Sessions {
  private sessions = new Map<string, Session>();
  private endedSessions = new Map<string, number>(); // session id -> when it ended
  private helpers = new Map<string, Helper>(); // helper robot id -> helper
  private projects = new Map<string, Project>(); // project root -> layout
  private nameIdx = 0;
  private buildingIds: Map<string, string>; // lowercased id or name -> id (for agentville.json)
  private gitRoots = new Map<string, string>();
  private slots: string[];
  private rootBuilding: string;
  private miscBuilding: string;
  private plaza?: string;
  /** where work that touches no file happens: shell commands, browser, web */
  private commandsBuilding?: string;

  constructor(buildings: Building[], private colors: string[], private emit: Emit, readonly worlds = new Worlds()) {
    this.slots = buildings.filter((b) => !b.role).map((b) => b.id);
    this.rootBuilding = buildings.find((b) => b.role === 'root')?.id ?? this.slots[0];
    this.miscBuilding = buildings.find((b) => b.role === 'misc')?.id ?? this.slots[this.slots.length - 1];
    this.plaza = buildings.find((b) => b.role === 'plaza')?.id;
    this.commandsBuilding = buildings.find((b) => b.role === 'commands')?.id;
    // folders may live in any building except the station and the plaza
    this.buildingIds = new Map(buildings.filter((b) => b.role !== 'station' && b.role !== 'plaza')
      .flatMap((b) => [[b.id.toLowerCase(), b.id], ...(b.name ? [[b.name.toLowerCase(), b.id]] : [])] as [string, string][]));
    setInterval(() => this.sweep(), 60_000).unref();
  }

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
      if ((ended && Date.now() - ended < ENDED_MS && !resumed) || !STARTS.has(ev)) return;
      s = this.start(e);
    }
    s.lastSeen = Date.now();
    // a subagent's own events: they move its helper robot, not the parent
    if (typeof e.agent_id === 'string' && e.agent_id) return this.handleHelper(s, e, e.agent_id);
    const st = s.state;
    const was = st.status;
    const before = st.task;

    switch (ev) {
      case 'SessionStart':
        break;
      case 'UserPromptSubmit':
        if (typeof e.session_title === 'string' && e.session_title) st.title = e.session_title.slice(0, 80);
        else if (typeof e.prompt === 'string' && e.prompt && !st.title) st.title = e.prompt.replace(/\s+/g, ' ').slice(0, 80);
        s.todo = undefined; // new request: forget the previous plan
        st.status = 'working';
        st.task = s.todo ?? 'Thinking…';
        // back to work: leave the plaza for the last building, or the commands building
        if (st.building === this.plaza) this.moveTo(s, s.lastWork ?? this.commandsBuilding);
        break;
      case 'PreToolUse': {
        const todo = activeTodo(e);
        if (isPlanTool(e.tool_name)) s.todo = todo ?? s.todo;
        st.status = 'working';
        st.task = isPlanTool(e.tool_name) ? s.todo ?? 'Planning' : s.todo && !isQuick(e.tool_name) ? s.todo : friendlyTask(e);
        // a command description or action summary stays visible even with an active to-do
        if (ownWords(e)) st.task = friendlyTask(e);
        // Edits always move the robot. Quick look-ups (Read/Grep/Glob) and work that touches no file
        // (commands, browser, web → the commands building) only move it if it has stayed put for a
        // while, so a quick command between edits doesn't make it run back and forth.
        // work in another repo: the robot goes to that town (edits at once, other work once it has stayed put)
        const town = this.townOf(s.root, e);
        const settled = Date.now() - s.lastMove > STICKY_MS || st.building === this.plaza;
        if (town && (isEdit(e.tool_name) || settled)) this.changeTown(s, town);
        const file = this.buildingFor(s.root, e);
        const b = file ?? (touchesNoFile(e) ? this.commandsBuilding : undefined);
        const sticky = isQuick(e.tool_name) || (!file && st.building !== this.plaza);
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
        break;
      case 'PermissionDenied':
        this.dropPending(s, e);
        st.status = 'working';
        st.task = s.todo ?? 'Trying another way';
        break;
      case 'PermissionRequest':
        st.status = 'waiting';
        st.task = e.tool_name ? `Wants to use ${e.tool_name}` : 'Needs permission';
        break;
      case 'Notification': {
        const t = e.notification_type ?? '';
        const msg = (typeof e.message === 'string' ? e.message : '').toLowerCase();
        if (t === 'permission_prompt' || msg.includes('permission')) { st.status = 'waiting'; st.task = 'Needs permission'; }
        else if (t === 'idle_prompt' || msg.includes('waiting for your input')) { st.status = 'waiting'; st.task = 'Waiting for your reply'; }
        break;
      }
      case 'Stop':
        // finished: gather at the plaza (watching the tree) until the next prompt
        st.status = 'idle';
        st.task = undefined;
        if (this.plaza) st.building = this.plaza;
        break;
      case 'SubagentStop': // without an agent_id: the oldest helper finished
        this.endHelper(s, s.helpers.keys().next().value);
        break;
      default:
        return;
    }
    return this.settle(st, s, s.project, e, was, before);
  }

  /** The other town (repo root) a tool call works in, if it isn't `current` and is inside a repo. */
  private townOf(current: string, e: HookEvent): string | undefined {
    const p = toolPath(e);
    if (!p) return;
    const abs = path.isAbsolute(p) ? p : path.resolve(e.cwd ?? current, p);
    if (abs === current || abs.startsWith(current + path.sep)) return;
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
    Object.assign(s.state, { town: root, project: s.project, building: this.commandsBuilding ?? this.rootBuilding });
    this.emit({ type: 'log', html: `<b>${s.state.name}</b> went from ${esc(from)} to ${esc(s.project)}` });
  }

  /** After an event: needs-you alert, history entry for the details panel, broadcast. */
  private settle(st: AgentState, t: { preWait?: string }, project: string, e: HookEvent, was: string, before?: string) {
    const ev = e.hook_event_name;
    if (st.status === 'waiting' && was !== 'waiting') {
      t.preWait = before;
      this.emit({ type: 'log', html: `<b>${st.name}</b> needs you${project ? ` in ${esc(project)}` : ''}` });
      this.emit({ type: 'needs', state: { ...st }, project });
    }
    st.lastActive = Date.now();
    // history: new requests, changed tasks, needs-you, failed / not allowed, finished
    const step = (was === 'waiting' ? t.preWait : before) ?? e.tool_name ?? 'a step';
    const note = st.status === 'waiting' && was !== 'waiting' ? `Needs you: ${st.task ?? 'waiting'}`
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
      if (!['SubagentStart', 'PreToolUse', 'PermissionRequest'].includes(ev)) return;
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
          Object.assign(st, { town, project: this.townName(town), building: this.commandsBuilding ?? this.rootBuilding });
          h.lastMove = Date.now();
        }
        const file = this.buildingFor(h.root, e);
        const b = file ?? (touchesNoFile(e) ? this.commandsBuilding : undefined);
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
        st.task = e.tool_name ? `Wants to use ${e.tool_name}` : 'Needs permission';
        break;
      case 'PermissionDenied':
        st.status = 'working';
        break;
      default:
        return;
    }
    return this.settle(st, h, st.project ?? s.project, e, was, before);
  }

  private moveTo(s: Session, b?: string) {
    if (!b || b === s.state.building) return;
    s.state.building = b;
    s.lastMove = Date.now();
    if (b !== this.plaza) s.lastWork = b;
  }

  private start(e: HookEvent): Session {
    // the folder the session started in: the transcript knows it even if the first event we see
    // (e.g. after the service restarts) comes from a different current folder
    const dir = startFolder(e) ?? e.cwd ?? process.cwd();
    const root = this.repoRoot(dir) ?? dir; // a folder outside any repo is a town of its own
    this.visit(root);
    const used = new Set([...this.sessions.values()].map((s) => s.state.color));
    const color = this.colors.find((c) => !used.has(c)) ?? this.colors[this.sessions.size % this.colors.length];
    const name = NAMES[this.nameIdx++ % NAMES.length];
    const project = this.townName(root);
    const s: Session = {
      state: { id: e.session_id, name, color, building: this.plaza ?? this.rootBuilding, status: 'idle', project, town: root, startedAt: Date.now() },
      root, project, lastSeen: Date.now(), lastMove: 0, helpers: new Map(), pending: [], helperSeq: 1, endedAgents: new Set(),
    };
    this.sessions.set(e.session_id, s);
    this.emit({ type: 'log', html: `<b>${name}</b> started in ${esc(project)}` });
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
    const h: Helper = { state, session: s.state.id, root: s.root, agentType, lastSeen: Date.now(), lastMove: 0 };
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

  /** Which building a tool call belongs to: the top-level folder of the file it touches. */
  private buildingFor(root: string, e: HookEvent): string | undefined {
    const i = e.tool_input ?? {};
    const p = toolPath(e);
    if (!p) return;
    const abs = path.isAbsolute(p) ? p : path.resolve(e.cwd ?? root, p);
    const rel = path.relative(root, abs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return; // outside the project: stay put
    const parts = rel.split(path.sep).filter(Boolean);
    const isDir = !path.extname(abs) && (i.path !== undefined || e.tool_name === 'Bash');
    // commands run from the project root don't move the robot; root files go to the root building
    if (parts.length === 0 && e.tool_name === 'Bash') return;
    if (parts.length === 0 || (parts.length === 1 && !isDir)) return this.rootBuilding;
    return this.assign(root, parts[0]);
  }

  private assign(root: string, folder: string) {
    const p = this.project(root);
    let b = p.map.get(folder);
    if (!b) {
      b = p.config.folders[folder] ?? this.pickSlot(p, folder);
      p.map.set(folder, b);
    }
    return b;
  }

  /**
   * A building for a folder that isn't pinned in agentville.json. The busiest folders (by git
   * history) hold the most prominent buildings (town.json order) even before they're used; other
   * folders take the best free building nobody holds, then the least prominent free one; then misc.
   */
  private pickSlot(p: Project, folder: string) {
    const pinned = new Set(Object.values(p.config.folders));
    const auto = this.slots.filter((x) => !pinned.has(x));
    const ranked = p.rank.filter((f) => !(f in p.config.folders)).slice(0, auto.length);
    const taken = new Set(p.map.values());
    const free = auto.filter((x) => !taken.has(x));
    if (!free.length) return this.miscBuilding;
    const own = auto[ranked.indexOf(folder)];
    if (own && free.includes(own)) return own;
    const held = new Set(ranked.filter((f) => !p.map.has(f)).map((f) => auto[ranked.indexOf(f)]));
    return free.find((x) => !held.has(x)) ?? free[free.length - 1];
  }

  /** The layout for a repo; reloads agentville.json (and starts the layout over) when it changes. */
  private project(root: string): Project {
    const file = path.join(root, 'agentville.json');
    let stamp = '';
    try { stamp = String(fs.statSync(file).mtimeMs); } catch { /* no override file */ }
    let p = this.projects.get(root);
    if (!p || p.configStamp !== stamp) {
      p = { map: new Map(), rank: p?.rank ?? gitRank(root), config: this.readConfig(file, stamp), configStamp: stamp };
      this.projects.set(root, p);
    }
    return p;
  }

  private readConfig(file: string, stamp: string): Config {
    const config: Config = { folders: {}, names: {} };
    if (!stamp) return config;
    let raw: any;
    try { raw = JSON.parse(fs.readFileSync(file, 'utf8')); } catch {
      console.error(`Ignoring ${file}: it isn't valid JSON.`);
      return config;
    }
    const building = (v: unknown, what: string) => {
      const id = typeof v === 'string' ? this.buildingIds.get(v.toLowerCase()) : undefined;
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
    return config;
  }

  /** Every town seen so far, with its world and building labels (folder names, renamed buildings). */
  towns(): TownInfo[] {
    const list = [...this.projects.keys()].map((root) => {
      const p = this.project(root);
      const folders: Record<string, string[]> = {};
      const add = (b: string, f: string) => (folders[b] ??= []).includes(f) || folders[b].push(f);
      add(this.rootBuilding, 'root files');
      if (this.commandsBuilding) add(this.commandsBuilding, 'commands & tools');
      for (const [f, b] of p.map) add(b, f);
      return { id: root, name: path.basename(root), world: this.worlds.worldOf(root, p.config.world), folders, names: { ...p.config.names } };
    });
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

/** Top-level folders of a repo that still exist, busiest first: how many of the last 500 commits touched each. */
function gitRank(root: string): string[] {
  let out: string;
  try {
    out = execFileSync('git', ['-C', root, '-c', 'core.quotePath=false', 'log', '-n', '500', '--name-only', '--format=%x00'],
      { encoding: 'utf8', timeout: 3000, maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] });
  } catch { return []; } // not a git repo, or git missing: first-used order
  const count = new Map<string, number>();
  for (const commit of out.split('\0')) {
    const folders = new Set(commit.split('\n').filter((l) => l.includes('/')).map((l) => l.slice(0, l.indexOf('/'))));
    for (const f of folders) count.set(f, (count.get(f) ?? 0) + 1);
  }
  const isDir = (f: string) => { try { return fs.statSync(path.join(root, f)).isDirectory(); } catch { return false; } };
  return [...count].filter(([f]) => isDir(f)).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([f]) => f);
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
  const t = e.transcript_path;
  const base = path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'));
  if (!t || !t.endsWith('.jsonl') || !path.resolve(t).startsWith(base + path.sep)) return;
  try {
    const fd = fs.openSync(t, 'r');
    const buf = Buffer.alloc(256 * 1024);
    const n = fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    const m = buf.toString('utf8', 0, n).match(/"cwd":("(?:[^"\\]|\\.)*")/);
    const dir = m ? JSON.parse(m[1]) : undefined;
    return typeof dir === 'string' && path.isAbsolute(dir) && fs.existsSync(dir) ? dir : undefined;
  } catch { return; }
}

const isQuick = (t?: string) => t === 'Read' || t === 'Grep' || t === 'Glob' || t === 'LS';
const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
