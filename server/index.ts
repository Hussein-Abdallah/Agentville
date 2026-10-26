// Agentville local service: receives Claude Code hook events and streams robot states to the town.
//   POST /events   <- hook JSON (from the curl hook)
//   GET  /status   -> what `npm run hooks:status` shows: the last event, sessions, debugging (needs the token)
//   POST /signin, /signin/wait -> one-click sign-in for a new browser (a system dialog asks you; pages only)
//   GET  /ws       -> WebSocket: {type:'snapshot'|'agent'|'remove'|'log'|'towns'|'alerts'|'needs'|'focused'|'settings'};
//                     the page sends {type:'alerts', on}, {type:'notify', can}, {type:'focus', id} (Go to session), {type:'rename', id, name},
//                     and from Settings {type:'settings', settings}, {type:'townMap', id, map}, {type:'buildingName', id, building, name}, {type:'world', ids, world}
//   GET  /*        -> the built app (dist/)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Sessions, type HookEvent } from './state';
import { EventLog, summarizeEvent } from './log';
import { Alerts } from './notify';
import { focusHost } from './focus';
import { Auth } from './auth';
import { MAX_EVENT_BYTES, RateLimit, warnOnce } from './limits';
import { SettingsFile } from './settings';
import type { Settings } from '../src/settings';
import { HookDebug } from './debug';
import { openUrl } from './open';
import { SignIn, browserName, systemAsk } from './signin';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const PORT = Number(process.env.AGENTVILLE_PORT ?? 4917);
const HOST = '127.0.0.1'; // local only
const DIST = path.join(APP, 'dist');
const PUBLIC = path.join(APP, 'public');
const DEBUG = !!process.env.AGENTVILLE_DEBUG;
const log = new EventLog(path.join(APP, 'logs'));
const auth = new Auth();
const rate = new RateLimit();
const settings = new SettingsFile();
// needs-you alerts and their sound follow the settings (AGENTVILLE_ALERTS=0 starts them off this time)
const alerts = new Alerts(settings.value.alerts && process.env.AGENTVILLE_ALERTS !== '0');
alerts.sound = settings.value.sound;
const MAX_CLIENTS = 20; // open pages
const hookDebug = new HookDebug(path.join(APP, 'logs'));
const signIn = new SignIn(systemAsk());
const startedAt = Date.now();
let eventCount = 0;
let lastEvent: { name: string; at: number; session: string } | undefined;

const robot = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'sprites', 'robot', 'robot.json'), 'utf8'));
// every town map in public/towns (Frostpeak first: repos get maps in this order of preference)
const MAP_ORDER = ['frostpeak', 'maplewood', 'azure-harbor', 'sunreach-oasis'];
const mapIds = fs.readdirSync(path.join(PUBLIC, 'towns')).filter((d) => fs.existsSync(path.join(PUBLIC, 'towns', d, 'town.json')))
  .sort((a, b) => (MAP_ORDER.indexOf(a) + 1 || 99) - (MAP_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
const townFiles = Object.fromEntries(mapIds.map((id) => [id, JSON.parse(fs.readFileSync(path.join(PUBLIC, 'towns', id, 'town.json'), 'utf8'))]));
const maps = Object.fromEntries(mapIds.map((id) => [id, Object.entries<any>(townFiles[id].buildings).map(([b, d]) => ({ id: b, name: d.name, role: d.role }))]));

const clients = new Set<WebSocket>();
const notifiers = new Set<WebSocket>(); // pages allowed to show browser notifications
const recent: string[] = [];
const broadcast = (msg: object) => {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
};
let labelsKey = '';
const sessions: Sessions = new Sessions(maps, Object.keys(robot.colors), (msg) => {
  if (msg.type === 'needs') {
    const via = alerts.needs(msg.state, msg.project, notifiers.size > 0);
    if (via === 'page') {
      const s = JSON.stringify(msg); // every allowed page gets it; the browser merges them (same tag)
      for (const c of notifiers) if (c.readyState === WebSocket.OPEN) c.send(s);
    }
    if (via) console.log(`${msg.state.name} needs you: notification ${via === 'page' ? `shown by ${notifiers.size} open page${notifiers.size === 1 ? '' : 's'}` : `sent to ${process.platform === 'win32' ? 'Windows' : 'macOS'} (no page allowed to notify)`}`);
    return;
  }
  if (msg.type === 'remove') alerts.forget(msg.id);
  if (msg.type === 'log') { recent.unshift(msg.html); recent.length = Math.min(recent.length, 20); }
  broadcast(msg);
  sendTowns();
});

// ~/.agentville/settings.json changed: every open page follows
settings.onChange = (value) => settingsChanged(value);
function settingsChanged(value: Settings) {
  alerts.on = value.alerts; alerts.sound = value.sound;
  broadcast({ type: 'settings', settings: value });
  broadcast({ type: 'alerts', on: alerts.on });
}
settings.watch();

// each town map's landscape ("land" in town.json), so a world sits on a matching spot of the planet
sessions.lands = Object.fromEntries(Object.entries(townFiles).filter(([, t]) => typeof t.land === 'string').map(([id, t]) => [id, t.land]));

/** The towns list (worlds, building labels) whenever it changes. */
function sendTowns() {
  const towns = sessions.towns();
  const k = JSON.stringify(towns);
  if (k !== labelsKey) { labelsKey = k; broadcast({ type: 'towns', towns }); }
}

// learn repos used with Claude before, so worlds are grouped right from the first event
sessions.worlds.seedFromClaudeHistory((dir) => sessions.repoRoot(dir)).then(sendTowns, () => {});

const MIME: Record<string, string> = {
  '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json',
  '.webp': 'image/webp', '.jpg': 'image/jpeg', '.png': 'image/png', '.svg': 'image/svg+xml', '.glb': 'model/gltf-binary',
};

function serveStatic(req: http.IncomingMessage, res: http.ServerResponse) {
  const url = decodeURIComponent((req.url ?? '/').split('?')[0]);
  const root = fs.existsSync(DIST) ? DIST : null;
  if (!root) { res.writeHead(503, { 'content-type': 'text/plain' }); return res.end('App not built yet. Run: npm run build'); }
  let file = path.normalize(path.join(root, url));
  if (!file.startsWith(root)) { res.writeHead(403); return res.end(); }
  if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) file = path.join(root, 'index.html');
  res.writeHead(200, { 'content-type': MIME[path.extname(file)] ?? 'application/octet-stream' });
  fs.createReadStream(file).pipe(res);
}

const LOCAL = ['localhost', '127.0.0.1', '[::1]'];
/**
 * Hooks (curl) send no Origin; browsers do. Only pages served from this machine may talk to the
 * service, and only under a local host name (a web page can't reach it by DNS rebinding).
 */
function localOrigin(req: http.IncomingMessage) {
  try { if (!LOCAL.includes(new URL(`http://${req.headers.host ?? ''}`).hostname)) return false; } catch { return false; }
  const o = req.headers.origin;
  if (!o) return true;
  try { return LOCAL.includes(new URL(o).hostname); } catch { return false; }
}

/** One header's value as a string. */
const header = (req: http.IncomingMessage, name: string) => { const v = req.headers[name]; return Array.isArray(v) ? v[0] : v; };

const server = http.createServer((req, res) => {
  const route = (req.url ?? '/').split('?')[0];
  if (req.method === 'POST' && route === '/events') {
    if (!localOrigin(req)) { res.writeHead(403).end(); return; }
    if (!auth.allows(req)) {
      warnOnce('token', 'Ignored events without Agentville\'s token. Run npm run hooks:install again so the hooks send it.');
      res.writeHead(401).end(); req.resume(); return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= MAX_EVENT_BYTES) chunks.push(c); });
    req.on('end', () => {
      if (size > MAX_EVENT_BYTES) {
        warnOnce('size', `Ignored an event of ${(size / 1048576).toFixed(1)} MB (the limit is ${MAX_EVENT_BYTES / 1048576} MB).`);
        return res.writeHead(413).end();
      }
      let e: HookEvent;
      try { e = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return res.writeHead(400).end(); }
      if (!rate.take(String(e?.session_id ?? ''))) {
        warnOnce('rate', `Too many events from session ${String(e?.session_id ?? '?').slice(0, 8)}: some are being dropped.`);
        return res.writeHead(429).end();
      }
      res.writeHead(204).end(); // answer right away: never slow Claude down
      try {
        // the app the session runs in comes from the hook's headers, never from the event itself
        e.agentville_app = header(req, 'x-agentville-app');
        e.agentville_term = header(req, 'x-agentville-term');
        e.agentville_tty = header(req, 'x-agentville-tty');
        e.agentville_entry = header(req, 'x-agentville-entry');
        e.agentville_wt = header(req, 'x-agentville-wt');
        if (DEBUG) console.log(e.hook_event_name, e.tool_name ?? '', e.session_id?.slice(0, 8));
        eventCount++;
        lastEvent = { name: String(e.hook_event_name ?? '?'), at: Date.now(), session: String(e.session_id ?? '').slice(0, 8) };
        const result = sessions.handle(e);
        if (hookDebug.on) hookDebug.write(e, result);
        log.write({ ...summarizeEvent(e), result: result && 'recent' in result ? { ...result, recent: undefined } : result }); // history would repeat on every line
      } catch { /* ignore malformed events */ }
    });
    return;
  }
  if (route === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  // for `npm run hooks:status`: is it getting events? (with the token: it tells which sessions are active)
  if (route === '/status') {
    if (!localOrigin(req) || !auth.allows(req)) { res.writeHead(401).end(); return; }
    const snap = sessions.snapshot();
    res.writeHead(200, { 'content-type': 'application/json' });
    return res.end(JSON.stringify({ startedAt, events: eventCount, lastEvent, sessions: snap.filter((a) => !a.parentId).length, helpers: snap.filter((a) => a.parentId).length,
      pages: clients.size, debugUntil: hookDebug.endsAt ?? null, pid: process.pid }));
  }
  // the page asks whether it's signed in (has the token cookie)
  if (route === '/auth') { res.writeHead(localOrigin(req) && auth.allows(req) ? 204 : 401).end(); return; }
  // one-click sign-in (pages only: a browser always sends a local Origin; curl and the hooks send none)
  if (req.method === 'POST' && (route === '/signin' || route === '/signin/wait')) {
    if (!localOrigin(req) || !req.headers.origin) { res.writeHead(403).end(); req.resume(); return; }
    const json = (code: number, body?: object, headers: Record<string, string> = {}) => {
      res.writeHead(code, body ? { 'content-type': 'application/json', ...headers } : headers).end(body ? JSON.stringify(body) : undefined);
    };
    if (route === '/signin') {
      req.resume();
      const browser = browserName(req.headers['user-agent']);
      const r = signIn.start(browser);
      if ('error' in r) return json(r.error === 'busy' ? 409 : r.error === 'too-many' ? 429 : 501, { error: r.error });
      console.log(`A browser asks to sign in (${browser}): a dialog asks you to allow it.`);
      return json(200, r);
    }
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => { size += c.length; if (size <= 4096) chunks.push(c); });
    req.on('end', async () => {
      let b: any;
      try { b = JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { return json(400); }
      const answer = await signIn.wait(b?.id, b?.secret);
      if (answer === 'allow') { console.log('Signed in a browser.'); return json(204, undefined, { 'set-cookie': auth.cookie() }); }
      if (answer === 'deny') console.log('A browser\'s sign-in was not allowed.');
      json(answer === 'gone' ? 410 : 403);
    });
    return;
  }
  // the sign-in link: keep the token in a cookie, then drop it from the address
  if (req.method === 'GET' && route === '/' && /[?&]token=/.test(req.url ?? '')) {
    if (localOrigin(req) && auth.allows(req)) { res.writeHead(302, { 'set-cookie': auth.cookie(), location: '/' }).end(); return; }
  }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 }); // the page only sends tiny messages
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws') || !localOrigin(req)) return socket.destroy();
  if (!auth.allows(req)) { socket.end('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); return; }
  if (clients.size >= MAX_CLIENTS) { socket.end('HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\n\r\n'); return; }
  // Go to session runs commands on this Mac, so only a page (a browser sends an Origin) may ask
  const page = !!req.headers.origin;
  let lastFocus = 0;
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'snapshot', agents: sessions.snapshot(), log: recent.slice(0, 8), towns: sessions.towns(), alerts: alerts.on, settings: settings.value,
      maps: mapIds.map((id) => ({ id, name: townFiles[id].name ?? id })) }));
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(String(data));
        // the Alerts button, and the Settings page: saved for next time too
        if (m?.type === 'alerts' && typeof m.on === 'boolean' && page) settingsChanged(settings.save({ ...settings.value, alerts: m.on }));
        if (m?.type === 'settings' && page) settingsChanged(settings.save(m.settings));
        if (m?.type === 'notify') {
          const n = notifiers.size;
          if (m.can === true) notifiers.add(ws); else notifiers.delete(ws);
          if (notifiers.size !== n) console.log(`Pages that can show notifications: ${notifiers.size}`);
        }
        if (m?.type === 'rename' && typeof m.id === 'string' && page) sessions.rename(m.id, m.name);
        // Settings: a town's map, a building's name, which world towns belong to (only towns it knows)
        if (m?.type === 'townMap' && typeof m.id === 'string' && typeof m.map === 'string' && page && sessions.setTownMap(m.id, m.map)) {
          sendTowns(); // pages load the new map first…
          for (const a of sessions.snapshot()) if (a.town === m.id) broadcast({ type: 'agent', state: a }); // …then its robots move to its plaza
        }
        if (m?.type === 'buildingName' && typeof m.id === 'string' && typeof m.building === 'string' && typeof m.name === 'string' && page
          && sessions.renameBuilding(m.id, m.building, m.name)) sendTowns();
        if (m?.type === 'world' && Array.isArray(m.ids) && typeof m.world === 'string' && page) {
          const known = new Set(sessions.towns().map((t) => t.id));
          const ids = m.ids.filter((id: unknown): id is string => typeof id === 'string' && known.has(id));
          if (sessions.worlds.assign(ids, m.world)) sendTowns();
        }
        if (m?.type === 'focus' && typeof m.id === 'string' && page && Date.now() - lastFocus > 1000) {
          lastFocus = Date.now();
          const target = sessions.hostOf(m.id);
          const done = (ok: boolean) => ws.readyState === WebSocket.OPEN && ws.send(JSON.stringify({ type: 'focused', id: m.id, ok }));
          if (!target) done(false);
          else focusHost(target.host, target.folder).then(done, () => done(false));
        }
      } catch { /* ignore */ }
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (notifiers.delete(ws)) console.log(`Pages that can show notifications: ${notifiers.size}`);
    });
  });
});

// remembered sessions are written a moment after each change: write them before stopping
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP'] as const) process.on(sig, () => { sessions.flush(); process.exit(0); });

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Is Agentville already running? (set AGENTVILLE_PORT to change it)`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = auth.link(PORT);
  console.log(`Agentville is running at http://localhost:${PORT}`);
  console.log(`Sign in a browser once with: ${url}  (or run: npm run token -- open)`);
  if (process.platform === 'darwin' || process.platform === 'win32') console.log(`Needs-you alerts ${alerts.on ? 'on' : 'off'} (switch with the Alerts button; start with AGENTVILLE_ALERTS=0 to begin off)`);
  console.log('Waiting for Claude Code events… (install the hooks once with: npm run hooks:install)');
  if (log.enabled) console.log(`Logging events to ${log.dir} (turn off with AGENTVILLE_LOG=0)`);
  log.write({ event: 'ServiceStart', version: 2, port: PORT, maps: mapIds });
  if (process.argv.includes('--open')) openUrl(url);
});
