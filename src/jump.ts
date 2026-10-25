// The ⌘K jump box: one search over robots (name, session title, what it's doing, its town), towns and
// worlds. Arrows to move, Enter to go, Esc to close. With nothing typed it lists robots that need you,
// then the most recently busy ones, then the worlds.
import type { AgentState, TownInfo } from './types';
import { esc, inOrder, mark } from './picker';

export type JumpTarget = { kind: 'robot'; id: string } | { kind: 'town'; id: string } | { kind: 'world'; name: string };

type Item = { target: JumpTarget; score: number; html: string };

export class JumpBox {
  private box: HTMLElement;
  private input: HTMLInputElement;
  private list: HTMLElement;
  private shown: Item[] = [];
  private active = 0;
  private key = '';
  /** bring the highlighted row into view on the next draw (moved with the keys, or new search); a redraw alone keeps your scroll */
  private reveal = false;
  private data: { agents: AgentState[]; towns: TownInfo[]; colors: Record<string, string> } = { agents: [], towns: [], colors: {} };

  constructor(private onPick: (t: JumpTarget) => void) {
    this.box = document.createElement('div');
    this.box.id = 'jump';
    this.box.hidden = true;
    this.box.innerHTML = `<div class="jp-panel" role="dialog" aria-label="Jump to a robot, town or world">
      <input class="jp-input" type="text" placeholder="Jump to a robot, town or world…" autocomplete="off" spellcheck="false">
      <div class="jp-list" role="listbox"></div>
      <div class="jp-foot"><span>↑↓ move</span><span>↵ go</span><span>esc close</span></div></div>`;
    document.body.append(this.box);
    this.input = this.box.querySelector('input')!;
    this.list = this.box.querySelector('.jp-list')!;
    this.box.addEventListener('mousedown', (e) => { if (e.target === this.box) this.close(); }); // the dimmed backdrop
    this.input.addEventListener('input', () => { this.active = 0; this.reveal = true; this.render(); });
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.shown.length) % Math.max(1, this.shown.length);
        this.reveal = true;
        this.render();
      } else if (e.key === 'Enter') { e.preventDefault(); this.pick(this.active); }
      else if (e.key === 'Escape') { e.preventDefault(); this.close(); }
    });
    this.list.addEventListener('mousedown', (e) => {
      const el = (e.target as HTMLElement).closest<HTMLElement>('[data-i]');
      if (el) { e.preventDefault(); this.pick(Number(el.dataset.i)); }
    });
    addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        if (this.box.hidden) this.open(); else this.close();
      }
    });
  }

  get isOpen() { return !this.box.hidden; }

  update(agents: AgentState[], towns: TownInfo[], colors: Record<string, string>) {
    this.data = { agents, towns, colors };
    if (this.isOpen) this.render();
  }

  open() {
    this.box.hidden = false;
    this.input.value = '';
    this.active = 0;
    this.reveal = true;
    this.list.scrollTop = 0;
    this.render();
    this.input.focus();
  }

  close() {
    this.box.hidden = true;
    this.input.blur();
  }

  private pick(i: number) {
    const it = this.shown[i];
    if (!it) return;
    this.close();
    this.onPick(it.target);
  }

  private render() {
    const q = this.input.value.trim().toLowerCase();
    this.shown = q ? this.matches(q) : this.idle();
    this.active = Math.min(this.active, Math.max(0, this.shown.length - 1));
    const html = this.shown.map((it, i) => `<div class="jp-item${i === this.active ? ' on' : ''}" role="option" data-i="${i}">${it.html}</div>`).join('')
      || '<div class="jp-none">Nothing matches</div>';
    if (html === this.key && !this.reveal) return;
    this.key = html;
    const top = this.list.scrollTop;
    this.list.innerHTML = html;
    this.list.scrollTop = top; // robots changing redraw the list: keep where you scrolled to
    if (this.reveal) { this.reveal = false; this.list.querySelector('.on')?.scrollIntoView({ block: 'nearest' }); }
  }

  /** Nothing typed: robots that need you (longest first), then the most recently busy, then the worlds. */
  private idle(): Item[] {
    const robots = [...this.data.agents].sort((a, b) =>
      Number(b.status === 'waiting') - Number(a.status === 'waiting') || (b.lastActive ?? 0) - (a.lastActive ?? 0)).slice(0, 8);
    return [...robots.map((a) => this.robot(a, '', 0)), ...this.worlds().map((w) => this.world(w, '', 0))];
  }

  private matches(q: string): Item[] {
    const s = (text: string | undefined, start: number, inside: number, letters = -1) => {
      const t = (text ?? '').toLowerCase();
      return !t ? -1 : t.startsWith(q) ? start : t.includes(q) ? inside : letters >= 0 && q.length >= 3 && inOrder(q, t) ? letters : -1;
    };
    const best = (...xs: number[]) => { const ok = xs.filter((x) => x >= 0); return ok.length ? Math.min(...ok) : -1; };
    const items: Item[] = [];
    for (const a of this.data.agents) {
      const score = best(s(a.name, 0, 2, 6), s(a.title, 3, 4), s(a.project, 3, 5), s(a.task, 5, 5));
      if (score >= 0) items.push(this.robot(a, q, score));
    }
    for (const t of this.data.towns) {
      const score = best(s(t.name, 1, 2, 6), s(t.world, 5, 7));
      if (score >= 0) items.push(this.town(t, q, score));
    }
    for (const w of this.worlds()) {
      const score = s(w, 1, 3, 7);
      if (score >= 0) items.push(this.world(w, q, score));
    }
    // best match first; a robot that needs you edges ahead of an equal match; then robots, towns, worlds
    return items.map((it, i) => ({ it, i })).sort((a, b) => a.it.score - b.it.score || a.i - b.i).map(({ it }) => it).slice(0, 30);
  }

  private worlds() { return [...new Set(this.data.towns.map((t) => t.world))].sort(); }

  private robot(a: AgentState, q: string, score: number): Item {
    const parent = a.parentId ? this.data.agents.find((x) => x.id === a.parentId) : undefined;
    const sub = a.status === 'waiting' ? `Wants: ${a.task ?? 'you'}` : a.title ?? a.task ?? '';
    const st = a.status === 'waiting' ? '<span class="st wait">Needs you</span>' : a.status === 'working' ? '<span class="st work">Working</span>' : '<span class="st idle">Idle</span>';
    return {
      target: { kind: 'robot', id: a.id }, score: score - (a.status === 'waiting' ? 0.5 : 0),
      html: `<span class="dot" style="background:${this.data.colors[a.color] ?? '#ffe08a'}"></span>
        <div class="mid"><div class="jp-name">${mark(a.name, q)}${parent ? `<span class="jp-dim"> · helper of ${esc(parent.name)}</span>` : ''}</div>
        ${sub ? `<div class="jp-sub">${mark(sub, q)}</div>` : ''}</div>
        <span class="jp-where">${mark(a.project ?? '', q)}</span>${st}`,
    };
  }

  private town(t: TownInfo, q: string, score: number): Item {
    const n = this.data.agents.filter((a) => a.town === t.id).length;
    return {
      target: { kind: 'town', id: t.id }, score,
      html: `<span class="jp-kind">Town</span><div class="mid"><div class="jp-name">${mark(t.name, q)}</div></div>
        <span class="jp-where">${mark(t.world, q)}</span>${n ? `<span class="tp-n">${n}</span>` : ''}`,
    };
  }

  private world(w: string, q: string, score: number): Item {
    const n = this.data.towns.filter((t) => t.world === w).length;
    return {
      target: { kind: 'world', name: w }, score,
      html: `<span class="jp-kind w">World</span><div class="mid"><div class="jp-name">${mark(w, q)}</div></div>
        <span class="jp-where">${n} town${n === 1 ? '' : 's'}</span>`,
    };
  }
}
