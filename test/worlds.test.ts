// Worlds: which world (project) each town (repo root) belongs to.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { Worlds } from '../server/worlds';
import { tmpDir } from './support';

/** A fake home folder with the given repo roots (each gets a .git folder). */
function home(...repos: string[]) {
  const h = tmpDir('worlds-home');
  for (const r of repos) fs.mkdirSync(path.join(h, r, '.git'), { recursive: true });
  const configFile = path.join(h, '.agentville', 'worlds.json');
  const w = new Worlds({ home: h, configFile, claudeDir: path.join(h, '.claude') });
  const at = (r: string) => path.join(h, r);
  /** Write worlds.json; each write gets a later mtime so it is seen as changed. */
  let bump = 0;
  const config = (data: unknown) => {
    fs.mkdirSync(path.dirname(configFile), { recursive: true });
    fs.writeFileSync(configFile, typeof data === 'string' ? data : JSON.stringify(data));
    const t = Date.now() / 1000 + 10 * ++bump;
    fs.utimesSync(configFile, t, t);
  };
  return { h, w, at, config, learn: (...rs: string[]) => rs.forEach((r) => w.addRepo(at(r))) };
}

test('repos are grouped by the first folder below the dev folder', () => {
  const { w, at, learn } = home('Dev/Acme/api', 'Dev/Acme/clients/web', 'Dev/Blog/site');
  learn('Dev/Acme/api', 'Dev/Acme/clients/web', 'Dev/Blog/site');
  assert.deepEqual(['Dev/Acme/api', 'Dev/Acme/clients/web', 'Dev/Blog/site'].map((r) => w.worldOf(at(r))), ['Acme', 'Acme', 'Blog']);
});

test('a single repo is its own world, named after its folder', () => {
  const { h, w, at, learn } = home('Dev/Agentville');
  learn('Dev/Agentville');
  assert.equal(w.worldOf(at('Dev/Agentville')), 'Agentville');
  assert.equal(new Worlds({ home: h, configFile: at('none.json') }).worldOf(at('Dev/Agentville')), 'Agentville', 'even when not learned');
});

test('repos in different top-level folders are grouped separately', () => {
  const { w, at, learn } = home('Dev/Acme/api', 'work/infra');
  learn('Dev/Acme/api', 'work/infra');
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'api', 'the only repo under Dev: its dev folder is Dev/Acme');
  assert.equal(w.worldOf(at('work/infra')), 'infra');
});

test('"root" in worlds.json sets the dev folder', () => {
  const { w, at, learn, config } = home('Dev/Acme/api', 'Dev/Blog', 'work/infra');
  learn('Dev/Acme/api');
  config({ root: '~/Dev' });
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'Acme');
  assert.equal(w.worldOf(at('Dev/Blog')), 'Blog', 'directly in the root: its own name');
  assert.equal(w.worldOf(at('work/infra')), 'infra', 'outside the root: automatic');
});

test('"worlds" patterns: exact paths, /** folders, first match wins', () => {
  const { h, w, at, learn, config } = home('Dev/Acme/api', 'Dev/Acme/web', 'Dev/Acme', 'work/acme-infra', 'Dev/Blog/site');
  learn('Dev/Acme/api', 'Dev/Acme/web', 'Dev/Blog/site');
  config({ worlds: { Web: [at('Dev/Acme/web')], Acme: ['~/Dev/Acme/**', '~/work/acme-infra'], Everything: [`${h}/**`] } });
  assert.equal(w.worldOf(at('Dev/Acme/web')), 'Web', 'an earlier world wins');
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'Acme');
  assert.equal(w.worldOf(at('work/acme-infra')), 'Acme', 'exact path');
  assert.equal(w.worldOf(at('Dev/Acme')), 'Everything', '/** does not match the folder itself');
  assert.equal(w.worldOf(at('Dev/Blog/site')), 'Everything');
  config({ worlds: { Acme: ['~/Dev/Acme/**'] } });
  assert.equal(w.worldOf(at('Dev/Blog/site')), 'Blog', 'no match: automatic');
});

test('precedence: worlds.json, then the repo\'s agentville.json, then folders', () => {
  const { w, at, learn, config } = home('Dev/Acme/api', 'Dev/Blog/site');
  learn('Dev/Acme/api', 'Dev/Blog/site');
  config({ worlds: { Mine: ['~/Dev/Acme/api'] } });
  assert.equal(w.worldOf(at('Dev/Acme/api'), 'Theirs'), 'Mine');
  assert.equal(w.worldOf(at('Dev/Blog/site'), 'Theirs'), 'Theirs');
  assert.equal(w.worldOf(at('Dev/Blog/site'), ' '), 'Blog', 'a blank world is ignored');
  assert.equal(w.worldOf(at('Dev/Blog/site')), 'Blog');
});

test('worlds.json is reloaded when it changes', () => {
  const { w, at, config } = home('Dev/Acme/api');
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'api', 'no file: no overrides');
  config({ worlds: { A: ['~/Dev/Acme/api'] } });
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'A');
  config({ worlds: { B: ['~/Dev/Acme/api'] } }); // same size: only the mtime changed
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'B');
});

test('bad worlds.json: reported once per change, bad parts ignored', (t) => {
  const err = t.mock.method(console, 'error', () => {});
  const { w, at, config } = home('Dev/Acme/api');
  config('{ not json');
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'api');
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'api');
  assert.equal(err.mock.callCount(), 1);
  config({ root: 5, worlds: { Bad: '~/Dev/Acme/api', Good: ['relative/path', 7, '~/Dev/Acme/api'] } });
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'Good');
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'Good');
  assert.equal(err.mock.callCount(), 2);
  config([1, 2]);
  assert.equal(w.worldOf(at('Dev/Acme/api')), 'api');
  assert.equal(err.mock.callCount(), 3);
});

test('repos in temp folders (outside home) and the Claude folder are not learned', () => {
  const { w, at, learn } = home('.claude/a/b/r1', '.claude/c/r2');
  learn('.claude/c/r2');
  assert.equal(w.worldOf(at('.claude/a/b/r1')), 'r1', 'r2 was not learned (else the world would be "a")');
  const tmp = tmpDir('worlds-tmp', { dirs: ['a/r1/.git', 'b/r2/.git'] });
  w.addRepo(path.join(tmp, 'b/r2'));
  assert.equal(w.worldOf(path.join(tmp, 'a/r1')), 'r1', 'r2 was not learned (else the world would be "a")');
});

test('seedFromClaudeHistory learns repos from the newest transcript of each project', async () => {
  const { h, w, at } = home('Dev/Acme/api', 'Dev/Blog/site', 'Dev/Old/x', 'Dev/Far/r', 'Dev/Boom/r');
  fs.mkdirSync(at('notes'));
  fs.mkdirSync(at('Dev/Acme/api/src'));
  const projects = at('.claude/projects');
  const transcript = (dir: string, file: string, lines: unknown[], mtime?: number) => {
    fs.mkdirSync(path.join(projects, dir), { recursive: true });
    const f = path.join(projects, dir, file);
    fs.writeFileSync(f, lines.map((l) => (typeof l === 'string' ? l : JSON.stringify(l))).join('\n') + '\n');
    if (mtime) fs.utimesSync(f, mtime, mtime);
    return f;
  };
  const now = Date.now() / 1000;
  transcript('p1', 'old.jsonl', [{ cwd: at('Dev/Old/x') }], now - 1000);
  transcript('p1', 'new.jsonl', [{ type: 'summary', text: 'no cwd here' }, { cwd: at('Dev/Acme/api/src') }, { cwd: at('notes') }], now);
  transcript('p2', 's.jsonl', [{ cwd: at('notes') }]); // not in a repo
  transcript('p3', 's.jsonl', ['\u0000\u0001 garbage {"cwd": 12', '{"cwd": "relative"}']);
  transcript('p4', 's.jsonl', [{ text: 'x'.repeat(70_000) }, { cwd: at('Dev/Far/r') }]); // past the first 64 KB
  transcript('p5', 's.jsonl', [{ cwd: at('Dev/Boom/r') }]); // gitRoot throws
  fs.chmodSync(transcript('p6', 's.jsonl', [{ cwd: at('gone') }]), 0o000); // unreadable
  fs.writeFileSync(path.join(projects, 'stray.jsonl'), '{}');
  fs.mkdirSync(path.join(projects, 'empty'));

  const asked: string[] = [];
  const gitRoot = (dir: string) => {
    asked.push(dir);
    if (dir.includes('Boom')) throw new Error('git failed');
    for (let d = dir; d.startsWith(h); d = path.dirname(d)) if (fs.existsSync(path.join(d, '.git'))) return d;
    return undefined;
  };
  assert.equal(await w.seedFromClaudeHistory(gitRoot), 1);
  assert.ok(!asked.includes(at('Dev/Old/x')), 'only the newest transcript is read');
  assert.ok(asked.includes(at('notes')), 'a cwd outside any repo adds nothing');
  assert.equal(w.worldOf(at('Dev/Blog/site')), 'Blog', 'Dev/Acme/api was learned (else the world would be "site")');
  assert.equal(await w.seedFromClaudeHistory(gitRoot), 0, 'already known');
  assert.equal(await new Worlds({ home: h, claudeDir: at('missing'), configFile: at('none.json') }).seedFromClaudeHistory(gitRoot), 0);
});
