// Opens a link in the default browser: macOS `open`, Windows' URL handler, Linux `xdg-open`. The link is one
// argument, never passed through a shell.
import { execFile } from 'node:child_process';

export type Spawn = (cmd: string, args: string[]) => void;
const spawn: Spawn = (cmd, args) => { execFile(cmd, args, () => {}); };

export function openUrl(url: string, platform: NodeJS.Platform = process.platform, run: Spawn = spawn) {
  if (platform === 'darwin') run('open', [url]);
  else if (platform === 'win32') run('rundll32', ['url.dll,FileProtocolHandler', url]);
  else run('xdg-open', [url]);
}
