# Agentville app

Your Claude Code sessions as robots in Frostpeak.

## First time

Needs Node.js 18 or newer (`node -v` to check; install from nodejs.org if missing).

```bash
cd app
npm install
npm run hooks:install     # connects Claude Code to Agentville (once)
```

`hooks:install` adds small hooks to `~/.claude/settings.json` (a backup is saved next to it first). They cover every Claude Code session on this Mac: terminal, VS Code and the desktop app. Each hook just sends the event to Agentville on your machine. It never blocks or slows Claude, and does nothing if Agentville isn't running.

After updating Agentville, run `npm run hooks:install` again to get any new hooks. It replaces Agentville's entries (backup first) and leaves your other hooks alone.

## Every day

```bash
cd app
npm start                 # builds and opens http://localhost:4917
```

Then use Claude Code as usual. Each session appears as a robot. Sessions that were already open when you installed the hooks show up on their next action, with no restart.

| Command | What it does |
|---|---|
| `npm start` | Build the app and run Agentville (opens the browser) |
| `npm run simulate` | Send fake Claude Code events, to see it working without Claude |
| `npm run hooks:status` | Show whether the hooks are installed |
| `npm run hooks:uninstall` | Remove the hooks from Claude Code (backup saved first) |
| `npm run dev` + `npm run serve` | Development: live-reloading UI (port 5173) plus the service (port 4917) |

Open `http://localhost:4917/?demo` (or the app without the service running) for demo mode with simulated agents.

## How it maps Claude Code to the town

| Claude Code | Agentville |
|---|---|
| Session starts | A robot in a new color appears at the train station |
| Reads/edits a file | Walks to the building for that file's top-level folder (labels show the folder) |
| Quick look-ups in other folders | Only move the robot if it has been in place 12+ seconds (no running back and forth) |
| Work that touches no project file (shell commands not run inside a project subfolder, browser and terminal tools, web fetch/search, other MCP tools) | Walks to the commands building ("commands & tools"), but only if it has been in place 12+ seconds; from the plaza it goes right away |
| Planning and other bookkeeping tools (TodoWrite, update_plan, the Claude desktop app's own `mcp__ccd_*` tools, ToolSearch, Skill, AskUserQuestion, EnterPlanMode/ExitPlanMode, Agent/Task and other Task* tools, SendMessage, ListAgents) | The robot doesn't move |
| New prompt while at the plaza | Walks back to the last building it worked at, or to the commands building if it has none |
| Working | Types, antenna blinks, green glow. Bubble shows Claude's to-do step, command description, or a friendly phrase |
| Failed tool call / tool not allowed | Shown in its recent history as "Failed: …" (naming the step from before any permission wait) or "Not allowed: …" |
| Permission prompt / waiting for your reply | Faces you and waves, orange bubble and glow, "needs you" in the header, plus a notification (shown by the page; macOS fallback) and a sound (see below) |
| Subagent (Agent/Task) | A smaller helper robot in the parent's color, named like "Atlas·2", that works on its own (see below) |
| Stop | Walks to the plaza and waits by the tree until the next prompt |
| Session ends (or 30 min silence) | Walks back to the station and leaves |

Buildings only get a label once a folder lives there, and the label is the folder name (the town's own names like Church or Hot springs mean nothing for code, so they're not shown). Files at the repo root go to the Grand lodge, labelled "root files". The Weather station is the commands building, labelled "commands & tools", so 10 buildings are left for folders. The busiest top-level folders, counted from the last 500 git commits, get the most prominent buildings (the order of `buildings` in `town.json`), and keep them even before they're used. Other folders take the next free building. Once all are taken, the rest share the Timber workshop. Outside a git repo, folders fill buildings in the order they're first used.

### Helper robots

Each subagent gets its own helper robot: smaller, in the parent's color, named like "Atlas·2". Its bubble and title are the Agent/Task call's description. It appears when the subagent starts (SubagentStart or its first tool event). It moves with its own tool calls, by the same rules as a session robot, and can need you. The parent robot is never moved by a subagent's work. A helper stays after the parent's Stop, because background subagents keep working. It leaves when the subagent stops, when the parent session ends, or after 10 quiet minutes (not while it's waiting for you). SubagentStart is a new hook, so run `npm run hooks:install` again after updating.

### Override: `agentville.json`

Put an `agentville.json` at the repo root to pin folders to buildings or rename buildings. Use building ids or names from `town.json`:

```json
{
  "folders": { "server": "church", "docs": "Log cabin library", "scripts": "timber-workshop" },
  "names": { "church": "Backend", "observatory": "Frontend" }
}
```

A name from `names` is shown before the building's folders. Pinned buildings are taken out of the automatic order. Changes apply on the next event, with no restart. Unknown buildings and invalid JSON are reported in the terminal and ignored.

## Event log

Every Claude Code event and what Agentville did with it is written to `Agentville/logs/events-YYYY-MM-DD.jsonl` (one line per event; file contents and tool output are left out, long text is cut). Logs are kept 7 days and are git-ignored. Turn logging off with `AGENTVILLE_LOG=0 npm start`.

## Getting around the town

Zoom with the mouse wheel or a trackpad pinch (it zooms toward the pointer), drag to pan, or use the **+ / − / ⤢** buttons in the corner of the town (keys: `+`, `-`, `0` for the whole town). Building labels turn green while robots work there and orange, with ripples, when a robot there needs you.

## Robot details

Click a robot in the town or its card in the sidebar to open its details at the top of the sidebar: project, building (with its folders), what it's doing or waiting for, its helpers or parent, when it started, when it was last active, and its last 8 actions (new requests, task changes, needs-you, failed or not-allowed tool calls, finished). The project comes from the folder the session started in. The selected robot keeps a white ring. Click it again, press ✕ or Esc to close. Click a helper's or parent's name to jump to it.

## Needs-you alerts

When a robot starts waiting for you, you get a notification ("Atlas needs you", with what it wants, the project and the session title) and the Glass sound. You get at most one alert per robot every 15 seconds (helpers count separately).

- **Notification:** the Agentville page shows it, using your browser's notification permission. Click **Allow notifications** in the header once (it appears until the browser has an answer). The page must stay open in a tab, but it can be in the background. Clicking the notification brings the page forward and highlights the robot.
- **No page allowed to notify:** the service falls back to a macOS notification through AppleScript. macOS credits it to the app that started the service (Terminal, iTerm, Claude…) and silently drops it if that app can't send notifications, so the page is the reliable route.
- **Sound:** played by the service on macOS, so it works with no page open.
- Turn alerts off or on with the **Alerts** button in the header. The setting applies to every open page and lasts until the service restarts. To start with alerts off, run `AGENTVILLE_ALERTS=0 npm start`.
- The Claude desktop app may also notify you about the same prompt. If you get two, turn one of them off.

## Privacy

Everything stays on your Mac. The service only listens on `127.0.0.1` and keeps robot state in memory. It refuses web pages from other sites (any browser `Origin` that isn't localhost), so a website you have open can't read your sessions or send fake events. The only thing written to disk is the event log above, which includes your prompts, file paths and commands. Turn it off if you'd rather not keep it.

## Code

| Path | Role |
|---|---|
| `server/index.ts` | Local service: `POST /events` from hooks, WebSocket `/ws` to the UI, serves the built app |
| `server/state.ts` | Hook events → robot states (sessions, helpers, buildings, needs-you) |
| `server/log.ts` | Event log (`logs/`) |
| `server/notify.ts` | Needs-you alerts: macOS notification + sound |
| `server/friendly.ts` | Friendly bubble text from tool calls |
| `server/hooks.ts` | Install/uninstall the hooks in `~/.claude/settings.json` |
| `server/simulate.ts` | Fake events for testing |
| `src/live.ts` | UI side of the WebSocket (auto-reconnects) |
| `src/world.ts` | PixiJS scene: background, glows, labels, bubbles (stacked, clicked one on top), robots |
| `src/robot.ts` | One robot: walking, turning, animation, bubble, name tag |
| `src/demo.ts` | Demo mode simulator |
| `public/towns/frostpeak/` | Town image + `town.json` |
| `public/sprites/robot/` | Robot sprite sheets |
