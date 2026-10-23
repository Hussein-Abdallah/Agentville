// What the details panel shows beyond the robot's walk: the context meter, the to-do list and the
// app a session runs in (for Go to session).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { newTown, tmpDir } from './support';
import { contextUsage, contextWindow } from '../server/transcript';
import { applyTodos } from '../server/todos';
import { appName, editorWindow, focusHost, hostFrom } from '../server/focus';

// transcripts and task files are only read inside the Claude folder: point it at a temporary one
const claude = tmpDir('claude');
process.env.CLAUDE_CONFIG_DIR = claude;
const repo = () => tmpDir('repo', { repo: true, dirs: ['src'] });

const reply = (used: number, model = 'claude-opus-5-5', extra: Record<string, unknown> = {}) => JSON.stringify({
  type: 'assistant', ...extra,
  message: { model, usage: { input_tokens: 2, cache_creation_input_tokens: 1000, cache_read_input_tokens: used - 1502, output_tokens: 500 } },
});
const boundary = JSON.stringify({ type: 'system', subtype: 'compact_boundary', compactMetadata: { trigger: 'auto', preTokens: 950_000 } });

function transcript(lines: string[]) {
  const dir = path.join(claude, 'projects', 'p');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `${Math.random().toString(36).slice(2)}.jsonl`);
  fs.writeFileSync(file, lines.join('\n') + '\n');
  return file;
}

test('the context in use is the latest reply\'s input, cached and output tokens', () => {
  const file = transcript([reply(100_000), JSON.stringify({ type: 'user', message: {} }), reply(250_000)]);
  assert.deepEqual(contextUsage(file), { used: 250_000, model: 'claude-opus-5-5' });
});

test('replies from subagents (sidechains) and compactions are told apart', () => {
  assert.equal(contextUsage(transcript([reply(300_000), reply(9000, 'claude-haiku-5-5', { isSidechain: true })]))?.used, 300_000);
  assert.equal(contextUsage(transcript([reply(900_000), boundary]))?.used, 0, 'compacted since the last reply');
  assert.equal(contextUsage(transcript([reply(900_000), boundary, reply(60_000)]))?.used, 60_000);
});

test('context windows: Haiku 200k, others 1M, and never smaller than what is in use', () => {
  assert.equal(contextWindow('claude-haiku-5-5', 1000), 200_000);
  assert.equal(contextWindow('claude-opus-5-5', 1000), 1_000_000);
  assert.equal(contextWindow('claude-sonnet-5-5', 1000), 1_000_000);
  assert.equal(contextWindow('claude-haiku-5-5', 300_000), 1_000_000);
});

test('a robot\'s context meter follows its transcript, through a compaction', () => {
  const t = newTown(), r = repo();
  const file = transcript([reply(400_000)]);
  t.send(r, { hook_event_name: 'UserPromptSubmit', prompt: 'hi', transcript_path: file });
  assert.deepEqual(t.robot()!.context, { used: 400_000, max: 1_000_000 });

  t.edit(r, 'src/a.ts');
  const pre = t.send(r, { hook_event_name: 'PreCompact', trigger: 'auto' });
  assert.equal(pre.task, 'Compacting the conversation');
  assert.equal(pre.context.compacting, true);
  fs.appendFileSync(file, boundary + '\n');
  const after = t.send(r, { hook_event_name: 'SessionStart', source: 'compact', transcript_path: file });
  assert.equal(after.context.used, 0);
  assert.equal(after.context.max, 1_000_000, 'keeps the window it knew');
  assert.equal(after.context.compactions, 1);
  assert.equal(after.context.compacting, undefined);
  assert.notEqual(after.task, 'Compacting the conversation', 'back to what it was doing');

  fs.appendFileSync(file, reply(50_000) + '\n');
  assert.equal(t.send(r, { hook_event_name: 'Stop' }).context.used, 50_000);
});

test('transcripts outside the Claude folder are never read', () => {
  const t = newTown(), r = repo();
  const outside = path.join(tmpDir('elsewhere'), 'x.jsonl');
  fs.writeFileSync(outside, reply(400_000) + '\n');
  t.send(r, { hook_event_name: 'UserPromptSubmit', prompt: 'hi', transcript_path: outside });
  assert.equal(t.robot()!.context, undefined);
});

test('TodoWrite and the desktop app\'s plan tool give the to-do list; the bubble shows the step in progress', () => {
  const t = newTown(), r = repo();
  t.prompt(r);
  const a = t.tool(r, 'TodoWrite', { todos: [
    { content: 'Read the code', activeForm: 'Reading the code', status: 'completed' },
    { content: 'Fix the bug', activeForm: 'Fixing the bug', status: 'in_progress' },
    { content: 'Run tests', activeForm: 'Running tests', status: 'pending' },
  ] });
  assert.deepEqual(a.todos.map((x: any) => x.status), ['completed', 'in_progress', 'pending']);
  assert.equal(a.task, 'Fixing the bug');

  const b = t.tool(r, 'mcp__ccd_turn__update_plan', { items: [{ content: 'Look around', status: 'in_progress' }, { content: 'Change it', status: 'pending' }] });
  assert.deepEqual(b.todos, [{ text: 'Look around', status: 'in_progress' }, { text: 'Change it', status: 'pending' }]);
  assert.equal(t.tool(r, 'mcp__ccd_turn__update_plan', { advance: true }).task, 'Change it');
  assert.deepEqual(t.tool(r, 'mcp__ccd_turn__wrap_up', { recap: 'done' }).todos.map((x: any) => x.status), ['completed', 'completed']);
  assert.equal(t.prompt(r).todos, undefined, 'a finished list is cleared by the next request');
});

test('plan steps: done and start by number', () => {
  const list = applyTodos(undefined, 'mcp__ccd_turn__update_plan', { items: ['a', 'b', 'c', 'd'].map((content, i) => ({ content, status: i ? 'pending' : 'in_progress' })) })!;
  const next = applyTodos(list, 'mcp__ccd_turn__update_plan', { done: [2], start: 4 })!;
  assert.deepEqual(next.map((x) => x.status), ['completed', 'completed', 'pending', 'in_progress']);
  assert.equal(applyTodos(list, 'Read', { file_path: 'x' }), undefined, 'other tools leave it alone');
});

test('Claude Code\'s task files give the list after TaskCreate / TaskUpdate', () => {
  const t = newTown(), r = repo();
  const dir = path.join(claude, 'tasks', 's1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '2.json'), JSON.stringify({ id: '2', subject: 'Write tests', activeForm: 'Writing tests', status: 'pending' }));
  fs.writeFileSync(path.join(dir, '1.json'), JSON.stringify({ id: '1', subject: 'Add the meter', activeForm: 'Adding the meter', status: 'in_progress' }));
  fs.writeFileSync(path.join(dir, '3.json'), JSON.stringify({ id: '3', subject: 'Gone', status: 'deleted' }));
  t.prompt(r);
  const a = t.send(r, { hook_event_name: 'PostToolUse', tool_name: 'TaskUpdate', tool_input: { taskId: '1' } });
  assert.deepEqual(a.todos.map((x: any) => x.text), ['Add the meter', 'Write tests']);
});

test('the app a session runs in comes from the hook headers, checked', () => {
  assert.deepEqual(hostFrom('com.apple.Terminal', 'Apple_Terminal', 'ttys003 '), { bundle: 'com.apple.Terminal', term: 'Apple_Terminal', tty: 'ttys003' });
  assert.deepEqual(hostFrom('x"; do shell script "rm', '$(boom)', '../../etc'), {}, 'anything odd is dropped');
  assert.equal(appName({ bundle: 'com.microsoft.VSCode' }), 'VS Code');
  assert.equal(appName({ term: 'iTerm.app' }), 'iTerm');
  assert.equal(appName({ bundle: 'com.anthropic.claudefordesktop' }), 'Claude');
  assert.equal(appName({}), undefined);

  const t = newTown(), r = repo();
  t.send(r, { hook_event_name: 'UserPromptSubmit', prompt: 'hi', agentville_app: 'com.apple.Terminal', agentville_tty: 'ttys004' });
  assert.equal(t.send(r, { hook_event_name: 'PreToolUse', tool_name: 'Read', tool_input: { file_path: path.join(r, 'src/a.ts') }, agentville_app: 'com.apple.Terminal' }).app, 'Terminal');
  assert.deepEqual(t.s.hostOf('s1')?.host, { bundle: 'com.apple.Terminal', tty: 'ttys004' }, 'later events without a tty keep it');
  t.send(r, { hook_event_name: 'SubagentStart', agent_id: 'a1', agent_type: 'Explore' });
  const helper = t.s.snapshot().find((x) => x.parentId === 's1')!;
  assert.equal(t.s.hostOf(helper.id)?.name, t.robot()!.name, 'a helper goes to its parent\'s session');
});

test('Go to session: Terminal selects the tab, editors open the folder, others are activated', { skip: process.platform !== 'darwin' }, async () => {
  const calls: string[][] = [];
  const run = async (cmd: string, args: string[]) => { calls.push([cmd, ...args]); return true; };
  const dir = tmpDir('proj');
  await focusHost({ bundle: 'com.apple.Terminal', tty: 'ttys003' }, dir, run);
  assert.equal(calls[0][0], 'osascript');
  assert.match(calls[0][2], /tty of t is "\/dev\/ttys003"/);
  await focusHost({ bundle: 'com.microsoft.VSCode' }, dir, run, tmpDir('no-editor-state'));
  assert.deepEqual(calls[1], ['open', '-b', 'com.microsoft.VSCode'], 'not open in VS Code: only bring VS Code forward, never a new window');
  await focusHost({ bundle: 'com.anthropic.claudefordesktop' }, dir, run);
  assert.deepEqual(calls[2], ['open', '-b', 'com.anthropic.claudefordesktop']);
  assert.equal(await focusHost({}, dir, run), false);
  assert.equal(await focusHost({ bundle: 'bad bundle;' }, dir, run), false);
  assert.equal(calls.length, 3);
});

test('VS Code: the window holding the session\'s folder, by folder or by .code-workspace file', { skip: process.platform !== 'darwin' }, async () => {
  const dev = tmpDir('dev', { dirs: ['shop/api/src', 'shop/web', 'blog', 'notes'] });
  const ws = path.join(dev, 'shop', 'shop.code-workspace');
  fs.writeFileSync(ws, `// the shop\n{ "folders": [ { "path": "api" }, { "path": "web", "name": "Web" }, ], "settings": { "x": "a // not a comment" } }`);
  const support = tmpDir('app-support');
  const state = path.join(support, 'Code', 'User', 'globalStorage');
  fs.mkdirSync(state, { recursive: true });
  const uri = (p: string) => `file://${p}`;
  fs.writeFileSync(path.join(state, 'storage.json'), JSON.stringify({ windowsState: {
    lastActiveWindow: { folder: uri(path.join(dev, 'blog')) },
    openedWindows: [{ workspaceIdentifier: { id: 'x', configURIPath: uri(ws) } }, { folder: uri(dev) }, { folder: 'vscode-remote://ssh/elsewhere' }],
  } }));
  const editor = path.join(support, 'Code');
  assert.equal(editorWindow(editor, path.join(dev, 'shop', 'api', 'src')), ws, 'inside a workspace folder: the workspace file');
  assert.equal(editorWindow(editor, path.join(dev, 'blog')), path.join(dev, 'blog'), 'its own folder window beats the parent folder window');
  assert.equal(editorWindow(editor, path.join(dev, 'notes')), dev, 'else the window of a parent folder');
  assert.equal(editorWindow(editor, tmpDir('elsewhere')), undefined);

  const calls: string[][] = [];
  await focusHost({ bundle: 'com.microsoft.VSCode' }, path.join(dev, 'shop', 'web'), async (cmd, args) => { calls.push([cmd, ...args]); return true; }, support);
  assert.deepEqual(calls, [['open', '-b', 'com.microsoft.VSCode', ws]]);
});
