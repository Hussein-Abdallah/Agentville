// Sends realistic Claude Code hook events to the local service, to test Agentville without Claude.
// Usage: npm run simulate            (service must be running: npm start)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Auth } from './auth';

const PORT = Number(process.env.AGENTVILLE_PORT ?? 4917);
const URL = `http://127.0.0.1:${PORT}/events`;
const token = new Auth().token; // the service only takes events that carry it
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// a throwaway "repo" so folders resolve like a real project
const repo = path.join(os.tmpdir(), 'agentville-demo-repo');
fs.mkdirSync(path.join(repo, '.git'), { recursive: true });

async function send(e: Record<string, unknown>) {
  try {
    await fetch(URL, { method: 'POST', headers: { 'content-type': 'application/json', 'x-agentville-token': token }, body: JSON.stringify(e) });
  } catch {
    console.error(`Couldn't reach Agentville at ${URL}. Start it first with: npm start`);
    process.exit(1);
  }
}

function session(id: string) {
  const base = { session_id: id, cwd: repo, transcript_path: path.join(os.tmpdir(), `${id}.jsonl`) };
  let n = 0;
  const tool = async (tool_name: string, tool_input: Record<string, unknown>, ms = 2500) => {
    const tool_use_id = `toolu_${id}_${++n}`;
    await send({ ...base, hook_event_name: 'PreToolUse', tool_name, tool_input, tool_use_id });
    await sleep(ms);
    await send({ ...base, hook_event_name: 'PostToolUse', tool_name, tool_input, tool_use_id, tool_response: {} });
  };
  return {
    start: () => send({ ...base, hook_event_name: 'SessionStart', source: 'startup' }),
    prompt: (prompt: string) => send({ ...base, hook_event_name: 'UserPromptSubmit', prompt }),
    tool,
    file: (p: string) => path.join(repo, p),
    permission: (tool_name: string) => send({ ...base, hook_event_name: 'Notification', notification_type: 'permission_prompt', message: `Claude needs your permission to use ${tool_name}` }),
    stop: () => send({ ...base, hook_event_name: 'Stop' }),
    end: () => send({ ...base, hook_event_name: 'SessionEnd', reason: 'exit' }),
  };
}

async function alice() {
  const s = session('sim-aaaa');
  await s.start();
  await s.prompt('Fix the login bug and add a test');
  await sleep(1500);
  await s.tool('TodoWrite', { todos: [{ content: 'Fix login validation', activeForm: 'Fixing the login validation', status: 'in_progress' }, { content: 'Add test', activeForm: 'Adding a login test', status: 'pending' }] }, 500);
  await s.tool('Read', { file_path: s.file('src/auth/LoginForm.tsx') }, 6000);
  await s.tool('Edit', { file_path: s.file('src/auth/LoginForm.tsx'), old_string: 'a', new_string: 'b' }, 6000);
  await s.tool('Write', { file_path: s.file('tests/login.test.ts'), content: '' }, 6000);
  await s.permission('Bash');
  await sleep(8000);
  await s.tool('Bash', { command: 'npm test', description: 'Run the unit tests' }, 6000);
  await s.stop();
  await sleep(6000);
  await s.end();
}

async function bob() {
  await sleep(3000);
  const s = session('sim-bbbb');
  await s.start();
  await s.prompt('Update the docs and dependencies');
  await s.tool('Edit', { file_path: s.file('docs/setup.md'), old_string: 'a', new_string: 'b' }, 7000);
  await s.tool('Task', { description: 'Review the API docs', prompt: '…', subagent_type: 'general-purpose' }, 9000);
  await s.tool('Edit', { file_path: s.file('package.json'), old_string: 'a', new_string: 'b' }, 6000);
  await s.tool('Bash', { command: 'npm install' }, 6000);
  await s.tool('Grep', { pattern: 'invoiceTotal', path: s.file('billing') }, 6000);
  await s.stop();
  await sleep(4000);
  await send({ session_id: 'sim-bbbb', cwd: repo, hook_event_name: 'Notification', notification_type: 'idle_prompt', message: 'Claude is waiting for your input' });
  await sleep(8000);
  await s.end();
}

console.log(`Sending simulated Claude Code events to ${URL} …`);
await Promise.all([alice(), bob()]);
console.log('Done.');
