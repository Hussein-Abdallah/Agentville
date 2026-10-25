// The train (or ferry) that brings robots into a town and takes them away: its timetable and route.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { DWELL, MAX_DWELL, TRAVEL, arriveCurve, leaveCurve, nextPhase, pointAt, routeLength } from '../src/town';

test('it comes when robots wait, stops, waits for those still walking, then leaves', () => {
  assert.equal(nextPhase('away', 5, false, false), 'away', 'nobody waiting: stays away');
  assert.equal(nextPhase('away', 0, true, false), 'arriving');
  assert.equal(nextPhase('arriving', TRAVEL - 0.1, true, false), 'arriving');
  assert.equal(nextPhase('arriving', TRAVEL, true, false), 'dwell');
  assert.equal(nextPhase('dwell', DWELL - 0.1, false, false), 'dwell', 'stops a moment at least');
  assert.equal(nextPhase('dwell', DWELL, true, false), 'dwell', 'robots still getting on or off');
  assert.equal(nextPhase('dwell', DWELL, false, true), 'dwell', 'waits for a robot walking to the station');
  assert.equal(nextPhase('dwell', MAX_DWELL, false, true), 'leaving', 'but not forever');
  assert.equal(nextPhase('dwell', DWELL, false, false), 'leaving');
  assert.equal(nextPhase('leaving', TRAVEL, true, false), 'away', 'leaves first; the next trip comes after');
});

test('points along a route, with its direction; past the end it carries on the same way', () => {
  const r: [number, number][] = [[0, 0], [100, 0], [100, 50]];
  assert.equal(routeLength(r), 150);
  assert.deepEqual(pointAt(r, 50), [50, 0, 0]);
  const [x, y, a] = pointAt(r, 125);
  assert.deepEqual([x, y], [100, 25]);
  assert.ok(Math.abs(a - Math.PI / 2) < 1e-9);
  assert.deepEqual(pointAt(r, 175).slice(0, 2), [100, 75], 'carries on past the end');
});

test('every town map has a train or ferry route that starts at its stop and leaves the picture', () => {
  for (const id of fs.readdirSync(new URL('../public/towns/', import.meta.url)).filter((d) => !d.startsWith('.'))) {
    const t = JSON.parse(fs.readFileSync(new URL(`../public/towns/${id}/town.json`, import.meta.url), 'utf8'));
    const tr = t.transit;
    assert.ok(tr, `${id} has a transit`);
    assert.deepEqual(tr.route[0], tr.stop, `${id}: the route starts at the stop`);
    const [ex, ey] = tr.route[tr.route.length - 1];
    assert.ok(ex < 0 || ey < 0 || ex > t.size[0] || ey > t.size[1], `${id}: the route ends outside the picture`);
    const st = Object.values<any>(t.buildings).find((b) => b.role === 'station');
    assert.ok(Math.hypot(tr.board[0] - st.door[0], tr.board[1] - st.door[1]) < 120, `${id}: robots board near the station`);
  }
});

test('trains come in at a steady speed and brake into the station; they pull away, then go steady', () => {
  assert.equal(arriveCurve(0), 0); assert.ok(Math.abs(arriveCurve(1) - 1) < 1e-9);
  const step = (fn: (f: number) => number, f: number) => fn(f + 0.01) - fn(f);
  assert.ok(Math.abs(step(arriveCurve, 0) - step(arriveCurve, 0.3)) < 1e-9, 'steady at first');
  assert.ok(step(arriveCurve, 0.98) < step(arriveCurve, 0.3) / 5, 'nearly stopped at the end');
  assert.ok(step(leaveCurve, 0) < step(leaveCurve, 0.9) / 5, 'leaving starts slowly');
  assert.ok(Math.abs(step(leaveCurve, 0.7) - step(leaveCurve, 0.95)) < 1e-9, 'then steady, no burst at the end');
  assert.ok(Math.abs(leaveCurve(1) - 1) < 1e-9);
});
