// Hook debugging's switch and its log.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { debugUntil, setDebug, HookDebug } from '../server/debug';
import { tmpDir } from './support';

test('hook debugging turns on for a while, then off by itself', () => {
  const d = tmpDir('dbg'), file = path.join(d, 'debug-hooks');
  assert.equal(debugUntil(file), undefined, 'off when there is no file');
  setDebug(30, file);
  const until = debugUntil(file)!;
  assert.ok(until > Date.now() + 29 * 60_000 && until <= Date.now() + 30 * 60_000);
  assert.equal(debugUntil(file, until + 1), undefined, 'over once the time is up');
  setDebug(0, file);
  assert.ok(!fs.existsSync(file));
});

test('while on, events are written in full with long strings cut', async () => {
  const d = tmpDir('dbg'), file = path.join(d, 'flag'), logs = path.join(d, 'logs');
  setDebug(5, file);
  const dbg = new HookDebug(logs, file);
  assert.ok(dbg.on);
  const log = console.log; console.log = () => {};
  try { dbg.write({ hook_event_name: 'PreToolUse', session_id: 'abc', tool_input: { content: 'x'.repeat(5000) } }, { ok: 1 }); } finally { console.log = log; }
  await new Promise((r) => setTimeout(r, 50));
  const [f] = fs.readdirSync(logs);
  assert.match(f, /^hooks-debug-\d{4}-\d{2}-\d{2}\.jsonl$/);
  const line = JSON.parse(fs.readFileSync(path.join(logs, f), 'utf8'));
  assert.equal(line.event.hook_event_name, 'PreToolUse');
  assert.match(line.event.tool_input.content, /…\(\+1000\)$/);
});
