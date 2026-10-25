// The needs-you board: the "2 need you" counter in the header opens a list of every robot waiting for a
// permission or an answer, in any world, longest waiting first. Click one to go to it; "Open in …"
// brings its session to the front so you can answer there.
import type { AgentState, TownInfo } from './types';
import { esc } from './picker';

export interface NeedsHandlers {
  /** go to the robot in its town */
  go: (a: AgentState) => void;
  /** bring its session's app to the front (live mode, when the app is known) */
  open?: (a: AgentState) => void;
}

export class NeedsBoard {
  private list: HTMLElement;
  private rows: AgentState[] = [];
  private key = '';
  private ctx?: { since: (a: AgentState) => number; towns: TownInfo[]; colors: Record<string, string>; app: (a: AgentState) => string | undefined };

  constructor(private button: HTMLElement, private h: NeedsHandlers) {
    this.list = document.createElement('div');
    this.list.className = 'nb-list';
    this.list.hidden = true;
    button.after(this.list);
    button.onclick = () => (this.list.hidden ? this.open() : this.close());
    this.list.addEventListener('click', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      const a = el && this.rows[Number(el.dataset.i)];
      if (!a) return;
      this.close();
      if ((e.target as HTMLElement).closest('.nb-open')) this.h.open?.(a);
      this.h.go(a);
    });
    // a click anywhere else closes it
    addEventListener('mousedown', (e) => {
      if (!this.list.hidden && !(e.target as HTMLElement).closest('.nb-list, #needs')) this.close();
    });
  }

  get isOpen() { return !this.list.hidden; }

  open() { if (this.rows.length) { this.list.hidden = false; this.key = ''; this.render(); } }
  close() { this.list.hidden = true; }

  /**
   * `since`: when each robot started waiting (ms); `app`: the app its session runs in, for the
   * "Open in …" button (undefined: no button, as in demo mode).
   */
  update(waiting: AgentState[], since: (a: AgentState) => number, towns: TownInfo[], colors: Record<string, string>, app: (a: AgentState) => string | undefined) {
    this.rows = [...waiting].sort((a, b) => since(a) - since(b));
    const n = this.rows.length;
    this.button.textContent = n ? `${n} need${n === 1 ? 's' : ''} you` : '';
    this.button.title = n ? 'Robots waiting for you, in every world' : '';
    this.ctx = { since, towns, colors, app };
    if (!n) return this.close();
    this.render();
  }

  private render() {
    if (this.list.hidden || !this.ctx) return;
    const { since, towns, colors, app } = this.ctx;
    const html = this.rows.map((a, i) => {
      const t = towns.find((x) => x.id === a.town);
      const where = [t?.name ?? a.project, t?.world].filter(Boolean).join(' · ');
      const via = app(a);
      return `<div class="nb-item" data-i="${i}">
        <span class="dot" style="background:${colors[a.color] ?? '#ffe08a'}"></span>
        <div class="mid">
          <div class="nb-top"><b>${esc(a.name)}</b>${a.title ? `<span class="ttl">${esc(a.title)}</span>` : ''}<span class="nb-age">${waited(since(a))}</span></div>
          <div class="nb-want">${esc(a.task ?? 'Waiting for you')}</div>
          ${where ? `<div class="nb-where">${esc(where)}</div>` : ''}
        </div>
        ${via ? `<button class="nb-open" title="Bring the session to the front to answer it">Open in ${esc(via)}</button>` : ''}
      </div>`;
    }).join('');
    if (html === this.key) return;
    this.key = html;
    this.list.innerHTML = `<div class="nb-head">Needs you</div>${html}`;
  }
}

/** "just now", "45 s", "3 min", "1 h 5 min" */
function waited(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 10 ? 'just now' : s < 60 ? `${s} s` : s < 3600 ? `${Math.floor(s / 60)} min` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min`;
}
