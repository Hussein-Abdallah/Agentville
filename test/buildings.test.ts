// Folders → buildings: busiest first, overflow, agentville.json, labels (milestone 5 + commands building).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS, MISC, ROOT, folderSlots, git, gitRepo, newTown, tmpDir } from './support';

/** api 5 commits, web 3, docs 1, "old" 10 but since deleted; "scripts" exists but is untracked. */
function busyRepo() {
  const d = gitRepo('busy', [['old', 10], ['api', 5], ['web', 3], ['docs', 1]]);
  fs.rmSync(path.join(d, 'old'), { recursive: true });
  git(d, 'add', '-A');
  git(d, 'commit', '-qm', 'remove old');
  fs.mkdirSync(path.join(d, 'scripts'));
  return d;
}

test('busiest folders hold the most prominent buildings, even before they are used', () => {
  const repo = busyRepo();
  const t = newTown();
  t.prompt(repo);
  assert.equal(t.edit(repo, 'docs/x.md').building, folderSlots[2], 'docs is 3rd busiest');
  assert.equal(t.edit(repo, 'scripts/x.sh').building, folderSlots[3], 'unranked: best building nobody holds');
  assert.equal(t.edit(repo, 'api/x.ts').building, folderSlots[0]);
  assert.equal(t.edit(repo, 'web/x.ts').building, folderSlots[1]);
  assert.equal(t.edit(repo, 'old/x').building, folderSlots[4], 'a deleted folder holds nothing');
  assert.equal(t.edit(repo, 'README.md').building, ROOT);
  assert.deepEqual(t.s.labels().folders, {
    [ROOT]: ['root files'], [COMMANDS]: ['commands & tools'],
    [folderSlots[2]]: ['docs'], [folderSlots[3]]: ['scripts'], [folderSlots[0]]: ['api'], [folderSlots[1]]: ['web'], [folderSlots[4]]: ['old'],
  });
});

test('outside git: first-used order, then the rest share the misc building', () => {
  const dir = tmpDir('nogit');
  const t = newTown();
  const got = Array.from({ length: folderSlots.length + 3 }, (_, i) => t.edit(dir, `f${String(i).padStart(2, '0')}/x`).building);
  assert.deepEqual(got.slice(0, folderSlots.length), folderSlots);
  assert.deepEqual(got.slice(folderSlots.length), [MISC, MISC, MISC]);
  assert.ok(!got.includes(COMMANDS), 'the commands building never holds a code folder');
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
  assert.deepEqual(town.s.labels().names, { church: 'Backend', observatory: 'Frontend' });
  assert.equal(errors.length, 2, 'unknown buildings are reported');

  const later = (ms: number) => { const d = new Date(Date.now() + ms); fs.utimesSync(file, d, d); };
  fs.writeFileSync(file, JSON.stringify({ folders: { web: 'hot-springs' } }));
  later(5000);
  assert.equal(town.edit(repo, 'web/y.ts').building, 'hot-springs', 'edited file is reloaded');
  assert.equal(town.edit(repo, 'api/y.ts').building, folderSlots[0]);
  assert.deepEqual(town.s.labels().names, {});

  fs.writeFileSync(file, '{ not json');
  later(10000);
  assert.equal(town.edit(repo, 'web/z.ts').building, folderSlots[1], 'broken file is ignored');
});

test('labels: root files and commands & tools only while a session exists', () => {
  const t = newTown();
  assert.deepEqual(t.s.labels().folders, {});
  t.prompt(tmpDir('labels', { repo: true }));
  assert.deepEqual(t.s.labels().folders, { [ROOT]: ['root files'], [COMMANDS]: ['commands & tools'] });
});
