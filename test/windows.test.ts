// The Windows side, testable anywhere: the headers its hook sends, which window Go to session picks, and
// Windows paths in the friendly text. (CI runs the whole suite on Windows too.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { appName, focusHost, hostFrom } from '../server/focus';
import { friendlyTask, waitingFor } from '../server/friendly';
import { openUrl } from '../server/open';
import { tmpDir } from './support';

test('Windows sessions are told apart by entry point and Windows Terminal', () => {
  assert.equal(appName(hostFrom(undefined, undefined, undefined, 'claude-desktop')), 'Claude');
  assert.equal(appName(hostFrom(undefined, undefined, undefined, 'claude-vscode')), 'VS Code');
  assert.equal(appName(hostFrom(undefined, 'vscode', undefined, 'cli')), 'VS Code');
  assert.equal(appName(hostFrom(undefined, undefined, undefined, 'cli', '1')), 'Windows Terminal');
  assert.equal(appName(hostFrom(undefined, undefined, undefined, 'cli')), undefined, 'a plain console: no button');
  assert.equal(hostFrom(undefined, undefined, undefined, 'bad entry; rm').entry, undefined, 'odd values are dropped');
});

test('Go to session on Windows: that app\'s window with the folder in its title, values as variables', async () => {
  const runs: Record<string, string>[] = [];
  const ps = async (_script: string, env: Record<string, string>) => { runs.push(env); return true; };
  const appData = tmpDir('appdata'), repo = tmpDir('My Repo', { repo: true });
  assert.ok(await focusHost(hostFrom(undefined, 'vscode', undefined, 'cli'), repo, undefined, appData, 'win32', ps));
  assert.deepEqual(runs[0], { AV_PROCS: 'Code', AV_TITLE: path.basename(repo) });
  // an editor window open on a workspace file: its name is in the title
  const ws = path.join(appData, 'my.code-workspace');
  fs.writeFileSync(ws, JSON.stringify({ folders: [{ path: repo }] }));
  fs.mkdirSync(path.join(appData, 'Code', 'User', 'globalStorage'), { recursive: true });
  fs.writeFileSync(path.join(appData, 'Code', 'User', 'globalStorage', 'storage.json'),
    JSON.stringify({ windowsState: { openedWindows: [{ workspaceIdentifier: { configURIPath: new URL(`file://${ws.startsWith('/') ? '' : '/'}${ws.replace(/\\/g, '/')}`).href } }] } }));
  await focusHost(hostFrom(undefined, 'vscode', undefined), repo, undefined, appData, 'win32', ps);
  assert.equal(runs[1].AV_TITLE, 'my');
  await focusHost(hostFrom(undefined, undefined, undefined, 'claude-desktop'), repo, undefined, appData, 'win32', ps);
  assert.equal(runs[2].AV_PROCS, 'Claude');
  assert.equal(await focusHost(hostFrom(undefined, undefined, undefined, 'cli'), repo, undefined, appData, 'win32', ps), false, 'unknown app: nothing to do');
  assert.equal(runs.length, 3);
});

test('Windows file paths read as nicely as macOS ones', () => {
  assert.equal(friendlyTask({ tool_name: 'Edit', tool_input: { file_path: 'C:\\Users\\me\\app\\src\\LoginForm.tsx' } }), 'Editing the login form');
  assert.equal(friendlyTask({ tool_name: 'Read', tool_input: { file_path: 'C:\\Users\\me\\app\\package.json' } }), 'Reading dependencies');
  assert.equal(friendlyTask({ tool_name: 'Edit', tool_input: { file_path: 'C:\\app\\test\\auth.test.ts' } }), 'Editing the auth tests');
  assert.equal(waitingFor({ tool_name: 'Write', tool_input: { file_path: 'C:\\app\\src\\auth\\session.ts' } }).ask, 'auth/session.ts');
});

test('links open with each system\'s own opener, as one argument', () => {
  const runs: string[][] = [];
  const url = 'http://localhost:4917/?token=abc';
  for (const p of ['darwin', 'win32', 'linux'] as const) openUrl(url, p, (cmd, args) => runs.push([cmd, ...args]));
  assert.deepEqual(runs, [['open', url], ['rundll32', 'url.dll,FileProtocolHandler', url], ['xdg-open', url]]);
});
