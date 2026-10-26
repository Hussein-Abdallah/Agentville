// The Agentville hook for Windows (any shell: Claude Code runs it directly, `node hook.mjs`). It does what
// the curl line does on macOS: sends the hook's JSON (stdin) to the local service with the token and a
// few details about where the session runs, and always ends quietly, so it never blocks or slows Claude
// and does nothing when Agentville isn't running. Plain JavaScript, no packages: it starts fast.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const port = Number(process.env.AGENTVILLE_PORT) || 4917;
const done = () => process.exit(0);
setTimeout(done, 1500).unref(); // never longer than this, whatever happens

let token = '';
try { token = fs.readFileSync(path.join(os.homedir(), '.agentville', 'token'), 'utf8').trim(); } catch { done(); }

const chunks = [];
process.stdin.on('data', (c) => chunks.push(c));
process.stdin.on('end', async () => {
  const env = process.env;
  const headers = { 'content-type': 'application/json', 'x-agentville-token': token };
  // where the session runs: the terminal program, Claude Code's entry point (the desktop app, the
  // VS Code extension…), and Windows Terminal
  if (env.TERM_PROGRAM) headers['x-agentville-term'] = env.TERM_PROGRAM;
  if (env.CLAUDE_CODE_ENTRYPOINT) headers['x-agentville-entry'] = env.CLAUDE_CODE_ENTRYPOINT;
  if (env.WT_SESSION) headers['x-agentville-wt'] = '1';
  if (env.__CFBundleIdentifier) headers['x-agentville-app'] = env.__CFBundleIdentifier;
  try {
    await fetch(`http://127.0.0.1:${port}/events`, { method: 'POST', headers, body: Buffer.concat(chunks), signal: AbortSignal.timeout(1000) });
  } catch { /* not running: nothing to do */ }
  done();
});
process.stdin.on('error', done);
