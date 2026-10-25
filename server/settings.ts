// ~/.agentville/settings.json: what the page shows you (which toasts…). Written with the defaults the
// first time; edit it by hand (a Settings page will later) and open pages pick the change up within a
// second or two. A file that doesn't parse is left as it is and the defaults are used until it's fixed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DEFAULT_SETTINGS, readSettings, type Settings } from '../src/settings';

export class SettingsFile {
  readonly file: string;
  value: Settings;
  /** called when the file changes on disk */
  onChange?: (s: Settings) => void;

  /** default process.env.AGENTVILLE_SETTINGS ?? ~/.agentville/settings.json */
  constructor(file = process.env.AGENTVILLE_SETTINGS ?? path.join(os.homedir(), '.agentville', 'settings.json')) {
    this.file = file;
    if (!fs.existsSync(file)) this.write(DEFAULT_SETTINGS);
    this.value = this.read();
  }

  /** Re-reads the file whenever it changes (polled: editors often replace the file rather than write it). */
  watch() {
    fs.watchFile(this.file, { interval: 1500, persistent: false }, () => {
      const next = this.read();
      if (JSON.stringify(next) === JSON.stringify(this.value)) return;
      this.value = next;
      this.onChange?.(next);
    });
  }

  stop() { fs.unwatchFile(this.file); }

  private read(): Settings {
    let text: string;
    try { text = fs.readFileSync(this.file, 'utf8'); } catch { return readSettings(undefined); }
    try { return readSettings(JSON.parse(text)); } catch {
      console.error(`${this.file} isn't valid JSON; using the default settings until it's fixed.`);
      return readSettings(undefined);
    }
  }

  private write(s: Settings) {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(s, null, 2) + '\n', { flag: 'wx' }); // never over a file that appeared meanwhile
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'EEXIST') console.error(`Couldn't write ${this.file}: ${(err as Error).message}`);
    }
  }
}
