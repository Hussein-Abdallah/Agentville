// Agentville's token and the limits on events.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type http from 'node:http';
import { Auth } from '../server/auth';
import { RateLimit } from '../server/limits';
import { newTown, tmpDir } from './support';

const req = (headers: Record<string, string>, url = '/') => ({ headers, url }) as unknown as http.IncomingMessage;

test('the token is made once, kept across restarts, and readable only by you', () => {
  const dir = path.join(tmpDir('home'), '.agentville');
  const a = new Auth(dir);
  assert.match(a.token, /^[0-9a-f]{48}$/);
  assert.equal(new Auth(dir).token, a.token, 'same token after a restart');
  // macOS and Linux: only you can read them (mode 600). Windows has no mode bits: files in your user
  // folder are already yours alone, through its own access lists.
  if (process.platform !== 'win32') {
    assert.equal(fs.statSync(path.join(dir, 'token')).mode & 0o777, 0o600);
    assert.equal(fs.statSync(a.headerFile).mode & 0o777, 0o600);
  }
  assert.equal(fs.readFileSync(a.headerFile, 'utf8'), `X-Agentville-Token: ${a.token}\n`, 'what curl -H @file sends');
  const renewed = new Auth(dir, true);
  assert.notEqual(renewed.token, a.token);
  assert.equal(fs.readFileSync(renewed.headerFile, 'utf8'), `X-Agentville-Token: ${renewed.token}\n`, 'the hooks pick up a new token at once');
});

test('a broken token file gets a new token', () => {
  const dir = path.join(tmpDir('home'), '.agentville');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'token'), 'not a token');
  assert.match(new Auth(dir).token, /^[0-9a-f]{48}$/);
});

test('requests carry the token in the hooks\' header, the page\'s cookie or ?token=', () => {
  const a = new Auth(path.join(tmpDir('home'), '.agentville'));
  assert.equal(a.allows(req({ 'x-agentville-token': a.token })), true);
  assert.equal(a.allows(req({ cookie: `theme=dark; agentville_token=${a.token}` })), true);
  assert.equal(a.allows(req({}, `/ws?token=${a.token}`)), true);
  assert.equal(a.allows(req({})), false);
  assert.equal(a.allows(req({ 'x-agentville-token': a.token.slice(0, -1) + (a.token.endsWith('0') ? '1' : '0') })), false);
  assert.equal(a.allows(req({ cookie: 'agentville_token=' })), false);
  assert.match(a.cookie(), /HttpOnly; SameSite=Strict/);
  assert.equal(a.link(4917), `http://localhost:4917/?token=${a.token}`);
});

test('rate limit: a burst, then a steady rate per session; other sessions are not held back', () => {
  let t = 0;
  const r = new RateLimit(5, 2, 3, () => t);
  for (let i = 0; i < 5; i++) assert.equal(r.take('a'), true);
  assert.equal(r.take('a'), false, 'burst used up');
  assert.equal(r.take('b'), true, 'another session still goes through');
  t += 1000;
  assert.equal(r.take('a'), true);
  assert.equal(r.take('a'), true);
  assert.equal(r.take('a'), false, 'two a second');
});

test('rate limit: all sessions together are capped too', () => {
  const r = new RateLimit(2, 1, 2, () => 0);
  const ok = ['a', 'a', 'b', 'b', 'c'].map((s) => r.take(s));
  assert.deepEqual(ok, [true, true, true, true, false]);
});

test('at most 100 robots at once; more sessions are ignored until some end', () => {
  const t = newTown(), r = tmpDir('repo', { repo: true });
  for (let i = 0; i < 105; i++) t.prompt(r, `s${i}`);
  assert.equal(t.s.snapshot().length, 100);
  t.send(r, { hook_event_name: 'SessionEnd' }, 's0');
  t.prompt(r, 's104');
  assert.ok(t.robot('s104'), 'room again after one ended');
});
