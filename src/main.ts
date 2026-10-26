import './style.css';
import { loadTown, pictureFor } from './town';
import { RobotSprites } from './sprites';
import { World } from './world';
import { Demo, DEMO_TOWNS, demoFolders } from './demo';
import { WorldMap, loadWorldArt } from './worldview';
import { PlanetView } from './planet';
import { WorldBoard } from './boardview';
import { connectLive, serviceAvailable, signedIn, startSignIn, waitSignIn } from './live';
import { TownPicker } from './picker';
import { BADGE_LABEL } from './badges';
import { Toasts } from './toasts';
import { JumpBox } from './jump';
import { NeedsBoard } from './needs';
import { DEFAULT_SETTINGS, readSettings, toastScale, type Settings } from './settings';
import { SettingsPanel, type MapChoice } from './settingsview';
import { lineFor } from './lines';
import { Tour } from './tour';
import type { ActivityKind } from './types';
import type { AgentState, TimeOfDay, TownData, TownInfo } from './types';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

async function main() {
  const sprites = new RobotSprites();
  // start on the map shown last time, in the day or night last chosen, and keep the town hidden until
  // the one to show is known (no other town flashing up first)
  $('#stage').classList.add('starting');
  const lastMap = localStorage.getItem('agentville.lastMap') ?? 'frostpeak';
  const [town] = await Promise.all([loadTown(lastMap).catch(() => loadTown('frostpeak')), sprites.init()]);
  const cached = readSettings(JSON.parse(localStorage.getItem('agentville.settings') ?? 'null'));

  const world = new World($('#stage'), town, sprites);
  world.time = cached.time === 'system' ? (matchMedia('(prefers-color-scheme: dark)').matches ? 'night' : 'day') : cached.time;
  await world.init();
  const reveal = () => $('#stage').classList.remove('starting');
  setTimeout(reveal, 3000); // no town to pick (no sessions yet): show what there is

  const feed: string[] = [];
  const log = (html: string) => {
    feed.unshift(html);
    feed.length = Math.min(feed.length, 8);
    $('#feed').innerHTML = feed.map((f) => `<div>${f}</div>`).join('');
  };

  // Live mode when the local service is running and this browser has its token; demo mode otherwise (or with ?demo).
  const running = !new URLSearchParams(location.search).has('demo') && (await serviceAvailable());
  const signed = running ? await signedIn() : undefined;
  const live = signed === true;
  /** The service runs but this browser isn't signed in: say how, over the (demo) town. */
  const signInNote = (show: boolean) => { $('#signin').hidden = !show; };
  if (running && signed === false) signInNote(true);
  // one click: a system dialog asks you to allow this browser, showing the same code as here
  $('#si-go').onclick = async () => {
    const go = $<HTMLButtonElement>('#si-go'), status = $('#si-status');
    go.disabled = true;
    const r = await startSignIn();
    if ('error' in r) {
      status.innerHTML = r.error === 'busy' ? 'Another sign-in is waiting for an answer. Try again in a minute.'
        : r.error === 'too-many' ? 'Too many tries. Wait a minute, then try again.'
        : r.error === 'unsupported' ? 'This computer can\'t show the dialog: use the link below.'
        : 'Couldn\'t reach Agentville. Is it still running?';
      go.disabled = false;
      return;
    }
    status.innerHTML = `A window asks you to allow this browser. Allow it only if it shows <b class="si-code">${r.code}</b>.`;
    const answer = await waitSignIn(r.id, r.secret);
    if (answer === 'allow') { status.textContent = 'Signed in. Loading your town…'; location.reload(); return; }
    status.textContent = answer === 'deny' ? 'Not allowed (or no answer in time).' : 'That sign-in expired. Try again.';
    go.disabled = false;
  };
  let demo: Demo | null = null;
  /** Go to session: bring a robot's session (terminal, editor, Claude app) to the front; live mode only */
  let goToSession: ((id: string) => void) | null = null;
  /** give a session's robot your own name (the service keeps it; the demo just changes it) */
  let renameRobot: (id: string, name: string) => void = () => {};

  // Live mode has a town per repo; the page shows one at a time and keeps every robot.
  const agents = new Map<string, AgentState>();
  let towns: TownInfo[] = [];
  let current: string | null = null;
  /** the town the scene shows robots for (set once its map has loaded) */
  let shown: string | null = null;
  // town maps (Frostpeak, Maplewood…), loaded once each; a missing one falls back to Frostpeak
  const mapCache = new Map<string, Promise<TownData>>([[town.id, Promise.resolve(town)]]);
  /** town maps already loaded, for their pictures (the world map's thumbnails) */
  const mapsLoaded = new Map<string, TownData>([[town.id, town]]);
  const mapData = (id: string) => {
    let p = mapCache.get(id);
    if (!p) { p = loadTown(id).catch(() => town); mapCache.set(id, p); p.then((t) => mapsLoaded.set(id, t)); }
    return p;
  };

  // settings (~/.agentville/settings.json in live mode; this browser's own copy in demo mode)
  let settings: Settings = cached;
  // (before Settings existed, day or night was kept on its own)
  const oldTime = localStorage.getItem('agentville.time');
  if (oldTime === 'day' || oldTime === 'night' || oldTime === 'system') { settings.time = oldTime; localStorage.removeItem('agentville.time'); }
  /** Saves settings: the service keeps them (live) or this browser does (demo). Set below. */
  let saveSettings: (s: Settings) => void = () => {};

  // day or night: the header icon (System follows the Mac's light or dark mode)
  type TimeMode = TimeOfDay | 'system';
  const timeMode = (): TimeMode => settings.time;
  const dark = matchMedia('(prefers-color-scheme: dark)');
  const timeNow = (): TimeOfDay => (timeMode() === 'system' ? (dark.matches ? 'night' : 'day') : (timeMode() as TimeOfDay));
  // one icon: a sun (day), a moon (night) or a half-lit circle (system); click for the next
  const TIME_ICON: Record<TimeMode, string> = {
    day: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.2"/><path d="M12 2.5v2.3M12 19.2v2.3M2.5 12h2.3M19.2 12h2.3M5.3 5.3l1.6 1.6M17.1 17.1l1.6 1.6M5.3 18.7l1.6-1.6M17.1 6.9l1.6-1.6"/></svg>',
    night: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linejoin="round"><path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/></svg>',
    system: '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="8.5"/><path d="M12 3.5a8.5 8.5 0 0 1 0 17z" fill="currentColor" stroke="none"/></svg>',
  };
  const TIME_NEXT: Record<TimeMode, TimeMode> = { day: 'night', night: 'system', system: 'day' };
  const TIME_TIP: Record<TimeMode, string> = { day: 'Day', night: 'Night', system: "System: follows your Mac's light or dark mode" };
  const applyTime = () => {
    world.setTime(timeNow());
    const b = $('#t-time'), m = timeMode();
    b.innerHTML = TIME_ICON[m];
    b.title = `${TIME_TIP[m]} (now ${timeNow()}). Click for ${TIME_TIP[TIME_NEXT[m]].split(':')[0].toLowerCase()}.`;
    b.setAttribute('aria-label', `Time of day: ${TIME_TIP[m]}`);
  };
  $('#t-time').onclick = () => saveSettings({ ...settings, time: TIME_NEXT[timeMode()] });
  dark.addEventListener('change', () => { if (timeMode() === 'system') applyTime(); });

  /** The clock in the header (Settings), redrawn when the minute changes. */
  let clockText = '';
  const renderClock = () => {
    const el = $('#clock');
    const text = settings.clock === 'off' ? '' : new Date().toLocaleTimeString([], { hour: settings.clock === '12h' ? 'numeric' : '2-digit', minute: '2-digit', hour12: settings.clock === '12h' });
    if (text !== clockText) { clockText = text; el.textContent = text; el.hidden = !text; }
  };
  /** Settings changed (saved here, or by another page, or by hand): show them everywhere. */
  const applySettings = (s: Settings) => {
    settings = s;
    // demo mode keeps its settings here; live mode keeps a copy so the next visit starts right (day or night…)
    localStorage.setItem('agentville.settings', JSON.stringify(s));
    applyTime();
    world.showLabels = s.labels; world.showPaths = s.paths;
    $('#t-labels').classList.toggle('on', s.labels); $('#t-paths').classList.toggle('on', s.paths);
    renderClock();
    settingsPanel?.refresh();
  };
  let settingsPanel: SettingsPanel | undefined;
  /** the town maps there are (for Settings) and how town edits are made: by the service, or in the demo */
  let mapChoices: MapChoice[] = [];
  let townEdits: { townMap: (id: string, map: string) => void; buildingName: (id: string, b: string, name: string) => void; moveTowns: (ids: string[], world: string) => void } =
    { townMap: () => {}, buildingName: () => {}, moveTowns: () => {} };
  let switching = 0;
  let shownMap: string | null = null;
  let picked = localStorage.getItem('agentville.town');
  const inView = (a: AgentState) => !a.town || a.town === shown;
  const showTownLabels = () => {
    const t = towns.find((x) => x.id === current);
    world.folders = t?.folders ?? {};
    world.names = t?.names ?? {};
    renderCrumbs();
  };
  const setTown = async (id: string | null, byUser = false) => {
    if (byUser && id) { picked = id; localStorage.setItem('agentville.town', id); }
    if (id === current) return;
    current = id;
    shown = null; // robots wait until the town's map is loaded
    const seq = ++switching;
    shownMap = towns.find((t) => t.id === id)?.map ?? 'frostpeak';
    const td = await mapData(shownMap);
    if (seq !== switching) return; // a newer switch won
    if (world.town !== td) await world.load(td); else world.clear();
    if (seq !== switching) return;
    shown = id;
    if (td.id) localStorage.setItem('agentville.lastMap', td.id); // the next visit starts on this map
    showTownLabels();
    for (const a of agents.values()) if (inView(a)) world.apply(a, true); // already at their buildings
    render();
    reveal();
  };
  /** The town you picked, else one where a robot needs you, else the most recently busy one. */
  const autoTown = () => {
    if (picked && towns.some((t) => t.id === picked)) return picked;
    const list = [...agents.values()].filter((a) => a.town).sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    return (list.find((a) => a.status === 'waiting') ?? list[0])?.town ?? towns[0]?.id ?? null;
  };
  /** Jump to a robot, in whatever town it is. */
  const goTo = async (a: AgentState) => { setView('town'); if (a.town && a.town !== current) await setTown(a.town, true); selected = a.id; world.focus(a.id); render(); };
  // toasts for what just happened (which kinds: Settings), and when each robot started waiting
  const toasts = new Toasts($('#toasts'));
  const waitSince = new Map<string, number>();
  const placeOf = (a: AgentState) => { const t = towns.find((x) => x.id === a.town); return [t?.name ?? a.project, t?.world].filter(Boolean).join(' · '); };
  /** `catchingUp`: the state came with a (re)connect, so nothing in it just happened. */
  const noteChange = (prev: AgentState | undefined, s: AgentState, catchingUp: boolean) => {
    const started = s.status === 'waiting' && prev?.status !== 'waiting';
    if (started) waitSince.set(s.id, catchingUp ? s.lastActive ?? Date.now() : Date.now());
    if (s.status !== 'waiting') { waitSince.delete(s.id); toasts.dismiss(`wait-${s.id}`); }
    if (catchingUp) return;
    const on = settings.toasts, dot = sprites.meta.colors[s.color], where = esc(placeOf(s)), k = toastScale(settings);
    const go = () => goTo(agents.get(s.id) ?? s);
    const who = `<b>${esc(s.name)}</b>`;
    if (on.needsYou && started) {
      toasts.show({ key: `wait-${s.id}`, tone: 'wait', dot, title: `${who} needs you`, body: [esc(s.task ?? 'Waiting for you'), s.ask ? `<i>${esc(s.ask)}</i>` : '', where].filter(Boolean).join('<br>'), onClick: go, seconds: 15 * k });
    }
    const r = s.result;
    if (on.failed && r && !r.ok && FAIL_TOASTS.has(r.kind) && r.at !== prev?.result?.at) {
      toasts.show({ key: `fail-${s.id}`, tone: 'bad', dot, title: `${who}: ${esc(RESULT_LABEL[r.kind][1])}`, body: where, onClick: go, seconds: 8 * k });
    }
    if (on.finished && !s.parentId && prev?.status === 'working' && s.status === 'idle') {
      toasts.show({ key: `done-${s.id}`, tone: 'done', dot, title: `${who} finished`, body: [esc(s.title ?? ''), where].filter(Boolean).join('<br>'), onClick: go, seconds: 6 * k });
    }
    if (on.sessions && !s.parentId && !prev) {
      toasts.show({ key: `came-${s.id}`, tone: 'info', dot, title: `${who} started`, body: [esc(s.title ?? ''), where].filter(Boolean).join('<br>'), onClick: go, seconds: 6 * k });
    }
    // follow new sessions (Settings): go to the town where one just started
    if (settings.followNew && !prev && !s.parentId && s.town && s.town !== current) { setTown(s.town, true); setView('town'); }
  };
  /** Personality lines (Settings): a short line when a session starts, finishes, or a test, build or deploy passes or fails. */
  const sayLine = (prev: AgentState | undefined, s: AgentState, catchingUp: boolean) => {
    if (!settings.lines || catchingUp || s.parentId) return;
    const r = s.result;
    if (!prev) world.say(s.id, lineFor('start'), 4);
    else if (r && r.at !== prev.result?.at && FAIL_TOASTS.has(r.kind)) world.say(s.id, lineFor(r.ok ? 'pass' : 'fail', r.kind), 4);
    else if (prev.status === 'working' && s.status === 'idle') world.say(s.id, lineFor('finish'), 4);
  };
  /** A robot appeared or changed (live service or demo). */
  const applyAgent = (s: AgentState, catchingUp = false) => {
    const prev = agents.get(s.id);
    const was = prev?.town;
    agents.set(s.id, s);
    noteChange(prev, s, catchingUp);
    // it went to another town of the same world: a train runs between them on the world map
    if (was && s.town && was !== s.town) {
      const world = (id: string) => towns.find((t) => t.id === id)?.world;
      if (world(was) && world(was) === world(s.town)) {
        const hex = sprites.meta.colors[s.color] ?? '#ffe08a';
        board.trip(was, s.town, hex);
        worldMap.trip(was, s.town, hex);
      }
    }
    if (current === null && towns.length) setTown(autoTown()); // on connect, the towns list (after the robots) picks
    if (inView(s)) { world.apply(s); sayLine(prev, s, catchingUp); }
    else if (world.robots.has(s.id)) world.remove(s.id); // it left for another town: walks off to the station
  };
  /** Folder labels per demo town, from its own map (loaded first). */
  const demoTowns = async () => {
    for (const t of DEMO_TOWNS) { const m = await mapData(t.map); t.folders = demoFolders(m); t.land = m.land; }
    return DEMO_TOWNS;
  };
  const removeAgent = (id: string, catchingUp = false) => {
    const a = agents.get(id);
    agents.delete(id); world.remove(id);
    waitSince.delete(id); toasts.dismiss(`wait-${id}`);
    if (a && !a.parentId && settings.toasts.sessions && !catchingUp) {
      toasts.show({ key: `came-${id}`, tone: 'info', dot: sprites.meta.colors[a.color], title: `<b>${esc(a.name)}</b> ended`, body: esc(placeOf(a)), seconds: 6 });
    }
  };

  // world map: the towns of one world, over the town view (button or M)
  // three levels: the planet (every world), a world map (one project's towns), a town (one repo)
  type View = 'planet' | 'world' | 'town';
  let view: View = 'town';
  let mapWorld: string | null = null;
  const currentWorld = () => towns.find((t) => t.id === current)?.world ?? null;
  // a world map is either the board (laid out by code, any number of towns) or the painted valley
  let mapStyle: 'board' | 'painted' = localStorage.getItem('agentville.worldmap') === 'painted' ? 'painted' : 'board';
  const board = new WorldBoard($('#boardview'), {
    openTown: (id) => { setTown(id, true); setView('town'); },
    showWorld: (w) => { mapWorld = w; renderCrumbs(); render(); },
  });
  // the board's ground: the world's patch of the planet (worked out once per world and set of towns)
  let ground: { key: string; value?: { image: string; u: number; v: number } } = { key: '' };
  const groundFor = (w: string) => {
    const key = w + '|' + towns.filter((t) => t.world === w).map((t) => t.id).join(',');
    if (ground.key !== key) {
      ground = { key };
      planet.whereIs(w, towns).then((p) => { if (ground.key === key && p) { ground.value = { image: planet.pictureUrl(), ...p }; render(); } });
    }
    return ground.value;
  };
  const worldMap = new WorldMap($('#worldview'), await loadWorldArt(), {
    openTown: (id) => { setTown(id, true); setView('town'); },
    showWorld: (w) => { mapWorld = w; renderCrumbs(); render(); },
  });
  const planet = new PlanetView($('#planetview'), {
    openWorld: (w) => { mapWorld = w; setView('world'); },
  });
  const setView = (v: View) => {
    view = v;
    if (v === 'world') mapWorld ??= currentWorld() ?? towns[0]?.world ?? null;
    if (v !== 'world' && v !== 'planet') mapWorld = null;
    $('#worldview').hidden = v !== 'world' || mapStyle !== 'painted';
    $('#boardview').hidden = v !== 'world' || mapStyle !== 'board';
    $('#wm-style').hidden = v !== 'world';
    $('#wm-style').textContent = mapStyle === 'board' ? 'Painted map' : 'Board';
    $('#planetview').hidden = v !== 'planet';
    world.visible = v === 'town'; // the world map and planet cover the town: don't draw it underneath
    $('.zoom').style.display = v === 'town' ? '' : 'none';
    planet.show(v === 'planet', mapWorld ?? currentWorld());
    renderCrumbs();
    render();
  };
  const up: Record<View, View> = { town: 'world', world: 'planet', planet: 'planet' };
  const down: Record<View, View> = { planet: 'world', world: 'town', town: 'town' };
  /** Planet › world › town, in the header; each part opens that level. */
  const renderCrumbs = () => {
    const w = view === 'town' ? currentWorld() : mapWorld ?? currentWorld();
    const t = towns.find((x) => x.id === current);
    const part = (label: string, to: View, on: boolean) => `<button data-view="${to}" class="${on ? 'on' : ''}">${esc(label)}</button>`;
    $('#crumbs').innerHTML = [
      part('Planet', 'planet', view === 'planet'),
      w ? part(w, 'world', view === 'world') : '',
      t && t.world === w ? part(t.name, 'town', view === 'town') : view === 'town' ? part(town.name, 'town', true) : '',
    ].filter(Boolean).join('<span class="sep">›</span>');
  };
  $('#crumbs').onclick = (e) => {
    const b = (e.target as HTMLElement).closest<HTMLElement>('[data-view]');
    if (!b) return;
    const v = b.dataset.view as View;
    if (v === 'world') mapWorld = view === 'town' ? currentWorld() : mapWorld;
    if (v === 'town' && mapWorld && mapWorld !== currentWorld()) return; // no town of that world is open
    setView(v);
  };

  // the needs-you board (under the counter) and the ⌘K jump box
  const needs = new NeedsBoard($('#needs'), { go: goTo, open: (a) => goToSession?.(a.id) });
  const jump = new JumpBox((t) => {
    if (t.kind === 'robot') { const a = agents.get(t.id); if (a) goTo(a); }
    else if (t.kind === 'town') { setTown(t.id, true); setView('town'); }
    else { mapWorld = t.name; setView('world'); }
  });

  /**
   * Disconnected: is it the token (renewed, or the cookie cleared: reconnecting won't help until you sign in
   * again) or just the service restarting? Only a clear "no" from a running service, while still
   * disconnected, shows the sign-in note: a restart answers "can't ask" or "yes".
   */
  let connected = false;
  const checkSignIn = async () => {
    const yes = await signedIn();
    if (yes === false && !connected && (await serviceAvailable()) && !connected) signInNote(true);
  };
  if (live) {
    $('#mode').textContent = 'Connecting…';
    $('#t-add').style.display = 'none';
    $('#note').innerHTML = 'Live: your Claude Code sessions appear here as robots. Approve requests in Claude Code itself. Click a robot or card to see its details.';
    const alertsBtn = $('#t-alerts');
    const allowBtn = $('#t-allow');
    // Notifications come from this page when the browser allows it; otherwise the service falls back to macOS.
    const canNotify = () => 'Notification' in window && Notification.permission === 'granted';
    const showAllow = () => { allowBtn.style.display = alertsBtn.dataset.on && 'Notification' in window && Notification.permission === 'default' ? '' : 'none'; };
    const conn = connectLive(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`, {
      apply: applyAgent,
      remove: removeAgent,
      log,
      towns: (list) => {
        towns = list;
        const t = towns.find((x) => x.id === current);
        if (!t) setTown(autoTown());
        else if (t.map !== shownMap) { current = null; setTown(t.id); } // its map changed (agentville.json "town")
        else showTownLabels();
      },
      alerts: (on) => { alertsBtn.classList.toggle('on', on); alertsBtn.dataset.on = on ? '1' : ''; showAllow(); },
      needs: (st, project) => {
        if (!canNotify()) return;
        const where = [project, st.title].filter(Boolean).join(' · ');
        // silent: the service plays the sound; the tag merges copies from several open pages
        const n = new Notification(`${st.name} needs you`, { body: [st.task ?? 'Waiting for you', st.ask, where].filter(Boolean).join('\n'), tag: `agentville-${st.id}`, silent: true });
        // straight to the session when we know its app (to answer it there); else to this page
        n.onclick = () => {
          const a = agents.get(st.id) ?? st;
          if (appOf(a, agents)) conn.focus(a.id); else window.focus();
          goTo(a); n.close();
        };
      },
      focused: (id, ok) => {
        const a = agents.get(id);
        if (!ok && a) log(`Couldn't open <b>${esc(a.name)}</b>'s session${appOf(a, agents) ? ` in ${esc(appOf(a, agents)!)}` : ''}`);
      },
      settings: (s) => applySettings(s),
      maps: (m) => { mapChoices = m; settingsPanel?.refresh(); },
      status: (ok) => {
        connected = ok;
        $('#mode').textContent = ok ? 'Live' : 'Reconnecting…'; $('#mode').className = 'mode ' + (ok ? 'live' : 'off');
        if (ok) signInNote(false); else checkSignIn();
      },
    });
    goToSession = (id) => conn.focus(id);
    renameRobot = (id, name) => conn.rename(id, name);
    // Settings are the service's: shown at once, and saved there (it sends them back to every page)
    saveSettings = (s) => { applySettings(s); conn.saveSettings(s); };
    townEdits = { townMap: conn.townMap, buildingName: conn.buildingName, moveTowns: conn.moveTowns };
    alertsBtn.onclick = () => conn.setAlerts(!alertsBtn.dataset.on);
    allowBtn.onclick = async () => { await Notification.requestPermission(); conn.setNotify(canNotify()); showAllow(); };
    conn.setNotify(canNotify());
    navigator.permissions?.query({ name: 'notifications' }).then((p) => { p.onchange = () => { conn.setNotify(canNotify()); showAllow(); }; }).catch(() => {});
  } else {
    $('#mode').textContent = 'Demo';
    $('#mode').className = 'mode demo';
    $('#t-alerts').style.display = 'none';
    $('#t-allow').style.display = 'none';
    towns = await demoTowns();
    const demoMaps = new Map(await Promise.all(towns.map(async (t) => [t.id, await mapData(t.map)] as const)));
    // robots in towns you aren't looking at count as arrived, so they keep working
    demo = new Demo((id) => demoMaps.get(id)!, sprites.colors(), applyAgent, removeAgent, log, (id) => !inView(agents.get(id)!) || world.robots.get(id)?.mode === 'present');
    $('#t-add').onclick = () => demo!.spawn();
    renameRobot = (id, name) => demo!.rename(id, name);
    // the demo keeps its settings in this browser, and its town edits only until you reload
    saveSettings = (s) => applySettings(s);
    mapChoices = [...new Set(towns.map((t) => t.map))].map((id) => ({ id, name: demoMaps.get(towns.find((t) => t.map === id)!.id)!.name }));
    townEdits = {
      townMap: () => log('Changing a town\'s look works with your real sessions'),
      buildingName: (id, b, name) => { const t = towns.find((x) => x.id === id); if (t) { if (name.trim()) t.names[b] = name.trim(); else delete t.names[b]; if (id === current) showTownLabels(); } },
      moveTowns: (ids, w) => { for (const t of towns) if (ids.includes(t.id)) t.world = w; renderCrumbs(); },
    };
    log('Demo mode: simulated agents');
    demo.start(12); // enough robots that bigger worlds aren't empty
  }
  // click a robot or card: show its details (click again, ✕ or Esc to close)
  let selected: string | null = null;
  const select = (id: string) => {
    // Settings can make a click bring the session to the front instead (when its app is known)
    if (settings.clickOpens === 'session' && goToSession && appOf(agents.get(id), agents)) { goToSession(id); world.focus(id); return; }
    const a = demo?.agents.get(id);
    if (a?.status === 'waiting') demo!.approve(id);
    else if (selected === id) { selected = null; render(); return; }
    selected = id;
    world.focus(id);
    render();
  };
  world.onRobotClick = select;
  (window as any).__av = { world, demo, applyAgent }; // for poking at it from the console

  // sidebar
  let last = '';
  let lastDetails = '';
  /** the details panel's last exchange is shown in full */
  let talkOpen = false;
  /** renaming the selected robot: the panel isn't redrawn meanwhile */
  let renaming = false;
  addEventListener('keydown', (e) => {
    if (e.metaKey || e.ctrlKey || e.altKey || (e.target as HTMLElement).closest('input, textarea, select')) return;
    if (e.key === 'Escape' && needs.isOpen) needs.close();
    else if (e.key === 'Escape' && view !== 'town') setView(down[view]);
    else if (e.key === 'Escape' && selected) { selected = null; render(); }
    else if ((e.key === 'g' || e.key === 'G') && selected && goToSession && appOf(agents.get(selected), agents)) goToSession(selected);
    else if (e.key === 'm' || e.key === 'M') setView(up[view]);
    else if (e.key === '+' || e.key === '=') (view === 'planet' ? planet : world).zoomBy(1.4);
    else if (e.key === '-') (view === 'planet' ? planet : world).zoomBy(1 / 1.4);
    else if (e.key === '0') (view === 'planet' ? planet : world).resetZoom();
  });
  /** Click the name in the details panel: a box to type a new one (Enter saves, Esc cancels). */
  const startRename = (el: HTMLElement) => {
    const id = selected;
    if (!id) return;
    renaming = true;
    const box = document.createElement('input');
    box.className = 'rename'; box.maxLength = 24; box.value = el.textContent ?? ''; box.setAttribute('aria-label', 'Robot name');
    el.replaceWith(box);
    box.focus(); box.select();
    let done = false;
    const finish = (save: boolean) => {
      if (done) return;
      done = true; renaming = false;
      const name = box.value.trim();
      if (save && name && name !== agents.get(id)?.name) renameRobot(id, name);
      lastDetails = ''; render();
    };
    box.addEventListener('keydown', (e) => { if (e.key === 'Enter') finish(true); else if (e.key === 'Escape') { e.stopPropagation(); finish(false); } });
    box.addEventListener('blur', () => finish(true));
  };
  const render = () => {
    const list = [...world.robots.values()].filter((r) => r.mode !== 'gone').map((r) => r.state);
    list.sort((a, b) => (a.parentId ?? a.id).localeCompare(b.parentId ?? b.id) || (a.parentId ? 1 : -1));
    const html = list.map((a) => card(a, world, sprites.meta.colors[a.color])).join('') || '<div class="empty">No agents yet</div>';
    if (html !== last) {
      last = html;
      $('#agents').innerHTML = html;
      $('#agents').querySelectorAll<HTMLElement>('.card').forEach((el) => (el.onclick = () => select(el.dataset.id!)));
    }
    if (selected && !list.some((a) => a.id === selected)) selected = null; // it left town
    for (const r of world.robots.values()) r.selected = r.state.id === selected;
    $('#agents').querySelectorAll<HTMLElement>('.card').forEach((el) => el.classList.toggle('sel', el.dataset.id === selected));
    const sel = selected ? world.robots.get(selected)!.state : null;
    const d = sel ? details(sel, list, world, towns.find((t) => t.id === sel.town), goToSession ? appOf(sel, agents) ?? '' : undefined, talkOpen) : '';
    if (renaming && sel) { /* keep the name box */ } else if (d !== lastDetails) {
      lastDetails = d;
      $('#details').innerHTML = d;
      $('#details').style.display = d ? '' : 'none';
      $('#details').querySelector<HTMLElement>('.x')?.addEventListener('click', () => { selected = null; render(); });
      $('#details').querySelectorAll<HTMLElement>('[data-id]').forEach((el) => (el.onclick = () => select(el.dataset.id!)));
      $('#details').querySelector<HTMLButtonElement>('.go')?.addEventListener('click', () => { if (selected) goToSession?.(selected); });
      $('#details').querySelector<HTMLElement>('.talk')?.addEventListener('click', () => { talkOpen = !talkOpen; render(); });
      $('#details').querySelector<HTMLElement>('.nm.can')?.addEventListener('click', (e) => startRename(e.currentTarget as HTMLElement));
    }
    // needs-you across every town: the counter opens the board
    const all = [...agents.values()];
    needs.update(all.filter((a) => a.status === 'waiting'), (a) => waitSince.get(a.id) ?? a.lastActive ?? Date.now(), towns, sprites.meta.colors,
      (a) => (goToSession ? appOf(a, agents) : undefined));
    jump.update(all, towns, sprites.meta.colors);
    settingsPanel?.refresh(); // towns and worlds change while it's open
    renderClock();
    renderPicker();
    if (view === 'planet') planet.update({ towns, agents: [...agents.values()], current: mapWorld ?? currentWorld() });
    if (view === 'world' && mapWorld && mapStyle === 'painted') worldMap.update({ towns, agents: [...agents.values()], world: mapWorld, current, colors: sprites.meta.colors });
    if (view === 'world' && mapWorld && mapStyle === 'board') board.update({
      towns, agents: [...agents.values()], world: mapWorld, current, colors: sprites.meta.colors,
      // each town's picture at the time of day you see (loading its map the first time)
      image: (t) => { const m = mapsLoaded.get(t.map); if (!m) mapData(t.map); return m ? pictureFor(m, timeNow()) : `towns/${t.map}/town.jpg`; },
      ground: groundFor(mapWorld),
    });
  };

  // town picker: search towns by name or world, grouped by world, with robot and needs-you counts
  const picker = new TownPicker($('#town-pick'), (id) => { setTown(id, true); setView('town'); });
  const renderPicker = () => picker.update(towns, [...agents.values()], current);
  world.onChange = render;
  setInterval(() => { if (!document.hidden) render(); }, 300); // a hidden tab catches up when it's shown
  document.addEventListener('visibilitychange', () => { if (!document.hidden) render(); });

  // controls
  const toggle = (id: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = $(id);
    b.classList.toggle('on', get());
    b.onclick = () => { set(!get()); b.classList.toggle('on', get()); };
  };
  $('#wm-style').onclick = () => {
    mapStyle = mapStyle === 'board' ? 'painted' : 'board';
    localStorage.setItem('agentville.worldmap', mapStyle);
    setView('world');
  };
  renderCrumbs();
  $('#z-in').onclick = () => world.zoomBy(1.4);
  $('#z-out').onclick = () => world.zoomBy(1 / 1.4);
  $('#z-fit').onclick = () => world.resetZoom();
  $('#t-labels').onclick = () => saveSettings({ ...settings, labels: !settings.labels });
  $('#t-paths').onclick = () => saveSettings({ ...settings, paths: !settings.paths });

  // the Settings page (gear button)
  settingsPanel = new SettingsPanel({
    get: () => settings, save: (s) => saveSettings(s), towns: () => towns, maps: () => mapChoices, mapData,
    townMap: (id, m) => townEdits.townMap(id, m), buildingName: (id, b, n) => townEdits.buildingName(id, b, n), moveTowns: (ids, w) => townEdits.moveTowns(ids, w),
    tour: () => startTour(), live,
  });
  $('#t-settings').onclick = () => settingsPanel!.open();

  // the first-run tour (again from Settings)
  const tour = new Tour(() => localStorage.setItem('agentville.toured', '1'));
  const startTour = () => {
    setView('town');
    tour.start([
      { target: '#stage', title: 'This is a town', text: 'Each town is one repo. Every robot is a Claude Code session working in it, and the buildings are its folders: a robot walks to the one it\'s working in. Helpers (subagents) are the small robots.' },
      { target: '#agents', title: 'Who\'s here', text: 'The robots in this town. Click one (or the robot itself) for its details: what it\'s doing, its to-do list, how full its context is, and your last exchange. Click its name there to rename it.' },
      { target: '#needs-wrap', title: 'When a robot needs you', text: 'A robot waiting for a permission or your answer turns orange and this counter lights up. Click it for the list across every world, with exactly what each one wants.' },
      { target: '#crumbs', title: 'Towns, worlds and the planet', text: 'A world is a project: the repos you work on together. Go up to see a world\'s towns, then the planet with every world (or press M). Esc comes back down.' },
      { target: '#town-pick', title: 'Find anything', text: `Search towns here (press /), or press ${/Mac|iP(hone|ad)/.test(navigator.platform) ? '⌘K' : 'Ctrl+K'} to jump to any robot, town or world.` },
      { target: '#t-time', title: 'Day and night', text: 'Each town has a day and a night look. This follows your Mac\'s light or dark mode, or pick one.' },
      { target: '#t-settings', title: 'Settings', text: 'Notifications and toasts, labels, a clock, robot lines, each town\'s look and building names, and which world each town belongs to. You can take this tour again from here.' },
    ]);
  };
  // not while the sign-in note is up (the tour would cover its button): it starts once this browser is signed in
  if (!localStorage.getItem('agentville.toured') && !new URLSearchParams(location.search).has('notour')) {
    setTimeout(() => { if ($('#signin').hidden) startTour(); }, 1200);
  }
  applySettings(settings);
}

function card(a: AgentState, world: World, hex: string) {
  const r = world.robots.get(a.id)!;
  const moving = r.mode === 'walking' || r.mode === 'arriving';
  const train = r.mode === 'held' ? 'Arriving by train' : r.mode === 'boarding' || r.mode === 'leaving' ? 'Taking the train' : '';
  const st = moving || train ? ['walk', train ? 'Travelling' : 'Walking'] : a.status === 'waiting' ? ['wait', 'Needs you'] : a.status === 'working' ? ['work', 'Working'] : ['idle', 'Idle'];
  const where = world.placeName(a.building, true) || (world.town.buildings[a.building]?.name ?? a.building);
  const detail = esc(train || (moving ? `→ ${where}` : a.status === 'waiting' ? `Waiting at ${where}` : `${a.task ? a.task + ' · ' : ''}${where}`));
  return `<div class="card ${a.status === 'waiting' && !moving ? 'wait' : ''} ${a.parentId ? 'sub' : ''}" data-id="${a.id}">
    <span class="dot" style="background:${hex}"></span>
    <div class="mid" title="${esc(a.title ?? '')}"><div class="top">${esc(a.name)}${a.title ? `<span class="ttl">${esc(a.title)}</span>` : ''}${todoCount(a)}<span class="st ${st[0]}">${st[1]}</span></div><div class="where">${detail}</div>${meter(a, true)}</div></div>`;
}

/** "3/7" for a robot with a to-do list. */
function todoCount(a: AgentState) {
  if (!a.todos?.length) return '';
  const done = a.todos.filter((t) => t.status === 'completed').length;
  return `<span class="todo-n" title="${done} of ${a.todos.length} to-dos done">${done}/${a.todos.length}</span>`;
}

/** The context meter: a bar (thin on cards) with the level's colour. */
function meter(a: AgentState, thin = false) {
  const c = a.context;
  if (!c?.max) return '';
  const f = Math.min(1, c.used / c.max);
  const cls = c.compacting ? 'compact' : f >= 0.85 ? 'high' : f >= 0.6 ? 'warn' : 'ok';
  const tip = c.compacting ? 'Compacting the conversation' : `Context ${Math.round(f * 100)}% full`;
  return `<div class="meter${thin ? ' thin' : ''} ${cls}" title="${tip}"><span style="width:${c.compacting ? 100 : Math.max(1, f * 100).toFixed(1)}%"></span></div>`;
}

/** The app a robot's session runs in (a helper's is its parent's). */
function appOf(a: AgentState | undefined, all: Map<string, AgentState>): string | undefined {
  return a ? a.app ?? (a.parentId ? all.get(a.parentId)?.app : undefined) : undefined;
}

const tokens = (n: number) => (n >= 1_000_000 ? `${+(n / 1_000_000).toFixed(n % 1_000_000 ? 1 : 0)}M` : n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));

/** The context section of the details panel. */
function contextSection(a: AgentState) {
  const c = a.context;
  if (!c?.max) return '';
  const f = Math.min(1, c.used / c.max);
  const line = c.compacting ? 'Compacting the conversation…'
    : !c.used && c.compactedAt ? `Compacted ${ago(c.compactedAt)}; measured again after the next reply`
    : `${tokens(c.used)} of ${tokens(c.max)} tokens · ${Math.round(f * 100)}%`;
  const times = c.compactions ? ` · compacted ${c.compactions === 1 ? 'once' : `${c.compactions} times`}` : '';
  return `<h3>Context</h3>${meter(a)}<div class="sub">${line}${times}</div>`;
}

/** The to-do section of the details panel. */
function todoSection(a: AgentState) {
  if (!a.todos?.length) return '';
  const done = a.todos.filter((t) => t.status === 'completed').length;
  const items = a.todos.map((t) => `<li class="${t.status}">${esc(t.status === 'in_progress' ? t.doing ?? t.text : t.text)}</li>`).join('');
  return `<h3>To-do · ${done} of ${a.todos.length} done</h3><ul class="todo">${items}</ul>`;
}

/** The details panel for one robot. */
/** `app`: the session's app for the Go to session button ('' when unknown; undefined in demo mode: no button). */
function details(a: AgentState, all: AgentState[], world: World, town?: TownInfo, app?: string, talkOpen = false) {
  const r = world.robots.get(a.id)!;
  const hex = world.sprites.meta.colors[a.color];
  const moving = r.mode === 'walking' || r.mode === 'arriving';
  const st = moving ? ['walk', 'Walking'] : a.status === 'waiting' ? ['wait', 'Needs you'] : a.status === 'working' ? ['work', 'Working'] : ['idle', 'Idle'];
  const building = world.placeName(a.building) || (world.town.buildings[a.building]?.name ?? a.building);
  const parent = a.parentId ? all.find((x) => x.id === a.parentId) : undefined;
  const helpers = all.filter((x) => x.parentId === a.id);
  const row = (k: string, v: string) => `<div class="k">${k}</div><div class="v">${v}</div>`;
  const rows = [
    town ? row('World', esc(town.world)) : '',
    a.project ? row('Town', esc(a.project)) : '',
    row('Where', esc(building)),
    a.status !== 'idle' && a.task ? row(a.status === 'waiting' ? 'Wants' : 'Doing', esc(a.task)) : '',
    a.status === 'waiting' && a.ask ? row(a.task === 'Waiting for your reply' ? 'Last said' : 'What', esc(a.ask)) : '',
    a.activity ? row('Running', esc(BADGE_LABEL[a.activity])) : '',
    a.result ? row('Last command', `<span class="res ${a.result.ok ? 'ok' : 'bad'}">${a.result.ok ? '✓' : '✗'}</span> ${esc(RESULT_LABEL[a.result.kind][a.result.ok ? 0 : 1])} · ${ago(a.result.at)}`) : '',
    a.background?.length ? row('In background', a.background.map((b) => `<div class="bg-item">${esc(BACKGROUND_TYPE[b.type])}${esc(b.text)}</div>`).join('')) : '',
    parent ? row('Helper of', `<a data-id="${parent.id}">${esc(parent.name)}</a>`) : '',
    helpers.length ? row('Helpers', helpers.map((h) => `<a data-id="${h.id}">${esc(h.name)}</a>`).join(', ')) : '',
    a.startedAt ? row('Started', ago(a.startedAt)) : '',
    a.lastActive ? row('Last active', ago(a.lastActive)) : '',
  ].join('');
  const recent = (a.recent ?? []).map((x) => `<li><span class="t">${clock(x.t)}</span>${esc(x.text)}</li>`).join('');
  return `<div class="det">
    <div class="top"><span class="dot" style="background:${hex}"></span>${a.parentId ? `<span class="nm">${esc(a.name)}</span>` : `<span class="nm can" title="Rename">${esc(a.name)}</span>`}<span class="st ${st[0]}">${st[1]}</span><button class="x" title="Close (Esc)">✕</button></div>
    ${a.title ? `<div class="title">${esc(a.title)}</div>` : ''}
    ${app === undefined ? '' : app ? `<button class="go" title="Bring ${a.parentId ? 'its parent' : 'this'} session to the front (G)">Open in ${esc(app)}</button>`
      : `<button class="go" disabled title="Agentville doesn't know which app this session runs in yet. Run npm run hooks:install again, then send the session a new message.">Go to session</button>`}
    <div class="grid">${rows}</div>
    ${talkSection(a, talkOpen)}
    ${contextSection(a)}
    ${todoSection(a)}
    ${recent ? `<h3>Recent</h3><ul>${recent}</ul>` : ''}
  </div>`;
}

const esc = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
const clock = (t: number) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
function ago(t: number) {
  const s = Math.max(0, Math.round((Date.now() - t) / 1000));
  return s < 10 ? 'just now' : s < 60 ? `${s} s ago` : s < 3600 ? `${Math.floor(s / 60)} min ago` : `${Math.floor(s / 3600)} h ${Math.floor((s % 3600) / 60)} min ago`;
}

main().catch((e) => {
  console.error(e);
  document.body.innerHTML = `<pre style="color:#fff;padding:20px">Agentville failed to start:\n${e?.message ?? e}</pre>`;
});

const RESULT_LABEL: Record<ActivityKind, [string, string]> = {
  test: ['Tests passed', 'Tests failed'], build: ['Build passed', 'Build failed'], git: ['Git done', 'Git failed'],
  install: ['Packages installed', 'Install failed'], server: ['Server stopped', 'Server failed'], deploy: ['Deployed', 'Deploy failed'],
};
/** Failures worth a toast (a failed git pull or install shows on the robot, but isn't news). */
const FAIL_TOASTS = new Set<ActivityKind>(['test', 'build', 'deploy']);
const BACKGROUND_TYPE: Record<NonNullable<AgentState['background']>[number]['type'], string> = { shell: '', agent: 'Helper: ', monitor: 'Watching: ', other: '' };

/** What you last asked and how Claude answered; clipped until clicked. */
function talkSection(a: AgentState, open: boolean) {
  if (!a.lastPrompt && !a.lastReply) return '';
  const said = (who: string, cls: string, text?: string) => (text ? `<div class="${cls}"><span class="who">${who}</span>${esc(text)}</div>` : '');
  return `<h3>Last exchange</h3><div class="talk${open ? ' open' : ''}" title="${open ? 'Show less' : 'Show all'}">${said('You', 'you', a.lastPrompt)}${said('Claude', 'claude', a.lastReply)}</div>`;
}

