# Agentville

Your Claude Code sessions as little robots in a cozy town. Each robot walks to the building for the folder it's working in, shows what it's doing in a speech bubble, and waves (with a notification) when it needs you. Everything runs on your computer: macOS or Windows.

## First time

Needs Node.js 22 or newer (`node -v` to check; install from nodejs.org if missing). Works on macOS and Windows; the commands below are the same on both (in Windows, use PowerShell or Command Prompt).

```bash
git clone https://github.com/Hussein-Abdallah/Agentville.git
cd Agentville
npm install
npm run hooks:install     # connects Claude Code to Agentville (once)
```

`hooks:install` adds small hooks to `~/.claude/settings.json` (a backup is saved next to it first). They cover every Claude Code session on this computer: terminal, VS Code and the desktop app. Each hook just sends the event to Agentville on your machine: on macOS a `curl` line, on Windows a small Node script (`server/hook.mjs`) that Claude Code runs directly, so it works whether your hooks run in Git Bash or PowerShell. It never blocks or slows Claude, and does nothing if Agentville isn't running.

After updating Agentville, run `npm run hooks:install` again to get any new hooks. It replaces Agentville's entries (backup first) and leaves your other hooks alone.

### On Windows

Everything works the same, with a few differences:

- **Hooks:** `npm run hooks:install` writes hooks that run `node server/hook.mjs` directly (no shell), so they work whether Claude Code runs hooks in Git Bash or PowerShell. Keep the Agentville folder where it is, or run `hooks:install` again after moving it.
- **Go to session:** brings forward the window of the app the session runs in (VS Code, Cursor, Windows Terminal, the Claude app, JetBrains IDEs), picking the one whose title has the session's folder. It can't pick a terminal tab the way it does on macOS.
- **Alerts:** the fallback notification is a Windows toast, and the sound is Windows' own.

## Every day

In the Agentville folder:

```bash
npm start                 # builds and opens http://localhost:4917
```

Then use Claude Code as usual. Each session appears as a robot. Sessions that were already open when you installed the hooks show up on their next action, with no restart.

| Command | What it does |
|---|---|
| `npm start` | Build the app and run Agentville (opens the browser) |
| `npm run simulate` | Send fake Claude Code events, to see it working without Claude |
| `npm test` | Run the tests (Node's test runner; no server, sound or notification needed) |
| `npm run typecheck` | Type-check the page, the service and the tests |
| `npm run hooks:status` | Check everything between Claude Code and the town: hooks, token, service, recent events |
| `npm run hooks:debug on [minutes]` / `off` | Log every hook event in full for a while (60 min by default) |
| `npm run hooks:uninstall` | Remove the hooks from Claude Code (backup saved first) |
| `npm run dev` + `npm run serve` | Development: live-reloading UI (port 5173) plus the service (port 4917) |

Open `http://localhost:4917/?demo` (or the app without the service running) for demo mode with simulated agents.

### Signing in a browser

The page only shows your real sessions to a browser that's signed in (otherwise you see the demo). The first time, click **Sign in this browser** on the page. Your Mac (or Windows) asks you in a dialog to allow it, with a 4-digit code: allow it only if the page shows the same code. That browser then stays signed in for a year. Each browser, and each Chrome profile, signs in once.

Without the dialog (or on Linux), run `npm run token -- link` and open the link it prints in that browser. The link holds Agentville's token, so keep it to yourself; `npm run token -- new` makes a new one, which signs every browser out.

### When robots don't show up

Run `npm run hooks:status`. It checks each link in order and says what to do about the first broken one:

1. the hooks are in `~/.claude/settings.json`, for every event, in this version;
2. the token files are in `~/.agentville`;
3. the service answers on port 4917 and accepts the token;
4. it has received events, and when the last one came.

If the hooks are fine but no events arrive, turn on `npm run hooks:debug on`, use Claude Code, and watch the service's output: each event prints a line, and the full event goes to `logs/hooks-debug-<date>.jsonl`. These logs can hold file contents and command output, so debugging turns itself off after an hour (or `npm run hooks:debug off`). They stay on your computer.

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
| Permission prompt / waiting for your reply | Faces you and waves, orange bubble and glow, "needs you" in the header, plus a notification (shown by the page; the system's as fallback) and a sound (see below) |
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

Add `"world": "Acme"` to put the repo in a world of your choice (see Worlds and towns below). A name from `names` is shown before the building's folders. Pinned buildings are taken out of the automatic order. Changes apply on the next event, with no restart. Unknown buildings and invalid JSON are reported in the terminal and ignored.

## Worlds and towns

Every repo is a **town** with its own folder → building layout, and towns are grouped into **worlds** (projects). The header has a town picker, grouped by world, with how many robots are in each town and how many need you. Pick a town to see it; your choice is remembered. On first open the page shows the town where a robot needs you, else the busiest one. Clicking "needs you" in the header jumps to that robot's town.

- **Three town maps:** Frostpeak (winter), Maplewood (autumn) and Azure Harbor (summer). Each repo gets a random map among those used least in its world (so a world's towns look different where they can); the pick is remembered in `~/.agentville/towns.json` so it keeps its look; edit that file, or put `"town": "maplewood"` (or `frostpeak`, `azure-harbor`) in the repo's `agentville.json`, to choose.
- **Three levels:** the header breadcrumb **Planet › world › town** opens each level; `M` goes up a level and `Esc` comes back down.
- **Planet:** every world (project) as a glowing settlement on a spinning globe, with its town and robot counts; it pulses orange when a robot there needs you. Drag to spin and tilt (up to either pole); zoom with the wheel, a pinch, the **+ / − / ⤢** buttons or `+`, `-`, `0`; click a world to open its world map. The planet picture is `public/planet/planet.jpg` (a flat 2:1 map that wraps around the globe), and `planet.json` lists its 34 clearings with their landscape (snow, tundra, autumn, forest, meadow, jungle, desert, canyon, savanna, volcanic, marsh, crystal, blossom, mushroom, reef, floating isles) plus which landscapes each town map prefers (`prefer`). A world settles on a free clearing that fits its first town's map, else any free one; past 34 worlds they share clearings, set a little apart. Your browser remembers each world's clearing per planet picture. A new town theme only needs an entry in `prefer`.
- **World map (board, the default):** one level up from a town (or `M`). Laid out by code, so a world can have any number of towns: each town is a round picture of its own town map (the first town bigger, in the middle), joined to its neighbours by a railway with no crossings and trains running on it. The ground is the world's patch of the planet, blurred. Drag to pan, zoom with the wheel, a pinch or the corner buttons. **Painted map** (bottom left) switches to the painted valley instead; your choice is remembered.
- **Painted valley:** the painted valley with the world's towns at their spots: the repo that got each map first in a world takes that town's spot; more repos appear as signposts along the railway. Each marker shows the repo name, a dot per robot (ringed in orange when it needs you) and a needs-you badge; spots no repo has yet are dimmed. Click a town to open it; tabs at the top switch worlds. A train runs on the painted railway. The demo (`?demo`) has made-up worlds of 1, 2, 4, 6, 12, 20 and 30 repos (Duo, Acme, Studio, Platform, Enterprise, Megacorp…) on all three maps, to see the board at every size.
- **Moving between towns:** when a session starts working in another repo, its robot goes to that town (edits there move it at once; reads and commands once it has stayed put 12 s). Files outside any repo never move it. Helpers move on their own.
- **Worlds, automatically:** Agentville finds your dev folder (the deepest folder holding every repo it knows, including repos you've used Claude Code in before) and each folder directly under it is a world: `~/Dev/Acme/api` and `~/Dev/Acme/clients/web` → world **Acme**, `~/Dev/Blog/site` → **Blog**. Two towns with the same name in a world get their parent folder added (`clients/web`).
- **Worlds, your way:** `~/.agentville/worlds.json` wins over everything, then a repo's `"world"` in `agentville.json`, then the automatic rule:

  ```json
  { "root": "~/Dev", "worlds": { "Acme": ["~/Dev/Acme/**", "~/work/acme-infra"] } }
  ```

  `root` pins the dev folder (useful when your repos are spread across folders). A pattern ending in `/**` matches every repo inside that folder; a plain path matches that repo. Changes apply on the next event.

## Event log

Every Claude Code event and what Agentville did with it is written to `logs/events-YYYY-MM-DD.jsonl` in the Agentville folder (one line per event; file contents and tool output are left out, long text is cut). Logs are kept 7 days and are git-ignored. Turn logging off with `AGENTVILLE_LOG=0 npm start`.

## Getting around the town

Zoom with the mouse wheel or a trackpad pinch (it zooms toward the pointer), drag to pan, or use the **+ / − / ⤢** buttons in the corner of the town (keys: `+`, `-`, `0` for the whole town). Building labels turn green while robots work there and orange, with ripples, when a robot there needs you.

## Robot details

Click a robot in the town or its card in the sidebar to open its details at the top of the sidebar: project, building (with its folders), what it's doing or waiting for, its helpers or parent, when it started, when it was last active, and its last 8 actions (new requests, task changes, needs-you, failed or not-allowed tool calls, finished). The project comes from the folder the session started in. The selected robot keeps a white ring. Click it again, press ✕ or Esc to close. Click a helper's or parent's name to jump to it.

## Needs-you alerts

When a robot starts waiting for you, you get a notification ("Atlas needs you", with what it wants, the project and the session title) and the Glass sound. You get at most one alert per robot every 15 seconds (helpers count separately).

- **Notification:** the Agentville page shows it, using your browser's notification permission. Click **Allow notifications** in the header once (it appears until the browser has an answer). The page must stay open in a tab, but it can be in the background. Clicking the notification brings the page forward and highlights the robot.
- **No page allowed to notify:** the service falls back to the system's notification. On macOS that's AppleScript: macOS credits it to the app that started the service (Terminal, iTerm, Claude…) and silently drops it if that app can't send notifications, so the page is the reliable route. On Windows it's a toast from PowerShell.
- **Sound:** played by the service (macOS's Glass, Windows' notification sound), so it works with no page open.
- Turn alerts off or on with the **Alerts** button in the header. The setting applies to every open page and lasts until the service restarts. To start with alerts off, run `AGENTVILLE_ALERTS=0 npm start`.
- The Claude desktop app may also notify you about the same prompt. If you get two, turn one of them off.

## Privacy

Everything stays on your computer. The service only listens on `127.0.0.1` and keeps robot state in memory. Pages need a sign-in (a cookie from the dialog above, or the link), and the hooks send a token from `~/.agentville`, so other programs and other user accounts can't read your sessions. It refuses web pages from other sites (any browser `Origin` that isn't localhost), so a website you have open can't read your sessions or send fake events. To group repos into worlds it reads, once at start, the first `cwd` line of the newest transcript in each `~/.claude/projects/` folder (nothing else from them). Written to disk: `~/.agentville/towns.json` (which town map each repo has), and the event log above, which includes your prompts, file paths and commands. Turn it off if you'd rather not keep it.

## Code

| Path | Role |
|---|---|
| `server/index.ts` | Local service: `POST /events` from hooks, WebSocket `/ws` to the UI, serves the built app |
| `server/state.ts` | Hook events → robot states (sessions, helpers, buildings, needs-you) |
| `server/log.ts` | Event log (`logs/`) |
| `server/worlds.ts` | Groups towns (repos) into worlds: automatic by folder, `~/.agentville/worlds.json` overrides |
| `server/townmaps.ts` | Which town map each repo gets (`~/.agentville/towns.json`) |
| `src/worldview.ts` | The world map: painted map, town spots, signposts, train |
| `src/planet.ts` | The planet: spinning globe, world settlements, placeholder planet |
| `src/boardview.ts` | The world board: town vignettes, railway network, trains, planet ground |
| `public/towns/<map>/` | Each town map: picture and `town.json` (buildings, doors, labels, roles, road paths) |
| `public/worlds/valley/` | The painted world map and its `world.json` (town spots, stations, railway) |
| `server/notify.ts` | Needs-you alerts: the system's notification + sound |
| `server/windows.ts` | Windows: bring a window forward (Go to session), the sound, a toast (PowerShell) |
| `server/hook.mjs` | The hook on Windows (`node hook.mjs`, no shell) |
| `server/open.ts` | Open a link in the default browser on each system |
| `server/friendly.ts` | Friendly bubble text from tool calls |
| `server/hooks.ts` | Install/uninstall the hooks in `~/.claude/settings.json` |
| `server/simulate.ts` | Fake events for testing |
| `test/` | Tests: buildings, sessions, helper robots, alerts, bubble text (`support.ts` has the shared setup) |
| `src/live.ts` | UI side of the WebSocket (auto-reconnects) |
| `src/world.ts` | PixiJS scene: background, glows, labels, bubbles (stacked, clicked one on top), robots |
| `src/robot.ts` | One robot: walking, turning, animation, bubble, name tag |
| `src/demo.ts` | Demo mode simulator |
| `public/towns/frostpeak/` | Town image + `town.json` |
| `public/sprites/robot/` | Robot sprite sheets |
