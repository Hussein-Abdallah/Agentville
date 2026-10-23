// Agentville's token: a random secret in ~/.agentville that only your user can read. The hooks send
// it with every event (curl reads it from the hook-header file), and the page gets it as a cookie
// after you open the sign-in link once (http://localhost:4917/?token=…). Without it the service
// takes no events and streams nothing, so other users on this Mac, sandboxed apps and web pages
// can't feed it fake robots or read your prompts and file paths.
// It stays the same across restarts (so an open page keeps working); `npm run token -- new` makes a new one.
// Usage: tsx server/auth.ts link | open | new
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
import type http from 'node:http';
import { fileURLToPath } from 'node:url';

export const HEADER = 'x-agentville-token';
export const COOKIE = 'agentville_token';
const TOKEN = /^[0-9a-f]{48}$/;

export class Auth {
  readonly token: string;
  /** what the hooks pass to curl as -H @<file> */
  readonly headerFile: string;

  /** Reads the token from `dir` (default ~/.agentville), making one the first time (or with `renew`). */
  constructor(readonly dir = path.join(os.homedir(), '.agentville'), renew = false) {
    const file = path.join(dir, 'token');
    this.headerFile = path.join(dir, 'hook-header');
    let token = '';
    try { token = fs.readFileSync(file, 'utf8').trim(); } catch { /* none yet */ }
    if (renew || !TOKEN.test(token)) {
      token = crypto.randomBytes(24).toString('hex');
      fs.mkdirSync(dir, { recursive: true });
      write(file, token + '\n');
    }
    this.token = token;
    const header = `X-Agentville-Token: ${token}\n`;
    let current = '';
    try { current = fs.readFileSync(this.headerFile, 'utf8'); } catch { /* none yet */ }
    if (current !== header) write(this.headerFile, header);
    try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  }

  /** Whether a value is the token (in constant time). */
  check(value: unknown): boolean {
    if (typeof value !== 'string' || value.length !== this.token.length) return false;
    return crypto.timingSafeEqual(Buffer.from(value), Buffer.from(this.token));
  }

  /** A request carries the token: in the hooks' header, the page's cookie, or ?token= (scripts). */
  allows(req: http.IncomingMessage): boolean {
    const h = req.headers[HEADER];
    if (this.check(Array.isArray(h) ? h[0] : h)) return true;
    if (this.check(cookie(req, COOKIE))) return true;
    return this.check(queryToken(req.url));
  }

  /** The cookie the sign-in link sets: only sent by this machine's pages, never readable by scripts. */
  cookie(): string {
    return `${COOKIE}=${this.token}; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000`;
  }

  /** The sign-in link for the page. */
  link(port: number): string {
    return `http://localhost:${port}/?token=${this.token}`;
  }
}

/** ?token= in a request URL. */
export function queryToken(url: string | undefined): string | undefined {
  try { return new URL(url ?? '/', 'http://localhost').searchParams.get('token') ?? undefined; } catch { return; }
}

function cookie(req: http.IncomingMessage, name: string): string | undefined {
  for (const part of (req.headers.cookie ?? '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
}

/** Writes a file only your user can read, atomically. */
function write(file: string, text: string) {
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

// npm run token -- link | open | new
if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.AGENTVILLE_PORT ?? 4917);
  const cmd = process.argv[2] ?? 'link';
  const auth = new Auth(undefined, cmd === 'new');
  if (cmd === 'new') console.log('Made a new Agentville token. The hooks use it right away; open the link below once in your browser:');
  console.log(auth.link(port));
  if (cmd === 'open' || cmd === 'new') exec(`open '${auth.link(port)}'`);
}
