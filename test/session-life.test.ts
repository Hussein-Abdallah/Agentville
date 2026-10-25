// A session's life around the service: its last prompt and reply, your name for it, what it left
// running in the background, and coming back as itself after the service restarts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newTown, tmpDir } from './support';

test('the last prompt and how Claude answered, as plain text', () => {
  const t = newTown(), r = tmpDir('talk', { repo: true });
  t.send(r, { hook_event_name: 'UserPromptSubmit', prompt: 'Fix   the **login** form' });
  assert.deepEqual([t.robot()!.lastPrompt, t.robot()!.lastReply], ['Fix the login form', undefined]);
  const done = t.send(r, { hook_event_name: 'Stop', last_assistant_message: '## Done\n\nFixed it:\n\n```ts\nx()\n```\n\nSee [the test](a.ts).' });
  assert.equal(done.lastReply, 'Done Fixed it: [code] See the test.');
  assert.equal(t.send(r, { hook_event_name: 'UserPromptSubmit', prompt: 'Thanks, now push' }).lastReply, undefined, 'a new prompt: the old reply goes');
});

test('a robot you rename keeps its name, and so do its helpers', () => {
  const t = newTown(), r = tmpDir('name', { repo: true });
  t.prompt(r);
  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
  assert.equal(t.s.rename('s1', '  Nova <b> '), true);
  assert.equal(t.robot()!.name, 'Nova b', 'trimmed, no markup');
  assert.match(t.s.snapshot().find((a) => a.parentId)!.name, /^Nova b·\d+$/);
  assert.equal(t.s.rename('s1', '   '), false, 'an empty name is ignored');
  assert.equal(t.s.rename('nope', 'X'), false);
});

test('the list of what is still running when a turn ends replaces the guesses', () => {
  const t = newTown(), r = tmpDir('bg', { repo: true });
  t.prompt(r);
  t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'sleep 100', run_in_background: true } });
  const left = t.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_response: { backgroundTaskId: 'sh1' } });
  assert.deepEqual(left.background, [{ type: 'shell', id: 'sh1', kind: undefined, text: 'sleep 100' }], 'any background command lights the lamp');
  const end = t.send(r, { hook_event_name: 'Stop', background_tasks: [
    { id: 'sh2', type: 'shell', status: 'running', description: 'Start the dev server', command: 'npm run dev' },
    { id: 'ag1', type: 'subagent', status: 'running', description: 'Review the diff', agent_type: 'general-purpose' },
    { id: 'old', type: 'shell', status: 'completed', command: 'ls' },
  ] });
  assert.deepEqual(end.background, [
    { type: 'shell', id: 'sh2', kind: 'server', text: 'Start the dev server' },
    { type: 'agent', id: 'ag1', text: 'Review the diff' },
  ]);
  t.prompt(r);
  const stopped = t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'TaskStop', tool_input: { task_id: 'ag1' } });
  assert.deepEqual(stopped.background?.map((b: any) => b.id), ['sh2'], 'stopping one by id leaves the others');
  assert.equal(t.send(r, { hook_event_name: 'Stop', background_tasks: [] }).background, undefined);
});

test('after a restart a running session comes back as itself on its next event', () => {
  const home = tmpDir('home'), r = tmpDir('back', { repo: true, dirs: ['src'] });
  const before = newTown(undefined, home);
  before.send(r, { hook_event_name: 'UserPromptSubmit', prompt: 'Speed up the search page' });
  before.edit(r, 'src/search.ts');
  before.s.rename('s1', 'Nova');
  const was = before.robot()!;
  assert.ok(fs.existsSync(path.join(home, '.agentville', 'sessions.json')));

  const after = newTown(undefined, home); // the service restarted: it knows nobody yet
  assert.equal(after.robot(), undefined);
  const back = after.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(r, 'src/search.ts') } });
  assert.ok(back, 'a PostToolUse brings back a session it knew');
  assert.deepEqual([back.name, back.color, back.title, back.building, back.startedAt, back.lastPrompt],
    ['Nova', was.color, 'Speed up the search page', was.building, was.startedAt, 'Speed up the search page']);
  assert.equal(after.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Edit' }, 'stranger'), undefined, 'one it never knew still waits for a real start');
});

test('a session first seen mid-way takes its title and last prompt from its transcript', () => {
  const claude = tmpDir('claude'), r = tmpDir('mid', { repo: true });
  const file = path.join(claude, 'projects', 'p', 'abc.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    { type: 'user', message: { content: 'hello' } },
    { type: 'custom-title', customTitle: 'Old title' },
    { type: 'last-prompt', lastPrompt: 'First question' },
    { type: 'custom-title', customTitle: 'Search page speed' },
    { type: 'last-prompt', lastPrompt: 'Make the **search** faster' },
  ].map((o) => JSON.stringify(o)).join('\n') + '\n');
  const was = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = claude;
  try {
    const t = newTown();
    const a = t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'Read', transcript_path: file, tool_input: {} }, 'abc');
    assert.deepEqual([a.title, a.lastPrompt], ['Search page speed', 'Make the search faster']);
  } finally {
    if (was === undefined) delete process.env.CLAUDE_CONFIG_DIR; else process.env.CLAUDE_CONFIG_DIR = was;
  }
});
