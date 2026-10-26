// What the hooks don't carry, read from a session's own files under the Claude folder (~/.claude):
// how full its context window is (the transcript's latest reply) and Claude Code's task files.
// Only files inside that folder are read, and transcripts only from the end (a small tail).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { TodoItem } from '../src/types';

/** The Claude folder (CLAUDE_CONFIG_DIR, else ~/.claude), read on every call so tests can point it elsewhere. */
export const claudeDir = () => path.resolve(process.env.CLAUDE_CONFIG_DIR ?? path.join(os.homedir(), '.claude'));

/** A transcript path from a hook event, if it's a .jsonl file inside the Claude folder. */
export function safeTranscript(t: unknown): string | undefined {
  if (typeof t !== 'string' || !t.endsWith('.jsonl')) return;
  const abs = path.resolve(t);
  // Windows paths ignore case (c:\Users and C:\users are the same folder)
  const fold = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p);
  return fold(abs).startsWith(fold(claudeDir() + path.sep)) ? abs : undefined;
}

/** The first bytes of a file (up to `max`), or undefined if it can't be read. */
export function readHead(file: string, max: number): string | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(max);
      const n = fs.readSync(fd, buf, 0, max, 0);
      return buf.toString('utf8', 0, n);
    } finally { fs.closeSync(fd); }
  } catch { return; }
}

/** The last `max` bytes of a file as whole lines (a partial first line is dropped). */
function readTail(file: string, max: number): { lines: string[]; whole: boolean } | undefined {
  try {
    const fd = fs.openSync(file, 'r');
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - max);
      const buf = Buffer.alloc(size - start);
      const n = fs.readSync(fd, buf, 0, buf.length, start);
      const lines = buf.toString('utf8', 0, n).split('\n');
      if (start > 0) lines.shift();
      return { lines, whole: start === 0 };
    } finally { fs.closeSync(fd); }
  } catch { return; }
}

export interface Usage {
  /** tokens in the context after the latest reply; 0 when the conversation was compacted since */
  used: number;
  model?: string;
}

/**
 * How full the context is: the newest main-conversation reply's token usage (input, cached and
 * output tokens), or 0 if the conversation was compacted after it. Reads 256 KB from the end,
 * then 4 MB if no reply was found (a reply carrying a big file can be long).
 */
export function contextUsage(transcript: string): Usage | undefined {
  for (const max of [256 * 1024, 4 * 1024 * 1024]) {
    const tail = readTail(transcript, max);
    if (!tail) return;
    for (let i = tail.lines.length - 1; i >= 0; i--) {
      const line = tail.lines[i];
      if (line.includes('"compact_boundary"')) {
        const e = parse(line);
        if (e?.type === 'system' && e.subtype === 'compact_boundary') return { used: 0 };
      }
      if (!line.includes('"usage"') || !line.includes('"assistant"')) continue;
      const e = parse(line);
      const u = e?.type === 'assistant' && !e.isSidechain ? e.message?.usage : undefined;
      if (!u || typeof u !== 'object') continue;
      const n = (k: string) => (typeof u[k] === 'number' && u[k] > 0 ? u[k] : 0);
      const used = n('input_tokens') + n('cache_creation_input_tokens') + n('cache_read_input_tokens') + n('output_tokens');
      return { used, model: typeof e.message.model === 'string' ? e.message.model : undefined };
    }
    if (tail.whole) return;
  }
}

/** A model's context window: 200k for Haiku, 1M for the others (Opus, Sonnet); never less than what's in use. */
export function contextWindow(model: string | undefined, used: number): number {
  const max = /haiku/i.test(model ?? '') ? 200_000 : 1_000_000;
  return used > max ? 1_000_000 : max;
}

/**
 * Claude Code's task list for a session: ~/.claude/tasks/<session id>/<id>.json, each
 * { id, subject, activeForm, status }. Undefined when the session has no task folder.
 */
export function taskFiles(sessionId: string): TodoItem[] | undefined {
  if (!/^[\w-]{1,100}$/.test(sessionId)) return;
  const dir = path.join(claudeDir(), 'tasks', sessionId);
  let names: string[];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')); } catch { return; }
  const tasks: { order: number; item: TodoItem }[] = [];
  for (const f of names.slice(0, 200)) {
    const t = parse(readHead(path.join(dir, f), 64 * 1024) ?? '');
    if (!t || typeof t.subject !== 'string' || t.status === 'deleted') continue;
    const item: TodoItem = { text: t.subject.slice(0, 120), status: todoStatus(t.status) };
    if (typeof t.activeForm === 'string' && t.activeForm.trim()) item.doing = t.activeForm.trim().slice(0, 120);
    const order = Number(t.id ?? f.replace(/\.json$/, ''));
    tasks.push({ order: Number.isFinite(order) ? order : Infinity, item });
  }
  return tasks.sort((a, b) => a.order - b.order).map((t) => t.item).slice(0, 50);
}

/** A to-do status in any of the tools' wordings. */
export function todoStatus(s: unknown): TodoItem['status'] {
  const v = String(s ?? '').toLowerCase();
  if (/complete|done|finished/.test(v)) return 'completed';
  if (/progress|active|current|doing/.test(v)) return 'in_progress';
  return 'pending';
}

function parse(line: string): any {
  try { return JSON.parse(line); } catch { return; }
}

/**
 * A session's title (the desktop app's "custom-title" lines) and your last prompt ("last-prompt"),
 * for a robot that shows up mid-session (the service restarted): the newest of each, looking at the
 * transcript's last 256 KB, then its first 256 KB.
 */
export function sessionLabels(transcript: string | undefined): { title?: string; lastPrompt?: string } {
  if (!transcript) return {};
  const out: { title?: string; lastPrompt?: string } = {};
  const scan = (lines: string[]) => {
    for (let i = lines.length - 1; i >= 0 && !(out.title && out.lastPrompt); i--) {
      const l = lines[i];
      if (!out.title && l.includes('"custom-title"')) { try { const o = JSON.parse(l); if (typeof o.customTitle === 'string') out.title = o.customTitle; } catch { /* partial line */ } }
      if (!out.lastPrompt && l.includes('"last-prompt"')) { try { const o = JSON.parse(l); if (typeof o.lastPrompt === 'string' && !/^\s*</.test(o.lastPrompt)) out.lastPrompt = o.lastPrompt; } catch { /* partial line */ } }
    }
  };
  const tail = readTail(transcript, 256 * 1024);
  if (tail) scan(tail.lines);
  if (tail && !tail.whole && !(out.title && out.lastPrompt)) scan((readHead(transcript, 256 * 1024) ?? '').split('\n'));
  return out;
}
