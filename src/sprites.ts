import { Assets, Rectangle, Texture } from 'pixi.js';
import type { RobotMeta } from './types';

export type Anim = 'walk' | 'idle' | 'type' | 'wave';
const ANIMS: Anim[] = ['walk', 'idle', 'type', 'wave'];
const BASE = 'sprites/robot/';

/** Sliced frames: frames[anim][dirRow][frame] */
export type RobotFrames = Record<Anim, Texture[][]>;

export class RobotSprites {
  meta!: RobotMeta;
  private cache = new Map<string, Promise<RobotFrames>>();

  async init() {
    this.meta = await (await fetch(BASE + 'robot.json')).json();
  }

  colors() {
    return Object.keys(this.meta.colors);
  }

  /** Loads (once) and slices the four sheets for a color. */
  get(color: string): Promise<RobotFrames> {
    let p = this.cache.get(color);
    if (!p) {
      p = this.load(color);
      this.cache.set(color, p);
    }
    return p;
  }

  private async load(color: string): Promise<RobotFrames> {
    const { w, h } = this.meta.frame;
    const out = {} as RobotFrames;
    await Promise.all(
      ANIMS.map(async (a) => {
        const sheet: Texture = await Assets.load(`${BASE}${color}/${a}.webp`);
        const n = this.meta.animations[a].frames;
        out[a] = this.meta.directions.map((_, row) =>
          Array.from({ length: n }, (_, f) => new Texture({ source: sheet.source, frame: new Rectangle(f * w, row * h, w, h) })),
        );
      }),
    );
    return out;
  }
}

/**
 * Screen movement -> robot yaw (radians). Yaw 0 = facing the viewer, +PI/2 = facing screen-right.
 * The camera looks down 30 degrees, so screen-y distances are foreshortened by sin(30) = 0.5.
 */
export function yawFromScreen(dx: number, dy: number, elevationDeg = 30) {
  const gy = dy / Math.sin((elevationDeg * Math.PI) / 180);
  return Math.atan2(dx, gy);
}

/** Row index for a yaw: rows are d, dr, r, ur, u, ul, l, dl (every 45 degrees). */
export function rowForYaw(yaw: number) {
  const i = Math.round(yaw / (Math.PI / 4));
  return ((i % 8) + 8) % 8;
}

export function rowCenterYaw(row: number) {
  const y = row * (Math.PI / 4);
  return y > Math.PI ? y - 2 * Math.PI : y;
}

export function angleDiff(a: number, b: number) {
  let d = a - b;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
