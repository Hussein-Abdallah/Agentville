// Town services: the badge beside a robot while it runs a meaningful command (tests, a build, git,
// installing packages, a dev server, a deploy), and the pass/fail flag when it ends. Drawn in code,
// centred on (0, 0) with radius R, animated by `t` (seconds).
import type { Graphics } from 'pixi.js';
import type { ActivityKind } from './types';

export const R = 13;
/** Ring colour per kind. */
const RING: Record<ActivityKind, number> = { test: 0x22b357, build: 0xf59e0b, git: 0xf05033, install: 0xa47148, server: 0xfacc15, deploy: 0x8a5cf6 };
export const BADGE_LABEL: Record<ActivityKind, string> = {
  test: 'Running tests', build: 'Building', git: 'Git', install: 'Installing packages', server: 'Running a server', deploy: 'Deploying',
};

/** An activity badge: a white disc with a coloured ring and the kind's little picture. */
export function drawActivity(g: Graphics, kind: ActivityKind, t: number) {
  g.circle(0, 1.5, R + 1).fill({ color: 0x000000, alpha: 0.25 });
  g.circle(0, 0, R).fill(0xffffff).stroke({ color: RING[kind], width: 2.5 });
  const ink = 0x2b3245;
  switch (kind) {
    case 'test': {
      // a tilted test tube with green liquid and bubbles rising
      g.roundRect(-3, -8, 6, 15, 3).stroke({ color: ink, width: 1.6 });
      g.roundRect(-2.2, 0, 4.4, 6.4, 2.2).fill(0x22c55e);
      for (let i = 0; i < 3; i++) {
        const p = (t * 0.9 + i / 3) % 1;
        g.circle(-1 + i, 2 - p * 11, 0.9 + p * 0.6).fill({ color: 0x22c55e, alpha: 1 - p });
      }
      g.rect(-4.5, -8.8, 9, 1.6).fill(ink);
      break;
    }
    case 'build': {
      // a hammer striking, with sparks
      const swing = Math.sin(t * 9) * 0.35;
      const c = Math.cos(-0.7 + swing), s = Math.sin(-0.7 + swing);
      const p = (x: number, y: number) => [x * c - y * s + 1, x * s + y * c + 2] as const;
      g.poly([...p(-1, -2), ...p(1, -2), ...p(1, 9), ...p(-1, 9)]).fill(0x9a6b3c);
      g.poly([...p(-5, -6), ...p(5, -6), ...p(5, -2), ...p(-5, -2)]).fill(0x5b6477);
      if (Math.sin(t * 9) > 0.4) for (const [x, y] of [[-8, -6], [-6, -9], [-9, -2]]) g.circle(x, y, 1.1).fill(0xffc53d);
      break;
    }
    case 'git': {
      // an envelope
      g.roundRect(-8, -5.5, 16, 11, 1.5).fill(0xfff4e8).stroke({ color: ink, width: 1.4 });
      g.moveTo(-8, -5).lineTo(0, 1.5).lineTo(8, -5).stroke({ color: ink, width: 1.4 });
      break;
    }
    case 'install': {
      // a crate dropping in
      const y = -2 + Math.max(0, Math.sin(t * 3)) * -2;
      g.rect(-6.5, y - 4.5, 13, 11).fill(0xc8955a).stroke({ color: 0x6b4423, width: 1.3 });
      g.moveTo(-6.5, y - 0.8).lineTo(6.5, y - 0.8).moveTo(-6.5, y + 2.8).lineTo(6.5, y + 2.8).moveTo(-6.5, y - 4.5).lineTo(6.5, y + 6.5).stroke({ color: 0x6b4423, width: 1 });
      break;
    }
    case 'server': {
      // a glowing lamp
      const glow = 0.45 + 0.35 * Math.sin(t * 3.5);
      g.circle(0, -2, 8).fill({ color: 0xffe066, alpha: glow * 0.5 });
      g.circle(0, -2, 5.2).fill(0xffd43b).stroke({ color: 0xb08900, width: 1 });
      g.rect(-2.6, 3.2, 5.2, 4).fill(0x5b6477);
      break;
    }
    case 'deploy': {
      // a rocket with a flickering flame
      const f = 3 + Math.abs(Math.sin(t * 14)) * 3;
      g.poly([-2.5, 5, 2.5, 5, 0, 5 + f]).fill(0xff8a3d);
      g.poly([0, -9, 3.6, -3, 3.6, 5, -3.6, 5, -3.6, -3]).fill(0xf1f3f7).stroke({ color: ink, width: 1.2 });
      g.poly([-3.6, 1, -6.5, 6, -3.6, 5]).fill(0xe5484d);
      g.poly([3.6, 1, 6.5, 6, 3.6, 5]).fill(0xe5484d);
      g.circle(0, -2, 1.6).fill(0x5aa9ff);
      break;
    }
  }
}

/** The result flag: a green disc with a check, or a red one with a cross. */
export function drawResult(g: Graphics, ok: boolean) {
  g.circle(0, 1.5, R + 1).fill({ color: 0x000000, alpha: 0.25 });
  g.circle(0, 0, R).fill(ok ? 0x22c55e : 0xef4444).stroke({ color: 0xffffff, width: 2 });
  if (ok) g.moveTo(-5.5, 0.5).lineTo(-1.5, 4.5).lineTo(6, -4.5).stroke({ color: 0xffffff, width: 2.6, cap: 'round', join: 'round' });
  else g.moveTo(-4.5, -4.5).lineTo(4.5, 4.5).moveTo(4.5, -4.5).lineTo(-4.5, 4.5).stroke({ color: 0xffffff, width: 2.6, cap: 'round' });
}
