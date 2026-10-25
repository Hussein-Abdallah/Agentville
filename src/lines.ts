// Personality lines: what a robot says for a few seconds when its session starts, finishes a turn, or a
// test, build or deploy passes or fails. Picked at random, never the same line twice in a row.
import type { ActivityKind } from './types';

export type Moment = 'start' | 'finish' | 'pass' | 'fail';

const LINES: Record<Moment, string[]> = {
  start: [
    "Morning! Let's see what we've got.",
    'Reporting for duty.',
    'Coffee loaded. Ready.',
    'New task? Love it.',
    'Rolling in!',
    "Okay, let's build something.",
    'Fresh context, fresh start.',
  ],
  finish: [
    'Done. Back to the tree.',
    'All yours!',
    'That should do it.',
    'Phew. Your turn.',
    'Wrapped up. What next?',
    'Shipped… well, almost.',
    'Taking five.',
  ],
  pass: [
    'Green across the board!',
    'All passing. Nice.',
    'Nailed it.',
    'Smooth as snow.',
    'Ta-da!',
  ],
  fail: [
    "Hmm, that didn't go well.",
    'Back to the drawing board.',
    'Red. Looking into it.',
    'Oops. On it.',
    'Not quite yet…',
  ],
};

/** Deploys and builds get their own words when they pass. */
const PASS_BY_KIND: Partial<Record<ActivityKind, string[]>> = {
  deploy: ["It's live!", 'Out the door!'],
  build: ['Built clean.', 'Compiles. Ship it?'],
};

let last = '';

/** A line for the moment (and the command's kind, for pass/fail). */
export function lineFor(moment: Moment, kind?: ActivityKind): string {
  const pool = moment === 'pass' && kind && PASS_BY_KIND[kind] ? [...LINES.pass, ...PASS_BY_KIND[kind]!] : LINES[moment];
  const choices = pool.filter((l) => l !== last);
  last = choices[Math.floor(Math.random() * choices.length)];
  return last;
}
