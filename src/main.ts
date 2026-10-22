import './style.css';
import { loadTown } from './town';
import { RobotSprites } from './sprites';
import { World } from './world';
import { Demo, DEMO_FOLDERS } from './demo';
import { connectLive, serviceAvailable } from './live';
import type { AgentState } from './types';

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
      apply: (s) => world.apply(s),
      remove: (id) => world.remove(id),
      log,
      folders: (f, names) => { world.folders = f; world.names = names; },
      alerts: (on) => { alertsBtn.classList.toggle('on', on); alertsBtn.dataset.on = on ? '1' : ''; showAllow(); },
      needs: (st, project) => {
        if (!canNotify()) return;
        const where = [project, st.title].filter(Boolean).join(' · ');
        // silent: the service plays the sound; the tag merges copies from several open pages
        const n = new Notification(`${st.name} needs you`, { body: (st.task ?? 'Waiting for you') + (where ? `\n${where}` : ''), tag: `agentville-${st.id}`, silent: true });
        n.onclick = () => { window.focus(); world.focus(st.id); n.close(); };
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
    world.folders = DEMO_FOLDERS;
    demo = new Demo(town, sprites.colors(), (s) => world.apply(s), (id) => world.remove(id), log, (id) => world.robots.get(id)?.mode === 'present');
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
    if (e.key === 'Escape' && selected) { selected = null; render(); }
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
    const d = selected ? details(world.robots.get(selected)!.state, list, world) : '';
    if (d !== lastDetails) {
      lastDetails = d;
      $('#details').innerHTML = d;
      $('#details').style.display = d ? '' : 'none';
      $('#details').querySelector<HTMLElement>('.x')?.addEventListener('click', () => { selected = null; render(); });
      $('#details').querySelectorAll<HTMLElement>('[data-id]').forEach((el) => (el.onclick = () => select(el.dataset.id!)));
    }
    const waiting = list.filter((a) => a.status === 'waiting').length;
    $('#needs').textContent = waiting ? `${waiting} need${waiting === 1 ? 's' : ''} you` : '';
  };
  world.onChange = render;
  setInterval(render, 300);

  // controls
  const toggle = (id: string, get: () => boolean, set: (v: boolean) => void) => {
    const b = $(id);
    b.classList.toggle('on', get());
    b.onclick = () => { set(!get()); b.classList.toggle('on', get()); };
  };
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
function details(a: AgentState, all: AgentState[], world: World) {
  const r = world.robots.get(a.id)!;
  const hex = world.sprites.meta.colors[a.color];
  const moving = r.mode === 'walking' || r.mode === 'arriving';
  const st = moving ? ['walk', 'Walking'] : a.status === 'waiting' ? ['wait', 'Needs you'] : a.status === 'working' ? ['work', 'Working'] : ['idle', 'Idle'];
  const building = world.placeName(a.building) || (world.town.buildings[a.building]?.name ?? a.building);
  const parent = a.parentId ? all.find((x) => x.id === a.parentId) : undefined;
  const helpers = all.filter((x) => x.parentId === a.id);
  const row = (k: string, v: string) => `<div class="k">${k}</div><div class="v">${v}</div>`;
  const rows = [
    a.project ? row('Project', esc(a.project)) : '',
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
