// Go to the session: bring the app a session runs in to the front. On macOS the hooks report
// the app's bundle id (__CFBundleIdentifier, inherited from the app that started Claude Code) and,
// on SessionStart / UserPromptSubmit, Claude Code's terminal (tty), so Terminal and iTerm can also
// select the right tab; editors open the session's folder, which brings that window forward.
// Every value is checked against a strict pattern and passed as an argument, never through a shell.
// For VS Code-style editors, the folder or .code-workspace file comes from the editor's own list of
// open windows, so we only ever bring an existing window forward (opening anything else makes a new one).
// On Windows the hooks report the terminal program, Claude Code's entry point and Windows Terminal, and a
// PowerShell helper brings forward that app's window whose title has the session's folder (see windows.ts).
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FOCUS_SCRIPT, WIN_PROCESSES, defaultPs, type PsRun } from './windows';

export interface Host {
  /** bundle id, e.g. com.apple.Terminal */
  bundle?: string;
  /** TERM_PROGRAM, e.g. Apple_Terminal, iTerm.app, vscode (when there's no bundle id) */
  term?: string;
  /** Claude Code's terminal device, e.g. ttys003 */
  tty?: string;
  /** Claude Code's entry point (CLAUDE_CODE_ENTRYPOINT): claude-desktop, claude-vscode, cli… */
  entry?: string;
  /** it runs in Windows Terminal */
  wt?: boolean;
}

const BUNDLE = /^[A-Za-z0-9][A-Za-z0-9.-]{1,120}$/;
const TERM = /^[A-Za-z0-9._ -]{1,40}$/;
const TTY = /^ttys?\d{1,4}$/;
const ENTRY = /^[a-z0-9-]{1,40}$/;

/** Host details from the hook's headers, keeping only well-formed values. */
export function hostFrom(bundle: unknown, term: unknown, tty: unknown, entry?: unknown, wt?: unknown): Host {
  const h: Host = {};
  if (typeof bundle === 'string' && BUNDLE.test(bundle.trim())) h.bundle = bundle.trim();
  if (typeof term === 'string' && TERM.test(term.trim())) h.term = term.trim();
  if (typeof tty === 'string' && TTY.test(tty.trim())) h.tty = tty.trim();
  if (typeof entry === 'string' && ENTRY.test(entry.trim())) h.entry = entry.trim();
  if (wt === '1') h.wt = true;
  return h;
}

const KNOWN: Record<string, string> = {
  'com.apple.Terminal': 'Terminal',
  'com.googlecode.iterm2': 'iTerm',
  'com.microsoft.VSCode': 'VS Code',
  'com.microsoft.VSCodeInsiders': 'VS Code Insiders',
  'com.todesktop.230313mzl4w4u92': 'Cursor',
  'com.exafunction.windsurf': 'Windsurf',
  'dev.zed.Zed': 'Zed',
  'com.anthropic.claudefordesktop': 'Claude',
  'dev.warp.Warp-Stable': 'Warp',
  'com.mitchellh.ghostty': 'Ghostty',
  'com.github.wez.wezterm': 'WezTerm',
  'net.kovidgoyal.kitty': 'kitty',
  'io.alacritty': 'Alacritty',
};
/** TERM_PROGRAM values, for when there's no bundle id */
const TERMS: Record<string, string> = {
  Apple_Terminal: 'com.apple.Terminal', 'iTerm.app': 'com.googlecode.iterm2', vscode: 'com.microsoft.VSCode',
  WarpTerminal: 'dev.warp.Warp-Stable', ghostty: 'com.mitchellh.ghostty', WezTerm: 'com.github.wez.wezterm',
};
/** VS Code-style editors and their folder in ~/Library/Application Support (where they list their open windows) */
const EDITORS: Record<string, string> = {
  'com.microsoft.VSCode': 'Code', 'com.microsoft.VSCodeInsiders': 'Code - Insiders', 'com.todesktop.230313mzl4w4u92': 'Cursor',
  'com.exafunction.windsurf': 'Windsurf', 'com.vscodium': 'VSCodium',
};
/** JetBrains IDEs all start with this */
const JETBRAINS = 'com.jetbrains.';

/** The bundle id to open: the reported one, else the one for the reported terminal program. */
export const bundleOf = (h: Host) => h.bundle ?? (h.term ? TERMS[h.term] : undefined);

/** A short name for the app, for the "Open in …" button. */
export function appName(h: Host): string | undefined {
  const b = bundleOf(h);
  if (!b) {
    // no bundle id (Windows, Linux): Claude Code's entry point, else Windows Terminal
    if (h.entry === 'claude-desktop') return 'Claude';
    if (h.entry === 'claude-vscode') return 'VS Code';
    if (h.wt) return 'Windows Terminal';
    return;
  }
  if (KNOWN[b]) return KNOWN[b];
  if (b.startsWith(JETBRAINS)) return 'JetBrains';
  const last = b.split('.').pop()!;
  return last.charAt(0).toUpperCase() + last.slice(1);
}

export type Run = (cmd: string, args: string[]) => Promise<boolean>;

const defaultRun: Run = (cmd, args) => new Promise((done) => execFile(cmd, args, { timeout: 5000 }, (err) => done(!err)));

/**
 * Brings the session's app forward: Terminal and iTerm select the tab with Claude Code's tty
 * (macOS asks once to let the service control them; without that, the app just comes to the front),
 * editors open the folder, other apps are activated. Resolves to whether it worked.
 */
export async function focusHost(h: Host, folder: string | undefined, run: Run = defaultRun,
  appSupport = appDataDir(), platform: NodeJS.Platform = process.platform, ps: PsRun = defaultPs): Promise<boolean> {
  if (platform === 'win32') return focusWindows(h, folder, appSupport, ps);
  if (platform !== 'darwin') return false;
  const b = bundleOf(h);
  if (!b || !BUNDLE.test(b)) return false;
  const tty = h.tty && TTY.test(h.tty) ? `/dev/${h.tty}` : undefined;
  if (tty && b === 'com.apple.Terminal' && await run('osascript', ['-e', terminalScript(tty)])) return true;
  if (tty && b === 'com.googlecode.iterm2' && await run('osascript', ['-e', itermScript(tty)])) return true;
  const dir = folder && path.isAbsolute(folder) && isDir(folder) ? folder : undefined;
  const open = dir && EDITORS[b] ? editorWindow(path.join(appSupport, EDITORS[b]), dir) : undefined;
  return run('open', open ? ['-b', b, open] : ['-b', b]);
}

/** Where VS Code-style editors keep their settings: ~/Library/Application Support on macOS, %APPDATA% on Windows. */
export function appDataDir(platform: NodeJS.Platform = process.platform): string {
  if (platform === 'win32') return process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
  if (platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  return process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
}

/**
 * Windows: the app's window whose title holds the session's folder name (an editor shows the folder of
 * its window, e.g. "app.ts - agentville - Visual Studio Code"), else any of its windows.
 */
async function focusWindows(h: Host, folder: string | undefined, appSupport: string, ps: PsRun): Promise<boolean> {
  const name = appName(h);
  const procs = name ? WIN_PROCESSES[name] : undefined;
  if (!procs) return false;
  const b = bundleOf(h);
  const dir = folder && path.isAbsolute(folder) && isDir(folder) ? folder : undefined;
  const window = dir && b && EDITORS[b] ? editorWindow(path.join(appSupport, EDITORS[b]), dir) : undefined;
  const title = (window ?? dir) ? path.basename(window ?? dir!).replace(/\.code-workspace$/i, '') : '';
  return ps(FOCUS_SCRIPT, { AV_PROCS: procs.join(','), AV_TITLE: title.replace(/[*?\[\]`]/g, '') });
}

/**
 * The folder or .code-workspace file of the editor window a session's folder belongs to: among the
 * windows the editor lists as open (User/globalStorage/storage.json), the one whose folder (or one of
 * whose workspace folders) holds `dir` most closely. Undefined if none does.
 */
export function editorWindow(editorDir: string, dir: string): string | undefined {
  let windows: any[];
  try {
    const ws = JSON.parse(fs.readFileSync(path.join(editorDir, 'User', 'globalStorage', 'storage.json'), 'utf8'))?.windowsState ?? {};
    windows = [ws.lastActiveWindow, ...(Array.isArray(ws.openedWindows) ? ws.openedWindows : [])].filter(Boolean);
  } catch { return; }
  let best: { open: string; depth: number } | undefined;
  for (const w of windows) {
    const folder = fromUri(w.folder ?? w.folderUri);
    const file = fromUri(w.workspace?.configPath ?? w.workspaceIdentifier?.configURIPath ?? w.workspace?.configURIPath);
    const roots = folder ? [folder] : file ? workspaceFolders(file) : [];
    for (const r of roots) {
      if (dir !== r && !dir.startsWith(r + path.sep)) continue;
      const depth = r.split(path.sep).length;
      if (!best || depth > best.depth) best = { open: (folder ?? file)!, depth };
    }
  }
  return best && fs.existsSync(best.open) ? best.open : undefined;
}

/** A local file:// URI as a path (anything else, e.g. a remote window, gives undefined). */
function fromUri(u: unknown): string | undefined {
  if (typeof u !== 'string' || !u.startsWith('file://')) return;
  try { return path.resolve(fileURLToPath(u)); } catch { return; }
}

/** The folders of a .code-workspace file (JSON with comments; paths relative to the file); the file's own folder if unreadable. */
function workspaceFolders(file: string): string[] {
  const base = path.dirname(file);
  try {
    const ws = JSON.parse(stripJsonc(fs.readFileSync(file, 'utf8')));
    const list = (Array.isArray(ws?.folders) ? ws.folders : [])
      .map((f: any) => (typeof f?.path === 'string' ? path.resolve(base, f.path) : fromUri(f?.uri)))
      .filter((p: unknown): p is string => typeof p === 'string');
    return list.length ? list : [base];
  } catch { return [base]; }
}

/** Removes line and block comments and trailing commas outside strings (for JSON with comments). */
function stripJsonc(text: string): string {
  let out = '', i = 0, str = false;
  while (i < text.length) {
    const c = text[i], n = text[i + 1];
    if (str) { out += c; if (c === '\\') { out += n ?? ''; i += 2; continue; } if (c === '"') str = false; i++; continue; }
    if (c === '"') { str = true; out += c; i++; continue; }
    if (c === '/' && n === '/') { while (i < text.length && text[i] !== '\n') i++; continue; }
    if (c === '/' && n === '*') { i = text.indexOf('*/', i + 2); i = i < 0 ? text.length : i + 2; continue; }
    out += c; i++;
  }
  return out.replace(/,(\s*[}\]])/g, '$1');
}

// The tty is checked against TTY above, so it is safe inside the AppleScript string.
const terminalScript = (tty: string) => `tell application id "com.apple.Terminal"
  repeat with w in windows
    repeat with t in tabs of w
      if tty of t is "${tty}" then
        set selected tab of w to t
        set index of w to 1
      end if
    end repeat
  end repeat
  activate
end tell`;

const itermScript = (tty: string) => `tell application id "com.googlecode.iterm2"
  repeat with w in windows
    repeat with t in tabs of w
      repeat with s in sessions of t
        if tty of s is "${tty}" then
          select w
          tell t to select
          tell s to select
        end if
      end repeat
    end repeat
  end repeat
  activate
end tell`;

function isDir(p: string) {
  try { return fs.statSync(p).isDirectory(); } catch { return false; }
}
