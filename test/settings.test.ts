// ~/.agentville/settings.json: written with the defaults the first time, read leniently after.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SettingsFile } from '../server/settings';
import { DEFAULT_SETTINGS } from '../src/settings';
import { tmpDir } from './support';

test('a missing file is written with the defaults (needs you, failures and finished turns on)', () => {
  const file = path.join(tmpDir('settings'), 'sub', 'settings.json');
  const s = new SettingsFile(file);
  assert.deepEqual(s.value, DEFAULT_SETTINGS);
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), DEFAULT_SETTINGS);
  assert.deepEqual(s.value.toasts, { needsYou: true, failed: true, finished: true, sessions: false });
});

test('what the file sets wins; missing or wrong values fall back to the defaults', () => {
  const file = path.join(tmpDir('settings'), 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ toasts: { finished: false, sessions: true, failed: 'no', extra: true }, other: 1 }));
  assert.deepEqual(new SettingsFile(file).value.toasts, { needsYou: true, failed: true, finished: false, sessions: true });
});

test('a file that does not parse is left alone and the defaults are used', () => {
  const file = path.join(tmpDir('settings'), 'settings.json');
  fs.writeFileSync(file, '{ "toasts": { "sessions": true, }');
  const errors: unknown[] = [], log = console.error;
  console.error = (...a: unknown[]) => errors.push(a);
  try { assert.deepEqual(new SettingsFile(file).value, DEFAULT_SETTINGS); } finally { console.error = log; }
  assert.equal(fs.readFileSync(file, 'utf8'), '{ "toasts": { "sessions": true, }', 'the broken file is kept for you to fix');
  assert.equal(errors.length, 1);
});
