// "Needs you" alerts: a notification plus a sound when a robot starts waiting for you.
// The notification is shown by an open Agentville page when the browser allows it (reliable: the
// browser has its own notification permission). Otherwise macOS osascript is the fallback, which
// macOS credits to whatever app started the service and may silently drop. The sound comes from
// the service (afplay), so it plays either way.
import { execFile } from 'node:child_process';
import type { AgentState } from '../src/types';

const SOUND = '/System/Library/Sounds/Glass.aiff';
const QUIET_MS = 15_000; // one alert per session per 15 s (permission prompts can come in bursts)

export class Alerts {
  private last = new Map<string, number>(); // session id -> last alert time

  /** play the sound with each alert */
  sound = true;

  constructor(public on: boolean, private run: (cmd: string, args: string[]) => void = defaultRun) {}

  /** Plays the sound and decides who shows the notification: an open page, macOS, or nobody. */
  needs(st: AgentState, project: string, pageCanNotify: boolean): 'page' | 'mac' | undefined {
    if (!this.on) return;
    const now = Date.now();
    if (now - (this.last.get(st.id) ?? -Infinity) < QUIET_MS) return;
    this.last.set(st.id, now);
    const mac = process.platform === 'darwin';
    if (mac && this.sound) this.run('afplay', [SOUND]);
    if (pageCanNotify) return 'page';
    if (!mac) return;
    const where = [project, st.title].filter(Boolean).join(' · ').slice(0, 80);
    const script = `display notification ${q(st.task ?? 'Waiting for you')} with title ${q(`${st.name} needs you`)}${where ? ` subtitle ${q(where)}` : ''}`;
    this.run('osascript', ['-e', script]);
    return 'mac';
  }

  /** Forget a session (it ended). */
  forget(id: string) { this.last.delete(id); }
}

/** AppleScript string literal. */
const q = (s: string) => `"${s.replace(/[\\"]/g, '\\$&').replace(/[\r\n]+/g, ' ')}"`;

const defaultRun = (cmd: string, args: string[]) => {
  execFile(cmd, args, { timeout: 5000 }, () => {}); // fire and forget; never break the service
};
