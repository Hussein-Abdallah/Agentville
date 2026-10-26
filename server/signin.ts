// One-click sign-in for a new browser: the page asks, and a system dialog (macOS or Windows) asks you to
// allow it. Other programs on this computer could ask too, so:
//   - the page shows a 4-digit code and the dialog shows the same one ("only allow if your browser shows it"),
//   - one request at a time, at most 3 a minute, Allow is never the default, and no answer in 60 s is no,
//   - only the requester holding the request's secret gets the cookie, once, after you allow it.
// The sign-in link (npm run token -- link) still works as well.
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import { DIALOG_SCRIPT, defaultPs, type PsRun } from './windows';

export type Answer = 'allow' | 'deny';
/** Shows the dialog; resolves to the answer (failing or no answer in time is a deny). */
export type Ask = (r: { code: string; browser: string }) => Promise<Answer>;

const PER_MINUTE = 3;
const FORGET_MS = 90_000;

interface Request { secret: string; answer: Promise<Answer>; at: number }

export class SignIn {
  private requests = new Map<string, Request>();
  private recent: number[] = [];
  private pending = 0;

  /** `ask`: undefined where there's no system dialog (sign-in with the link only). */
  constructor(private ask: Ask | undefined, private now = Date.now) {}

  /** A browser asks to sign in: its code (for the page) and secret (to collect the cookie), or why not. */
  start(browser: string): { id: string; code: string; secret: string } | { error: 'busy' | 'too-many' | 'unsupported' } {
    if (!this.ask) return { error: 'unsupported' };
    const t = this.now();
    for (const [id, r] of this.requests) if (t - r.at > FORGET_MS) this.requests.delete(id);
    if (this.pending) return { error: 'busy' };
    this.recent = this.recent.filter((x) => t - x < 60_000);
    if (this.recent.length >= PER_MINUTE) return { error: 'too-many' };
    this.recent.push(t);
    const id = crypto.randomBytes(12).toString('hex');
    const code = String(crypto.randomInt(0, 10_000)).padStart(4, '0');
    const secret = crypto.randomBytes(32).toString('hex');
    this.pending++;
    const answer = this.ask({ code, browser }).catch((): Answer => 'deny').finally(() => { this.pending--; });
    this.requests.set(id, { secret, answer, at: t });
    return { id, code, secret };
  }

  /** The requester waits for your answer; the secret must match, and each request is answered once. */
  async wait(id: unknown, secret: unknown): Promise<Answer | 'gone'> {
    const r = typeof id === 'string' ? this.requests.get(id) : undefined;
    if (!r) return 'gone';
    if (typeof secret !== 'string' || secret.length !== r.secret.length || !crypto.timingSafeEqual(Buffer.from(secret), Buffer.from(r.secret))) return 'deny';
    this.requests.delete(id as string);
    return r.answer;
  }
}

/** What the dialog says. */
export const dialogText = (code: string, browser: string) =>
  `A browser wants to see your Agentville (your Claude Code sessions): ${browser}.\n\nCode: ${code}\n\n`
  + 'Only allow it if you just clicked “Sign in this browser” and your browser shows this same code.';

/** A short name for the browser from its User-Agent: for the dialog only, never trusted. */
export function browserName(ua: unknown): string {
  const s = typeof ua === 'string' ? ua : '';
  const name = /Edg\//.test(s) ? 'Edge' : /OPR\/|Opera/.test(s) ? 'Opera' : /Brave/.test(s) ? 'Brave' : /Firefox\//.test(s) ? 'Firefox'
    : /Chrome\//.test(s) ? 'Chrome' : /Safari\//.test(s) ? 'Safari' : 'a browser';
  const os = /Windows/.test(s) ? 'Windows' : /Mac OS X|Macintosh/.test(s) ? 'macOS' : /Linux/.test(s) ? 'Linux' : '';
  return os && name !== 'a browser' ? `${name} on ${os}` : name;
}

/** The arguments for macOS's dialog: the text is an argument (argv), never part of the script. */
export const macDialogArgs = (text: string) => [
  '-e', 'on run argv',
  '-e', 'display dialog (item 1 of argv) with title "Agentville" buttons {"Don’t allow", "Allow"} default button 1 cancel button 1 with icon caution giving up after 60',
  '-e', 'end run', text,
];

/** The system's dialog, or undefined where there isn't one we can show. */
export function systemAsk(platform: NodeJS.Platform = process.platform, ps: PsRun = defaultPs): Ask | undefined {
  if (platform === 'darwin') {
    return ({ code, browser }) => new Promise((done) => execFile('osascript', macDialogArgs(dialogText(code, browser)), { timeout: 65_000 },
      // "Don't allow" is the cancel button: osascript exits with an error for it
      (err, out) => done(!err && /button returned:Allow/.test(String(out)) && !/gave up:true/.test(String(out)) ? 'allow' : 'deny')));
  }
  if (platform === 'win32') {
    return async ({ code, browser }) => ((await ps(DIALOG_SCRIPT, { AV_TEXT: dialogText(code, browser) }, 65_000)) ? 'allow' : 'deny');
  }
  return undefined;
}
