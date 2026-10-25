// What the page shows you and how it behaves, kept in ~/.agentville/settings.json by the service (the
// Settings page edits it; demo mode keeps its own copy in the browser). Anything missing or of the
// wrong type falls back to the default.

/** Toasts in the page: a robot needs you, a test/build/deploy failed, a session finished its turn, a session started or ended. */
export type ToastKind = 'needsYou' | 'failed' | 'finished' | 'sessions';

export interface Settings {
  toasts: Record<ToastKind, boolean>;
  /** how long toasts stay up */
  toastTime: 'short' | 'normal' | 'long';
  /** needs-you notifications (a page notification, or macOS's) */
  alerts: boolean;
  /** the needs-you sound */
  sound: boolean;
  /** day or night in the towns; system follows the Mac's light or dark mode */
  time: 'day' | 'night' | 'system';
  /** folder names on buildings */
  labels: boolean;
  /** the roads robots walk */
  paths: boolean;
  /** robots say a short line when they start, finish, pass or fail */
  lines: boolean;
  /** a clock in the header */
  clock: 'off' | '12h' | '24h';
  /** go to the town of a session that just started */
  followNew: boolean;
  /** clicking a robot opens its details, or brings its session to the front */
  clickOpens: 'details' | 'session';
}

export const DEFAULT_SETTINGS: Settings = {
  toasts: { needsYou: true, failed: true, finished: false, sessions: false },
  toastTime: 'normal',
  alerts: true,
  sound: true,
  time: 'system',
  labels: true,
  paths: false,
  lines: true,
  clock: 'off',
  followNew: false,
  clickOpens: 'details',
};

/** How much longer (or shorter) toasts stay up than usual. */
export const toastScale = (s: Settings) => ({ short: 0.6, normal: 1, long: 2 })[s.toastTime];

/** The defaults, with whatever `raw` sets right. */
export function readSettings(raw: unknown): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  const r = (raw && typeof raw === 'object' ? raw : {}) as Record<string, any>;
  if (r.toasts && typeof r.toasts === 'object') {
    for (const k of Object.keys(s.toasts) as ToastKind[]) if (typeof r.toasts[k] === 'boolean') s.toasts[k] = r.toasts[k];
  }
  const pick = <K extends keyof Settings>(k: K, ok: readonly Settings[K][]) => { if (ok.includes(r[k])) s[k] = r[k]; };
  pick('toastTime', ['short', 'normal', 'long']);
  pick('time', ['day', 'night', 'system']);
  pick('clock', ['off', '12h', '24h']);
  pick('clickOpens', ['details', 'session']);
  for (const k of ['alerts', 'sound', 'labels', 'paths', 'lines', 'followNew'] as const) if (typeof r[k] === 'boolean') s[k] = r[k];
  return s;
}
