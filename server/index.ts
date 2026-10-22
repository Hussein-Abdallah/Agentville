// Agentville local service: receives Claude Code hook events and streams robot states to the town.
//   POST /events   <- hook JSON (from the curl hook)
//   GET  /ws       -> WebSocket: {type:'snapshot'|'agent'|'remove'|'log'|'towns'|'alerts'|'needs'}; the page sends {type:'alerts', on} and {type:'notify', can}
//   GET  /*        -> the built app (dist/)
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { exec } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { WebSocketServer, WebSocket } from 'ws';
import { Sessions, type HookEvent } from './state';
import { EventLog, summarizeEvent } from './log';
import { Alerts } from './notify';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const APP = path.resolve(HERE, '..');
const PORT = Number(process.env.AGENTVILLE_PORT ?? 4917);
const HOST = '127.0.0.1'; // local only
const DIST = path.join(APP, 'dist');
const PUBLIC = path.join(APP, 'public');
const DEBUG = !!process.env.AGENTVILLE_DEBUG;
const log = new EventLog(path.join(APP, 'logs'));
const alerts = new Alerts(process.env.AGENTVILLE_ALERTS !== '0');

const robot = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'sprites', 'robot', 'robot.json'), 'utf8'));
// every town map in public/towns (Frostpeak first: repos get maps in this order of preference)
const MAP_ORDER = ['frostpeak', 'maplewood', 'azure-harbor'];
const mapIds = fs.readdirSync(path.join(PUBLIC, 'towns')).filter((d) => fs.existsSync(path.join(PUBLIC, 'towns', d, 'town.json')))
  .sort((a, b) => (MAP_ORDER.indexOf(a) + 1 || 99) - (MAP_ORDER.indexOf(b) + 1 || 99) || a.localeCompare(b));
const maps = Object.fromEntries(mapIds.map((id) => {
  const t = JSON.parse(fs.readFileSync(path.join(PUBLIC, 'towns', id, 'town.json'), 'utf8'));
  return [id, Object.entries<any>(t.buildings).map(([b, d]) => ({ id: b, name: d.name, role: d.role }))];
}));

const clients = new Set<WebSocket>();
const notifiers = new Set<WebSocket>(); // pages allowed to show browser notifications
const recent: string[] = [];
const broadcast = (msg: object) => {
  const s = JSON.stringify(msg);
  for (const c of clients) if (c.readyState === WebSocket.OPEN) c.send(s);
};
let labelsKey = '';
const sessions = new Sessions(maps, Object.keys(robot.colors), (msg) => {
  if (msg.type === 'needs') {
    const via = alerts.needs(msg.state, msg.project, notifiers.size > 0);
    if (via === 'page') {
      const s = JSON.stringify(msg); // every allowed page gets it; the browser merges them (same tag)
      for (const c of notifiers) if (c.readyState === WebSocket.OPEN) c.send(s);
    }
    if (via) console.log(`${msg.state.name} needs you: notification ${via === 'page' ? `shown by ${notifiers.size} open page${notifiers.size === 1 ? '' : 's'}` : 'sent to macOS (no page allowed to notify)'}`);
    return;
  }
  if (msg.type === 'remove') alerts.forget(msg.id);
  if (msg.type === 'log') { recent.unshift(msg.html); recent.length = Math.min(recent.length, 20); }
  broadcast(msg);
  sendTowns();
});

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

/** Hooks (curl) send no Origin; browsers do. Only pages served from this machine may talk to the service. */
function localOrigin(req: http.IncomingMessage) {
  const o = req.headers.origin;
  if (!o) return true;
  try { return ['localhost', '127.0.0.1', '[::1]'].includes(new URL(o).hostname); } catch { return false; }
}

const server = http.createServer((req, res) => {
  if (req.method === 'POST' && req.url?.startsWith('/events')) {
    if (!localOrigin(req)) { res.writeHead(403).end(); return; }
    let body = '';
    req.on('data', (c) => { body += c; if (body.length > 2_000_000) req.destroy(); });
    req.on('end', () => {
      res.writeHead(204).end(); // answer right away: never slow Claude down
      try {
        const e: HookEvent = JSON.parse(body);
        if (DEBUG) console.log(e.hook_event_name, e.tool_name ?? '', e.session_id?.slice(0, 8));
        const result = sessions.handle(e);
        log.write({ ...summarizeEvent(e), result: result && 'recent' in result ? { ...result, recent: undefined } : result }); // history would repeat on every line
      } catch { /* ignore malformed events */ }
    });
    return;
  }
  if (req.url === '/health') { res.writeHead(200, { 'content-type': 'application/json' }); return res.end('{"ok":true}'); }
  serveStatic(req, res);
});

const wss = new WebSocketServer({ noServer: true });
server.on('upgrade', (req, socket, head) => {
  if (!req.url?.startsWith('/ws') || !localOrigin(req)) return socket.destroy();
  wss.handleUpgrade(req, socket, head, (ws) => {
    clients.add(ws);
    ws.send(JSON.stringify({ type: 'snapshot', agents: sessions.snapshot(), log: recent.slice(0, 8), towns: sessions.towns(), alerts: alerts.on }));
    ws.on('message', (data) => {
      try {
        const m = JSON.parse(String(data));
        if (m?.type === 'alerts' && typeof m.on === 'boolean') { alerts.on = m.on; broadcast({ type: 'alerts', on: alerts.on }); }
        if (m?.type === 'notify') {
          const n = notifiers.size;
          if (m.can === true) notifiers.add(ws); else notifiers.delete(ws);
          if (notifiers.size !== n) console.log(`Pages that can show notifications: ${notifiers.size}`);
        }
      } catch { /* ignore */ }
    });
    ws.on('close', () => {
      clients.delete(ws);
      if (notifiers.delete(ws)) console.log(`Pages that can show notifications: ${notifiers.size}`);
    });
  });
});

server.on('error', (err: NodeJS.ErrnoException) => {
  if (err.code === 'EADDRINUSE') console.error(`Port ${PORT} is busy. Is Agentville already running? (set AGENTVILLE_PORT to change it)`);
  else console.error(err);
  process.exit(1);
});

server.listen(PORT, HOST, () => {
  const url = `http://localhost:${PORT}`;
  console.log(`Agentville is running at ${url}`);
  if (process.platform === 'darwin') console.log(`Needs-you alerts ${alerts.on ? 'on' : 'off'} (switch with the Alerts button; start with AGENTVILLE_ALERTS=0 to begin off)`);
  console.log('Waiting for Claude Code events… (install the hooks once with: npm run hooks:install)');
  if (log.enabled) console.log(`Logging events to ${log.dir} (turn off with AGENTVILLE_LOG=0)`);
  log.write({ event: 'ServiceStart', version: 2, port: PORT, maps: mapIds });
  if (process.argv.includes('--open')) exec(`${process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'} ${url}`);
});
