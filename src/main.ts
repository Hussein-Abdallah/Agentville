import './style.css';
import { loadTown } from './town';
import { RobotSprites } from './sprites';
import { World } from './world';
import { Demo, DEMO_TOWNS, demoFolders } from './demo';
import { WorldMap, loadWorldArt } from './worldview';
import { PlanetView } from './planet';
import { WorldBoard } from './boardview';
import { connectLive, serviceAvailable, signedIn } from './live';
import { TownPicker } from './picker';
import { BADGE_LABEL } from './badges';
import { Toasts } from './toasts';
import { JumpBox } from './jump';
import { NeedsBoard } from './needs';
import { DEFAULT_SETTINGS, type Settings } from './settings';
import type { ActivityKind } from './types';
import type { AgentState, TownData, TownInfo } from './types';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

async function main() {
  const sprites = new RobotSprites();
  const [town] = await Promise.all([loadTown('frostpeak'), sprites.init()]);

  const world = new World($('#stage'), town, sprites);
  await world.init();

  const feed: string[] = [];
  const log = (html: string) => {
    feed.unshift(html);
    feed.length = Math.min(feed.length, 8);
    $('#feed').innerHTML = feed.map((f) => `<div>${f}</div>`).join('');
  };

  // Live mode when the local service is running and this browser has its token; demo mode otherwise (or with ?demo).
  const running = !new URLSearchParams(location.search).has('demo') && (await serviceAvailable());
  const live = running && (await signedIn());
  /** The service runs but this browser isn't signed in: say how, over the (demo) town. */
  const signInNote = (show: boolean) => { $('#signin').hidden = !show; };
  if (running && !live) signInNote(true);
  let demo: Demo | null = null;
  /** Go to session: bring a robot's session (terminal, editor, Claude app) to the front; live mode only */
  let goToSession: ((id: string) => void) | null = null;

  // Live mode has a town per repo; the page shows one at a time and keeps every robot.
  const agents = new Map<string, AgentState>();
  let towns: TownInfo[] = [];
  let current: string | null = null;
  /** the town the scene shows robots for (set once its map has loaded) */
  let shown: string | null = null;
  // town maps (Frostpeak, Maplewood…), loaded once each; a missing one falls back to Frostpeak
  const mapCache = new Map<string, Promise<TownData>>([['frostpeak', Promise.resolve(town)]]);
  const mapData = (id: string) => {
    let p = mapCache.get(id);
    if (!p) { p = loadTown(id).catch(() => town); mapCache.set(id, p); }
    return p;
  };
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
    showTownLabels();
    for (const a of agents.values()) if (inView(a)) world.apply(a, true); // already at their buildings
    render();
  };
  /** The town you picked, else one where a robot needs you, else the most recently busy one. */
  const autoTown = () => {
    if (picked && towns.some((t) => t.id === picked)) return picked;
    const list = [...agents.values()].filter((a) => a.town).sort((a, b) => (b.lastActive ?? 0) - (a.lastActive ?? 0));
    return (list.find((a) => a.status === 'waiting') ?? list[0])?.town ?? towns[0]?.id ?? null;
  };
  /** Jump to a robot, in whatever town it is. */
  const goTo = async (a: AgentState) => { setView('town'); if (a.town && a.town !== current) await setTown(a.town, true); selected = a.id; world.focus(a.id); render(); };
  // toasts for what just happened (which kinds: ~/.agentville/settings.json), and when each robot started waiting
  let settings: Settings = DEFAULT_SETTINGS;
  const toasts = new Toasts($('#toasts'));
  const waitSince = new Map<string, number>();
  const placeOf = (a: AgentState) => { const t = towns.find((x) => x.id === a.town); return [t?.name ?? a.project, t?.world].filter(Boolean).join(' · '); };
  /** `catchingUp`: the state came with a (re)connect, so nothing in it just happened. */
  const noteChange = (prev: AgentState | undefined, s: AgentState, catchingUp: boolean) => {
    const started = s.status === 'waiting' && prev?.status !== 'waiting';
    if (started) waitSince.set(s.id, catchingUp ? s.lastActive ?? Date.now() : Date.now());
    if (s.status !== 'waiting') { waitSince.delete(s.id); toasts.dismiss(`wait-${s.id}`); }
    if (catchingUp) return;
    const on = settings.toasts, dot = sprites.meta.colors[s.color], where = esc(placeOf(s));
    const go = () => goTo(agents.get(s.id) ?? s);
    const who = `<b>${esc(s.name)}</b>`;
    if (on.needsYou && started) {
      toasts.show({ key: `wait-${s.id}`, tone: 'wait', dot, title: `${who} needs you`, body: [esc(s.task ?? 'Waiting for you'), s.ask ? `<i>${esc(s.ask)}</i>` : '', where].filter(Boolean).join('<br>'), onClick: go, seconds: 15 });
    }
    const r = s.result;
    if (on.failed && r && !r.ok && FAIL_TOASTS.has(r.kind) && r.at !== prev?.result?.at) {
      toasts.show({ key: `fail-${s.id}`, tone: 'bad', dot, title: `${who}: ${esc(RESULT_LABEL[r.kind][1])}`, body: where, onClick: go });
    }
    if (on.finished && !s.parentId && prev?.status === 'working' && s.status === 'idle') {
      toasts.show({ key: `done-${s.id}`, tone: 'done', dot, title: `${who} finished`, body: [esc(s.title ?? ''), where].filter(Boolean).join('<br>'), onClick: go, seconds: 6 });
    }
    if (on.sessions && !s.parentId && !prev) {
      toasts.show({ key: `came-${s.id}`, tone: 'info', dot, title: `${who} started`, body: [esc(s.title ?? ''), where].filter(Boolean).join('<br>'), onClick: go, seconds: 6 });
    }
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
    if (inView(s)) world.apply(s);
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
      settings: (s) => { settings = s; },
      status: (ok) => {
        $('#mode').textContent = ok ? 'Live' : 'Reconnecting…'; $('#mode').className = 'mode ' + (ok ? 'live' : 'off');
        // the token was renewed (or the cookie cleared): reconnecting won't help until you sign in again
        if (ok) signInNote(false); else signedIn().then((yes) => serviceAvailable().then((up) => signInNote(up && !yes)));
      },
    });
    goToSession = (id) => conn.focus(id);
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
    log('Demo mode: simulated agents');
    demo.start(12); // enough robots that bigger worlds aren't empty
  }
  // click a robot or card: show its details (click again, ✕ or Esc to close)
  let selected: string | null = null;
  const select = (id: string) => {
    const a = demo?.agents.get(id);
    if (a?.status === 'waiting') demo!.approve(id);
    else if (selected === id) { selected = null; render(); return; }
    selected = id;
    world.focus(id);
    render();
  };
  world.onRobotClick = select;
  (window as any).__av = { world, demo };

  // sidebar
  let last = '';
  let lastDetails = '';
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
    const d = sel ? details(sel, list, world, towns.find((t) => t.id === sel.town), goToSession ? appOf(sel, agents) ?? '' : undefined) : '';
    if (d !== lastDetails) {
      lastDetails = d;
      $('#details').innerHTML = d;
      $('#details').style.display = d ? '' : 'none';
      $('#details').querySelector<HTMLElement>('.x')?.addEventListener('click', () => { selected = null; render(); });
      $('#details').querySelectorAll<HTMLElement>('[data-id]').forEach((el) => (el.onclick = () => select(el.dataset.id!)));
      $('#details').querySelector<HTMLButtonElement>('.go')?.addEventListener('click', () => { if (selected) goToSession?.(selected); });
    }
    // needs-you across every town: the counter opens the board
    const all = [...agents.values()];
    needs.update(all.filter((a) => a.status === 'waiting'), (a) => waitSince.get(a.id) ?? a.lastActive ?? Date.now(), towns, sprites.meta.colors,
      (a) => (goToSession ? appOf(a, agents) : undefined));
    jump.update(all, towns, sprites.meta.colors);
    renderPicker();
    if (view === 'planet') planet.update({ towns, agents: [...agents.values()], current: mapWorld ?? currentWorld() });
    if (view === 'world' && mapWorld && mapStyle === 'painted') worldMap.update({ towns, agents: [...agents.values()], world: mapWorld, current, colors: sprites.meta.colors });
    if (view === 'world' && mapWorld && mapStyle === 'board') board.update({
      towns, agents: [...agents.values()], world: mapWorld, current, colors: sprites.meta.colors,
      image: (t) => `towns/${t.map}/town.jpg`, ground: groundFor(mapWorld),
    });
  };

  // town picker: search towns by name or world, grouped by world, with robot and needs-you counts
  const picker = new TownPicker($('#town-pick'), (id) => { setTown(id, true); setView('town'); });
  const renderPicker = () => picker.update(towns, [...agents.values()], current);
  world.onChange = render;
  setInterval(render, 300);

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
  toggle('#t-labels', () => world.showLabels, (v) => (world.showLabels = v));
  toggle('#t-paths', () => world.showPaths, (v) => (world.showPaths = v));
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
    <div class="mid" title="${esc(a.title ?? '')}"><div class="top">${a.name}${a.title ? `<span class="ttl">${esc(a.title)}</span>` : ''}${todoCount(a)}<span class="st ${st[0]}">${st[1]}</span></div><div class="where">${detail}</div>${meter(a, true)}</div></div>`;
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
function details(a: AgentState, all: AgentState[], world: World, town?: TownInfo, app?: string) {
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
    a.background?.length ? row('In background', esc([...new Set(a.background)].map((k) => BACKGROUND_LABEL[k]).join(', '))) : '',
    parent ? row('Helper of', `<a data-id="${parent.id}">${esc(parent.name)}</a>`) : '',
    helpers.length ? row('Helpers', helpers.map((h) => `<a data-id="${h.id}">${esc(h.name)}</a>`).join(', ')) : '',
    a.startedAt ? row('Started', ago(a.startedAt)) : '',
    a.lastActive ? row('Last active', ago(a.lastActive)) : '',
  ].join('');
  const recent = (a.recent ?? []).map((x) => `<li><span class="t">${clock(x.t)}</span>${esc(x.text)}</li>`).join('');
  return `<div class="det">
    <div class="top"><span class="dot" style="background:${hex}"></span>${esc(a.name)}<span class="st ${st[0]}">${st[1]}</span><button class="x" title="Close (Esc)">✕</button></div>
    ${a.title ? `<div class="title">${esc(a.title)}</div>` : ''}
    ${app === undefined ? '' : app ? `<button class="go" title="Bring ${a.parentId ? 'its parent' : 'this'} session to the front (G)">Open in ${esc(app)}</button>`
      : `<button class="go" disabled title="Agentville doesn't know which app this session runs in yet. Run npm run hooks:install again, then send the session a new message.">Go to session</button>`}
    <div class="grid">${rows}</div>
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
const BACKGROUND_LABEL: Record<ActivityKind, string> = { test: 'tests', build: 'a build', git: 'git', install: 'an install', server: 'a dev server', deploy: 'a deploy' };

