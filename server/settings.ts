// ~/.agentville/settings.json: what the page shows you and how it behaves (toasts, alerts, day or
// night…). Written with the defaults the first time; the Settings page saves it, and edits by hand are
// picked up by open pages within a second or two. A file that doesn't parse is left as it is and the
// defaults are used until it's fixed (or saved from the page).
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

  /** Saves new settings (from the Settings page): checked, then written whole. Returns what was kept. */
  save(raw: unknown): Settings {
    const next = readSettings(raw);
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp-${process.pid}`;
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n');
      fs.renameSync(tmp, this.file);
    } catch (err) { console.error(`Couldn't save ${this.file}: ${(err as Error).message}`); }
    this.value = next;
    return next;
  }

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
