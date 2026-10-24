// The world board: a world map laid out by code, so a project can have any number of towns.
// Each town is a round vignette of its own town map; a railway joins neighbouring towns without
// crossings (a minimum spanning tree plus a few short extra lines for loops), with trains on it.
// The ground is the world's own patch of the planet, blurred, so a desert world sits on desert.
import type { AgentState, TownInfo } from './types';

export interface BoardData {
  towns: TownInfo[];
  agents: AgentState[];
  world: string;
  current: string | null;
  colors: Record<string, string>;
  /** picture of a town map (its town.jpg) */
  image: (town: TownInfo) => string;
  /** the planet picture and where this world sits on it (0–1 across, 0–1 down), for the ground */
  ground?: { image: string; u: number; v: number };
}

export interface BoardEvents {
  openTown: (id: string) => void;
  showWorld: (world: string) => void;
}

const GAP = 210; // px between town centres
const SIZE = 118, BIG = 150; // vignette diameters (the primary town is bigger)

/** Draws the board into `el`; call update() as robots and towns change. */
export class WorldBoard {
  private head: HTMLElement;
  private view: HTMLElement;
  private sheet: HTMLElement;
  private ground: HTMLElement;
  private keys = { head: '', layout: '', towns: '', ground: '' };
  private pos = new Map<string, [number, number]>();
  private zoom = 1;
  private pan: [number, number] = [0, 0];
  private fitted = '';
  private drag: { x: number; y: number; px: number; py: number; moved: boolean } | null = null;
  private dragged = false;
  /** the railway as drawn: town ids, their positions and the lines between them (index pairs) */
  private net?: { ids: string[]; P: [number, number][]; edges: [number, number][] };

  constructor(private el: HTMLElement, private on: BoardEvents) {
    el.innerHTML = `<div class="wb-ground"></div><div class="wm-head"></div>
      <div class="wb-view"><div class="wb-sheet"><svg class="wb-rails"></svg><div class="wb-towns"></div></div></div>
      <div class="pl-zoom wb-zoom"><button data-zoom="in" title="Zoom in">+</button><button data-zoom="out" title="Zoom out">−</button><button data-zoom="fit" title="All towns">⤢</button></div>`;
    this.head = el.querySelector('.wm-head')!;
    this.view = el.querySelector('.wb-view')!;
    this.sheet = el.querySelector('.wb-sheet')!;
    this.ground = el.querySelector('.wb-ground')!;
    // drag to pan, wheel or pinch to zoom
    this.view.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault();
      this.drag = { x: e.clientX, y: e.clientY, px: this.pan[0], py: this.pan[1], moved: false };
      this.dragged = false;
    });
    addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      if (Math.hypot(e.clientX - d.x, e.clientY - d.y) > 4) d.moved = true;
      if (d.moved) { this.pan = [d.px + e.clientX - d.x, d.py + e.clientY - d.y]; this.apply(); }
    });
    addEventListener('pointerup', () => { if (this.drag?.moved) this.dragged = true; this.drag = null; });
    this.view.addEventListener('wheel', (e) => {
      e.preventDefault();
      const r = this.view.getBoundingClientRect();
      this.zoomAt(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    el.querySelector('.wb-zoom')!.addEventListener('click', (e) => {
      const z = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
      if (z === 'in') this.zoomAt(1.3); else if (z === 'out') this.zoomAt(1 / 1.3); else if (z === 'fit') this.fit();
    });
    el.addEventListener('click', (e) => {
      if (this.dragged) { this.dragged = false; return; }
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-town],[data-world]');
      if (t?.dataset.town) this.on.openTown(t.dataset.town);
      else if (t?.dataset.world) this.on.showWorld(t.dataset.world);
    });
    new ResizeObserver(() => this.fit()).observe(this.view);
  }

  update(d: BoardData) {
    const here = order(d.towns.filter((t) => t.world === d.world));
    const robots = (id: string) => d.agents.filter((a) => a.town === id);
    const waiting = (l: AgentState[]) => l.filter((a) => a.status === 'waiting').length;

    // header: world name, totals, tabs for the other worlds (same look as the painted map)
    const worlds = [...new Set(d.towns.map((t) => t.world))];
    const all = here.flatMap((t) => robots(t.id)), n = waiting(all);
    const tabs = worlds.length > 1 ? `<div class="wm-tabs">${worlds.map((w) => {
      const k = waiting(d.agents.filter((a) => d.towns.find((t) => t.id === a.town)?.world === w));
      return `<button data-world="${esc(w)}" class="${w === d.world ? 'on' : ''}">${esc(w)}${k ? ` <span class="wm-badge">${k}</span>` : ''}</button>`;
    }).join('')}</div>` : '';
    const head = `<div><div class="wm-title">${esc(d.world)}</div><div class="wm-sub">${plural(here.length, 'town')} · ${plural(all.length, 'robot')}${n ? ` · <b>${n} need${n === 1 ? 's' : ''} you</b>` : ''}</div></div>${tabs}`;
    if (head !== this.keys.head) { this.keys.head = head; this.head.innerHTML = head; }

    // the ground: this world's patch of the planet
    const g = d.ground ? `${d.ground.image}|${d.ground.u.toFixed(4)}|${d.ground.v.toFixed(4)}` : '';
    if (g !== this.keys.ground) { this.keys.ground = g; this.paintGround(d.ground); }

    // layout and railway change only when the set of towns does
    const layout = here.map((t) => t.id).join('|');
    if (layout !== this.keys.layout) {
      this.keys.layout = layout;
      this.pos = place(here);
      this.drawRails(here);
      if (this.fitted !== d.world + layout) { this.fitted = d.world + layout; requestAnimationFrame(() => this.fit()); }
    }

    // town vignettes
    const html = here.map((t) => {
      const list = robots(t.id), w = waiting(list), [x, y] = this.pos.get(t.id)!;
      const size = t.primary ? BIG : SIZE;
      const dots = list.slice(0, 8).map((a) => `<span class="wm-dot ${a.status}${a.parentId ? ' sub' : ''}" style="background:${d.colors[a.color] ?? '#999'}"></span>`).join('')
        + (list.length > 8 ? `<span class="wm-more">+${list.length - 8}</span>` : '');
      return `<div class="wb-town${t.id === d.current ? ' current' : ''}${w ? ' needs' : ''}${t.primary ? ' primary' : ''}" data-town="${esc(t.id)}" style="left:${x}px;top:${y}px;transform:translate(-50%,-${size / 2}px)">
        <div class="wb-pic" style="width:${size}px;height:${size}px;background-image:url('${esc(d.image(t))}')"></div>
        <div class="wb-label"><b>${esc(t.name)}</b>${w ? ` <span class="wm-badge">${w}</span>` : ''}<div class="wm-meta">${dots || '<span class="wm-quiet">No robots</span>'}</div></div></div>`;
    }).join('') || '<div class="wm-empty">No towns yet. They appear when Claude Code works in a repo.</div>';
    if (html !== this.keys.towns) { this.keys.towns = html; this.sheet.querySelector('.wb-towns')!.innerHTML = html; }
  }

  /**
   * A robot went from one town to another: a train in its colour runs along the railway between
   * them (over the fewest lines), then disappears.
   */
  trip(from: string, to: string, color: string) {
    const n = this.net;
    if (!n) return;
    const a = n.ids.indexOf(from), b = n.ids.indexOf(to);
    if (a < 0 || b < 0 || a === b) return;
    const prev = new Map<number, number>([[a, -1]]), queue = [a];
    while (queue.length) {
      const u = queue.shift()!;
      if (u === b) break;
      for (const [x, y] of n.edges) { const v = x === u ? y : y === u ? x : -1; if (v >= 0 && !prev.has(v)) { prev.set(v, u); queue.push(v); } }
    }
    if (!prev.has(b)) return;
    const hops: [number, number][] = [];
    for (let v = b; v !== a; v = prev.get(v)!) hops.unshift([prev.get(v)!, v]);
    let d = `M${n.P[a][0]},${n.P[a][1]}`, len = 0;
    for (const [u, v] of hops) {
      // the same curve as drawn, whichever way the line was stored
      const e = n.edges.find(([x, y]) => (x === u && y === v) || (x === v && y === u))!;
      const [cx, cy] = bendOf(n.P, e[0], e[1]);
      d += ` Q${cx},${cy} ${n.P[v][0]},${n.P[v][1]}`;
      len += Math.hypot(n.P[v][0] - n.P[u][0], n.P[v][1] - n.P[u][1]);
    }
    const dur = len / 110 + 1.2;
    const svg = this.sheet.querySelector('svg')!;
    svg.insertAdjacentHTML('beforeend', `<g class="wb-trip"><circle r="9" fill="${esc(color)}"/><circle r="9" class="wb-trip-ring"/><animateMotion dur="${dur.toFixed(2)}s" begin="indefinite" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.55 1" path="${d}"/></g>`);
    const g = svg.lastElementChild as SVGGElement;
    (g.querySelector('animateMotion') as SVGAnimationElement).beginElement();
    setTimeout(() => g.remove(), (dur + 0.6) * 1000);
  }

  /** Show every town, centred. */
  fit() {
    const pts = [...this.pos.values()];
    const vw = this.view.clientWidth, vh = this.view.clientHeight;
    if (!pts.length || !vw) return;
    const xs = pts.map((p) => p[0]), ys = pts.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs) + GAP * 1.3, bh = Math.max(...ys) - Math.min(...ys) + GAP * 1.5;
    this.zoom = Math.min(1.25, vw / bw, vh / bh);
    const cx = (Math.max(...xs) + Math.min(...xs)) / 2, cy = (Math.max(...ys) + Math.min(...ys)) / 2 + 12;
    this.pan = [vw / 2 - cx * this.zoom, vh / 2 - cy * this.zoom];
    this.apply();
  }

  private zoomAt(f: number, x = this.view.clientWidth / 2, y = this.view.clientHeight / 2) {
    const z = Math.max(0.25, Math.min(3, this.zoom * f));
    this.pan = [x - ((x - this.pan[0]) * z) / this.zoom, y - ((y - this.pan[1]) * z) / this.zoom];
    this.zoom = z;
    this.apply();
  }

  private apply() {
    this.sheet.style.transform = `translate(${this.pan[0]}px, ${this.pan[1]}px) scale(${this.zoom})`;
    // labels grow as you zoom out so names stay readable; far out, only names and needs-you badges
    this.sheet.style.setProperty('--label', String(Math.min(1.7, Math.max(1, 1 / this.zoom))));
    this.sheet.classList.toggle('far', this.zoom < 0.5);
  }

  private paintGround(g?: { image: string; u: number; v: number }) {
    if (!g) { this.ground.style.backgroundImage = ''; return; }
    // a patch about a fifth of the planet's width, centred on the world's clearing
    const f = 0.2, vw = this.el.clientWidth || 1000, vh = this.el.clientHeight || 600;
    const fv = Math.min(0.95, (2 * f * vh) / vw); // visible share of the planet's height
    const px = ((g.u - f / 2) / (1 - f)) * 100, py = ((g.v - fv / 2) / (1 - fv)) * 100;
    Object.assign(this.ground.style, {
      backgroundImage: `url('${g.image}')`, backgroundSize: `${100 / f}% auto`,
      backgroundPosition: `${Math.max(0, Math.min(100, px))}% ${Math.max(0, Math.min(100, py))}%`,
    });
  }

  /** Railway: minimum spanning tree, plus short extra lines that cross nothing, drawn as gentle curves. */
  private drawRails(towns: TownInfo[]) {
    const ids = towns.map((t) => t.id), P = ids.map((id) => this.pos.get(id)!);
    const edges = network(P);
    this.net = { ids, P, edges };
    const curve = (a: number, b: number) => { const [cx, cy] = bendOf(P, a, b); return `M${P[a][0]},${P[a][1]} Q${cx},${cy} ${P[b][0]},${P[b][1]}`; };
    const paths = edges.map(([a, b]) => curve(a, b));
    const longest = edges.map((e, i) => [Math.hypot(P[e[0]][0] - P[e[1]][0], P[e[0]][1] - P[e[1]][1]), i]).sort((a, b) => b[0] - a[0]).slice(0, 3);
    const svg = this.sheet.querySelector('svg')!;
    svg.innerHTML = paths.map((p) => `<path d="${p}" class="wb-bed"/><path d="${p}" class="wb-ties"/><path d="${p}" class="wb-rail"/>`).join('')
      + longest.map(([len, i], k) => `<circle r="7" class="wb-train"><animateMotion dur="${(len / 60 + 4).toFixed(1)}s" begin="${k * 1.7}s" repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear" path="${paths[i]}"/></circle>`).join('');
  }
}

/** The control point of the gentle curve drawn for the line from town a to town b (in that order). */
function bendOf(P: [number, number][], a: number, b: number): [number, number] {
  const [x1, y1] = P[a], [x2, y2] = P[b], mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
  const len = Math.hypot(x2 - x1, y2 - y1) || 1, bend = ((a * 7 + b * 13) % 2 ? 1 : -1) * 0.12 * len;
  return [mx + ((y1 - y2) / len) * bend, my + ((x2 - x1) / len) * bend];
}

/** Primary town first (it goes in the middle), then the rest by name. */
function order(towns: TownInfo[]) {
  return [...towns].sort((a, b) => Number(b.primary) - Number(a.primary) || a.name.localeCompare(b.name));
}

/**
 * Town centres in px: a sunflower spiral from the middle (the primary town at the centre), then
 * pushed apart until no two are closer than GAP. Same towns, same layout.
 */
function place(towns: TownInfo[]) {
  const pts = towns.map((_, i) => [GAP * 0.9 * Math.sqrt(i) * Math.cos(i * 2.39996), GAP * 0.62 * Math.sqrt(i) * Math.sin(i * 2.39996)]);
  for (let it = 0; it < 80; it++) for (let i = 0; i < pts.length; i++) for (let j = i + 1; j < pts.length; j++) {
    const dx = pts[j][0] - pts[i][0], dy = (pts[j][1] - pts[i][1]) * 1.4, d = Math.hypot(dx, dy) || 1;
    if (d >= GAP) continue;
    const push = (GAP - d) / 2 / d;
    if (i > 0) { pts[i][0] -= dx * push; pts[i][1] -= (dy * push) / 1.4; } // the primary town stays put
    pts[j][0] += dx * push; pts[j][1] += (dy * push) / 1.4;
  }
  return new Map(towns.map((t, i) => [t.id, [Math.round(pts[i][0]), Math.round(pts[i][1])] as [number, number]]));
}

/** Railway lines as index pairs: a minimum spanning tree, then each town's two nearest neighbours if the line is short and crosses nothing. */
function network(P: [number, number][]): [number, number][] {
  const n = P.length, d = (a: number, b: number) => Math.hypot(P[a][0] - P[b][0], P[a][1] - P[b][1]);
  if (n < 2) return [];
  const edges: [number, number][] = [], inTree = new Set([0]);
  while (inTree.size < n) { // Prim
    let best: [number, number] | null = null;
    for (const a of inTree) for (let b = 0; b < n; b++) if (!inTree.has(b) && (!best || d(a, b) < d(best[0], best[1]))) best = [a, b];
    edges.push(best!); inTree.add(best![1]);
  }
  const longest = Math.max(...edges.map(([a, b]) => d(a, b)));
  const has = (a: number, b: number) => edges.some(([x, y]) => (x === a && y === b) || (x === b && y === a));
  for (let a = 0; a < n; a++) {
    const near = [...Array(n).keys()].filter((b) => b !== a).sort((x, y) => d(a, x) - d(a, y)).slice(0, 2);
    for (const b of near) {
      if (has(a, b) || d(a, b) > longest * 1.25) continue;
      if (edges.some(([x, y]) => x !== a && x !== b && y !== a && y !== b && crosses(P[a], P[b], P[x], P[y]))) continue;
      edges.push([a, b]);
    }
  }
  return edges;
}

function crosses(p: number[], q: number[], r: number[], s: number[]) {
  const o = (a: number[], b: number[], c: number[]) => Math.sign((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]));
  return o(p, q, r) !== o(p, q, s) && o(r, s, p) !== o(r, s, q);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
