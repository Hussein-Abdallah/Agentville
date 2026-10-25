import { Application, Assets, Container, Graphics, Sprite, Text, Texture } from 'pixi.js';
import type { AgentState, TownData } from './types';
import { RobotSprites } from './sprites';
import { Robot } from './robot';
import { Transit, loadVehicle } from './transit';

const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';
const SLOTS = [0, -46, 46, -92, 92, -138, 138];
const MAX_ZOOM = 4;

/** The town scene: background, building glows and labels, robots. Feed it AgentState updates. */
export class World {
  app = new Application();
  robots = new Map<string, Robot>();
  showLabels = true;
  showPaths = false;
  hovered: string | null = null;
  onRobotClick?: (id: string) => void;
  onChange?: () => void;

  private scene = new Container();
  private glowLayer = new Container();
  private pathLayer = new Graphics();
  private labelLayer = new Container();
  private robotLayer = new Container();
  private tagLayer = new Container();
  private bubbleLayer = new Container();
  private tipLayer = new Container();
  private focusSeq = 0;
  /** folder names per building (live mode) */
  folders: Record<string, string[]> = {};
  /** building names from agentville.json (live mode) */
  names: Record<string, string> = {};
  private glowTex!: Texture;
  private glows = new Map<string, Sprite>();
  /** expanding rings around buildings where a robot needs you */
  private ripples = new Graphics();
  private labels = new Map<string, Container>();
  private clock = 0;
  private labelKey = new Map<string, string>();
  /** zoom relative to "whole town fits", and the image point at the middle of the view */
  private zoom = 1;
  private center: [number, number] = [0, 0];
  private drag: { x: number; y: number; cx: number; cy: number; moved: boolean } | null = null;
  private bg = new Sprite();
  private dragged = false;
  /** the town's train or ferry, if it has one */
  private transit?: Transit;
  /** full frame rate until then (ms): the mouse is in use */
  private lively = 0;

  constructor(private host: HTMLElement, public town: TownData, public sprites: RobotSprites) {}

  async init() {
    await this.app.init({ resizeTo: this.host, backgroundAlpha: 0, antialias: true, autoDensity: true, resolution: Math.min(devicePixelRatio, 2) });
    this.host.appendChild(this.app.canvas);
    this.watchDensity();
    this.robotLayer.sortableChildren = true;
    this.scene.addChild(this.bg, this.glowLayer, this.pathLayer, this.labelLayer, this.robotLayer, this.tagLayer, this.bubbleLayer, this.tipLayer);
    this.bubbleLayer.sortableChildren = true;
    this.tagLayer.sortableChildren = true;
    this.app.stage.addChild(this.scene);
    this.glowTex = makeGlowTexture();
    this.glowLayer.addChild(this.ripples);
    this.app.stage.eventMode = 'static';
    this.app.stage.on('pointermove', (e) => { this.wake(); this.pointerMove(e.global.x, e.global.y); });
    this.app.stage.on('pointertap', (e) => { if (!this.dragged) this.pointerTap(e.global.x, e.global.y); });
    // drag to pan (when zoomed in), wheel or pinch to zoom toward the pointer
    this.app.stage.on('pointerdown', (e) => { this.dragged = false; this.drag = { x: e.global.x, y: e.global.y, cx: this.center[0], cy: this.center[1], moved: false }; });
    this.app.stage.on('globalpointermove', (e) => {
      const d = this.drag;
      if (!d) return;
      const dx = e.global.x - d.x, dy = e.global.y - d.y;
      if (!d.moved && Math.hypot(dx, dy) < 5) return;
      d.moved = true;
      this.app.canvas.style.cursor = 'grabbing';
      this.center = [d.cx - dx / this.scene.scale.x, d.cy - dy / this.scene.scale.y];
      this.fit();
    });
    const endDrag = () => { if (this.drag?.moved) { this.dragged = true; this.app.canvas.style.cursor = 'default'; } this.drag = null; };
    this.app.stage.on('pointerup', endDrag);
    this.app.stage.on('pointerupoutside', endDrag);
    this.app.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.wake();
      const r = this.app.canvas.getBoundingClientRect();
      this.zoomBy(Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)), e.clientX - r.left, e.clientY - r.top);
    }, { passive: false });
    await this.load(this.town);
    this.app.ticker.add((t) => this.tick(t.deltaMS / 1000));
    window.addEventListener('resize', () => this.fit());
    this.fit();
  }

  /**
   * Keep the canvas at the screen's pixel density: when the window moves to a screen with another
   * density (a wide external monitor, say), render at that density instead of being stretched.
   */
  private watchDensity() {
    const apply = () => {
      const want = Math.min(devicePixelRatio, 2);
      if (this.app.renderer.resolution === want) return;
      this.app.renderer.resolution = want;
      this.app.resize();
      this.fit();
    };
    const listen = () => matchMedia(`(resolution: ${devicePixelRatio}dppx)`).addEventListener('change', () => { apply(); listen(); }, { once: true });
    apply();
    listen();
  }

  /** Show a town map (background, building glows and labels). Robots are cleared; add them again after. */
  async load(town: TownData) {
    // load the picture first, then swap everything at once: the ticker must never see a half-switched town
    const tex = await Assets.load({ src: town.image, data: { autoGenerateMipmaps: true } });
    this.clear();
    this.town = town;
    this.bg.texture = tex;
    this.bg.width = town.size[0]; this.bg.height = town.size[1];
    this.transit?.view.destroy({ children: true });
    const transit = (this.transit = town.transit ? new Transit(town, town.transit) : undefined);
    if (transit) {
      this.robotLayer.addChild(transit.view);
      // the model (train or boat), once loaded; until then (or without one) the drawn version
      loadVehicle(town.transit!.kind === 'ferry' ? 'boat' : 'train').then((look) => { if (this.transit === transit) transit.setLook(look); }).catch(() => {});
    }
    for (const g of this.glows.values()) g.destroy();
    for (const l of this.labels.values()) l.destroy({ children: true });
    this.glows.clear(); this.labels.clear(); this.labelKey.clear();
    for (const [k, b] of Object.entries(town.buildings)) {
      const g = new Sprite(this.glowTex);
      g.anchor.set(0.5); g.alpha = 0; g.blendMode = 'add';
      g.position.set(...b.door);
      this.glowLayer.addChild(g); this.glows.set(k, g);
      const l = new Container(); this.labelLayer.addChild(l); this.labels.set(k, l);
    }
    this.hovered = null;
    this.resetZoom();
  }

  /** Add or update an agent. `instant`: a new robot stands at its building instead of walking in from the station. */
  apply(state: AgentState, instant = false) {
    const r = this.robots.get(state.id);
    if (r) r.update(state);
    else {
      const nr = new Robot(state, this.town, this.sprites, (r, place) => this.claimSpot(r, place));
      if (instant) nr.arriveNow();
      else if (this.transit) nr.hold(); // comes in on the next train
      this.robots.set(state.id, nr);
      this.robotLayer.addChild(nr.view);
      this.tagLayer.addChild(nr.tag);
      this.bubbleLayer.addChild(nr.bubble, nr.badge);
    }
    this.onChange?.();
  }

  /** First standing spot at a place that no other robot has claimed. */
  private claimSpot(me: Robot, place: string) {
    const n = this.town.buildings[place]?.spots?.length ?? 1;
    const taken = new Set([...this.robots.values()].filter((r) => r !== me && r.target === place && r.spot >= 0).map((r) => r.spot));
    for (let i = 0; i < n; i++) if (!taken.has(i)) return i;
    return Math.floor(Math.random() * n);
  }

  /** Remove every robot at once (the page is switching towns). */
  clear() {
    this.wake();
    for (const r of this.robots.values()) { r.view.destroy({ children: true }); r.bubble.destroy({ children: true }); r.badge.destroy(); r.tag.destroy({ children: true }); }
    this.robots.clear();
    this.onChange?.();
  }

  remove(id: string) {
    this.robots.get(id)?.leave();
    this.onChange?.();
  }

  focus(id: string) {
    const r = this.robots.get(id);
    if (r) { r.highlight = 2.5; r.lastFocus = ++this.focusSeq; }
  }

  /**
   * What to call a building: its agentville.json name and/or the folders it holds. The town's own
   * names (Church, Hot springs…) mean nothing for code, so they're only a fallback (plaza, station).
   */
  placeName(k: string, short = false) {
    const f = this.folders?.[k] ?? [];
    const fl = short && f.length > 2 ? `${f.slice(0, 2).join(', ')} +${f.length - 2}` : f.join(', ');
    const n = this.names[k];
    return n ? (fl ? `${n}  ·  ${fl}` : n) : fl;
  }

  /** Zoom by a factor, keeping the image point under (gx, gy) in place (default: the middle). */
  zoomBy(f: number, gx = this.app.screen.width / 2, gy = this.app.screen.height / 2) {
    this.wake();
    const [ix, iy] = this.toImage(gx, gy);
    this.zoom = Math.min(MAX_ZOOM, Math.max(1, this.zoom * f));
    const s = this.fitScale() * this.zoom;
    this.center = [ix - (gx - this.app.screen.width / 2) / s, iy - (gy - this.app.screen.height / 2) / s];
    this.fit();
  }

  /** Back to the whole town. */
  resetZoom() {
    this.wake();
    this.zoom = 1;
    this.center = [this.town.size[0] / 2, this.town.size[1] / 2];
    this.fit();
  }

  private fitScale() {
    return Math.min(this.app.screen.width / this.town.size[0], this.app.screen.height / this.town.size[1]);
  }

  private fit() {
    const [W, H] = this.town.size;
    const sw = this.app.screen.width, sh = this.app.screen.height;
    const s = this.fitScale() * this.zoom;
    // zoomed in: keep the image covering the view; otherwise center it
    const clamp = (c: number, view: number, size: number) => (size * s <= view ? size / 2 : Math.min(Math.max(c, view / 2 / s), size - view / 2 / s));
    this.center = [clamp(this.center[0], sw, W), clamp(this.center[1], sh, H)];
    this.scene.scale.set(s);
    this.scene.position.set(sw / 2 - this.center[0] * s, sh / 2 - this.center[1] * s);
  }

  private toImage(gx: number, gy: number): [number, number] {
    const s = this.scene.scale.x;
    return [(gx - this.scene.x) / s, (gy - this.scene.y) / s];
  }

  private pointerMove(gx: number, gy: number) {
    const [x, y] = this.toImage(gx, gy);
    let best: string | null = null, bd = 60;
    for (const [k, b] of Object.entries(this.town.buildings)) {
      const d = Math.min(Math.hypot(b.door[0] - x, b.door[1] - 25 - y), Math.hypot(b.label[0] - x, b.label[1] - y));
      if (d < bd) { bd = d; best = k; }
    }
    this.hovered = best;
    if (this.drag?.moved) return;
    const overRobot = [...this.robots.values()].some((r) => r.hitTest(x, y));
    this.app.canvas.style.cursor = overRobot ? 'pointer' : this.zoom > 1 ? 'grab' : 'default';
  }

  private pointerTap(gx: number, gy: number) {
    const [x, y] = this.toImage(gx, gy);
    const hit = [...this.robots.values()].filter((r) => r.mode !== 'gone' && r.mode !== 'held' && r.hitTest(x, y)).sort((a, b) => b.y - a.y)[0];
    if (hit) this.onRobotClick?.(hit.state.id);
  }

  /**
   * Idle CPU: full frame rate while something moves (a robot walking, the train, the mouse in use),
   * otherwise 20 frames a second, enough for the robots' own animations (6–12 fps), the glows and badges.
   */
  private pace() {
    const moving = this.drag || performance.now() < this.lively || (this.transit && this.transit.phase !== 'away')
      || [...this.robots.values()].some((r) => r.busy);
    const fps = moving ? 0 : 20; // 0: no cap
    if (this.app.ticker.maxFPS !== fps) this.app.ticker.maxFPS = fps;
  }

  /** Back to full frame rate for a moment (the mouse moved, zooming). A robot that moves wakes it by itself (busy). */
  wake(ms = 1500) { this.lively = Math.max(this.lively, performance.now() + ms); this.pace(); }

  /** The town isn't on screen (the world map or planet covers it): stop drawing it at all. */
  set visible(on: boolean) {
    if (on === this.app.ticker.started) return;
    if (on) { this.app.start(); this.wake(); } else this.app.stop();
  }

  private tick(dt: number) {
    dt = Math.min(dt, 0.05);
    this.pace();
    this.clock += dt;
    // who is where
    const at = new Map<string, Robot[]>();
    for (const r of this.robots.values()) {
      if (r.mode === 'present') (at.get(r.at) ?? at.set(r.at, []).get(r.at)!).push(r);
    }
    for (const list of at.values()) list.sort((a, b) => a.state.id.localeCompare(b.state.id)).forEach((r, i) => (r.slot = i));
    // the train comes for robots waiting to get on or off; while it's in, they do
    if (this.transit) {
      const rs = [...this.robots.values()];
      this.transit.tick(dt, rs.some((r) => r.mode === 'held' || r.mode === 'boarding'), rs.some((r) => r.mode === 'leaving'));
      if (this.transit.here) for (const r of rs) { if (r.mode === 'held') r.release(); else r.board(); }
    }
    for (const [id, r] of this.robots) {
      r.tick(dt, this.clock, SLOTS[r.slot % SLOTS.length]);
      if (r.mode === 'gone' && r.view.alpha < 0.02) { r.view.destroy({ children: true }); r.bubble.destroy({ children: true }); r.badge.destroy(); r.tag.destroy({ children: true }); this.robots.delete(id); this.onChange?.(); }
    }
    // building glows: green while working, orange (with ripples) when a robot needs you
    this.ripples.clear();
    for (const [k, g] of this.glows) {
      const st = statusAt(at.get(k));
      const target = st === 'waiting' ? 1 : st === 'working' ? 0.85 : 0;
      g.alpha += (target - g.alpha) * Math.min(1, 5 * dt);
      g.tint = st === 'waiting' ? 0xff7a1a : 0x5dffb0;
      const pulse = 1 + Math.sin(this.clock * (st === 'waiting' ? 5 : 3)) * 0.08;
      g.scale.set(1.7 * pulse, 0.9 * pulse);
      if (st === 'waiting' && this.town.buildings[k].role !== 'plaza') {
        const [x, y] = this.town.buildings[k].door;
        for (const off of [0, 0.5]) {
          const p = (this.clock * 0.7 + off) % 1;
          // dark halo under a saturated ring so it reads on bright snow
          this.ripples.ellipse(x, y, 34 + 70 * p, 13 + 27 * p).stroke({ color: 0x3a1200, width: 8, alpha: 0.35 * (1 - p) });
          this.ripples.ellipse(x, y, 34 + 70 * p, 13 + 27 * p).stroke({ color: 0xff6a00, width: 4.5, alpha: Math.pow(1 - p, 0.7) });
        }
      }
    }
    this.layoutTags();
    this.layoutBubbles();
    this.drawLabels(at);
    this.drawPaths();
    this.drawTooltip(at);
  }

  /** Keep name tags readable: when robots pass or stand close, overlapping tags stack downward. */
  private layoutTags() {
    const list = [...this.robots.values()].filter((r) => r.tag.alpha > 0.02);
    // priority (keeps its place): selected, last clicked, waiting, then closer to the viewer
    list.sort((a, b) => Number(b.selected) - Number(a.selected) || b.lastFocus - a.lastFocus
      || Number(b.state.status === 'waiting') - Number(a.state.status === 'waiting') || b.y - a.y);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    list.forEach((r, i) => {
      const s = r.tag.scale.x, w = r.tagSize.w * s, h = r.tagSize.h * s;
      let y = r.tag.y;
      for (let guard = 0; guard < 6; guard++) {
        const hit = placed.find((p) => Math.abs(p.x - r.tag.x) < (p.w + w) / 2 + 1 && Math.abs(p.y - y) < (p.h + h) / 2);
        if (!hit) break;
        y = hit.y + (hit.h + h) / 2 + 1;
      }
      r.tag.y = y;
      r.tag.zIndex = list.length - i;
      placed.push({ x: r.tag.x, y, w, h });
    });
  }

  /** Keep bubbles readable: the most recently clicked one is on top, and overlapping ones stack upward. */
  private layoutBubbles() {
    const list = [...this.robots.values()].filter((r) => r.bubble.visible && r.bubbleSize.w > 0);
    // priority: focused first, then waiting, then lower on screen
    list.sort((a, b) => b.lastFocus - a.lastFocus || Number(b.state.status === 'waiting') - Number(a.state.status === 'waiting') || b.y - a.y);
    const placed: { x: number; y: number; w: number; h: number }[] = [];
    list.forEach((r, i) => {
      const s = r.bubble.scale.x, w = r.bubbleSize.w * s, h = r.bubbleSize.h * s;
      let y = r.bubble.y;
      for (let guard = 0; guard < 8; guard++) {
        const hit = placed.find((p) => Math.abs(p.x - r.bubble.x) < (p.w + w) / 2 + 2 && Math.abs(p.y - y) < (p.h + h) / 2);
        if (!hit) break;
        y = hit.y - (hit.h + h) / 2 - 2;
      }
      r.bubble.y = y;
      r.bubble.zIndex = list.length - i;
      placed.push({ x: r.bubble.x, y, w, h });
    });
  }

  private drawLabels(at: Map<string, Robot[]>) {
    for (const [k, b] of Object.entries(this.town.buildings)) {
      const l = this.labels.get(k)!;
      const n = at.get(k)?.length ?? 0;
      const visible = this.showLabels || this.hovered === k;
      const st = statusAt(at.get(k));
      const name = this.placeName(k, true); // empty: no folder here yet, so no label
      const key = `${visible}|${n}|${st}|${this.hovered === k}|${name}`;
      if (this.labelKey.get(k) === key) continue;
      this.labelKey.set(k, key);
      l.removeChildren().forEach((c) => c.destroy());
      if (!visible || !name || b.role === 'plaza' || b.role === 'station') continue;
      const hov = this.hovered === k;
      const text = name + (n ? `  ·  ${n}` : '');
      const t = new Text({ text, style: { fontFamily: FONT, fontSize: hov ? 14 : 12, fontWeight: '600', fill: 0xffffff } });
      t.resolution = 3; t.anchor.set(0.5);
      const w = t.width + 16, h = hov ? 24 : 20;
      const bgc = hov ? 0xd97757 : st === 'waiting' ? 0xc2410c : st === 'working' ? 0x146c4c : n ? 0x182048 : 0x0d1020;
      l.addChild(new Graphics().roundRect(-w / 2, -h / 2, w, h, h / 2).fill({ color: bgc, alpha: hov || n ? 0.94 : 0.72 }), t);
      l.position.set(...b.label);
    }
  }

  private drawPaths() {
    this.pathLayer.clear();
    if (!this.showPaths) return;
    for (const p of Object.values(this.town.paths)) {
      this.pathLayer.moveTo(p[0][0], p[0][1]);
      for (const q of p.slice(1)) this.pathLayer.lineTo(q[0], q[1]);
    }
    this.pathLayer.stroke({ color: 0x00e5ff, width: 2, alpha: 0.6 });
    for (const b of Object.values(this.town.buildings)) this.pathLayer.circle(b.door[0], b.door[1], 5).fill(0xff3fb4);
  }

  private tipKey = '';
  private drawTooltip(at: Map<string, Robot[]>) {
    const here = this.hovered ? at.get(this.hovered) ?? [] : [];
    // unlabelled, empty buildings are just scenery: no tooltip
    const k = this.hovered && (here.length || this.placeName(this.hovered)) ? this.hovered : null;
    const lines = k ? (here.length ? here.map((r) => `${r.state.name}: ${r.state.status === 'waiting' ? 'needs you' : r.state.status === 'working' ? r.state.task ?? 'working' : 'idle'}`) : ['No agents here']) : [];
    const key = k + lines.join('|');
    if (key === this.tipKey) return;
    this.tipKey = key;
    this.tipLayer.removeChildren().forEach((c) => c.destroy());
    if (!k) return;
    const t = new Text({ text: lines.join('\n'), style: { fontFamily: FONT, fontSize: 12.5, fill: 0xe9ecff, lineHeight: 19 } });
    t.resolution = 3;
    const w = t.width + 20, h = t.height + 14;
    const [dx, dy] = this.town.buildings[k].door;
    const x = Math.min(Math.max(dx - w / 2, 6), this.town.size[0] - w - 6), y = dy + 16;
    t.position.set(x + 10, y + 7);
    this.tipLayer.addChild(new Graphics().roundRect(x, y, w, h, 8).fill({ color: 0x0d1020, alpha: 0.93 }), t);
  }
}

/** The most urgent status among robots standing at a building. */
function statusAt(here: Robot[] = []) {
  return here.some((r) => r.state.status === 'waiting') ? 'waiting' : here.some((r) => r.state.status === 'working') ? 'working' : here.length ? 'idle' : '';
}

function makeGlowTexture() {
  const c = document.createElement('canvas');
  c.width = c.height = 128;
  const g = c.getContext('2d')!;
  const grd = g.createRadialGradient(64, 64, 4, 64, 64, 64);
  grd.addColorStop(0, 'rgba(255,255,255,0.9)');
  grd.addColorStop(0.5, 'rgba(255,255,255,0.35)');
  grd.addColorStop(1, 'rgba(255,255,255,0)');
  g.fillStyle = grd; g.fillRect(0, 0, 128, 128);
  return Texture.from(c);
}
