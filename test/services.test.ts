// Town services: meaningful commands get a badge while they run and a pass/fail flag after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { activityOf } from '../server/activity';
import { newTown, tmpDir } from './support';

test('commands are recognised by kind; everyday ones are not', () => {
  const cases: [string, string | undefined][] = [
    ['npm test', 'test'], ['npx vitest run src', 'test'], ['pytest -q', 'test'], ['go test ./...', 'test'], ['npm run test -- --watch=false', 'test'],
    ['npm run build', 'build'], ['npx tsc --noEmit', 'build'], ['npm run typecheck && npm test', 'test'], ['cargo clippy', 'build'],
    ['git commit -m "fix tests"', 'git'], ['git push origin main', 'git'], ['gh pr create --fill', 'git'],
    ['npm install', 'install'], ['pip install -r requirements.txt', 'install'], ['brew install ffmpeg', 'install'],
    ['npm run dev', 'server'], ['python3 -m http.server 8000', 'server'],
    ['vercel --prod', 'deploy'], ['npm run build && firebase deploy', 'deploy'],
    ['ls -la', undefined], ['cat package.json', undefined], ['grep -rn test src', undefined], ['echo "npm test"', undefined],
    ["git commit -F - <<'EOF'\nrun npm test\nEOF", 'git'],
  ];
  for (const [cmd, kind] of cases) assert.equal(activityOf(cmd), kind, cmd);
});

test('a badge while it runs, then a pass or fail flag and a history line', () => {
  const t = newTown(), r = tmpDir('svc', { repo: true });
  t.prompt(r);
  const run = t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } });
  assert.equal(run.activity, 'test');
  const ok = t.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'b1', tool_input: { command: 'npm test' } });
  assert.equal(ok.activity, undefined);
  assert.deepEqual([ok.result.kind, ok.result.ok], ['test', true]);
  assert.equal(ok.recent[0].text, 'Tests passed');

  t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'npm run build' } });
  const bad = t.send(r, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b2', tool_input: { command: 'npm run build' } });
  assert.deepEqual([bad.result.kind, bad.result.ok], ['build', false]);
  assert.equal(bad.recent[0].text, 'Build failed');

  t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b3', tool_input: { command: 'npm test' } });
  const stopped = t.send(r, { hook_event_name: 'PostToolUseFailure', tool_name: 'Bash', tool_use_id: 'b3', is_interrupt: true });
  assert.equal(stopped.result, undefined, 'an interrupted command gets no flag');
  assert.equal(stopped.recent[0].text, 'Stopped');

  const plain = t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'b4', tool_input: { command: 'ls' } });
  assert.equal(plain.activity, undefined, 'everyday commands show nothing');
});

test('a command left running in the background lights a lamp until it is stopped', () => {
  const t = newTown(), r = tmpDir('bg', { repo: true });
  t.prompt(r);
  t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'Bash', tool_use_id: 'd1', tool_input: { command: 'npm run dev', run_in_background: true } });
  const started = t.send(r, { hook_event_name: 'PostToolUse', tool_name: 'Bash', tool_use_id: 'd1' });
  assert.deepEqual(started.background, ['server']);
  assert.equal(started.result, undefined, 'starting it is not a result');
  assert.deepEqual(t.send(r, { hook_event_name: 'Stop' }).background, ['server'], 'it keeps running after the turn ends');
  t.prompt(r);
  const off = t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'KillShell', tool_input: { shell_id: 'x' } });
  assert.equal(off.background, undefined);
});
