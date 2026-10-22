// Needs-you alerts (milestone 6): who shows the notification, the sound, the quiet period.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { Alerts } from '../server/notify';
import type { AgentState } from '../src/types';

const mac = process.platform === 'darwin';
const waiting = (id: string, extra: Partial<AgentState> = {}): AgentState =>
  ({ id, name: 'Atlas', color: 'orange', building: 'church', status: 'waiting', task: 'Wants to use Bash', ...extra });

function recorder() {
  const calls: string[][] = [];
  return { calls, alerts: new Alerts(true, (cmd, args) => calls.push([cmd, ...args])) };
}

test('no page can notify: the service plays the sound and sends a macOS notification', { skip: !mac && 'macOS only' }, () => {
  const { calls, alerts } = recorder();
  assert.equal(alerts.needs(waiting('s1', { title: 'Fix "login" \\ bug\nnow' }), 'app', false), 'mac');
  assert.deepEqual(calls.map((c) => c[0]), ['afplay', 'osascript']);
  // the AppleScript must parse, and the subtitle must survive quotes, backslashes and newlines
  const subtitle = calls[1][2].match(/subtitle (".*")$/)![1];
  assert.equal(execFileSync('osascript', ['-e', `return ${subtitle}`], { encoding: 'utf8' }).trim(), 'app · Fix "login" \\ bug now');
});

test('a page that may notify shows it; the service only plays the sound', { skip: !mac && 'macOS only' }, () => {
  const { calls, alerts } = recorder();
  assert.equal(alerts.needs(waiting('s1'), 'app', true), 'page');
  assert.deepEqual(calls.map((c) => c[0]), ['afplay']);
});

test('one alert per robot every 15 s; again after it ends; none when switched off', () => {
  const { alerts } = recorder();
  assert.equal(alerts.needs(waiting('s1'), 'app', true), 'page');
  assert.equal(alerts.needs(waiting('s1'), 'app', true), undefined, 'same robot within 15 s: quiet');
  assert.equal(alerts.needs(waiting('s2'), 'app', true), 'page', 'another robot is separate');
  alerts.forget('s1');
  assert.equal(alerts.needs(waiting('s1'), 'app', true), 'page');
  alerts.on = false;
  assert.equal(alerts.needs(waiting('s3'), 'app', true), undefined);
});
