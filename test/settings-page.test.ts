// The Settings page's changes as the service keeps them: settings, a town's map, building names, worlds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { SettingsFile } from '../server/settings';
import { Worlds } from '../server/worlds';
import { Alerts } from '../server/notify';
import { DEFAULT_SETTINGS } from '../src/settings';
import { newTown, tmpDir } from './support';

test('settings from the page are checked, then saved whole', () => {
  const file = path.join(tmpDir('st'), 'settings.json');
  const f = new SettingsFile(file);
  const kept = f.save({ ...DEFAULT_SETTINGS, clock: '24h', time: 'night', toastTime: 'forever', lines: 'yes', followNew: true });
  assert.deepEqual([kept.clock, kept.time, kept.toastTime, kept.lines, kept.followNew], ['24h', 'night', 'normal', true, true], 'bad values fall back');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), kept);
  assert.deepEqual(new SettingsFile(file).value, kept, 'read back the same');
});

test('the alert sound can be off while alerts stay on', () => {
  const ran: string[] = [];
  const a = new Alerts(true, (cmd) => ran.push(cmd));
  a.sound = false;
  a.needs({ id: 'x', name: 'Atlas', color: 'orange', building: 'b', status: 'waiting' }, 'app', true);
  assert.ok(!ran.includes('afplay'));
});

test('moving towns to a world writes worlds.json and wins over folder patterns', () => {
  const home = tmpDir('home'), file = path.join(home, '.agentville', 'worlds.json');
  const dev = path.join(home, 'Dev'), a = path.join(dev, 'acme', 'api'), b = path.join(dev, 'acme', 'web');
  for (const d of [a, b]) fs.mkdirSync(path.join(d, '.git'), { recursive: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ root: '~/Dev', worlds: { Acme: ['~/Dev/acme/**'] } }));
  const w = new Worlds({ configFile: file, home, claudeDir: path.join(home, '.claude') });
  assert.equal(w.worldOf(a), 'Acme');
  assert.ok(w.assign([a], 'Platform'));
  assert.deepEqual([w.worldOf(a), w.worldOf(b)], ['Platform', 'Acme'], 'the repo listed by itself wins over Acme\'s folder pattern');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { root: '~/Dev', worlds: { Acme: ['~/Dev/acme/**'], Platform: ['~/Dev/acme/api'] } }, 'your own entries stay');
  assert.ok(w.assign([a, b], 'Shop'), 'renaming a world = moving all its towns');
  assert.deepEqual([w.worldOf(a), w.worldOf(b)], ['Shop', 'Shop']);
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).worlds.Platform, undefined, 'an emptied world goes');
});

test('a town gets another map: its robots wait at the new plaza; agentville.json picks win', () => {
  const t = newTown(), r = tmpDir('look', { repo: true, dirs: ['src'] });
  t.edit(r, 'src/a.ts');
  // newTown has one map; add a second by name only to see the refusal paths
  assert.equal(t.s.setTownMap(r, 'frostpeak'), false, 'same map: nothing to do');
  assert.equal(t.s.setTownMap(r, 'nowhere'), false, 'unknown map');
  fs.writeFileSync(path.join(r, 'agentville.json'), JSON.stringify({ town: 'frostpeak' }));
  t.edit(r, 'src/a.ts');
  assert.equal(t.town(r)!.mapPinned, true);
});

test('naming a building shows in the towns list, and an empty name goes back to the map\'s', () => {
  const t = newTown(), r = tmpDir('names', { repo: true, dirs: ['src'] });
  t.edit(r, 'src/a.ts');
  const b = t.robot()!.building;
  assert.ok(t.s.renameBuilding(r, b, '  Auth <HQ> '));
  assert.equal(t.town(r)!.names[b], 'Auth HQ');
  assert.ok(t.s.renameBuilding(r, b, ''));
  assert.equal(t.town(r)!.names[b], undefined);
  assert.equal(t.s.renameBuilding(r, 'no-such-building', 'X'), false);
});

test('switching a town to another map moves its robots to that map\'s plaza', async () => {
  const { Sessions } = await import('../server/state');
  const { TownMaps } = await import('../server/townmaps');
  const { BuildingStore } = await import('../server/buildings');
  const { SessionStore } = await import('../server/sessionstore');
  const { buildings } = await import('./support');
  const home = tmpDir('home'), r = tmpDir('two', { repo: true, dirs: ['src'] });
  const other = buildings.map((b) => ({ ...b, id: `x-${b.id}` }));
  const w = new Worlds({ configFile: path.join(home, 'w.json'), home, claudeDir: path.join(home, '.claude') });
  const s = new Sessions({ frostpeak: buildings, other }, ['orange'], () => {}, w,
    new TownMaps(['frostpeak', 'other'], { file: path.join(home, 'towns.json'), random: () => 0 }),
    new BuildingStore({ file: path.join(home, 'b.json'), delay: 0 }), new SessionStore({ file: path.join(home, 's.json'), delay: 0 }));
  s.handle({ session_id: 's1', cwd: r, hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: path.join(r, 'src/a.ts') } });
  assert.equal(s.towns()[0].map, 'frostpeak');
  assert.ok(s.setTownMap(r, 'other'));
  assert.equal(s.towns()[0].map, 'other');
  assert.equal(s.snapshot()[0].building, 'x-plaza');
  assert.equal(JSON.parse(fs.readFileSync(path.join(home, 'towns.json'), 'utf8'))[r], 'other', 'remembered');
});
