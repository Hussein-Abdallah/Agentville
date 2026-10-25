// What a waiting robot waits for: the question, the command, the file, or the end of Claude's last reply.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { lastWords, waitingFor } from '../server/friendly';
import { newTown, tmpDir } from './support';

test('a permission request says exactly what it wants, and the notice after it keeps that', () => {
  const t = newTown(), r = tmpDir('wait', { repo: true });
  t.prompt(r);
  const asked = t.send(r, { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command: 'npm test', description: 'Run the unit tests' } });
  assert.deepEqual([asked.status, asked.task, asked.ask], ['waiting', 'Wants to run a command', 'Run the unit tests: npm test']);
  const notice = t.send(r, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use Bash' });
  assert.deepEqual([notice.task, notice.ask], ['Wants to run a command', 'Run the unit tests: npm test']);
  const on = t.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_input: { command: 'npm test' } });
  assert.equal(on.ask, undefined, 'answered: nothing to show');
});

test('a notice without a request before it still names the tool', () => {
  const t = newTown(), r = tmpDir('wait', { repo: true });
  t.prompt(r);
  const n = t.send(r, { hook_event_name: 'Notification', notification_type: 'permission_prompt', message: 'Claude needs your permission to use WebFetch' });
  assert.deepEqual([n.status, n.task], ['waiting', 'Wants to open a web page']);
});

test('waiting for your reply shows the end of what Claude last said', () => {
  const t = newTown(), r = tmpDir('wait', { repo: true });
  t.prompt(r);
  t.send(r, { hook_event_name: 'Stop', last_assistant_message: 'I fixed the **login** form.\n\n```ts\nconst x = 1;\n```\n\nShould I also push it? Or wait for review.' });
  const w = t.send(r, { hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  assert.deepEqual([w.status, w.task, w.ask], ['waiting', 'Waiting for your reply', 'Should I also push it?']);
  assert.equal(t.prompt(r).ask, undefined);
});

test('wording per tool', () => {
  assert.deepEqual(waitingFor({ tool_name: 'AskUserQuestion', tool_input: { questions: [{ question: 'Which colour?' }, { question: 'Ship today?' }] } }),
    { task: 'Has 2 questions', ask: 'Which colour? · Ship today?' });
  assert.deepEqual(waitingFor({ tool_name: 'Edit', tool_input: { file_path: '/repo/src/auth/session.ts' } }), { task: 'Wants to edit a file', ask: 'auth/session.ts' });
  assert.deepEqual(waitingFor({ tool_name: 'ExitPlanMode', tool_input: { plan: '\n# Move billing\n1. …' } }), { task: 'Wants you to approve a plan', ask: 'Move billing' });
  assert.equal(waitingFor({ tool_name: 'mcp__github__create_issue', tool_input: {} }).task, 'Wants to use github');
  assert.equal(lastWords('All done. The tests pass.'), 'All done. The tests pass.');
  assert.equal(lastWords(undefined), undefined);
});
