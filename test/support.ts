// Shared setup for the tests: the Frostpeak buildings, temporary repos, a Sessions driver and a fake clock.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { after } from 'node:test';
import { Sessions } from '../server/state';
import { Worlds } from '../server/worlds';
import { TownMaps } from '../server/townmaps';
import { BuildingStore } from '../server/buildings';

const townFile = new URL('../public/towns/frostpeak/town.json', import.meta.url);
const town = JSON.parse(fs.readFileSync(townFile, 'utf8'));
export const buildings: { id: string; name: string; role?: string }[] =
  Object.entries<any>(town.buildings).map(([id, b]) => ({ id, name: b.name, role: b.role }));
/** Buildings that hold code folders, most prominent first. */
export const folderSlots = buildings.filter((b) => !b.role).map((b) => b.id);
export const ROOT = 'grand-lodge', COMMANDS = 'weather-station', MISC = 'timber-workshop', PLAZA = 'plaza';

const made: string[] = [];
after(() => { for (const d of made) fs.rmSync(d, { recursive: true, force: true }); });

/** A temporary folder; with `repo` it gets a `.git` folder so it counts as a repo root. */
export function tmpDir(name: string, opts: { repo?: boolean; dirs?: string[] } = {}) {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `agentville-${name}-`)));
  made.push(d);
  if (opts.repo) fs.mkdirSync(path.join(d, '.git'));
  for (const sub of opts.dirs ?? []) fs.mkdirSync(path.join(d, sub), { recursive: true });
  return d;
}

/** Run git in a test repo (with a throwaway identity). */
export const git = (d: string, ...args: string[]) => execFileSync('git', ['-C', d, '-c', 'user.name=t', '-c', 'user.email=t@t', ...args], { stdio: 'ignore' });

/** A real git repo with commits: [folder, number of commits touching it], in order. */
export function gitRepo(name: string, commits: [string, number][]) {
  const d = tmpDir(name);
  git(d, 'init', '-q');
  for (const [folder, n] of commits) for (let i = 0; i < n; i++) {
    fs.mkdirSync(path.join(d, folder), { recursive: true });
    fs.writeFileSync(path.join(d, folder, 'f'), String(i));
    git(d, 'add', '-A');
    git(d, 'commit', '-qm', `${folder} ${i}`);
  }
  return d;
}

/** A Sessions instance plus helpers to send events and look at the robots. Its worlds never read your real files. */
export function newTown(worlds?: Worlds, home = tmpDir('home')) {
  const emitted: any[] = [];
  worlds ??= new Worlds({ configFile: path.join(home, 'no-worlds.json'), claudeDir: path.join(home, '.claude'), home });
  const s = new Sessions({ frostpeak: buildings }, ['orange', 'blue', 'green'], (m) => emitted.push(m), worlds,
    new TownMaps(['frostpeak'], { file: path.join(home, '.agentville', 'towns.json') }),
    new BuildingStore({ file: path.join(home, '.agentville', 'buildings.json'), delay: 0 }));
  const send = (root: string, e: Record<string, unknown>, session = 's1') => s.handle({ session_id: session, cwd: root, ...e } as any) as any;
  return {
    s, emitted, send,
    prompt: (root: string, session = 's1') => send(root, { hook_event_name: 'UserPromptSubmit', prompt: 'hi' }, session),
    edit: (root: string, file: string, session = 's1') => send(root, { hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(root, file) } }, session),
    tool: (root: string, tool_name: string, tool_input: Record<string, unknown> = {}, session = 's1') => send(root, { hook_event_name: 'PreToolUse', tool_name, tool_input }, session),
    robot: (id = 's1') => s.snapshot().find((a) => a.id === id),
    robots: () => s.snapshot().map((a) => `${a.id}=${a.title ?? a.name}@${a.building}`).sort(),
    town: (root: string) => s.towns().find((x) => x.id === root),
  };
}

/** Freeze Date.now; move it with tick(ms). Call restore() when done. */
export function fakeClock() {
  const real = Date.now;
  let t = real();
  Date.now = () => t;
  return { tick: (ms: number) => { t += ms; }, restore: () => { Date.now = real; } };
}
