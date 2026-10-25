// The Settings page: a dialog with four tabs. General (day or night, labels, paths, personality lines,
// clock, following new sessions, what a click on a robot does), Notifications (alerts, sound, which
// toasts and for how long), Towns (each repo's town map and building names) and Worlds (which world
// each town belongs to, world names). Changes apply at once; the service keeps them in ~/.agentville.
import type { Settings, ToastKind } from './settings';
import type { TownData, TownInfo } from './types';
import { esc } from './picker';

export interface MapChoice { id: string; name: string }

export interface SettingsHooks {
  get: () => Settings;
  save: (s: Settings) => void;
  towns: () => TownInfo[];
  maps: () => MapChoice[];
  /** a town map's buildings (loads it the first time) */
  mapData: (id: string) => Promise<TownData>;
  townMap: (town: string, map: string) => void;
  buildingName: (town: string, building: string, name: string) => void;
  moveTowns: (towns: string[], world: string) => void;
  tour: () => void;
  /** live mode (demo changes aren't kept) */
  live: boolean;
}

type Tab = 'general' | 'notifications' | 'towns' | 'worlds';
const TABS: [Tab, string][] = [['general', 'General'], ['notifications', 'Notifications'], ['towns', 'Towns'], ['worlds', 'Worlds']];
const TOASTS: [ToastKind, string, string][] = [
  ['needsYou', 'A robot needs you', 'Waiting for a permission or your answer'],
  ['failed', 'Something failed', 'Tests, a build or a deploy'],
  ['finished', 'A session finished', 'It ended its turn and waits for your next prompt'],
  ['sessions', 'Sessions start and end', 'A robot arrives in town, or leaves'],
];

export class SettingsPanel {
  private box: HTMLElement;
  private body: HTMLElement;
  private tab: Tab = 'general';
  /** the town whose buildings are shown (Towns tab) */
  private openTown: string | null = null;
  private key = '';

  constructor(private h: SettingsHooks) {
    this.box = document.createElement('div');
    this.box.id = 'settings';
    this.box.hidden = true;
    this.box.innerHTML = `<div class="st-panel" role="dialog" aria-label="Settings">
      <div class="st-head"><b>Settings</b><nav class="st-tabs">${TABS.map(([t, l]) => `<button data-tab="${t}">${l}</button>`).join('')}</nav><button class="st-x" title="Close (Esc)">✕</button></div>
      <div class="st-body"></div></div>`;
    document.body.append(this.box);
    this.body = this.box.querySelector('.st-body')!;
    this.box.addEventListener('mousedown', (e) => { if (e.target === this.box) this.close(); });
    this.box.querySelector('.st-x')!.addEventListener('click', () => this.close());
    this.box.querySelector('.st-tabs')!.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-tab]')?.dataset.tab as Tab | undefined;
      if (t) { this.tab = t; this.render(true, true); }
    });
    addEventListener('keydown', (e) => { if (e.key === 'Escape' && this.isOpen && !(e.target as HTMLElement).closest?.('input')) this.close(); });
    this.body.addEventListener('change', (e) => this.changed(e.target as HTMLElement));
    this.body.addEventListener('click', (e) => this.clicked(e.target as HTMLElement));
  }

  get isOpen() { return !this.box.hidden; }

  open(tab?: Tab) {
    if (tab) this.tab = tab;
    this.box.hidden = false;
    this.render(true, true);
  }

  close() { this.box.hidden = true; }

  /** Settings, towns or worlds changed: draw again (not while you're typing in a box). */
  refresh() {
    if (!this.isOpen || this.body.contains(document.activeElement) && (document.activeElement as HTMLElement).matches('input[type=text]')) return;
    this.render();
  }

  /** `force`: draw even if nothing changed; `toTop`: a new tab starts at the top (otherwise your scroll stays) */
  private render(force = false, toTop = false) {
    this.box.querySelectorAll<HTMLElement>('[data-tab]').forEach((b) => b.classList.toggle('on', b.dataset.tab === this.tab));
    const html = this.tab === 'general' ? this.general() : this.tab === 'notifications' ? this.notifications() : this.tab === 'towns' ? this.townsTab() : this.worldsTab();
    if (!force && html === this.key) return;
    this.key = html;
    const top = this.body.scrollTop;
    this.body.innerHTML = html;
    this.body.scrollTop = toTop ? 0 : top;
    if (this.tab === 'towns' && this.openTown) this.fillBuildings(this.openTown);
  }

  // —— General ——
  private general() {
    const s = this.h.get();
    return `${this.choice('time', 'Day or night', 'System follows your Mac\'s light or dark mode', s.time, [['day', 'Day'], ['night', 'Night'], ['system', 'System']])}
      ${this.toggle('labels', 'Building labels', 'Folder names on the buildings', s.labels)}
      ${this.toggle('paths', 'Roads', 'Show the roads robots walk', s.paths)}
      ${this.toggle('lines', 'Robot lines', 'A short line when a robot starts, finishes, passes or fails', s.lines)}
      ${this.choice('clock', 'Clock', 'In the top bar', s.clock, [['off', 'Off'], ['12h', '12-hour'], ['24h', '24-hour']])}
      ${this.toggle('followNew', 'Follow new sessions', 'Go to the town where a session just started', s.followNew)}
      ${this.choice('clickOpens', 'Clicking a robot', this.h.live ? 'Its session opens in its app (Terminal, VS Code, Claude…)' : 'Opening the session works with your real sessions', s.clickOpens, [['details', 'Shows its details'], ['session', 'Opens its session']])}
      <div class="st-row"><div><div class="st-l">Tour</div><div class="st-d">A quick look at each part of Agentville</div></div><button class="st-btn" data-act="tour">Take the tour</button></div>`;
  }

  // —— Notifications ——
  private notifications() {
    const s = this.h.get();
    return `${this.toggle('alerts', 'Needs-you alerts', 'A notification when a robot needs you', s.alerts)}
      ${this.toggle('sound', 'Sound', 'A chime with each alert', s.sound)}
      <h4>Toasts in the page</h4>
      ${TOASTS.map(([k, l, d]) => this.toggle(`toasts.${k}`, l, d, s.toasts[k])).join('')}
      ${this.choice('toastTime', 'Toasts stay up', '', s.toastTime, [['short', 'Short'], ['normal', 'Normal'], ['long', 'Long']])}`;
  }

  // —— Towns ——
  private townsTab() {
    const towns = this.h.towns(), maps = this.h.maps();
    if (!towns.length) return '<p class="st-empty">No towns yet. A town appears when a Claude Code session works in a repo.</p>';
    let world = '';
    return `<p class="st-note">Each repo is a town. Pick its look, and rename its buildings if you like.${this.h.live ? '' : ' (Demo: changes last until you reload.)'}</p>` + towns.map((t) => {
      const head = t.world !== world ? `<h4>${esc((world = t.world))}</h4>` : '';
      const select = t.mapPinned ? `<span class="st-d" title="Set by agentville.json in the repo">${esc(maps.find((m) => m.id === t.map)?.name ?? t.map)} (agentville.json)</span>`
        : `<select data-town="${esc(t.id)}" data-k="map"${this.h.live ? '' : ' disabled title="Changing a town\'s look works with your real sessions"'}>${maps.map((m) => `<option value="${esc(m.id)}"${m.id === t.map ? ' selected' : ''}>${esc(m.name)}</option>`).join('')}</select>`;
      const open = this.openTown === t.id;
      return `${head}<div class="st-row town"><div><div class="st-l">${esc(t.name)}</div><div class="st-d">${esc(t.id)}</div></div>
        <div class="st-ctl">${select}<button class="st-btn small" data-act="buildings" data-town="${esc(t.id)}">${open ? 'Hide buildings' : 'Buildings'}</button></div></div>
        ${open ? `<div class="st-buildings" data-for="${esc(t.id)}">Loading…</div>` : ''}`;
    }).join('');
  }

  /** The building names of one town, once its map is loaded. */
  private fillBuildings(id: string) {
    const t = this.h.towns().find((x) => x.id === id);
    if (!t) return;
    this.h.mapData(t.map).then((m) => {
      const el = this.body.querySelector<HTMLElement>(`.st-buildings[data-for="${CSS.escape(id)}"]`);
      if (!el) return;
      const rows = Object.entries(m.buildings).filter(([, b]) => b.role !== 'station' && b.role !== 'plaza').map(([b, def]) => {
        const folders = t.folders[b]?.join(', ') ?? '';
        return `<label class="st-b"><span class="st-d">${esc(def.name)}${folders ? ` · ${esc(folders)}` : ''}</span>
          <input type="text" maxlength="40" placeholder="${esc(def.name)}" value="${esc(t.names[b] ?? '')}" data-town="${esc(id)}" data-building="${esc(b)}"></label>`;
      }).join('');
      el.innerHTML = `<div class="st-d">Leave a box empty to keep the map's own name.</div>${rows}`;
    });
  }

  // —— Worlds ——
  private worldsTab() {
    const towns = this.h.towns();
    if (!towns.length) return '<p class="st-empty">No worlds yet.</p>';
    const worlds = [...new Set(towns.map((t) => t.world))].sort();
    return `<p class="st-note">A world is a project: the towns (repos) you work on together. Rename a world, or move a town to another one.${this.h.live ? ' Kept in ~/.agentville/worlds.json.' : ' (Demo: changes last until you reload.)'}</p>` + worlds.map((w) => {
      const list = towns.filter((t) => t.world === w);
      return `<div class="st-world"><input type="text" class="st-wname" maxlength="40" value="${esc(w)}" data-world="${esc(w)}" title="Rename this world">
        ${list.map((t) => `<div class="st-row town"><div class="st-l">${esc(t.name)}</div>
          <select data-town="${esc(t.id)}" data-k="world">${worlds.map((x) => `<option value="${esc(x)}"${x === w ? ' selected' : ''}>${esc(x)}</option>`).join('')}<option value="__new">New world…</option></select></div>`).join('')}</div>`;
    }).join('');
  }

  // —— pieces ——
  private toggle(k: string, label: string, desc: string, on: boolean) {
    return `<label class="st-row"><div><div class="st-l">${label}</div>${desc ? `<div class="st-d">${desc}</div>` : ''}</div>
      <input type="checkbox" class="st-switch" data-k="${k}"${on ? ' checked' : ''}></label>`;
  }

  private choice(k: string, label: string, desc: string, value: string, opts: [string, string][]) {
    return `<div class="st-row"><div><div class="st-l">${label}</div>${desc ? `<div class="st-d">${desc}</div>` : ''}</div>
      <div class="st-seg">${opts.map(([v, l]) => `<button data-k="${k}" data-v="${v}" class="${v === value ? 'on' : ''}">${l}</button>`).join('')}</div></div>`;
  }

  private set(k: string, v: unknown) {
    const s = structuredClone(this.h.get());
    if (k.startsWith('toasts.')) s.toasts[k.slice(7) as ToastKind] = v as boolean;
    else (s as any)[k] = v;
    this.h.save(s);
    this.render();
  }

  private changed(el: HTMLElement) {
    if (el instanceof HTMLInputElement && el.type === 'checkbox' && el.dataset.k) return this.set(el.dataset.k, el.checked);
    if (el instanceof HTMLSelectElement && el.dataset.k === 'map') return this.h.townMap(el.dataset.town!, el.value);
    if (el instanceof HTMLSelectElement && el.dataset.k === 'world') {
      let w = el.value;
      if (w === '__new') {
        w = prompt('Name of the new world')?.trim() ?? '';
        if (!w) { this.render(true); return; }
      }
      return this.h.moveTowns([el.dataset.town!], w);
    }
    if (el instanceof HTMLInputElement && el.dataset.building) return this.h.buildingName(el.dataset.town!, el.dataset.building, el.value);
    if (el instanceof HTMLInputElement && el.dataset.world !== undefined) {
      const from = el.dataset.world, to = el.value.trim();
      if (!to || to === from) { el.value = from; return; }
      this.h.moveTowns(this.h.towns().filter((t) => t.world === from).map((t) => t.id), to);
    }
  }

  private clicked(el: HTMLElement) {
    const seg = el.closest<HTMLElement>('.st-seg [data-k]');
    if (seg) return this.set(seg.dataset.k!, seg.dataset.v);
    const act = el.closest<HTMLElement>('[data-act]');
    if (act?.dataset.act === 'tour') { this.close(); this.h.tour(); }
    if (act?.dataset.act === 'buildings') { const id = act.dataset.town!; this.openTown = this.openTown === id ? null : id; this.render(true); }
  }
}
