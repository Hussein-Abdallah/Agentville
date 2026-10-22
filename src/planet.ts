// The planet: every world (project) as a glowing settlement on a slowly spinning globe.
// Each screen pixel of the disc maps to a point of an equirectangular planet picture
// (public/planet/planet.jpg, or a placeholder drawn in code when it's missing), shifted by the
// spin; shading and the night side are added here, not painted. It's drawn with WebGL2 at the
// screen's full resolution with smooth sampling; without WebGL2, on a small 2D canvas instead.
// public/planet/planet.json lists the picture's clearings, where worlds settle, by landscape.
import type { AgentState, TownInfo } from './types';

export interface PlanetData {
  /** every town, any world */
  towns: TownInfo[];
  /** every robot, any town */
  agents: AgentState[];
  /** the world you're in (its settlement is highlighted) */
  current: string | null;
}

/** public/planet/planet.json: the picture and its clearings (radians), with the landscape of each. */
interface PlanetArt {
  /** changes with the picture, so worlds saved on an older picture settle again */
  id: string;
  image: string;
  /** town map id -> landscapes it fits, best first (a world settles where its first town would fit) */
  prefer: Record<string, string[]>;
  spots: { lat: number; lon: number; land: string }[];
}

export interface PlanetEvents {
  openWorld: (world: string) => void;
}

const SIZE = 440; // globe resolution in canvas px (scaled with CSS)
const TILT = -0.15; // starting tilt: north pole tipped a little toward the viewer (radians)
const MAX_TILT = Math.PI / 2; // drag up or down as far as either pole, not past it
const MAX_ZOOM = 5;
const SPIN = 0.06; // radians per second
const LIGHT = norm([-0.55, 0.35, 0.76]); // from the upper left, in view space

/** Draws the globe into `el`; call update() as worlds and robots change, show() when it's visible. */
export class PlanetView {
  private canvas: HTMLCanvasElement;
  private gl: GlobeGL | null;
  private ctx?: CanvasRenderingContext2D;
  private frame?: ImageData;
  private tex?: { data: Uint8ClampedArray; w: number; h: number };
  // per pixel of the disc (-1 row = outside): where it lands on the sphere, its light and edge alpha,
  // and, once the picture is loaded, its picture row offset and column (before the spin)
  private lat = new Float32Array(SIZE * SIZE);
  private lon = new Float32Array(SIZE * SIZE);
  private light = new Float32Array(SIZE * SIZE);
  private alpha = new Uint8ClampedArray(SIZE * SIZE);
  private row = new Int32Array(SIZE * SIZE).fill(-1);
  private col = new Float32Array(SIZE * SIZE);
  private rot = 0;
  private tilt = TILT;
  /** 1 = the whole globe fits; more brings the camera closer */
  private zoom = 1;
  private globe: HTMLElement;
  private target: number | null = null;
  private tiltTarget: number | null = null;
  private running = false;
  private last = 0;
  private drag: { x: number; y: number; rot: number; tilt: number; moved: boolean } | null = null;
  /** the last pointer press turned into a spin: its click must not open a world */
  private spun = false;
  /** the pointer is over a world: hold the spin so it's easy to click */
  private hovering = false;
  private places = new Map<string, { lat: number; lon: number }>();
  private art?: PlanetArt | null; // null: no planet.json (placeholder planet, spots from names)
  private marks: HTMLElement;
  private markKey = '';
  /** a world to turn to the front once it has a spot */
  private face: string | null = null;

  constructor(private el: HTMLElement, private on: PlanetEvents, private base = 'planet') {
    el.innerHTML = '<div class="pl-head"><div class="pl-title">Planet</div><div class="pl-sub"></div></div><div class="pl-stage"><div class="pl-globe"><canvas></canvas><div class="pl-marks"></div></div>'
      + '<div class="pl-zoom"><button data-zoom="in" title="Zoom in (+)">+</button><button data-zoom="out" title="Zoom out (−)">−</button><button data-zoom="fit" title="Whole planet (0)">⤢</button></div></div>';
    this.canvas = el.querySelector('canvas')!;
    this.marks = el.querySelector('.pl-marks')!;
    this.globe = el.querySelector<HTMLElement>('.pl-globe')!;
    this.gl = GlobeGL.create(this.canvas);
    if (!this.gl) { // fallback: a 2D canvas at a fixed size, square, no zoom
      this.globe.classList.add('flat');
      el.querySelector<HTMLElement>('.pl-zoom')!.style.display = 'none';
      this.canvas.width = this.canvas.height = SIZE;
      this.ctx = this.canvas.getContext('2d')!;
      this.frame = this.ctx.createImageData(SIZE, SIZE);
      this.precompute();
    }
    // drag to spin; a click on a settlement opens its world
    const globe = this.globe;
    // wheel or trackpad pinch to zoom, and the corner buttons
    globe.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015))); }, { passive: false });
    el.querySelector('.pl-zoom')!.addEventListener('click', (e) => {
      const z = (e.target as HTMLElement).closest<HTMLElement>('[data-zoom]')?.dataset.zoom;
      if (z === 'in') this.zoomBy(1.4); else if (z === 'out') this.zoomBy(1 / 1.4); else if (z === 'fit') this.resetZoom();
    });
    globe.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.preventDefault(); // no text selection or image drag while spinning
      this.drag = { x: e.clientX, y: e.clientY, rot: this.rot, tilt: this.tilt, moved: false };
      this.spun = false;
      this.target = this.tiltTarget = null;
    });
    addEventListener('pointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.clientX - d.x, dy = e.clientY - d.y;
      if (Math.hypot(dx, dy) > 4) d.moved = true;
      if (!d.moved) return;
      const k = Math.PI / (2 * this.radius()); // half a turn across the globe, slower when zoomed in
      this.rot = d.rot - dx * k;
      // up and down too (the 2D fallback is drawn for one fixed tilt)
      if (this.gl) this.tilt = Math.max(-MAX_TILT, Math.min(MAX_TILT, d.tilt - dy * k));
    });
    addEventListener('pointerup', () => { if (this.drag?.moved) this.spun = true; this.drag = null; });
    this.marks.addEventListener('pointerover', (e) => { this.hovering = !!(e.target as HTMLElement).closest('[data-world]'); });
    this.marks.addEventListener('pointerleave', () => { this.hovering = false; });
    el.addEventListener('click', (e) => {
      if (this.spun) { this.spun = false; return; } // the end of a spin, not a click
      const w = (e.target as HTMLElement).closest<HTMLElement>('[data-world]')?.dataset.world;
      if (w) this.on.openWorld(w);
    });
  }

  zoomBy(f: number) { if (this.gl) this.zoom = Math.max(1, Math.min(MAX_ZOOM, this.zoom * f)); }
  resetZoom() { this.zoom = 1; }

  /** The globe's radius in CSS px: fits the stage at zoom 1 (the 2D fallback fills its square). */
  private radius() {
    const w = this.globe.clientWidth, h = this.globe.clientHeight;
    return this.gl ? 0.43 * Math.min(w, h) * this.zoom : w / 2;
  }

  /** Start or stop drawing; `face`: turn this world to the front. */
  async show(open: boolean, face?: string | null) {
    if (open && !this.tex && !this.gl?.ready) {
      await this.loadArt();
      const src = await loadSource(this.pictureUrl());
      if (this.gl) this.gl.setSource(src); else this.setPicture(pixels(src));
    }
    if (open) this.face = face ?? null;
    if (open && !this.running) { this.running = true; this.last = performance.now(); requestAnimationFrame((t) => this.loop(t)); }
    if (!open) this.running = false;
  }

  private async loadArt() {
    if (this.art === undefined) this.art = await fetch(`${this.base}/planet.json`).then((r) => (r.ok ? r.json() : null)).catch(() => null);
  }

  pictureUrl() { return `${this.base}/${this.art?.image ?? 'planet.jpg'}`; }

  /** Landscapes a world fits: its first town's own landscape, then what planet.json lists for that map. */
  private fitsFor(towns: TownInfo[]) {
    return (w: string) => {
      const first = towns.find((t) => t.world === w && t.primary) ?? towns.find((t) => t.world === w);
      return first ? [...new Set([first.land, ...(this.art?.prefer?.[first.map] ?? [])].filter((x): x is string => !!x))] : [];
    };
  }

  /** Where a world sits on the planet picture (0–1 across, 0–1 down), e.g. for its world map's ground. */
  async whereIs(world: string, towns: TownInfo[]): Promise<{ u: number; v: number } | null> {
    await this.loadArt();
    if (!this.art) return null;
    this.place([...new Set(towns.map((t) => t.world))].sort((a, b) => a.localeCompare(b)), this.fitsFor(towns));
    const p = this.places.get(world);
    if (!p) return null;
    const u = ((p.lon / (2 * Math.PI) + 0.5) % 1 + 1) % 1;
    return { u, v: 0.5 - p.lat / Math.PI };
  }

  update(d: PlanetData) {
    const worlds = [...new Set(d.towns.map((t) => t.world))].sort((a, b) => a.localeCompare(b));
    if (this.art !== undefined) this.place(worlds, this.fitsFor(d.towns));
    if (this.face && this.places.has(this.face)) {
      const p = this.places.get(this.face)!;
      this.target = p.lon - 0.35; // a little left of center
      if (this.gl) this.tiltTarget = -p.lat * 0.85; // and tipped so it sits near the middle
      this.face = null;
    }
    const n = (w: string) => {
      const towns = d.towns.filter((t) => t.world === w);
      const robots = d.agents.filter((a) => towns.some((t) => t.id === a.town));
      return { towns: towns.length, robots: robots.length, waiting: robots.filter((a) => a.status === 'waiting').length };
    };
    const all = worlds.map((w) => ({ w, ...n(w) }));
    const html = all.map(({ w, towns, robots, waiting }) =>
      `<button class="pl-world${w === d.current ? ' current' : ''}${waiting ? ' needs' : ''}${robots ? ' busy' : ''}" data-world="${esc(w)}">
        <span class="pl-glow"></span><span class="pl-label"><b>${esc(w)}</b>${waiting ? ` <span class="wm-badge">${waiting}</span>` : ''}
        <small>${plural(towns, 'town')} · ${plural(robots, 'robot')}</small></span></button>`).join('');
    if (html !== this.markKey) {
      this.markKey = html;
      this.marks.innerHTML = html;
      const w = all.reduce((a, x) => a + x.waiting, 0);
      this.el.querySelector('.pl-sub')!.innerHTML = `${plural(worlds.length, 'world')} · ${plural(all.reduce((a, x) => a + x.robots, 0), 'robot')}${w ? ` · <b>${w} need${w === 1 ? 's' : ''} you</b>` : ''}`;
      this.position();
    }
  }

  /**
   * Each world settles on a clearing of the picture: a free one in a landscape it fits (best first),
   * else any free one, else it shares one (a little apart). The pick is remembered in the browser,
   * per picture, so worlds stay put. Without planet.json (placeholder planet), the spot comes from the name.
   */
  private place(worlds: string[], fits: (w: string) => string[]) {
    const spots = this.art?.spots;
    if (spots?.length) {
      const key = `agentville.planet:${this.art!.id ?? 'planet'}`;
      const saved: Record<string, number> = JSON.parse(localStorage.getItem(key) ?? '{}');
      const taken = new Map<number, number>(); // spot -> worlds on it
      for (const [w, i] of Object.entries(saved)) if (worlds.includes(w) && spots[i]) taken.set(i, (taken.get(i) ?? 0) + 1);
      for (const w of worlds) {
        if (this.places.has(w)) continue;
        let i = saved[w];
        if (!spots[i]) {
          const free = spots.map((_, k) => k).filter((k) => !taken.has(k));
          const fit = fits(w).map((land) => free.filter((k) => spots[k].land === land)).find((l) => l.length) ?? [];
          const pool = fit.length ? fit : free.length ? free : spots.map((_, k) => k);
          i = pool[hash(w) % pool.length];
          saved[w] = i;
          taken.set(i, (taken.get(i) ?? 0) + 1);
        }
        const n = Object.entries(saved).filter(([x, k]) => k === i && worlds.includes(x)).map(([x]) => x).sort().indexOf(w);
        const off = n > 0 ? 0.06 * Math.sqrt(n) : 0, a = n * 2.39996; // sharing: a little spiral apart
        this.places.set(w, { lat: spots[i].lat + off * Math.sin(a), lon: spots[i].lon + off * Math.cos(a) });
      }
      localStorage.setItem(key, JSON.stringify(saved));
      return;
    }
    for (const w of worlds) {
      if (this.places.has(w)) continue;
      let h = hash(w), lon = (h % 3600) / 3600 * 2 * Math.PI, lat = ((h >>> 12) % 1000) / 1000 * 1.6 - 0.72;
      for (let i = 0; i < 16 && [...this.places.values()].some((p) => angle(p, { lat, lon }) < 0.5); i++) {
        lon = (lon + 2.39996) % (2 * Math.PI); // golden angle
        lat = Math.max(-0.75, Math.min(0.85, -lat * 0.8 + 0.1));
      }
      this.places.set(w, { lat, lon });
    }
  }

  private loop(t: number) {
    if (!this.running) return;
    const dt = Math.min(0.05, (t - this.last) / 1000);
    this.last = t;
    if (this.target !== null) {
      // turn the shortest way to the world you came from, then keep spinning
      let d = ((this.target - this.rot) % (2 * Math.PI) + 3 * Math.PI) % (2 * Math.PI) - Math.PI;
      if (Math.abs(d) < 0.01) this.target = null; else this.rot += d * Math.min(1, 4 * dt);
    } else if (!this.drag && !this.hovering) this.rot += SPIN * dt;
    if (this.tiltTarget !== null) {
      const d = this.tiltTarget - this.tilt;
      if (Math.abs(d) < 0.005) this.tiltTarget = null; else this.tilt += d * Math.min(1, 4 * dt);
    }
    this.draw();
    this.position();
    requestAnimationFrame((n) => this.loop(n));
  }

  private draw() {
    if (this.gl) { this.gl.draw(this.rot, this.tilt, this.radius()); return; }
    const tex = this.tex;
    if (!tex || !this.frame || !this.ctx) return;
    const out = this.frame.data, src = tex.data, w = tex.w;
    const shift = ((this.rot / (2 * Math.PI)) * w % w + w) % w;
    for (let i = 0, k = 0; i < SIZE * SIZE; i++, k += 4) {
      const r = this.row[i];
      if (r < 0) { out[k + 3] = 0; continue; }
      let u = this.col[i] + shift; if (u >= w) u -= w;
      const s = (r + (u | 0)) * 4, l = this.light[i], night = (1 - l) * 0.22;
      out[k] = src[s] * l + 18 * night; out[k + 1] = src[s + 1] * l + 28 * night; out[k + 2] = src[s + 2] * l + 70 * night;
      out[k + 3] = this.alpha[i];
    }
    this.ctx.putImageData(this.frame, 0, 0);
  }

  /** Move the settlements with the spin; ones on the far side fade out. */
  private position() {
    const c = Math.cos(this.tilt), s = Math.sin(this.tilt), R = this.radius();
    for (const b of this.marks.querySelectorAll<HTMLElement>('[data-world]')) {
      const p = this.places.get(b.dataset.world!);
      if (!p) { b.style.opacity = '0'; b.style.pointerEvents = 'none'; continue; } // not settled yet
      const lon = p.lon - this.rot;
      const X = Math.cos(p.lat) * Math.sin(lon), Y = Math.sin(p.lat), Z = Math.cos(p.lat) * Math.cos(lon);
      const x = X, y = Y * c + Z * s, z = -Y * s + Z * c; // planet -> view
      const vis = Math.max(0, Math.min(1, (z - 0.05) / 0.25));
      b.style.left = `${this.globe.clientWidth / 2 + x * R}px`;
      b.style.top = `${this.globe.clientHeight / 2 - y * R}px`;
      b.style.opacity = String(vis);
      b.style.pointerEvents = vis > 0.4 ? '' : 'none';
      b.style.zIndex = String(Math.round(z * 100) + 100);
    }
  }

  /** For each pixel of the disc: where it lands on the planet picture, and how lit it is. */
  private precompute() {
    const c = Math.cos(TILT), s = Math.sin(TILT);
    for (let py = 0; py < SIZE; py++) for (let px = 0; px < SIZE; px++) {
      const x = (px + 0.5) / SIZE * 2 - 1, y = 1 - (py + 0.5) / SIZE * 2, rr = x * x + y * y;
      const i = py * SIZE + px;
      const edge = (1 - Math.sqrt(rr)) * SIZE / 2; // px from the rim, for a smooth edge
      if (edge <= -0.5) continue;
      const z = Math.sqrt(Math.max(0, 1 - rr));
      const Y = y * c - z * s, Z = y * s + z * c; // view -> planet
      this.lat[i] = Math.asin(Math.max(-1, Math.min(1, Y)));
      this.lon[i] = Math.atan2(x, Z);
      this.row[i] = 0; // inside the disc
      const d = Math.max(0, x * LIGHT[0] + y * LIGHT[1] + z * LIGHT[2]);
      this.light[i] = 0.3 + 0.7 * Math.pow(d, 0.8) * (0.75 + 0.25 * z);
      this.alpha[i] = Math.round(255 * Math.max(0, Math.min(1, edge + 0.5)));
    }
  }

  /** Use a planet picture (equirectangular, 2:1): map every pixel of the disc onto it. */
  setPicture(t: { data: Uint8ClampedArray; w: number; h: number }) {
    this.tex = t;
    for (let i = 0; i < SIZE * SIZE; i++) {
      if (this.row[i] < 0) continue;
      const v = Math.min(t.h - 1, Math.max(0, Math.floor((0.5 - this.lat[i] / Math.PI) * t.h)));
      this.row[i] = v * t.w;
      this.col[i] = ((this.lon[i] / (2 * Math.PI) + 0.5) * t.w) % t.w;
    }
  }
}

/** The planet picture: the painted one if present, else a placeholder drawn here. */
async function loadSource(url: string): Promise<HTMLImageElement | HTMLCanvasElement> {
  const img = await new Promise<HTMLImageElement | null>((ok) => {
    const i = new Image();
    i.onload = () => ok(i);
    i.onerror = () => ok(null);
    i.src = url;
  });
  if (img) return img;
  const p = placeholder(1024, 512);
  const c = document.createElement('canvas'); c.width = p.w; c.height = p.h;
  c.getContext('2d')!.putImageData(new ImageData(p.data, p.w, p.h), 0, 0);
  return c;
}

/** A picture as pixels (for the 2D fallback), at most 2048 wide. */
function pixels(src: HTMLImageElement | HTMLCanvasElement) {
  const sw = src instanceof HTMLImageElement ? src.naturalWidth : src.width;
  const w = Math.min(2048, sw), h = Math.round(w / 2);
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const x = c.getContext('2d')!; x.drawImage(src, 0, 0, w, h);
  return { data: x.getImageData(0, 0, w, h).data, w, h };
}

/**
 * The globe on the GPU: one quad, and a fragment shader doing what the 2D path does per pixel
 * (sphere -> latitude/longitude -> picture, plus light, night side and a smooth rim), at the
 * canvas's real pixel size, sampling the picture with mipmaps so it stays sharp and smooth.
 */
class GlobeGL {
  private tex: WebGLTexture | null = null;
  get ready() { return !!this.tex; }
  private u: Record<string, WebGLUniformLocation | null> = {};

  static create(canvas: HTMLCanvasElement): GlobeGL | null {
    const gl = canvas.getContext('webgl2', { premultipliedAlpha: true, antialias: false });
    if (!gl) return null;
    try { return new GlobeGL(gl, canvas); } catch { return null; }
  }

  private constructor(private gl: WebGL2RenderingContext, private canvas: HTMLCanvasElement) {
    const vs = `#version 300 es
      in vec2 p;
      void main() { gl_Position = vec4(p, 0.0, 1.0); }`;
    const fs = `#version 300 es
      precision highp float;
      out vec4 o;
      uniform sampler2D tex; uniform float rot, tilt, radius; uniform vec2 center; uniform vec3 light, iceN, iceS;
      const float PI = 3.14159265;
      void main() {
        // where this screen pixel is on the globe's disc (radius 1); zoom is just a bigger radius
        vec2 v = (gl_FragCoord.xy - center) / radius;
        float r = length(v), px = 1.5 / radius;
        // a soft atmosphere just outside the rim
        float halo = r > 1.0 ? pow(clamp(1.0 - (r - 1.0) / 0.07, 0.0, 1.0), 2.0) * 0.4 : 0.0;
        vec4 haze = vec4(vec3(0.45, 0.62, 1.0) * halo, halo);
        if (r > 1.0 + px) { o = haze; return; }
        float a = 1.0 - smoothstep(1.0 - px, 1.0 + px, r);
        float z = sqrt(max(0.0, 1.0 - r * r));
        float c = cos(tilt), s = sin(tilt);
        float Y = v.y * c - z * s, Z = v.y * s + z * c; // view -> planet
        float lat = asin(clamp(Y, -1.0, 1.0)), lon = atan(v.x, Z);
        // not wrapped with fract(): the texture repeats, so the spin never makes a visible seam
        vec2 uv = vec2(lon / (2.0 * PI) + 0.5 + rot / (2.0 * PI), 0.5 - lat / PI);
        // longitude jumps by a full turn where the picture's edges meet: take the jump out of the
        // derivatives, or the mipmap level spikes there and draws a line (visible when tilted)
        vec2 gx = dFdx(uv), gy = dFdy(uv);
        gx.x -= round(gx.x); gy.x -= round(gy.x);
        vec3 col = textureGrad(tex, uv, gx, gy).rgb;
        // flat maps pinch to a point at the poles, which draws rays (an "axis") when you look down at
        // one: toward each pole, fade into a heavily blurred sample of the picture's own polar ice
        // one ice colour per pole (the average of the picture's polar band), the same all the way round
        col = mix(col, lat > 0.0 ? iceN : iceS, smoothstep(1.18, 1.42, abs(lat)));
        float d = max(0.0, dot(vec3(v, z), light));
        float l = 0.3 + 0.7 * pow(d, 0.8) * (0.75 + 0.25 * z);
        col = col * l + vec3(18.0, 28.0, 70.0) / 255.0 * (1.0 - l) * 0.22;
        col += vec3(0.25, 0.35, 0.6) * pow(1.0 - z, 3.0) * 0.45; // a little blue at the limb
        o = vec4(col * a, a) + haze * (1.0 - a);
      }`;
    const prog = gl.createProgram()!;
    for (const [type, src] of [[gl.VERTEX_SHADER, vs], [gl.FRAGMENT_SHADER, fs]] as const) {
      const sh = gl.createShader(type)!;
      gl.shaderSource(sh, src); gl.compileShader(sh);
      if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh) ?? 'shader');
      gl.attachShader(prog, sh);
    }
    gl.linkProgram(prog);
    if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog) ?? 'link');
    gl.useProgram(prog);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(prog, 'p');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    for (const n of ['tex', 'rot', 'tilt', 'radius', 'center', 'light', 'iceN', 'iceS']) this.u[n] = gl.getUniformLocation(prog, n);
    gl.uniform3f(this.u.light, LIGHT[0], LIGHT[1], LIGHT[2]);
    gl.uniform1i(this.u.tex, 0);
  }

  setSource(src: HTMLImageElement | HTMLCanvasElement) {
    const gl = this.gl;
    // the average colour of the top and bottom rows: each pole's ice
    const small = document.createElement('canvas'); small.width = 64; small.height = 32;
    const sx = small.getContext('2d')!; sx.drawImage(src, 0, 0, 64, 32);
    const avg = (y: number) => {
      const d = sx.getImageData(0, y, 64, 1).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; }
      return [r / 64 / 255, g / 64 / 255, b / 64 / 255] as const;
    };
    gl.uniform3f(this.u.iceN, ...avg(1));
    gl.uniform3f(this.u.iceS, ...avg(30));
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, src);
    gl.generateMipmap(gl.TEXTURE_2D);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.REPEAT);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const aniso = gl.getExtension('EXT_texture_filter_anisotropic');
    if (aniso) gl.texParameterf(gl.TEXTURE_2D, aniso.TEXTURE_MAX_ANISOTROPY_EXT, Math.min(8, gl.getParameter(aniso.MAX_TEXTURE_MAX_ANISOTROPY_EXT)));
  }

  /** `radius`: the globe's radius in CSS px, centred in the canvas (zoom makes it bigger). */
  draw(rot: number, tilt: number, radius: number) {
    const gl = this.gl, c = this.canvas;
    // match the canvas to its size on screen, in device pixels, so nothing is stretched
    const dpr = Math.min(devicePixelRatio, 2.5);
    const w = Math.round(Math.min(4096, c.clientWidth * dpr)), h = Math.round(Math.min(4096, c.clientHeight * dpr));
    if (w && h && (c.width !== w || c.height !== h)) { c.width = w; c.height = h; gl.viewport(0, 0, w, h); }
    if (!this.tex) return;
    gl.clearColor(0, 0, 0, 0); gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(this.u.rot, rot);
    gl.uniform1f(this.u.tilt, tilt);
    gl.uniform2f(this.u.center, c.width / 2, c.height / 2);
    gl.uniform1f(this.u.radius, radius * (c.width / Math.max(1, c.clientWidth)));
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
  }
}

/**
 * A placeholder planet: continents from 3D noise sampled on the sphere (so it wraps seamlessly),
 * four seasons around the globe (autumn, summer, winter, spring), oceans, ice caps.
 */
function placeholder(w: number, h: number) {
  const data = new Uint8ClampedArray(w * h * 4);
  const seasons: [number, number, number][][] = [
    [[176, 82, 38], [214, 140, 48], [120, 60, 36]], // autumn
    [[86, 160, 72], [130, 186, 84], [58, 120, 60]], // summer
    [[226, 232, 242], [180, 198, 214], [140, 160, 178]], // winter
    [[150, 200, 104], [236, 168, 196], [104, 160, 84]], // spring
  ];
  for (let v = 0; v < h; v++) {
    const lat = Math.PI * (0.5 - (v + 0.5) / h);
    for (let u = 0; u < w; u++) {
      const lon = (2 * Math.PI * (u + 0.5)) / w - Math.PI;
      const p: V3 = [Math.cos(lat) * Math.sin(lon), Math.sin(lat), Math.cos(lat) * Math.cos(lon)];
      const height = fbm(p[0] * 2.2, p[1] * 2.2, p[2] * 2.2);
      const detail = fbm(p[0] * 9 + 5, p[1] * 9, p[2] * 9);
      let col: [number, number, number];
      if (Math.abs(lat) > 1.25 + 0.08 * detail) col = [236, 242, 248]; // ice caps
      else if (height < 0.5) {
        const t = Math.max(0, Math.min(1, (height - 0.3) / 0.2)); // deep to shallow
        col = [mix(22, 52, t), mix(62, 148, t), mix(120, 196, t)];
      } else {
        // the season shifts around the globe, warped a little by noise
        const turn = ((lon + Math.PI) / (2 * Math.PI) * 4 + (fbm(p[0] * 1.3 + 9, p[1] * 1.3, p[2] * 1.3) - 0.5) * 1.6 + 4) % 4;
        const sea = seasons[Math.floor(turn) % 4];
        const shade = sea[detail > 0.56 ? 1 : detail < 0.44 ? 2 : 0];
        const coast = height < 0.53 ? 1 : 0; // a sandy rim
        col = coast ? [214, 196, 150] : shade;
      }
      const k = (v * w + u) * 4;
      data[k] = col[0]; data[k + 1] = col[1]; data[k + 2] = col[2]; data[k + 3] = 255;
    }
  }
  return { data, w, h };
}

type V3 = [number, number, number];
const mix = (a: number, b: number, t: number) => a + (b - a) * t;
function norm(v: V3): V3 { const l = Math.hypot(...v); return [v[0] / l, v[1] / l, v[2] / l]; }
function angle(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  return Math.acos(Math.max(-1, Math.min(1, Math.sin(a.lat) * Math.sin(b.lat) + Math.cos(a.lat) * Math.cos(b.lat) * Math.cos(a.lon - b.lon))));
}
function hash(s: string) { let h = 2166136261; for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 16777619); } return h >>> 0; }

/** Smooth 3D value noise, summed over a few octaves (0–1). */
function fbm(x: number, y: number, z: number) {
  let sum = 0, amp = 0.5, f = 1;
  for (let o = 0; o < 5; o++) { sum += amp * noise(x * f, y * f, z * f); f *= 2; amp *= 0.5; }
  return sum / 0.96875;
}
function noise(x: number, y: number, z: number) {
  const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
  const fx = x - xi, fy = y - yi, fz = z - zi;
  const sx = fx * fx * (3 - 2 * fx), sy = fy * fy * (3 - 2 * fy), sz = fz * fz * (3 - 2 * fz);
  const r = (a: number, b: number, c: number) => { let n = Math.imul(a, 374761393) + Math.imul(b, 668265263) + Math.imul(c, 2147483647); n = Math.imul(n ^ (n >>> 13), 1274126177); return ((n ^ (n >>> 16)) >>> 0) / 4294967295; };
  const l = (a: number, b: number, t: number) => a + (b - a) * t;
  return l(
    l(l(r(xi, yi, zi), r(xi + 1, yi, zi), sx), l(r(xi, yi + 1, zi), r(xi + 1, yi + 1, zi), sx), sy),
    l(l(r(xi, yi, zi + 1), r(xi + 1, yi, zi + 1), sx), l(r(xi, yi + 1, zi + 1), r(xi + 1, yi + 1, zi + 1), sx), sy), sz);
}

const plural = (n: number, w: string) => `${n} ${w}${n === 1 ? '' : 's'}`;
const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
