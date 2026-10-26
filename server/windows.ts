// Windows helpers, through PowerShell: bring a window to the front (Go to session), play the alert sound,
// show a notification. Values reach PowerShell as environment variables, never inside the script text,
// so nothing from a session can change what runs.
import { execFile } from 'node:child_process';

/** Runs a PowerShell script with these environment variables; resolves to whether it exited 0 (in time: `timeoutMs`, 8 s by default). */
export type PsRun = (script: string, env: Record<string, string>, timeoutMs?: number) => Promise<boolean>;

export const defaultPs: PsRun = (script, env, timeoutMs = 8000) => new Promise((done) => execFile('powershell.exe',
  ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
  { timeout: timeoutMs, windowsHide: true, env: { ...process.env, ...env } }, (err) => done(!err)));

/** A Yes/No question (AV_TEXT) on top of everything, No being the default; exits 0 only for Yes. */
export const DIALOG_SCRIPT = `
Add-Type -AssemblyName System.Windows.Forms
$r = [System.Windows.Forms.MessageBox]::Show($env:AV_TEXT, 'Agentville',
  [System.Windows.Forms.MessageBoxButtons]::YesNo, [System.Windows.Forms.MessageBoxIcon]::Warning,
  [System.Windows.Forms.MessageBoxDefaultButton]::Button2, [System.Windows.Forms.MessageBoxOptions]::DefaultDesktopOnly)
if ($r -eq [System.Windows.Forms.DialogResult]::Yes) { exit 0 } else { exit 1 }
`;

/**
 * Brings forward the first top-level window of one of the processes `AV_PROCS` (names without .exe, comma
 * separated) whose title contains `AV_TITLE` (any title when it's empty, or when none has it). Windows only
 * lets the app you're using take the focus, so it taps Alt first (the usual way to be allowed to).
 * Exits 1 when no window was found.
 */
export const FOCUS_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type @"
using System; using System.Text; using System.Runtime.InteropServices;
public static class AvWin {
  public delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll")] public static extern bool EnumWindows(EnumProc f, IntPtr l);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] public static extern bool SetForegroundWindow(IntPtr h);
  [DllImport("user32.dll")] public static extern bool ShowWindow(IntPtr h, int c);
  [DllImport("user32.dll")] public static extern bool IsIconic(IntPtr h);
  [DllImport("user32.dll")] public static extern void keybd_event(byte k, byte s, uint f, UIntPtr e);
}
"@
$procs = $env:AV_PROCS.Split(',') | Where-Object { $_ }
$title = $env:AV_TITLE
$ids = @{}
foreach ($p in Get-Process -ErrorAction SilentlyContinue | Where-Object { $procs -contains $_.ProcessName }) { $ids[[uint32]$p.Id] = $true }
$found = New-Object System.Collections.ArrayList
[AvWin]::EnumWindows({ param($h, $l)
  if ([AvWin]::IsWindowVisible($h)) {
    $pid = [uint32]0; [void][AvWin]::GetWindowThreadProcessId($h, [ref]$pid)
    if ($ids.ContainsKey($pid)) {
      $sb = New-Object System.Text.StringBuilder 512; [void][AvWin]::GetWindowText($h, $sb, 512)
      if ($sb.Length -gt 0) { [void]$found.Add(@($h, $sb.ToString())) }
    }
  }
  return $true }, [IntPtr]::Zero) | Out-Null
$pick = $null
if ($title) { $pick = $found | Where-Object { $_[1] -like "*$title*" } | Select-Object -First 1 }
if (-not $pick) { $pick = $found | Select-Object -First 1 }
if (-not $pick) { exit 1 }
$h = $pick[0]
if ([AvWin]::IsIconic($h)) { [void][AvWin]::ShowWindow($h, 9) }
[AvWin]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero); [AvWin]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)
if (-not [AvWin]::SetForegroundWindow($h)) { exit 1 }
`;

/** Plays Windows' notification sound (and waits for it, so the process lives long enough). */
export const SOUND_SCRIPT = `[System.Media.SystemSounds]::Asterisk.Play(); Start-Sleep -Milliseconds 900`;

/** A toast notification with a title (AV_TITLE) and text (AV_TEXT), credited to PowerShell. */
export const TOAST_SCRIPT = `
$ErrorActionPreference = 'Stop'
[void][Windows.UI.Notifications.ToastNotificationManager, Windows.UI.Notifications, ContentType = WindowsRuntime]
[void][Windows.Data.Xml.Dom.XmlDocument, Windows.Data.Xml.Dom.XmlDocument, ContentType = WindowsRuntime]
$x = [Windows.UI.Notifications.ToastNotificationManager]::GetTemplateContent([Windows.UI.Notifications.ToastTemplateType]::ToastText02)
$t = $x.GetElementsByTagName('text')
[void]$t.Item(0).AppendChild($x.CreateTextNode($env:AV_TITLE))
[void]$t.Item(1).AppendChild($x.CreateTextNode($env:AV_TEXT))
$app = '{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe'
[Windows.UI.Notifications.ToastNotificationManager]::CreateToastNotifier($app).Show([Windows.UI.Notifications.ToastNotification]::new($x))
`;

/** Windows processes (without .exe) for each app a session can run in, as Go to session knows them. */
export const WIN_PROCESSES: Record<string, string[]> = {
  'VS Code': ['Code'],
  'VS Code Insiders': ['Code - Insiders'],
  Cursor: ['Cursor'],
  Windsurf: ['Windsurf'],
  Claude: ['Claude'],
  'Windows Terminal': ['WindowsTerminal'],
  JetBrains: ['idea64', 'pycharm64', 'webstorm64', 'goland64', 'rider64', 'phpstorm64', 'clion64', 'rubymine64'],
  Terminal: ['WindowsTerminal', 'powershell', 'pwsh', 'cmd', 'conhost'],
};
