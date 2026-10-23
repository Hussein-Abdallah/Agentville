import type { AgentState, TownInfo } from './types';

type Msg =
  | { type: 'snapshot'; agents: AgentState[]; log: string[]; towns: TownInfo[]; alerts?: boolean }
  | { type: 'agent'; state: AgentState }
  | { type: 'remove'; id: string }
  | { type: 'log'; html: string }
  | { type: 'towns'; towns: TownInfo[] }
  | { type: 'alerts'; on: boolean }
  | { type: 'needs'; state: AgentState; project: string }
  | { type: 'focused'; id: string; ok: boolean };

export interface LiveHandlers {
  apply: (s: AgentState) => void;
  remove: (id: string) => void;
  log: (html: string) => void;
  /** every town (repo) seen, with its world and building labels */
  towns: (towns: TownInfo[]) => void;
  status: (connected: boolean) => void;
  /** needs-you notifications on/off (shared by every open page) */
  alerts: (on: boolean) => void;
  /** a robot needs you and this page should show the notification */
  needs: (state: AgentState, project: string) => void;
  /** Go to session finished: whether the app came to the front */
  focused: (id: string, ok: boolean) => void;
}

/** Connects to the local Agentville service and keeps reconnecting if it restarts. Returns a sender for settings. */
export function connectLive(url: string, h: LiveHandlers) {
  let sock: WebSocket | null = null;
  let canNotify = false; // told to the service on every (re)connect
  const send = (m: object) => { if (sock?.readyState === WebSocket.OPEN) sock.send(JSON.stringify(m)); };
  let known = new Set<string>();
  let retry = 500;
  const open = () => {
    const ws = (sock = new WebSocket(url));
    ws.onopen = () => { retry = 500; h.status(true); send({ type: 'notify', can: canNotify }); };
    ws.onmessage = (ev) => {
      const m: Msg = JSON.parse(ev.data);
      if (m.type === 'snapshot') {
        const ids = new Set(m.agents.map((a) => a.id));
        for (const id of known) if (!ids.has(id)) h.remove(id);
        known = ids;
        m.agents.forEach(h.apply);
        [...m.log].reverse().forEach(h.log);
        h.towns(m.towns ?? []);
        if (m.alerts !== undefined) h.alerts(m.alerts);
      } else if (m.type === 'agent') { known.add(m.state.id); h.apply(m.state); }
      else if (m.type === 'remove') { known.delete(m.id); h.remove(m.id); }
      else if (m.type === 'log') h.log(m.html);
      else if (m.type === 'towns') h.towns(m.towns);
      else if (m.type === 'alerts') h.alerts(m.on);
      else if (m.type === 'needs') h.needs(m.state, m.project);
      else if (m.type === 'focused') h.focused(m.id, m.ok);
    };
    ws.onclose = () => { h.status(false); setTimeout(open, retry); retry = Math.min(retry * 2, 8000); };
  };
  open();
  return {
    setAlerts: (on: boolean) => send({ type: 'alerts', on }),
    /** whether this page may show notifications (browser permission granted) */
    setNotify: (can: boolean) => { canNotify = can; send({ type: 'notify', can }); },
    /** bring the robot's session (its terminal, editor or the Claude app) to the front */
    focus: (id: string) => send({ type: 'focus', id }),
  };
}

/** Does this browser have Agentville's token (the cookie the sign-in link sets)? */
export async function signedIn(): Promise<boolean> {
  try {
    const r = await fetch('/auth', { cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  }
}

/** Is the service reachable? (it serves /health) */
export async function serviceAvailable(): Promise<boolean> {
  try {
    const r = await fetch('/health', { cache: 'no-store' });
    return r.ok;
  } catch {
    return false;
  }
}
