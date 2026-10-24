// Folders → buildings: they follow the work (first come, best free building; the quietest hands over), adaptive depth, agentville.json, labels.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS, MISC, ROOT, fakeClock, folderSlots, git, gitRepo, newTown, tmpDir } from './support';

/** api 5 commits, web 3, docs 1, "old" 10 but since deleted; "scripts" exists but is untracked. */
function busyRepo() {
  const d = gitRepo('busy', [['old', 10], ['api', 5], ['web', 3], ['docs', 1]]);
  fs.rmSync(path.join(d, 'old'), { recursive: true });
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'remove old');
  fs.mkdirSync(path.join(d, 'scripts'));
  return d;
}

test('folders take the most prominent free building in the order they come up (no git ranking)', () => {
  const repo = busyRepo();
  const t = newTown();
  t.prompt(repo);
  assert.equal(t.edit(repo, 'docs/x.md').building, folderSlots[0], 'first come, best building');
  assert.equal(t.edit(repo, 'scripts/x.sh').building, folderSlots[1]);
  assert.equal(t.edit(repo, 'api/x.ts').building, folderSlots[2]);
  assert.equal(t.edit(repo, 'docs/y.md').building, folderSlots[0], 'a folder keeps its building');
  assert.equal(t.edit(repo, 'README.md').building, ROOT);
  assert.deepEqual(t.town(repo)!.folders, {
    [ROOT]: ['root files'], [COMMANDS]: ['commands & tools'],
    [folderSlots[0]]: ['docs'], [folderSlots[1]]: ['scripts'], [folderSlots[2]]: ['api'],
  });
});

test('edits claim a building at once; reads only once the robot has stayed put 12 s', () => {
  const clock = fakeClock();
  try {
    const t = newTown(), r = tmpDir('claims', { repo: true, dirs: ['api', 'web'] });
    t.prompt(r);
    const at = t.edit(r, 'api/a.ts').building;
    clock.tick(2000);
    assert.equal(t.tool(r, 'Read', { file_path: path.join(r, 'web/b.ts') }).building, at, 'a quick look elsewhere claims nothing');
    assert.deepEqual(Object.values(t.town(r)!.folders).flat().sort(), ['api', 'commands & tools', 'root files']);
    clock.tick(12_500);
    assert.equal(t.tool(r, 'Read', { file_path: path.join(r, 'web/b.ts') }).building, folderSlots[1], 'after a while, reading claims it');
  } finally { clock.restore(); }
});

test('a full town hands the building of its quietest folder to a new one; never one a robot is at', () => {
  const clock = fakeClock();
  try {
    const t = newTown(), r = tmpDir('full', { repo: true });
    const n = folderSlots.length;
    for (let i = 0; i < n; i++) { t.edit(r, `f${i}/x`); clock.tick(1000); }
    t.edit(r, 'f0/x', 's2'); // another robot now works in f0 (the quietest otherwise)
    clock.tick(1000);
    assert.equal(t.edit(r, 'new1/x').building, folderSlots[1], 'f0 has a robot at it, so f1 (next quietest) hands over');
    const labels = Object.values(t.town(r)!.folders).flat();
    assert.ok(labels.includes('new1') && !labels.includes('f1') && labels.includes('f0'));
    assert.ok(!labels.includes('commands & tools ') && t.town(r)!.folders[COMMANDS].length === 1, 'the commands building never holds a code folder');
  } finally { clock.restore(); }
});

test('when every building has a robot at it, a new folder uses the shared building', () => {
  const t = newTown(), r = tmpDir('busy-all', { repo: true });
  folderSlots.forEach((_, i) => t.edit(r, `f${i}/x`, `s${i}`));
  assert.equal(t.edit(r, 'late/x', 'sX').building, MISC);
});

test('depth adapts: a folder that only holds folders splits into them; pins work at any depth', () => {
  const r = tmpDir('deep', { repo: true, dirs: ['src/auth', 'src/ui', 'src/db', 'server', 'docs/guides'] });
  fs.writeFileSync(path.join(r, 'server', 'index.ts'), '');
  fs.writeFileSync(path.join(r, 'server', 'state.ts'), '');
  fs.writeFileSync(path.join(r, 'src', 'main.ts'), '');
  fs.writeFileSync(path.join(r, 'agentville.json'), JSON.stringify({ folders: { 'src/db': 'library' } }));
  const t = newTown();
  t.prompt(r);
  t.edit(r, 'src/auth/login.ts');
  t.edit(r, 'src/ui/Button.tsx');
  t.edit(r, 'server/index.ts');
  t.edit(r, 'docs/guides/setup.md');
  assert.equal(t.edit(r, 'src/db/schema.ts').building, 'library');
  t.edit(r, 'src/main.ts');
  const labels = Object.values(t.town(r)!.folders).flat().sort();
  assert.deepEqual(labels, ['commands & tools', 'docs', 'root files', 'server', 'src', 'src/auth', 'src/db', 'src/ui'],
    'src holds 3 folders and 1 file: split; docs holds 1 folder: not; files right in src go to "src"');
});

test('a repo nested inside a town is never one of its folders', () => {
  const outer = tmpDir('outer', { repo: true, dirs: ['tools'] });
  const inner = path.join(outer, 'inner-app');
  fs.mkdirSync(path.join(inner, '.git'), { recursive: true });
  fs.mkdirSync(path.join(inner, 'src'));
  const t = newTown();
  t.prompt(outer);
  t.edit(outer, 'tools/x.ts');
  t.tool(outer, 'Read', { file_path: path.join(inner, 'src', 'a.ts') });
  t.tool(outer, 'Grep', { pattern: 'x', path: inner });
  const labels = Object.values(t.town(outer)!.folders).flat();
  assert.ok(!labels.includes('inner-app'), 'no building for the nested repo');
  assert.equal(t.edit(outer, 'inner-app/src/b.ts').town, inner, 'an edit there takes the robot to its own town');
});

test('the layout is remembered across restarts, per town map', () => {
  const home = tmpDir('home'), r = tmpDir('kept', { repo: true });
  const a = newTown(undefined, home);
  a.edit(r, 'web/x.ts');
  a.edit(r, 'api/x.ts');
  const b = newTown(undefined, home);
  b.prompt(r);
  assert.equal(b.edit(r, 'api/y.ts').building, folderSlots[1], 'api kept its building after the restart');
  assert.deepEqual(Object.values(b.town(r)!.folders).flat().sort(), ['api', 'commands & tools', 'root files', 'web']);
});

test('agentville.json pins folders and renames buildings; reloads when it changes', (t) => {
  const repo = busyRepo();
  const file = path.join(repo, 'agentville.json');
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => errors.push(a));
  fs.writeFileSync(file, JSON.stringify({
    folders: { api: 'library', docs: 'Timber workshop', x: 'moon' },
    names: { church: 'Backend', Observatory: 'Frontend', moon: 'Nope' },
  }));
  const town = newTown();
  assert.equal(town.edit(repo, 'api/x.ts').building, 'library', 'pinned by id');
  assert.equal(town.edit(repo, 'docs/x.md').building, MISC, 'pinned by building name');
  assert.equal(town.edit(repo, 'web/x.ts').building, folderSlots[0], 'web moves up: api left the automatic order');
  assert.deepEqual(town.town(repo)!.names, { church: 'Backend', observatory: 'Frontend' });
  assert.equal(errors.length, 2, 'unknown buildings are reported');

  const later = (ms: number) => { const d = new Date(Date.now() + ms); fs.utimesSync(file, d, d); };
  fs.writeFileSync(file, JSON.stringify({ folders: { web: 'hot-springs' } }));
  later(5000);
  assert.equal(town.edit(repo, 'web/y.ts').building, 'hot-springs', 'edited file is reloaded');
  assert.equal(town.edit(repo, 'api/y.ts').building, folderSlots[0]);
  assert.deepEqual(town.town(repo)!.names, {});

  fs.writeFileSync(file, '{ not json');
  later(10000);
  assert.equal(town.edit(repo, 'web/z.ts').building, folderSlots[1], 'broken file is ignored');
});

test('a town appears when a robot first works there, labelled root files and commands & tools', () => {
  const t = newTown(), r = tmpDir('labels', { repo: true });
  assert.deepEqual(t.s.towns(), []);
  t.prompt(r);
  assert.deepEqual(t.town(r)!.folders, { [ROOT]: ['root files'], [COMMANDS]: ['commands & tools'] });
});
