// One robot per session: where it walks, what it shows, its history, and odd or late events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { COMMANDS, PLAZA, ROOT, fakeClock, newTown, tmpDir } from './support';

const repo = () => tmpDir('repo', { repo: true, dirs: ['src', 'lib'] });

test('a new session walks from the plaza to the commands building on its first prompt', () => {
  const t = newTown(), r = repo();
  assert.equal(t.send(r, { hook_event_name: 'SessionStart' }).building, PLAZA);
  assert.equal(t.prompt(r).building, COMMANDS);
});

test('after finishing at the plaza, a new prompt returns the robot to its last building', () => {
  const t = newTown(), r = repo();
  t.prompt(r);
  const at = t.edit(r, 'src/a.ts').building;
  assert.equal(t.send(r, { hook_event_name: 'Stop' }).building, PLAZA);
  assert.equal(t.prompt(r).building, at);
});

test('work that touches no file goes to the commands building only after 12 s in place', () => {
  const clock = fakeClock();
  try {
    const t = newTown(), r = repo();
    t.prompt(r);
    const at = t.edit(r, 'src/a.ts').building;
    clock.tick(1000);
    assert.equal(t.tool(r, 'Bash', { command: 'ls' }).building, at, 'a quick command between edits stays put');
    clock.tick(12_500);
    assert.equal(t.tool(r, 'Bash', { command: 'ls' }).building, COMMANDS);
    assert.notEqual(t.edit(r, 'lib/b.ts').building, COMMANDS, 'an edit always moves at once');
    assert.equal(t.edit(r, 'README.md').building, ROOT);
  } finally { clock.restore(); }
});

test('from the plaza, file-less work goes to the commands building at once', () => {
  for (const [name, input] of [['Bash', { command: 'ls' }], ['mcp__Claude_Browser__navigate', { url: 'http://localhost:3000' }]] as const) {
    const t = newTown(), r = repo();
    t.prompt(r); t.edit(r, 'src/a.ts'); t.send(r, { hook_event_name: 'Stop' });
    assert.equal(t.tool(r, name, input).building, COMMANDS, name);
  }
});

test('planning and other bookkeeping tools never move the robot', () => {
  const clock = fakeClock();
  try {
    const tools: [string, Record<string, unknown>][] = [
      ['mcp__ccd_turn__update_plan', { items: [{ content: 'x', status: 'in_progress' }] }], ['mcp__ccd_turn__wrap_up', { recap: 'r' }],
      ['TodoWrite', { todos: [{ content: 'x', activeForm: 'Doing x', status: 'in_progress' }] }], ['ToolSearch', { query: 'q' }],
      ['Agent', { description: 'd', prompt: 'p' }], ['Task', { description: 'd', prompt: 'p' }], ['AskUserQuestion', {}],
    ];
    for (const where of ['plaza', 'folder', 'folder after 13 s']) for (const [name, input] of tools) {
      const t = newTown(), r = repo();
      t.send(r, { hook_event_name: 'SessionStart' });
      if (where !== 'plaza') t.edit(r, 'src/a.ts');
      if (where === 'folder after 13 s') clock.tick(13_000);
      const before = t.robot()!.building;
      assert.equal(t.tool(r, name, input).building, before, `${name} at ${where}`);
    }
  } finally { clock.restore(); }
});

test('history: requests, tasks, needs-you, failures and finishing, newest first, at most 8', () => {
  const t = newTown(), r = repo();
  t.prompt(r);
  t.tool(r, 'Read', { file_path: path.join(r, 'src/login.ts') });
  t.tool(r, 'Read', { file_path: path.join(r, 'src/login.ts') }); // same text: not repeated
  t.tool(r, 'Bash', { command: 'npm test', description: 'Run the unit tests' });
  t.send(r, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  t.send(r, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'needs permission' });
  t.send(r, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash' });
  const st = t.send(r, { hook_event_name: 'Stop' });
  assert.deepEqual(st.recent.map((x: any) => x.text).reverse(),
    ['New request', 'Reading login.ts', 'Run the unit tests', 'Needs you: Wants to use Bash', 'Tests failed', 'Finished']);
  for (let i = 0; i < 12; i++) t.tool(r, 'Bash', { command: 'x', description: `Step ${i}` });
  const last = t.robot()!;
  assert.equal(last.recent!.length, 8);
  assert.equal(last.recent![0].text, 'Step 11');
});

test('a denied permission is recorded and the robot carries on', () => {
  const t = newTown(), r = repo();
  t.prompt(r);
  assert.equal(t.send(r, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' }).status, 'waiting');
  const st = t.send(r, { hook_event_name: 'PermissionDenied', tool_name: 'Bash' });
  assert.equal(st.status, 'working');
  assert.equal(st.recent[0].text, 'Not allowed: Bash');
});

test('one needs-you alert per wait', () => {
  const t = newTown(), r = repo();
  const needs = () => t.emitted.filter((m) => m.type === 'needs').map((m) => m.state.task);
  t.prompt(r);
  t.send(r, { hook_event_name: 'PermissionRequest', tool_name: 'Bash' });
  t.send(r, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission' });
  assert.deepEqual(needs(), ['Wants to use Bash'], 'a request and its notification are one wait');
  t.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  t.send(r, { hook_event_name: 'Stop' });
  t.send(r, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.deepEqual(needs(), ['Wants to use Bash', 'Waiting for your reply']);
});

test("the project comes from the session's start folder in its transcript (only under the Claude folder)", (t) => {
  const config = tmpDir('claude-config');
  const started = repo(), elsewhere = tmpDir('elsewhere');
  const transcript = path.join(config, 'projects', 'x', 'session.jsonl');
  fs.mkdirSync(path.dirname(transcript), { recursive: true });
  fs.writeFileSync(transcript, JSON.stringify({ type: 'user', cwd: started }) + '\n');
  const outside = path.join(elsewhere, 'session.jsonl');
  fs.copyFileSync(transcript, outside);
  const old = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = config;
  t.after(() => { if (old === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = old; });

  const town = newTown();
  const a = town.send(elsewhere, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: transcript }, 'a');
  assert.equal(a.project, path.basename(started), 'first event came from another folder');
  const b = town.send(elsewhere, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_input: { command: 'ls' }, transcript_path: outside }, 'b');
  assert.equal(b.project, path.basename(elsewhere), 'a transcript outside the Claude folder is not read');
});

test('late or stray events do not bring robots back', () => {
  const t = newTown(), r = repo();
  t.prompt(r);
  t.send(r, { hook_event_name: 'SessionEnd' });
  t.send(r, { hook_event_name: 'SubagentStop', agent_id: 'A1' });
  t.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Bash' });
  assert.deepEqual(t.robots(), [], 'ended session stays gone');
  t.send(r, { hook_event_name: 'Stop' }, 'other');
  assert.deepEqual(t.robots(), [], 'a stray Stop does not start a robot');
  t.prompt(r);
  assert.equal(t.robots().length, 1, 'a new prompt resumes the session');
});

test('odd field types do not throw', () => {
  const t = newTown(), r = repo();
  assert.doesNotThrow(() => t.send(r, { hook_event_name: 'UserPromptSubmit', prompt: 42 }));
  assert.doesNotThrow(() => t.tool(r, 'mcp__x__y', { path: ['a'] }));
  assert.doesNotThrow(() => t.tool(r, 'Edit', { file_path: { not: 'a string' } }));
  assert.doesNotThrow(() => t.send(r, { hook_event_name: 'Notification', message: 7 }));
});
