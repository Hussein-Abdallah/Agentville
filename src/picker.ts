// The town picker: a search box with an autocomplete list of towns, grouped by world, with robot and
// needs-you counts. Type to filter (by town or world name, best matches first), arrows to move,
// Enter to open, Esc to close. `/` anywhere focuses it.
import type { AgentState, TownInfo } from './types';

export class TownPicker {
  private input: HTMLInputElement;
  private list: HTMLElement;
  private towns: TownInfo[] = [];
  private agents: AgentState[] = [];
  private current: string | null = null;
  private shown: TownInfo[] = [];
  private active = 0;
  private key = '';

  constructor(private el: HTMLElement, private onPick: (id: string) => void) {
    el.innerHTML = `<input class="tp-input" type="text" placeholder="Find a town ( / )" aria-label="Find a town" autocomplete="off" spellcheck="false">
      <div class="tp-list" role="listbox" hidden></div>`;
    this.input = el.querySelector('input')!;
    this.list = el.querySelector('.tp-list')!;
    this.input.addEventListener('focus', () => { this.input.select(); this.open(); });
    this.input.addEventListener('input', () => { this.active = 0; this.open(); });
    this.input.addEventListener('blur', () => this.close());
    this.input.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        this.active = (this.active + (e.key === 'ArrowDown' ? 1 : -1) + this.shown.length) % Math.max(1, this.shown.length);
        this.renderList();
      } else if (e.key === 'Enter') {
        e.preventDefault();
        const t = this.shown[this.active];
        if (t) this.pick(t.id);
      } else if (e.key === 'Escape') {
        e.preventDefault();
        this.input.blur();
      }
    });
    // mousedown, not click: picking must happen before the input's blur closes the list
    this.list.addEventListener('mousedown', (e) => {
      const item = (e.target as HTMLElement).closest<HTMLElement>('[data-id]');
      if (!item) return;
      e.preventDefault();
      this.pick(item.dataset.id!);
    });
    addEventListener('keydown', (e) => {
      if (e.key !== '/' || e.metaKey || e.ctrlKey || (e.target as HTMLElement).closest('input, textarea, select')) return;
      e.preventDefault();
      this.input.focus();
    });
  }

  update(towns: TownInfo[], agents: AgentState[], current: string | null) {
    this.towns = towns; this.agents = agents; this.current = current;
    this.el.style.display = towns.length ? '' : 'none';
    if (document.activeElement !== this.input) this.input.value = towns.find((t) => t.id === current)?.name ?? '';
    else this.renderList();
  }

  private pick(id: string) {
    this.input.blur();
    this.onPick(id);
  }

  private open() {
    this.list.hidden = false;
    this.key = '';
    this.renderList();
  }

  private close() {
    this.list.hidden = true;
    this.input.value = this.towns.find((t) => t.id === this.current)?.name ?? '';
  }

  /** Matching towns, best first: name starts with the query, then contains it, then its world does, then (3+ letters) the letters in order in the name. */
  private matches(q: string): TownInfo[] {
    const byWorld = (a: TownInfo, b: TownInfo) => a.world.localeCompare(b.world) || a.name.localeCompare(b.name);
    if (!q) return [...this.towns].sort(byWorld);
    const score = (t: TownInfo) => {
      const n = t.name.toLowerCase(), w = t.world.toLowerCase();
      return n.startsWith(q) ? 0 : n.includes(q) ? 1 : w.startsWith(q) ? 2 : w.includes(q) ? 3 : q.length >= 3 && inOrder(q, n) ? 4 : -1;
    };
    return this.towns.map((t) => [t, score(t)] as const).filter(([, s]) => s >= 0).sort((a, b) => a[1] - b[1] || byWorld(a[0], b[0])).map(([t]) => t);
  }

  private renderList() {
    if (this.list.hidden) return;
    const q = document.activeElement === this.input && this.input.value !== (this.towns.find((t) => t.id === this.current)?.name ?? '')
      ? this.input.value.trim().toLowerCase() : '';
    this.shown = this.matches(q);
    this.active = Math.min(this.active, Math.max(0, this.shown.length - 1));
    const count = (id: string) => {
      const here = this.agents.filter((a) => a.town === id), w = here.filter((a) => a.status === 'waiting').length;
      return `${here.length ? `<span class="tp-n">${here.length}</span>` : ''}${w ? `<span class="wm-badge">${w}</span>` : ''}`;
    };
    let world = '';
    const html = this.shown.map((t, i) => {
      const head = !q && t.world !== world ? `<div class="tp-world">${esc((world = t.world))}</div>` : '';
      return `${head}<div class="tp-item${i === this.active ? ' on' : ''}${t.id === this.current ? ' cur' : ''}" role="option" data-id="${esc(t.id)}">
        <span class="tp-name">${mark(t.name, q)}</span>${q ? `<span class="tp-wname">${mark(t.world, q)}</span>` : ''}${count(t.id)}</div>`;
    }).join('') || '<div class="tp-none">No town matches</div>';
    if (html === this.key) return;
    this.key = html;
    this.list.innerHTML = html;
    this.list.querySelector('.on')?.scrollIntoView({ block: 'nearest' });
  }
}

/** The letters of q appear in s, in order. */
function inOrder(q: string, s: string) {
  let i = 0;
  for (const c of s) if (c === q[i]) i++;
  return i === q.length;
}

/** The name with the matched part in bold. */
function mark(s: string, q: string) {
  const i = q ? s.toLowerCase().indexOf(q) : -1;
  return i < 0 ? esc(s) : `${esc(s.slice(0, i))}<b>${esc(s.slice(i, i + q.length))}</b>${esc(s.slice(i + q.length))}`;
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
