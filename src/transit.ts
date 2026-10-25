// A town's train (or ferry): it comes in along the town's route when robots are waiting to get on
// or off, stops, waits while they do, and leaves the way it came. Shown with a pre-rendered model
// (public/vehicles/train or boat: 32 headings, see tools/robot-sprites/vehicles.html), picking the
// heading closest to where it's going; drawn in code as small boxes if that's missing.
import { Assets, Container, Graphics, Rectangle, Sprite, Texture } from 'pixi.js';
import type { TownData, TransitDef } from './types';
import { TRAVEL, arriveCurve, leaveCurve, nextPhase, pointAt, routeLength, type Phase } from './town';

/** A boat leaving: it backs away from the jetty while turning round (BACK_OUT s), then goes out bow first. */
const BOAT_LEAVE = 5.6, BACK_OUT = 2.4;
const ease = (u: number) => u * u * (3 - 2 * u);

interface Box { L: number; W: number; H: number; side: number; top: number; windows?: number }

/** A pre-rendered vehicle: one frame per heading (heading k points k × 360°/n from screen-right toward "away"). */
export interface VehicleLook {
  frames: Texture[];
  anchor: [number, number];
  /** the model's length in frame px at scale 1 */
  lengthPx: number;
  /** its length in the town, in robot heights */
  lengthRobots: number;
  /** it has a bow (a boat): it turns to go out front-first; a train with a cab at each end just reverses */
  bow: boolean;
}

const LOOKS: Record<string, { lengthRobots: number; bow: boolean }> = { train: { lengthRobots: 3.0, bow: false }, boat: { lengthRobots: 2.4, bow: true } };
const loading = new Map<string, Promise<VehicleLook>>();

/** Loads public/vehicles/<name>.json and its sheet (once). */
export function loadVehicle(name: 'train' | 'boat'): Promise<VehicleLook> {
  let p = loading.get(name);
  if (!p) {
    p = (async () => {
      const meta = await fetch(`vehicles/${name}.json`).then((r) => { if (!r.ok) throw new Error(name); return r.json(); });
      const sheet: Texture = await Assets.load({ src: `vehicles/${meta.image}`, data: { autoGenerateMipmaps: true } });
      const { w, h } = meta.frame;
      const frames = Array.from({ length: meta.headings }, (_, k) =>
        new Texture({ source: sheet.source, frame: new Rectangle((k % meta.cols) * w, Math.floor(k / meta.cols) * h, w, h) }));
      return { frames, anchor: [meta.anchor.x / w, meta.anchor.y / h], lengthPx: meta.lengthPx, ...LOOKS[name] };
    })();
    loading.set(name, p);
  }
  return p;
}

/** The sheet's heading for a direction on screen (radians, image px): the camera looks 30° down, so screen-up is squashed. */
function headingIndex(a: number, n: number) {
  const gx = Math.cos(a), gy = Math.sin(a) / Math.sin(Math.PI / 6);
  const psi = Math.atan2(-gy, gx);
  return ((Math.round(psi / (Math.PI * 2 / n)) % n) + n) % n;
}

export class Transit {
  /** goes in the town's robot layer (sorted by depth); masked to the picture */
  readonly view = new Container();
  phase: Phase = 'away';
  private t = 0;
  private g = new Graphics();
  private len: number;
  private puffs: { x: number; y: number; age: number }[] = [];
  private puffClock = 0;
  private look?: VehicleLook;
  private sprite?: Sprite;

  constructor(private town: TownData, private def: TransitDef) {
    this.len = routeLength(def.route);
    const mask = new Graphics().rect(0, 0, town.size[0], town.size[1]).fill(0xffffff);
    this.view.addChild(this.g, mask);
    this.view.mask = mask;
    // just behind robots standing on the platform, in front of the station behind the tracks
    this.view.zIndex = def.board[1] - 1;
    this.view.visible = false;
  }

  /** Use a pre-rendered model instead of the drawn boxes. */
  setLook(look: VehicleLook) {
    this.look = look;
    this.sprite = new Sprite(look.frames[0]);
    this.sprite.anchor.set(...look.anchor);
    this.view.addChildAt(this.sprite, 1);
  }

  /** The direction from a vehicle's front to its back when it stands at the stop (radians, image px). */
  private platformAngle(len: number) {
    const [x0, y0] = pointAt(this.def.route, 0), [x1, y1] = pointAt(this.def.route, len);
    return Math.atan2(y1 - y0, x1 - x0);
  }

  /** The vehicle's length along the route, image px (at the stop's depth). */
  private length() {
    const s = 0.78 + 0.32 * (this.def.stop[1] / this.town.size[1]);
    return this.look ? this.look.lengthRobots * this.town.robotHeight * s : 210 * (this.town.robotHeight / 92) * s;
  }

  /** At the stop with its doors open: robots get on and off now. */
  get here() { return this.phase === 'dwell'; }

  /**
   * `need`: robots are waiting to get on or off; `walking`: robots are on their way to the station
   * (it waits a little for them).
   */
  tick(dt: number, need: boolean, walking: boolean) {
    this.t += dt;
    const next = nextPhase(this.phase, this.t, need, walking, this.look?.bow ? BOAT_LEAVE : TRAVEL);
    if (next !== this.phase) { this.phase = next; this.t = 0; }
    this.view.visible = this.phase !== 'away' || this.puffs.length > 0;
    const f = Math.min(1, this.t / TRAVEL);
    // distance of the front from the stop: in at a steady speed, braking into the station; out by
    // pulling away, then steady; far enough that the whole vehicle is out of the picture (the route
    // carries on past its end)
    const reach = this.len + this.length();
    const d = this.phase === 'arriving' ? reach * (1 - arriveCurve(f)) : this.phase === 'leaving' ? reach * leaveCurve(f) : this.phase === 'dwell' ? 0 : reach;
    const moving = this.phase === 'arriving' || this.phase === 'leaving';
    if (this.look) this.drawModel(d, moving); else this.draw(d, dt, moving);
  }

  /** The pre-rendered vehicle at distance d (its front) along the route. */
  private drawModel(d: number, moving: boolean) {
    const look = this.look!, sp = this.sprite!, g = this.g.clear();
    const H = this.town.size[1], depth = (y: number) => 0.78 + 0.32 * (y / H);
    const L = look.lengthRobots * this.town.robotHeight;
    const half = (L * depth(this.def.stop[1])) / 2;
    // where its middle is along the route, and which way it points: in toward the stop (against the
    // route) while arriving and waiting; a train leaves by reversing the way it came
    let along = d + half, turn = 0;
    if (look.bow && this.phase === 'leaving') {
      // like a real boat: back away from the jetty while swinging round, then go out bow first
      if (this.t < BACK_OUT) { const u = ease(this.t / BACK_OUT); along = half + L * 0.7 * u; turn = u; }
      else { const v = (this.t - BACK_OUT) / (BOAT_LEAVE - BACK_OUT); along = half + L * 0.7 + (this.len + L * 1.5) * leaveCurve(v, 0.5); turn = 1; }
    }
    const [x, y, alongAngle] = pointAt(this.def.route, along);
    const s = depth(y);
    // a train is rigid: it keeps the heading it has standing at the platform (front to back), so a
    // kink in the track doesn't turn it; a boat steers along its route
    const a = look.bow ? alongAngle : this.platformAngle(2 * half);
    const dir = a + Math.PI * (1 - turn);
    sp.texture = look.frames[headingIndex(dir, look.frames.length)];
    sp.position.set(x, y);
    sp.scale.set((L * s) / look.lengthPx);
    sp.visible = this.phase !== 'away';
    if (look.bow && moving) {
      // churned water at the stern (where the motors are), whichever way it's going
      const back = dir + Math.PI;
      for (let i = 1; i <= 3; i++) {
        const bx = x + Math.cos(back) * (L / 2 + i * 12) * s, by = y + Math.sin(back) * (L / 2 + i * 12) * s * 0.5;
        g.ellipse(bx, by + 2 * s, (10 + i * 7) * s, (4 + i * 2) * s).stroke({ color: 0xffffff, width: 1.5, alpha: 0.5 - i * 0.12 });
      }
    }
  }

  private draw(d: number, dt: number, moving: boolean) {
    const g = this.g.clear();
    const k = this.town.robotHeight / 92; // the towns' scale (Frostpeak = 1)
    const depth = (y: number) => (0.78 + 0.32 * (y / this.town.size[1])) * k;
    const cars: { at: number; box: Box; loco?: boolean }[] = this.def.kind === 'ferry'
      ? [{ at: 0, box: { L: 112, W: 40, H: 12, side: 0xf4f1ea, top: 0xdfe7ee } }]
      : [
        { at: 0, box: { L: 58, W: 24, H: 22, side: 0x2c3646, top: 0x3d4a60 }, loco: true },
        { at: 64, box: { L: 66, W: 24, H: 24, side: 0x8c2f28, top: 0xc9b48a, windows: 5 } },
        { at: 134, box: { L: 66, W: 24, H: 24, side: 0x2f6b4a, top: 0xc9b48a, windows: 5 } },
      ];
    // farthest first, so nearer cars cover them
    const placed = cars.map((c) => {
      const s = depth(this.def.stop[1]);
      const [x, y, a] = pointAt(this.def.route, d + (c.at + c.box.L / 2) * s);
      return { ...c, x, y, a, s: depth(y) };
    }).sort((p, q) => p.y - q.y);
    if (this.def.kind === 'ferry' && moving) this.wake(placed[0]);
    for (const p of placed) {
      const b = p.box, s = p.s;
      g.ellipse(p.x, p.y + 3 * s, (b.L / 2 + 4) * s, (b.W / 2 + 3) * s).fill({ color: 0x000000, alpha: this.def.kind === 'ferry' ? 0.18 : 0.28 });
      box(g, p.x, p.y, p.a, b.L * s, b.W * s, b.H * s, b.side, b.top, b.windows);
      if (this.def.kind === 'ferry') bow(g, p.x, p.y, p.a, b.L * s, b.W * s, b.H * s, b.side, b.top);
      if (this.def.kind === 'ferry') {
        // stripe, cabin with a blue roof
        box(g, p.x - Math.cos(p.a) * 8 * s, p.y - Math.sin(p.a) * 8 * s - b.H * s, p.a, 44 * s, 24 * s, 16 * s, 0xffffff, 0x2f6fb3, 3);
      }
      if (p.loco) {
        // boiler front, cab at the back, chimney with smoke
        const fx = p.x - Math.cos(p.a) * b.L * 0.32 * s, fy = p.y - Math.sin(p.a) * b.L * 0.32 * s;
        box(g, p.x + Math.cos(p.a) * b.L * 0.3 * s, p.y + Math.sin(p.a) * b.L * 0.3 * s - b.H * s, p.a, 18 * s, 22 * s, 14 * s, 0x2c3646, 0x9e3b2f, 2);
        g.rect(fx - 4 * s, fy - (b.H + 14) * s, 8 * s, 14 * s).fill(0x1b2029);
        g.rect(fx - 5.5 * s, fy - (b.H + 16) * s, 11 * s, 3 * s).fill(0x9e8a5a);
        this.puffClock += dt;
        if (this.puffClock > (moving ? 0.12 : 0.35) && this.phase !== 'away') { this.puffClock = 0; this.puffs.push({ x: fx, y: fy - (b.H + 18) * s, age: 0 }); }
        g.circle(fx + Math.cos(p.a) * 6 * s, fy + Math.sin(p.a) * 6 * s - b.H * 0.55 * s, 3 * s).fill({ color: 0xffd27a, alpha: 0.95 }); // headlamp
      }
    }
    for (const q of this.puffs) {
      q.age += dt;
      const r = (5 + q.age * 14) * k;
      g.circle(q.x + q.age * 8, q.y - q.age * 26 * k, r).fill({ color: 0xe9eef5, alpha: Math.max(0, 0.55 * (1 - q.age / 1.6)) });
    }
    this.puffs = this.puffs.filter((q) => q.age < 1.6);
  }

  /** Ripples behind a moving ferry. */
  private wake(p: { x: number; y: number; a: number; s: number; box: Box }) {
    const g = this.g;
    for (let i = 1; i <= 3; i++) {
      const bx = p.x + Math.cos(p.a) * (p.box.L / 2 + i * 14) * p.s, by = p.y + Math.sin(p.a) * (p.box.L / 2 + i * 14) * p.s;
      g.ellipse(bx, by + 2 * p.s, (10 + i * 7) * p.s, (4 + i * 2) * p.s).stroke({ color: 0xffffff, width: 1.5, alpha: 0.5 - i * 0.12 });
    }
  }
}

/**
 * A box standing on the ground at (cx, cy), its length along angle `a`: the side faces facing the
 * viewer, then the top (raised by `H`). `windows`: lit windows along the long side that faces us.
 */
function box(g: Graphics, cx: number, cy: number, a: number, L: number, W: number, H: number, side: number, top: number, windows = 0) {
  const c = Math.cos(a), s = Math.sin(a);
  const pt = (u: number, v: number): [number, number] => [cx + c * u - s * v, cy + s * u + c * v];
  const base = [pt(-L / 2, -W / 2), pt(L / 2, -W / 2), pt(L / 2, W / 2), pt(-L / 2, W / 2)];
  const up = (p: [number, number]): [number, number] => [p[0], p[1] - H];
  // the two faces nearest the viewer (largest y) are visible
  const faces = [0, 1, 2, 3].map((i) => [base[i], base[(i + 1) % 4]] as const).sort((x, y) => (y[0][1] + y[1][1]) - (x[0][1] + x[1][1])).slice(0, 2);
  for (const [p, q] of faces.reverse()) {
    const shade = Math.abs(p[0] - q[0]) > Math.abs(p[1] - q[1]) ? side : darken(side, 0.78);
    g.poly([...p, ...q, ...up(q), ...up(p)]).fill(shade);
    const long = Math.hypot(q[0] - p[0], q[1] - p[1]) > (L + W) / 2;
    if (windows && long) for (let i = 0; i < windows; i++) {
      const f0 = (i + 0.25) / windows, f1 = (i + 0.75) / windows;
      const w0: [number, number] = [p[0] + (q[0] - p[0]) * f0, p[1] + (q[1] - p[1]) * f0 - H * 0.42];
      const w1: [number, number] = [p[0] + (q[0] - p[0]) * f1, p[1] + (q[1] - p[1]) * f1 - H * 0.42];
      g.poly([...w0, ...w1, w1[0], w1[1] - H * 0.36, w0[0], w0[1] - H * 0.36]).fill(0xffd27a);
    }
  }
  g.poly(base.flatMap((p) => up(p))).fill(top);
}

/** A pointed bow on the front (the stop side) of a hull drawn with box(), with a blue stripe along the waterline. */
function bow(g: Graphics, cx: number, cy: number, a: number, L: number, W: number, H: number, side: number, top: number) {
  const c = Math.cos(a), s = Math.sin(a);
  const pt = (u: number, v: number): [number, number] => [cx + c * u - s * v, cy + s * u + c * v];
  const up = (p: [number, number]): [number, number] => [p[0], p[1] - H];
  const l = pt(-L / 2, -W / 2), r = pt(-L / 2, W / 2), tip = pt(-L / 2 - W * 0.85, 0);
  // the hull's sides toward the tip that face the viewer, then the deck
  for (const q of [l, r].sort((x, y) => x[1] - y[1])) g.poly([...q, ...tip, ...up(tip), ...up(q)]).fill(darken(side, 0.9));
  g.poly([...up(l), ...up(tip), ...up(r)]).fill(top);
  // stripe
  const a0 = pt(-L / 2, W / 2), a1 = pt(L / 2, W / 2), k = H * 0.35;
  const [n0, n1] = a0[1] + a1[1] > pt(-L / 2, -W / 2)[1] + pt(L / 2, -W / 2)[1] ? [a0, a1] : [pt(-L / 2, -W / 2), pt(L / 2, -W / 2)];
  g.poly([n0[0], n0[1] - k, n1[0], n1[1] - k, n1[0], n1[1] - k * 1.9, n0[0], n0[1] - k * 1.9]).fill(0x2f6fb3);
}

const darken = (c: number, f: number) => (Math.round(((c >> 16) & 255) * f) << 16) | (Math.round(((c >> 8) & 255) * f) << 8) | Math.round((c & 255) * f);
