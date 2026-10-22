// Several town maps: each repo gets one (different from the others in its world), remembered across restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Sessions } from '../server/state';
import { TownMaps } from '../server/townmaps';
import { Worlds } from '../server/worlds';
import { tmpDir } from './support';

/** A tiny map: root, commands, plaza, station, misc and two folder buildings, ids prefixed. */
const fakeMap = (p: string) => [
  { id: `${p}-hall`, name: `${p} hall`, role: 'root' }, { id: `${p}-lab`, role: 'commands' }, { id: `${p}-square`, role: 'plaza' },
  { id: `${p}-dock`, role: 'station' }, { id: `${p}-shed`, role: 'misc' }, { id: `${p}-one` }, { id: `${p}-two` },
];
const MAPS = { a: fakeMap('a'), b: fakeMap('b'), c: fakeMap('c') };

function setup() {
  const h = tmpDir('home');
  const repo = (r: string) => { fs.mkdirSync(path.join(h, r, '.git'), { recursive: true }); fs.mkdirSync(path.join(h, r, 'src'), { recursive: true }); return path.join(h, r); };
  const file = path.join(h, '.agentville', 'towns.json');
  const make = () => {
    const worlds = new Worlds({ configFile: path.join(h, 'none.json'), claudeDir: path.join(h, '.claude'), home: h });
    worlds.addRepo(repo('Dev/Blog/site')); // like a repo learned from Claude's history: makes ~/Dev the dev folder
    return new Sessions(MAPS, ['orange'], () => {}, worlds, new TownMaps(Object.keys(MAPS), { file }));
  };
  const visit = (s: Sessions, root: string) => s.handle({ hook_event_name: 'UserPromptSubmit', session_id: root, cwd: root, prompt: 'x' } as any) as any;
  return { h, repo, file, make, visit };
}

test('repos in one world get different maps, in order; then the least used map is reused', () => {
  const { repo, make, visit } = setup();
  const s = make();
  const roots = ['Dev/Acme/one', 'Dev/Acme/two', 'Dev/Acme/three', 'Dev/Acme/four'].map(repo);
  roots.forEach((r) => visit(s, r));
  const towns = s.towns();
  assert.deepEqual(roots.map((r) => towns.find((t) => t.id === r)!.map), ['a', 'b', 'c', 'a']);
  assert.deepEqual(roots.map((r) => towns.find((t) => t.id === r)!.spot), [true, true, true, false], 'the 4th is a signpost');
});

test("a robot's buildings come from its own town's map", () => {
  const { repo, make, visit } = setup();
  const s = make();
  const one = repo('Dev/Acme/one'), two = repo('Dev/Acme/two');
  assert.equal(visit(s, one).building, 'a-lab', 'first prompt: commands building of map a');
  assert.equal(visit(s, two).building, 'b-lab', 'and of map b');
  const st = s.handle({ hook_event_name: 'PreToolUse', session_id: two, cwd: two, tool_name: 'Edit', tool_input: { file_path: path.join(two, 'README.md') } } as any) as any;
  assert.equal(st.building, 'b-hall', 'root files go to map b\'s root building');
  assert.deepEqual(s.towns().find((t) => t.id === two)!.folders, { 'b-hall': ['root files'], 'b-lab': ['commands & tools'] });
});

test('maps are remembered across restarts', () => {
  const { repo, file, make, visit } = setup();
  const one = repo('Dev/Acme/one'), two = repo('Dev/Acme/two');
  const first = make();
  visit(first, one); visit(first, two);
  const again = make();
  visit(again, two); // seen first this time, but keeps its map
  assert.equal(again.towns().find((t) => t.id === two)!.map, 'b');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), { [one]: 'a', [two]: 'b' });
});

test('worlds have their own maps: the first repo of each world gets the first map', () => {
  const { repo, make, visit } = setup();
  const s = make();
  const acme = repo('Dev/Acme/one'), blog = repo('Dev/Blog/site');
  visit(s, acme); visit(s, blog);
  assert.deepEqual(s.towns().map((t) => `${t.world}: ${t.map} ${t.spot}`), ['Acme: a true', 'Blog: a true']);
});

test('"town" in agentville.json picks the map (unknown names are reported and ignored)', (t) => {
  const { repo, make, visit } = setup();
  const errors: unknown[] = [];
  t.mock.method(console, 'error', (...a: unknown[]) => errors.push(a));
  const one = repo('Dev/Acme/one'), two = repo('Dev/Acme/two');
  fs.writeFileSync(path.join(one, 'agentville.json'), JSON.stringify({ town: 'c' }));
  fs.writeFileSync(path.join(two, 'agentville.json'), JSON.stringify({ town: 'moon' }));
  const s = make();
  visit(s, one); visit(s, two);
  assert.deepEqual(s.towns().map((x) => x.map), ['c', 'a']);
  assert.equal(errors.length, 1);
});
