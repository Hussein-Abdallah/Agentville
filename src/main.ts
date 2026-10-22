import './style.css';
import { loadTown } from './town';
import { RobotSprites } from './sprites';
import { World } from './world';
import { Demo, DEMO_TOWNS, demoFolders } from './demo';
import { WorldMap, loadWorldArt } from './worldview';
import { connectLive, serviceAvailable } from './live';
import type { AgentState, TownData, TownInfo } from './types';

const $ = <T extends HTMLElement>(s: string) => document.querySelector(s) as T;

async function main() {
  const sprites = new RobotSprites();
  const [town] = await Promise.all([loadTown('frostpeak'), sprites.init()]);
  $('#town-name').textContent = town.name;

  const world = new World($('#stage'), town, sprites);
  await world.init();

  const feed: string[] = [];
  const log = (html: string) => {
    feed.unshift(html);
    feed.length = Math.min(feed.length, 8);
    $('#feed').innerHTML = feed.map((f) => `<div>${f}</div>`).join('');
  };

  // Live mode when the local service is running; demo mode otherwise (or with ?demo).
  const live = !new URLSearchParams(location.search).has('demo') && (await serviceAvailable());
  let demo: Demo | null = null;

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
    $('#town-name').textContent = t ? `${t.world} · ${t.name}` : town.name;
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
  const goTo = async (a: AgentState) => { showMap(false); if (a.town && a.town !== current) await setTown(a.town, true); selected = a.id; world.focus(a.id); render(); };
  /** A robot appeared or changed (live service or demo). */
  const applyAgent = (s: AgentState) => {
    agents.set(s.id, s);
    if (current === null && towns.length) setTown(autoTown()); // on connect, the towns list (after the robots) picks
    if (inView(s)) world.apply(s);
    else if (world.robots.has(s.id)) world.remove(s.id); // it left for another town: walks off to the station
  };
  /** Folder labels per demo town, from its own map (loaded first). */
  const demoTowns = async () => {
    for (const t of DEMO_TOWNS) t.folders = demoFolders(await mapData(t.map));
    return DEMO_TOWNS;
  };
  const removeAgent = (id: string) => { agents.delete(id); world.remove(id); };

  // world map: the towns of one world, over the town view (button or M)
  let mapOpen = false;
  let mapWorld: string | null = null;
  const worldMap = new WorldMap($('#worldview'), await loadWorldArt(), {
    openTown: (id) => { setTown(id, true); showMap(false); },
    showWorld: (w) => { mapWorld = w; render(); },
  });
  const showMap = (open: boolean) => {
    mapOpen = open;
    if (open) mapWorld = towns.find((t) => t.id === current)?.world ?? towns[0]?.world ?? null;
    $('#worldview').hidden = !open;
    $('#t-map').classList.toggle('on', open);
    $('#t-map').textContent = open ? 'Town view' : 'World map';
    $('.zoom').style.display = open ? 'none' : '';
    render();
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
        const n = new Notification(`${st.name} needs you`, { body: (st.task ?? 'Waiting for you') + (where ? `\n${where}` : ''), tag: `agentville-${st.id}`, silent: true });
        n.onclick = () => { window.focus(); goTo(agents.get(st.id) ?? st); n.close(); };
      },
      status: (ok) => { $('#mode').textContent = ok ? 'Live' : 'Reconnecting…'; $('#mode').className = 'mode ' + (ok ? 'live' : 'off'); },
    });
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
    demo.start(5);
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
    if (e.metaKey || e.ctrlKey || e.altKey) return;
    if (e.key === 'Escape' && mapOpen) showMap(false);
    else if (e.key === 'Escape' && selected) { selected = null; render(); }
    else if (e.key === 'm' || e.key === 'M') showMap(!mapOpen);
    else if (e.key === '+' || e.key === '=') world.zoomBy(1.4);
    else if (e.key === '-') world.zoomBy(1 / 1.4);
    else if (e.key === '0') world.resetZoom();
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
    const d = sel ? details(sel, list, world, towns.find((t) => t.id === sel.town)) : '';
    if (d !== lastDetails) {
      lastDetails = d;
      $('#details').innerHTML = d;
      $('#details').style.display = d ? '' : 'none';
      $('#details').querySelector<HTMLElement>('.x')?.addEventListener('click', () => { selected = null; render(); });
      $('#details').querySelectorAll<HTMLElement>('[data-id]').forEach((el) => (el.onclick = () => select(el.dataset.id!)));
    }
    // needs-you across every town; click to jump to the first one
    const all = [...agents.values()];
    const waiting = all.filter((a) => a.status === 'waiting');
    $('#needs').textContent = waiting.length ? `${waiting.length} need${waiting.length === 1 ? 's' : ''} you` : '';
    $('#needs').onclick = waiting.length ? () => goTo(waiting[0]) : null;
    renderPicker();
    if (mapOpen && mapWorld) worldMap.update({ towns, agents: [...agents.values()], world: mapWorld, current, colors: sprites.meta.colors });
  };

  // town picker: towns grouped by world, with robot and needs-you counts
  const pick = $<HTMLSelectElement>('#town-pick');
  let lastPick = '';
  const renderPicker = () => {
    const byWorld = new Map<string, TownInfo[]>();
    for (const t of towns) (byWorld.get(t.world) ?? byWorld.set(t.world, []).get(t.world)!).push(t);
    const counts = (id: string) => {
      const here = [...agents.values()].filter((a) => a.town === id), w = here.filter((a) => a.status === 'waiting').length;
      return (here.length ? `  ·  ${here.length}` : '') + (w ? `  ·  ${w} need${w === 1 ? 's' : ''} you` : '');
    };
    const html = [...byWorld].map(([w, ts]) => `<optgroup label="${esc(w)}">${ts.map((t) =>
      `<option value="${esc(t.id)}"${t.id === current ? ' selected' : ''}>${esc(t.name)}${counts(t.id)}</option>`).join('')}</optgroup>`).join('');
    if (html !== lastPick) { lastPick = html; pick.innerHTML = html; }
    pick.style.display = towns.length ? '' : 'none';
  };
  pick.onchange = () => { setTown(pick.value, true); showMap(false); };
  world.onChange = render;
  setInterval(render, 300);

  // controls
  const toggle = (id: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = $(id);
    b.classList.toggle('on', get());
    b.onclick = () => { set(!get()); b.classList.toggle('on', get()); };
  };
  $('#t-map').onclick = () => showMap(!mapOpen);
  $('#z-in').onclick = () => world.zoomBy(1.4);
  $('#z-out').onclick = () => world.zoomBy(1 / 1.4);
  $('#z-fit').onclick = () => world.resetZoom();
  toggle('#t-labels', () => world.showLabels, (v) => (world.showLabels = v));
  toggle('#t-paths', () => world.showPaths, (v) => (world.showPaths = v));
}

function card(a: AgentState, world: World, hex: string) {
  const r = world.robots.get(a.id)!;
  const moving = r.mode === 'walking' || r.mode === 'arriving';
  const st = moving ? ['walk', 'Walking'] : a.status === 'waiting' ? ['wait', 'Needs you'] : a.status === 'working' ? ['work', 'Working'] : ['idle', 'Idle'];
  const where = world.placeName(a.building, true) || (world.town.buildings[a.building]?.name ?? a.building);
  const detail = esc(moving ? `→ ${where}` : a.status === 'waiting' ? `Waiting at ${where}` : `${a.task ? a.task + ' · ' : ''}${where}`);
  return `<div class="card ${a.status === 'waiting' && !moving ? 'wait' : ''} ${a.parentId ? 'sub' : ''}" data-id="${a.id}">
    <span class="dot" style="background:${hex}"></span>
    <div class="mid" title="${esc(a.title ?? '')}"><div class="top">${a.name}${a.title ? `<span class="ttl">${esc(a.title)}</span>` : ''}<span class="st ${st[0]}">${st[1]}</span></div><div class="where">${detail}</div></div></div>`;
}

/** The details panel for one robot. */
function details(a: AgentState, all: AgentState[], world: World, town?: TownInfo) {
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
    parent ? row('Helper of', `<a data-id="${parent.id}">${esc(parent.name)}</a>`) : '',
    helpers.length ? row('Helpers', helpers.map((h) => `<a data-id="${h.id}">${esc(h.name)}</a>`).join(', ')) : '',
    a.startedAt ? row('Started', ago(a.startedAt)) : '',
    a.lastActive ? row('Last active', ago(a.lastActive)) : '',
  ].join('');
  const recent = (a.recent ?? []).map((x) => `<li><span class="t">${clock(x.t)}</span>${esc(x.text)}</li>`).join('');
  return `<div class="det">
    <div class="top"><span class="dot" style="background:${hex}"></span>${esc(a.name)}<span class="st ${st[0]}">${st[1]}</span><button class="x" title="Close (Esc)">✕</button></div>
    ${a.title ? `<div class="title">${esc(a.title)}</div>` : ''}
    <div class="grid">${rows}</div>
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
