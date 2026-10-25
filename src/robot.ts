import { Container, Graphics, Sprite, Text } from 'pixi.js';
import type { AgentState, TownData } from './types';
import { angleDiff, rowCenterYaw, rowForYaw, yawFromScreen, type Anim, type RobotFrames, type RobotSprites } from './sprites';
import { pathBetween, stationOf } from './town';
import { drawActivity, drawResult } from './badges';

/** how long a pass/fail flag stays (s) */
const RESULT_SECONDS = 6;
const TURN_RATE = 9; // how fast the facing angle follows movement (per second)
const HYSTERESIS = (10 * Math.PI) / 180; // extra angle needed before switching sprite direction
const FONT = '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif';

/** held: waiting unseen on the incoming train; boarding: on the platform, waiting to get on */
type Mode = 'held' | 'arriving' | 'walking' | 'present' | 'leaving' | 'boarding' | 'gone';

/** One robot on the map: movement, facing, animation, bubble and name tag. */
export class Robot {
  readonly view = new Container();
  state: AgentState;
  /** building the robot is standing at (or last left) */
  at: string;
  mode: Mode = 'arriving';
  x: number;
  y: number;
  slot = 0;
  highlight = 0;
  /** shown in the details panel: keeps a steady ring */
  selected = false;

  private frames?: RobotFrames;
  private body = new Sprite();
  private shadow = new Graphics();
  private ring = new Graphics();
  /** name tag: lives in the world's tag layer so overlapping tags can be spread apart */
  readonly tag = new Container();
  tagSize = { w: 0, h: 0 };
  /** lives in the world's top bubble layer so bubbles never hide behind other robots */
  readonly bubble = new Container();
  /** town services: the activity badge / result flag beside the robot (lives in the bubble layer) */
  readonly badge = new Graphics();
  bubbleSize = { w: 0, h: 0 };
  lastFocus = 0;
  private bubbleKey = '';
  private path: [number, number][] = [];
  private yaw = 0;
  private row = 0;
  private alpha = 0;
  private phase = Math.random() * 10;
  private small: boolean;

  /** index of the claimed standing spot at a place with spots (plaza), or -1 */
  spot = -1;

  constructor(state: AgentState, private town: TownData, private sprites: RobotSprites, private claimSpot: (r: Robot, place: string) => number = () => 0) {
    this.state = { ...state };
    this.small = !!state.parentId;
    const st = stationOf(town);
    this.at = st;
    [this.x, this.y] = town.buildings[st].door;
    this.view.addChild(this.ring, this.shadow, this.body);
    this.view.eventMode = 'static';
    this.view.cursor = 'pointer';
    this.body.anchor.set(sprites.meta.anchor.x / sprites.meta.frame.w, sprites.meta.anchor.y / sprites.meta.frame.h);
    this.buildTag();
    this.shownTag = this.tagKey();
    sprites.get(state.color).then((f) => (this.frames = f));
    this.walkTo(state.building);
  }

  /** New state from the simulator / live service. */
  update(next: AgentState) {
    const moved = next.building !== this.state.building;
    this.state = { ...next };
    if (moved && (this.mode === 'arriving' || this.mode === 'walking' || this.mode === 'present')) this.walkTo(next.building);
  }

  /** Already standing at its building (no walk from the station), e.g. when the page switches towns. */
  arriveNow() {
    this.path = [];
    this.at = this.target;
    const spots = this.town.buildings[this.target]?.spots;
    [this.x, this.y] = spots?.length && this.spot >= 0 ? spots[this.spot % spots.length] : this.town.buildings[this.target].door;
    this.mode = 'present';
    this.alpha = 1;
  }

  /** Wait unseen for the town's train (or ferry) to bring it in; release() lets it step off. */
  hold() {
    const b = this.town.transit?.board;
    if (!b) return;
    this.mode = 'held';
    [this.x, this.y] = b;
    this.path = [];
    this.alpha = 0;
  }

  /** The train is in: step off at the platform and walk to the building. */
  release() {
    if (this.mode !== 'held') return;
    this.mode = 'arriving';
    this.walkTo(this.state.building);
  }

  /** Off to the station; with a train, it then waits on the platform (boarding) until board() takes it. */
  leave() {
    if (this.mode === 'held') { this.mode = 'gone'; return; } // never got off
    this.mode = 'leaving';
    this.walkTo(stationOf(this.town));
    const b = this.town.transit?.board;
    if (b) this.path.push(b);
  }

  /** Gets on the train (fades out). */
  board() { if (this.mode === 'boarding') this.mode = 'gone'; }

  /** Join the road network from wherever the robot is now and head to a building. */
  private walkTo(building: string) {
    let best: [number, number][] = [], bd = Infinity;
    for (const from of Object.keys(this.town.buildings)) {
      const p = pathBetween(this.town, from, building);
      for (let i = 0; i < p.length; i++) {
        const d = Math.hypot(p[i][0] - this.x, p[i][1] - this.y);
        if (d < bd) { bd = d; best = p.slice(i); }
      }
    }
    // places with standing spots (the plaza): walk on to a free spot
    const spots = this.town.buildings[building]?.spots;
    this.spot = -1;
    if (spots?.length) { this.spot = this.claimSpot(this, building); best = [...best, spots[this.spot % spots.length]]; }
    this.path = best;
    this.target = building;
    if (this.mode === 'present') this.mode = 'walking';
  }
  target = '';

  /** depth scale: robots lower on the screen are closer and bigger */
  scaleAt(y: number) {
    const [, H] = this.town.size;
    return (0.78 + 0.32 * (y / H)) * (this.small ? 0.72 : 1);
  }

  /** Walking, travelling or fading: the town draws at full speed while any robot is. */
  get busy() {
    return this.path.length > 0 || (this.mode !== 'present' && this.mode !== 'held') || Math.abs((this.mode === 'held' ? 0 : 1) - this.alpha) > 0.02 || this.highlight > 0;
  }

  tick(dt: number, clock: number, slotOffset: number) {
    // movement
    let moving = false;
    if (this.path.length && this.mode !== 'held') {
      // go this frame's whole distance, past as many path points as it takes: stopping at a point
      // would make the frame count as standing still (an idle frame flashing in while rolling)
      let step = this.town.walkSpeed * this.scaleAt(this.y) * dt;
      let dir: [number, number] | null = null;
      while (step > 0 && this.path.length) {
        const [tx, ty] = this.path[0];
        const dx = tx - this.x, dy = ty - this.y, d = Math.hypot(dx, dy);
        if (d > 1e-6) dir = [dx, dy];
        if (d <= step) { this.x = tx; this.y = ty; this.path.shift(); step -= d; }
        else { this.x += (dx / d) * step; this.y += (dy / d) * step; step = 0; }
      }
      if (dir) {
        moving = true;
        this.yaw += angleDiff(yawFromScreen(dir[0], dir[1]), this.yaw) * Math.min(1, TURN_RATE * dt);
      }
      if (!this.path.length) {
        this.at = this.target;
        if (this.mode === 'leaving') this.mode = this.town.transit ? 'boarding' : 'gone';
        else if (this.mode !== 'boarding' && this.mode !== 'gone') this.mode = 'present';
      }
    }
    if (this.mode === 'present' && !moving) {
      // face the viewer when waiting so the wave is visible; otherwise a three-quarter view
      const look = this.town.buildings[this.at]?.lookAt;
      const want = this.state.status === 'waiting' ? 0 : look ? yawFromScreen(look[0] - this.x, look[1] - this.y) : (slotOffset < 0 ? -Math.PI / 4 : Math.PI / 4);
      this.yaw += angleDiff(want, this.yaw) * Math.min(1, 6 * dt);
    }
    // sprite direction with hysteresis (no flicker at bends)
    if (Math.abs(angleDiff(this.yaw, rowCenterYaw(this.row))) > Math.PI / 8 + HYSTERESIS) this.row = rowForYaw(this.yaw);

    // fade in at the station, fade out when leaving
    const targetAlpha = this.mode === 'gone' || this.mode === 'held' ? 0 : 1;
    this.alpha += (targetAlpha - this.alpha) * Math.min(1, 4 * dt);

    // animation
    let anim: Anim = 'idle';
    if (moving) anim = 'walk';
    else if (this.mode === 'present') anim = this.state.status === 'working' ? 'type' : this.state.status === 'waiting' ? 'wave' : 'idle';
    if (this.frames) {
      const meta = this.sprites.meta.animations[anim];
      const fr = this.frames[anim][this.row];
      this.body.texture = fr[Math.floor((clock + this.phase) * meta.fps) % fr.length];
    }

    // place
    const s = this.scaleAt(this.y);
    const ox = this.mode === 'present' && !moving && this.spot < 0 ? slotOffset * s : 0;
    this.view.position.set(this.x + ox, this.y);
    this.view.zIndex = this.y;
    this.view.alpha = this.alpha;
    const px = (this.town.robotHeight / (this.sprites.meta.frame.h * 0.9)) * s;
    this.body.scale.set(px);
    this.shadow.clear().ellipse(0, 0, 20 * s, 7 * s).fill({ color: 0x000000, alpha: 0.28 });
    const tk = this.tagKey();
    if (tk !== this.shownTag) { this.shownTag = tk; this.buildTag(); }
    this.tag.scale.set(s);
    // world position under the feet; the world nudges overlapping tags apart afterwards
    this.tag.position.set(this.view.x, this.y + 12 * s);
    this.tag.alpha = this.alpha;
    this.ring.clear();
    const flash = this.highlight > 0 ? Math.min(1, (this.highlight -= dt)) : 0;
    const a = Math.max(flash, this.selected ? 0.85 : 0);
    if (a > 0) this.ring.ellipse(0, 0, 28 * s, 11 * s).stroke({ color: 0xffffff, width: 2.5, alpha: a });

    // speech bubble
    const show = this.mode === 'present' && !moving && (this.state.status === 'waiting' || (this.state.status === 'working' && !!this.state.task));
    // between your prompt and Claude's first step it's thinking: the dots count up
    const dots = this.state.task === 'Thinking…' ? 1 + (Math.floor(this.badgeClock * 2.5) % 3) : 0;
    const text = this.state.status === 'waiting' ? 'Needs you' : dots ? 'Thinking' + '.'.repeat(dots) + '\u2008'.repeat(3 - dots) : this.state.task ?? '';
    const key = show ? this.state.status + text : '';
    if (key !== this.bubbleKey) { this.bubbleKey = key; this.buildBubble(show ? text : '', this.state.status === 'waiting'); }
    this.bubble.scale.set(s);
    // world position; the world nudges overlapping bubbles apart afterwards
    this.bubble.position.set(this.view.x, this.y - this.town.robotHeight * s - 14 * s);
    this.bubble.alpha = this.alpha;
    this.bubble.visible = !!this.bubbleKey;

    // town services: a badge while a meaningful command runs, then a pass/fail flag for a few seconds
    this.badgeClock += dt;
    const res = this.state.result, age = res ? (Date.now() - res.at) / 1000 : Infinity;
    const g = this.badge.clear();
    const shown = this.mode === 'present' || this.mode === 'walking';
    if (shown && this.state.activity) drawActivity(g, this.state.activity, this.badgeClock);
    else if (shown && res && age < RESULT_SECONDS) drawResult(g, res.ok);
    // the flag pops in, then fades out
    const pop = res && !this.state.activity ? Math.min(1, age * 5) : 1;
    const fade = res && !this.state.activity ? Math.min(1, (RESULT_SECONDS - age) / 0.6) : 1;
    this.badge.scale.set(s * (0.6 + 0.4 * pop) * (pop < 1 ? 1.15 : 1));
    this.badge.position.set(this.view.x + 30 * s, this.y - this.town.robotHeight * s * 0.62);
    this.badge.alpha = this.alpha * Math.max(0, fade);
    this.badge.visible = g.bounds.width > 0;
  }
  private badgeClock = Math.random() * 10;

  /**
   * The name tag; once the context is half full (or being compacted) a thin bar inside it shows how
   * full, turning amber and then red, like a backpack filling up.
   */
  private buildTag() {
    this.tag.removeChildren().forEach((c) => c.destroy());
    const t = new Text({ text: this.state.name, style: { fontFamily: FONT, fontSize: 11, fontWeight: '600', fill: 0xffffff } });
    t.resolution = 3; t.anchor.set(0.5);
    const w = t.width + 12, h = 17;
    const bg = new Graphics().roundRect(-w / 2, -h / 2, w, h, h / 2).fill({ color: 0x0f1328, alpha: 0.8 });
    this.tag.addChild(bg, t);
    const c = this.state.context;
    const f = c && c.max ? Math.min(1, c.used / c.max) : 0;
    if (c && (f >= 0.5 || c.compacting)) {
      const bw = w - 12, x = -bw / 2, y = h / 2 - 3.5;
      const bar = new Graphics().roundRect(x, y, bw, 2, 1).fill({ color: 0xffffff, alpha: 0.18 });
      if (c.compacting) bar.roundRect(x, y, bw, 2, 1).fill({ color: 0x8fd3ff, alpha: 0.9 });
      else bar.roundRect(x, y, Math.max(2, bw * f), 2, 1).fill({ color: meterColor(f) });
      this.tag.addChild(bar);
    }
    // a command left running in the background (a dev server…): a glowing lamp on the tag
    if (this.state.background?.length) {
      const lamp = new Graphics().circle(w / 2 - 1, -h / 2 + 2, 5).fill({ color: 0xffe066, alpha: 0.35 }).circle(w / 2 - 1, -h / 2 + 2, 3).fill(0xffd43b);
      this.tag.addChild(lamp);
    }
    this.tagSize = { w, h };
  }

  /** What the name tag shows, so it's only rebuilt when that changes. */
  private tagKey() {
    const c = this.state.context;
    const f = c && c.max ? Math.min(1, c.used / c.max) : 0;
    return `${this.state.name}|${c?.compacting ? 'c' : f >= 0.5 ? Math.round(f * 50) : ''}|${this.state.background?.length ?? 0}`;
  }
  private shownTag = '';

  private buildBubble(text: string, urgent: boolean) {
    this.bubble.removeChildren().forEach((c) => c.destroy());
    this.bubbleSize = { w: 0, h: 0 };
    if (!text) return;
    const t = new Text({ text: (urgent ? '! ' : '') + text, style: { fontFamily: FONT, fontSize: 12.5, fontWeight: '600', fill: urgent ? 0xffffff : 0x1c2036 } });
    t.resolution = 3; t.anchor.set(0.5);
    const w = t.width + 18, h = 24;
    const g = new Graphics()
      .roundRect(-w / 2, -h / 2, w, h, 9)
      .fill({ color: urgent ? 0xff7a1a : 0xffffff, alpha: 0.96 })
      .poly([-6, h / 2 - 1, 6, h / 2 - 1, 0, h / 2 + 6])
      .fill({ color: urgent ? 0xff7a1a : 0xffffff, alpha: 0.96 });
    this.bubble.addChild(g, t);
    this.bubbleSize = { w, h: h + 6 };
  }

  hitTest(ix: number, iy: number) {
    const s = this.scaleAt(this.y);
    const cx = this.view.x, top = this.y - this.town.robotHeight * s;
    return Math.abs(ix - cx) < 22 * s && iy > top - 10 && iy < this.y + 10;
  }
}

/** Context meter colour: green, then amber past 60 %, red past 85 %. */
export const meterColor = (f: number) => (f >= 0.85 ? 0xff6b5e : f >= 0.6 ? 0xffb347 : 0x6fd49a);
