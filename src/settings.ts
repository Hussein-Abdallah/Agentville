// What the page shows you, kept in ~/.agentville/settings.json by the service (a Settings page will
// edit it later). Anything missing or of the wrong type falls back to the default.

/** Toasts in the page: a robot needs you, a test/build/deploy failed, a session finished its turn, a session started or ended. */
export type ToastKind = "needsYou" | "failed" | "finished" | "sessions";

export interface Settings {
  toasts: Record<ToastKind, boolean>;
}

export const DEFAULT_SETTINGS: Settings = {
  toasts: {needsYou: true, failed: true, finished: false, sessions: false},
};

/** The defaults, with whatever `raw` sets right. */
export function readSettings(raw: unknown): Settings {
  const s = structuredClone(DEFAULT_SETTINGS);
  const toasts = (raw as any)?.toasts;
  if (toasts && typeof toasts === "object") {
    for (const k of Object.keys(s.toasts) as ToastKind[])
      if (typeof toasts[k] === "boolean") s.toasts[k] = toasts[k];
  }
  return s;
}
