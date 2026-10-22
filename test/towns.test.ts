// Milestone 9: a town per repo, robots moving between towns, towns grouped into worlds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worlds } from '../server/worlds';
import { COMMANDS, fakeClock, newTown, tmpDir } from './support';

/** A fake home with repos (folders holding .git) at the given paths, and Worlds that only look there. */
function home(...repos: string[]) {
  const h = tmpDir('home');
  for (const r of repos) fs.mkdirSync(path.join(h, r, '.git'), { recursive: true });
  const worlds = new Worlds({ configFile: path.join(h, '.agentville', 'worlds.json'), claudeDir: path.join(h, '.claude'), home: h });
  return { h, at: (r: string) => path.join(h, r), worlds };
}

test('an edit in another repo takes the robot to that town at once; the first town stays listed', () => {
  const { at, worlds } = home('Dev/Acme/api', 'Dev/Acme/web');
  const t = newTown(worlds);
  t.prompt(at('Dev/Acme/api'));
  assert.equal(t.robot()!.town, at('Dev/Acme/api'));
  const st = t.edit(at('Dev/Acme/api'), '../web/src/app.ts');
  assert.equal(st.town, at('Dev/Acme/web'));
  assert.equal(st.project, 'web');
  assert.notEqual(st.building, COMMANDS, 'and walks to the folder it edits');
  assert.deepEqual(t.s.towns().map((x) => x.name), ['api', 'web']);
  assert.ok(t.emitted.some((m) => m.type === 'log' && /went from api to web/.test(m.html)));
});

test('reads and commands in another repo move the robot only after 12 s in place', () => {
  const clock = fakeClock();
  try {
    const { at, worlds } = home('Dev/Acme/api', 'Dev/Acme/web');
    const t = newTown(worlds), api = at('Dev/Acme/api'), web = at('Dev/Acme/web');
    t.prompt(api);
    t.edit(api, 'src/a.ts');
    clock.tick(1000);
    assert.equal(t.tool(api, 'Read', { file_path: path.join(web, 'README.md') }).town, api, 'a quick look stays');
    assert.equal(t.send(web, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).town, api, 'so does a quick command');
    clock.tick(12_500);
    assert.equal(t.send(web, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } }).town, web);
  } finally { clock.restore(); }
});

test('files and folders outside any repo never change the town', () => {
  const clock = fakeClock();
  try {
    const { at, worlds } = home('Dev/Acme/api');
    const outside = tmpDir('scratch'); // no .git anywhere above
    const t = newTown(worlds), api = at('Dev/Acme/api');
    t.prompt(api);
    clock.tick(13_000);
    assert.equal(t.edit(api, path.relative(api, path.join(outside, 'notes.md'))).town, api);
    assert.equal(t.send(outside, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' } }).town, api);
    assert.deepEqual(t.s.towns().map((x) => x.name), ['api']);
  } finally { clock.restore(); }
});

test('a helper goes to its own town; its parent stays', () => {
  const { at, worlds } = home('Dev/Acme/api', 'Dev/Acme/web');
  const t = newTown(worlds), api = at('Dev/Acme/api'), web = at('Dev/Acme/web');
  t.prompt(api);
  t.send(api, { hook_event_name: 'SubagentStart', agent_id: 'A1' });
  assert.equal(t.robot('s1:A1')!.town, api, 'starts where its parent is');
  const h = t.send(api, { hook_event_name: 'PreToolUse', agent_id: 'A1', tool_name: 'Edit', tool_input: { file_path: path.join(web, 'src/x.ts') } });
  assert.deepEqual([h.town, h.project], [web, 'web']);
  assert.equal(t.robot()!.town, api);
});

test('towns are grouped into worlds by folder; same-named towns in a world get their parent folder', () => {
  const repos = ['Dev/Acme/api', 'Dev/Acme/clients/web', 'Dev/Acme/tools/web', 'Dev/Blog/site', 'Dev/Blog/web'];
  const { at, worlds } = home(...repos);
  const t = newTown(worlds);
  for (const r of repos) t.prompt(at(r), r);
  assert.deepEqual(t.s.towns().map((x) => `${x.world}: ${x.name}`),
    ['Acme: api', 'Acme: clients/web', 'Acme: tools/web', 'Blog: site', 'Blog: web'], 'web is only ambiguous inside Acme');
});

test('worlds.json and a repo\'s "world" override the automatic grouping', () => {
  const { h, at, worlds } = home('Dev/Acme/api', 'Dev/Blog/site', 'work/infra');
  fs.mkdirSync(path.join(h, '.agentville'));
  fs.writeFileSync(path.join(h, '.agentville', 'worlds.json'), JSON.stringify({ worlds: { Acme: ['~/work/infra'] } }));
  fs.writeFileSync(path.join(at('Dev/Blog/site'), 'agentville.json'), JSON.stringify({ world: 'Writing' }));
  const t = newTown(worlds);
  for (const r of ['Dev/Acme/api', 'Dev/Blog/site', 'work/infra']) t.prompt(at(r), r);
  assert.deepEqual(t.s.towns().map((x) => `${x.world}: ${x.name}`), ['Acme: api', 'Acme: infra', 'Writing: site']);
});
