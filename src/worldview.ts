// The world map: a painted map of one project's towns, over the town view. Each town map (Frostpeak,
// Maplewood…) has its spot on the painted map; a town that shares its map with an earlier one in the
// same world becomes a signpost along the railway. A train runs on the painted track.
import type { AgentState, TownInfo } from './types';

/** A painted world map (public/worlds/<id>/world.json). */
export interface WorldMapArt {
  id: string;
  name: string;
  image: string;
  size: [number, number];
  /** per town map id: its display name, where its town is drawn, and its station on the railway (image px) */
  towns: Record<string, { name: string; spot: [number, number]; station: [number, number] }>;
  /** the railway as a polyline (image px), for the train and the signposts */
  railway: [number, number][];
}

/** Loads a world map; image becomes a URL. Later, the map can be chosen by how many towns a world has. */
export async function loadWorldArt(id = 'valley'): Promise<WorldMapArt> {
  const res = await fetch(`worlds/${id}/world.json`);
  if (!res.ok) throw new Error(`Couldn't load world map "${id}"`);
  const w: WorldMapArt = await res.json();
  w.image = `worlds/${id}/${w.image}`;
  return w;
}

export interface WorldMapData {
  /** every town, any world */
  towns: TownInfo[];
  /** every robot, any town */
  agents: AgentState[];
  /** the world to show */
  world: string;
  /** the town open in the town view (highlighted) */
  current: string | null;
  /** robot color name -> CSS color */
  colors: Record<string, string>;
}

export interface WorldMapEvents {
  openTown: (id: string) => void;
  showWorld: (world: string) => void;
}

/** Draws the world map into `el`; call update() as robots and towns change (it only redraws what changed). */
export class WorldMap {
  private keys = { head: '', marks: '' };
  private head: HTMLElement;
  private box: HTMLElement;
  private marks: HTMLElement;
  /** where each town meets the railway (its map's station, or its signpost), image px */
  private onRail = new Map<string, [number, number]>();

  constructor(private el: HTMLElement, private art: WorldMapArt, private on: WorldMapEvents) {
    const [W, H] = art.size;
    const rail = 'M' + art.railway.map(([x, y]) => `${x},${y}`).join(' L');
    el.innerHTML = `<div class="wm-head"></div><div class="wm-map"><div class="wm-box">
      <img class="wm-art" src="${art.image}" alt="">
      <svg class="wm-train" viewBox="0 0 ${W} ${H}"><circle r="9"><animateMotion dur="40s" repeatCount="indefinite" keyPoints="0;1;0" keyTimes="0;0.5;1" calcMode="linear" path="${rail}"/></circle></svg>
      <div class="wm-marks"></div></div></div>`;
    this.head = el.querySelector('.wm-head')!;
    this.box = el.querySelector('.wm-box')!;
    this.marks = el.querySelector('.wm-marks')!;
    // keep the painted map's proportions inside whatever space the page gives it
    const fit = () => {
      const area = el.querySelector<HTMLElement>('.wm-map')!;
      const s = Math.min(area.clientWidth / W, area.clientHeight / H);
      Object.assign(this.box.style, { width: `${W * s}px`, height: `${H * s}px` });
    };
    new ResizeObserver(fit).observe(el);
    el.addEventListener('click', (e) => {
      const t = (e.target as HTMLElement).closest<HTMLElement>('[data-town],[data-world]');
      if (t?.dataset.town) this.on.openTown(t.dataset.town);
      else if (t?.dataset.world) this.on.showWorld(t.dataset.world);
    });
  }

  update(d: WorldMapData) {
    const here = d.towns.filter((t) => t.world === d.world);
    const robots = (id: string) => d.agents.filter((a) => a.town === id);
    const waiting = (list: AgentState[]) => list.filter((a) => a.status === 'waiting').length;
    const [W, H] = this.art.size;
    const pct = ([x, y]: [number, number]) => `left:${(100 * x / W).toFixed(2)}%;top:${(100 * y / H).toFixed(2)}%`;

    // header: world name, totals, and tabs for the other worlds
    const worlds = [...new Set(d.towns.map((t) => t.world))];
    const all = here.flatMap((t) => robots(t.id));
    const tabs = worlds.length > 1 ? `<div class="wm-tabs">${worlds.map((w) => {
      const n = waiting(d.agents.filter((a) => d.towns.find((t) => t.id === a.town)?.world === w));
      return `<button data-world="${esc(w)}" class="${w === d.world ? 'on' : ''}">${esc(w)}${n ? ` <span class="wm-badge">${n}</span>` : ''}</button>`;
    }).join('')}</div>` : '';
    const n = waiting(all);
    const head = `<div><div class="wm-title">${esc(d.world)}</div><div class="wm-sub">${plural(here.length, 'town')} · ${plural(all.length, 'robot')}${n ? ` · <b>${n} need${n === 1 ? 's' : ''} you</b>` : ''}</div></div>${tabs}`;
    if (head !== this.keys.head) { this.keys.head = head; this.head.innerHTML = head; }

    const dots = (list: AgentState[]) => list.slice(0, 10).map((a) =>
      `<span class="wm-dot ${a.status}${a.parentId ? ' sub' : ''}" style="background:${d.colors[a.color] ?? '#999'}" title="${esc(a.name)}"></span>`).join('')
      + (list.length > 10 ? `<span class="wm-more">+${list.length - 10}</span>` : '');
    const mark = (t: TownInfo, cls: string, at: [number, number], sub: string) => {
      const list = robots(t.id), w = waiting(list);
      return `<div class="wm-mark ${cls}${t.id === d.current ? ' current' : ''}${w ? ' needs' : ''}" data-town="${esc(t.id)}" style="${pct(at)}">
        <div class="wm-name">${esc(t.name)}${w ? ` <span class="wm-badge">${w}</span>` : ''}</div>
        <div class="wm-meta">${list.length ? dots(list) : `<span class="wm-quiet">${sub}</span>`}</div></div>`;
    };

    // each town map's spot: the town holding it, or the map's own name, dimmed, if no repo has it yet
    const spots = Object.entries(this.art.towns).map(([mapId, s]) => {
      const t = here.find((x) => x.map === mapId && x.spot);
      return t ? mark(t, 'spot', s.spot, s.name)
        : `<div class="wm-mark spot free" style="${pct(s.spot)}"><div class="wm-name">${esc(s.name)}</div><div class="wm-meta"><span class="wm-quiet">No repo yet</span></div></div>`;
    });
    // the rest: signposts in the open stretches of railway between the stations
    const extra = here.filter((t) => !(t.spot && t.map in this.art.towns));
    const at = postSpots(this.art, extra.length);
    this.onRail = new Map([
      ...here.filter((t) => t.spot && t.map in this.art.towns).map((t) => [t.id, this.art.towns[t.map].station] as [string, [number, number]]),
      ...extra.map((t, i) => [t.id, at[i]] as [string, [number, number]]),
    ]);
    const posts = extra.map((t, i) => mark(t, 'post', at[i], 'Signpost'));
    const marks = spots.join('') + posts.join('');
    if (marks !== this.keys.marks) { this.keys.marks = marks; this.marks.innerHTML = marks; }
  }

  /** A robot went from one town to another: a train in its colour runs along the painted railway between them. */
  trip(from: string, to: string, color: string) {
    const a = this.onRail.get(from), b = this.onRail.get(to);
    if (!a || !b) return;
    const rail = this.art.railway, fa = fraction(rail, a), fb = fraction(rail, b);
    if (Math.abs(fa - fb) < 0.005) return;
    const pts = Array.from({ length: 41 }, (_, i) => along(rail, fa + ((fb - fa) * i) / 40));
    const total = pts.slice(1).reduce((n, p, i) => n + Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]), 0);
    const dur = total / 160 + 1.2;
    const svg = this.box.querySelector('svg.wm-train')!;
    svg.insertAdjacentHTML('beforeend', `<g class="wb-trip"><circle r="11" fill="${esc(color)}"/><circle r="11" class="wb-trip-ring"/><animateMotion dur="${dur.toFixed(2)}s" begin="indefinite" fill="freeze" calcMode="spline" keyTimes="0;1" keySplines="0.45 0 0.55 1" path="M${pts.map(([x, y]) => `${x.toFixed(1)},${y.toFixed(1)}`).join(' L')}"/></g>`);
    const g = svg.lastElementChild as SVGGElement;
    (g.querySelector('animateMotion') as SVGAnimationElement).beginElement();
    setTimeout(() => g.remove(), (dur + 0.6) * 1000);
  }
}

/**
 * Where n signposts go: the railway is cut at its stations into stretches; signposts are shared out
 * over the longest stretches and spaced evenly inside each, so they don't crowd a town.
 */
function postSpots(art: WorldMapArt, n: number): [number, number][] {
  if (!n) return [];
  const rail = art.railway;
  const stops = [0, 1, ...Object.values(art.towns).map((t) => fraction(rail, t.station))].sort((a, b) => a - b);
  const stretches = stops.slice(1).map((end, i) => ({ from: stops[i], to: end, count: 0 })).filter((s) => s.to - s.from > 0.02);
  for (let i = 0; i < n; i++) {
    // the stretch with the most room per signpost gets the next one
    const s = stretches.reduce((best, x) => ((x.to - x.from) / (x.count + 1) > (best.to - best.from) / (best.count + 1) ? x : best));
    s.count++;
  }
  return stretches.flatMap((s) => Array.from({ length: s.count }, (_, k) => along(rail, s.from + ((k + 1) * (s.to - s.from)) / (s.count + 1))));
}

/** How far along a polyline (0–1) the vertex nearest to p is. */
function fraction(pts: [number, number][], p: [number, number]): number {
  let best = 0, bestD = Infinity, run = 0, at = 0;
  const total = pts.slice(1).reduce((a, q, i) => a + Math.hypot(q[0] - pts[i][0], q[1] - pts[i][1]), 0);
  pts.forEach((q, i) => {
    if (i) run += Math.hypot(q[0] - pts[i - 1][0], q[1] - pts[i - 1][1]);
    const d = Math.hypot(q[0] - p[0], q[1] - p[1]);
    if (d < bestD) { bestD = d; best = i; at = run; }
  });
  return best === 0 ? 0 : at / total;
}

/** The point a fraction `f` (0–1) of the way along a polyline. */
function along(pts: [number, number][], f: number): [number, number] {
  const seg = pts.slice(1).map((p, i) => Math.hypot(p[0] - pts[i][0], p[1] - pts[i][1]));
  let left = f * seg.reduce((a, b) => a + b, 0);
  for (let i = 0; i < seg.length; i++) {
    if (left <= seg[i]) { const t = left / seg[i]; return [pts[i][0] + t * (pts[i + 1][0] - pts[i][0]), pts[i][1] + t * (pts[i + 1][1] - pts[i][1])]; }
    left -= seg[i];
  }
  return pts[pts.length - 1];
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
