// Helper robots: one per subagent, keyed by the agent_id its hook events carry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { COMMANDS, PLAZA, fakeClock, newTown, tmpDir } from './support';

const repo = () => tmpDir('helpers', { repo: true, dirs: ['src', 'docs'] });
const agentCall = (id: string, description: string, subagent_type = 'general-purpose') =>
  ({ hook_event_name: 'PreToolUse', tool_name: 'Agent', tool_use_id: id, tool_input: { description, subagent_type } });

test('background subagents get their own robots and work on their own', () => {
  const t = newTown(), r = repo();
  t.prompt(r);
  // two background Agent calls; each returns right away, before its subagent's first event
  t.send(r, agentCall('u1', 'Test new session logic'));
  t.send(r, agentCall('u2', 'Update docs for new behaviour'));
  t.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'u2' });
  t.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Agent', tool_use_id: 'u1' });
  assert.equal(t.robots().length, 1, 'no helper until the subagent starts; the Agent call returning removes nothing');
  const parentAt = t.robot()!.building;

  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A1', agent_type: 'general-purpose' });
  const h2 = t.send(r, { hook_event_name: 'PreToolUse', agent_id: 'A2', tool_name: 'Edit', tool_input: { file_path: path.join(r, 'docs/README.md') } });
  assert.equal(t.robot('s1:A1')!.title, 'Test new session logic');
  assert.equal(h2.title, 'Update docs for new behaviour');
  assert.equal(h2.name, 'Atlas·3');
  assert.equal(h2.task, 'Editing the README');
  assert.notEqual(h2.building, COMMANDS);
  assert.equal(t.robot()!.building, parentAt, "the parent isn't moved by its helpers' work");

  const h1 = t.send(r, { hook_event_name: 'PreToolUse', agent_id: 'A1', tool_name: 'Bash', tool_input: { command: 'npx tsx t.ts', description: 'Run the scenario tests' } });
  assert.deepEqual([h1.building, h1.task], [COMMANDS, 'Run the scenario tests']);

  t.send(r, { hook_event_name: 'Stop' });
  assert.equal(t.robot()!.building, PLAZA);
  assert.equal(t.robots().length, 3, "helpers outlive the parent's Stop");

  assert.equal(t.send(r, { hook_event_name: 'PermissionRequest', agent_id: 'A1', tool_name: 'Bash' }).status, 'waiting', 'a helper can need you');
  const f = t.send(r, { hook_event_name: 'PostToolUseFailure', agent_id: 'A1', tool_name: 'Bash' });
  assert.deepEqual([f.status, f.recent[0].text], ['working', 'Failed: Run the scenario tests']);

  assert.deepEqual(t.send(r, { hook_event_name: 'SubagentStop', agent_id: 'A2' }), { removed: 's1:A2' });
  assert.equal(t.robots().length, 2);
  t.send(r, { hook_event_name: 'SubagentStop' });
  assert.equal(t.robots().length, 1, 'SubagentStop without an agent_id ends the oldest helper');
});

test('a failed Agent call leaves no name behind', () => {
  const t = newTown(), r = repo();
  t.prompt(r);
  t.send(r, agentCall('u1', 'Bad call', 'nope'));
  t.send(r, { hook_event_name: 'PostToolUseFailure', tool_name: 'Agent', tool_use_id: 'u1' });
  t.send(r, agentCall('u2', 'Good call'));
  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A2', agent_type: 'general-purpose' });
  assert.equal(t.robot('s1:A2')!.title, 'Good call');
});

test('a subagent that starts before its Agent call arrives is named when it does', () => {
  const t = newTown(), r = repo();
  t.prompt(r);
  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A1', agent_type: 'Explore' });
  t.send(r, agentCall('u1', 'First', 'Explore'));
  t.send(r, agentCall('u2', 'Second'));
  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A2', agent_type: 'general-purpose' });
  assert.deepEqual([t.robot('s1:A1')!.title, t.robot('s1:A2')!.title], ['First', 'Second']);
});

test('subagents of different types that start out of order keep their own names', () => {
  const t = newTown(), r = repo();
  t.send(r, agentCall('u1', 'Explore stuff', 'Explore'));
  t.send(r, agentCall('u2', 'Plan stuff', 'Plan'));
  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'B', agent_type: 'Plan' });
  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A', agent_type: 'Explore' });
  assert.deepEqual([t.robot('s1:A')!.title, t.robot('s1:B')!.title], ['Explore stuff', 'Plan stuff']);
});

test('late events from a stopped subagent are dropped', () => {
  const t = newTown(), r = repo();
  t.send(r, agentCall('u1', 'One'));
  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A1' });
  t.send(r, { hook_event_name: 'SubagentStop', agent_id: 'A1' });
  t.send(r, agentCall('u2', 'Two'));
  assert.equal(t.send(r, { hook_event_name: 'PostToolUse', agent_id: 'A1', tool_name: 'Bash' }), undefined);
  assert.equal(t.robot('s1:A1'), undefined, 'no ghost helper');
  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A2' });
  assert.equal(t.robot('s1:A2')!.title, 'Two', 'and the next helper still gets its name');
});

test('quiet helpers leave after 10 minutes, but not while they wait for you', () => {
  const clock = fakeClock();
  try {
    const t = newTown(), r = repo();
    t.send(r, agentCall('u1', 'Waits'));
    t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A1' });
    t.send(r, { hook_event_name: 'PermissionRequest', agent_id: 'A1', tool_name: 'Bash' });
    t.send(r, agentCall('u2', 'Quiet'));
    t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A2' });
    clock.tick(11 * 60_000);
    (t.s as any).sweep();
    assert.ok(t.robot('s1:A1'), 'waiting helper stays');
    assert.equal(t.robot('s1:A2'), undefined, 'quiet helper is gone');
  } finally { clock.restore(); }
});

test("an Agent call whose subagent never starts doesn't name a later helper", () => {
  const clock = fakeClock();
  try {
    const t = newTown(), r = repo();
    t.send(r, agentCall('u1', 'Never starts'));
    t.send(r, { hook_event_name: 'Stop' });
    clock.tick(2 * 60_000);
    t.prompt(r);
    t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'A9' });
    assert.equal(t.robot('s1:A9')!.title, undefined);
    assert.equal(t.robot('s1:A9')!.task, 'Helping out');
  } finally { clock.restore(); }
});
