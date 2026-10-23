// Shared shapes. The live service (milestone 4) will produce the same AgentState objects the demo simulator does.

export type AgentStatus = 'idle' | 'working' | 'waiting';

export interface AgentState {
  id: string;
  name: string;
  /** one of the sprite colors in robot.json */
  color: string;
  /** building id in the town */
  building: string;
  status: AgentStatus;
  /** friendly text for the speech bubble */
  task?: string;
  /** session title (Claude desktop) or the first prompt */
  title?: string;
  /** set for subagents: the parent session id */
  parentId?: string;
  /** town (repo) name (live mode) */
  project?: string;
  /** town id: the repo root the robot is working in (live mode); its world comes with the towns list */
  town?: string;
  /** when the session (or subagent) appeared, ms since epoch */
  startedAt?: number;
  /** last Claude Code event for this session, ms since epoch */
  lastActive?: number;
  /** latest actions, newest first (at most 8) */
  recent?: { t: number; text: string }[];
  /** how full the session's context window is (from its transcript); helpers have none */
  context?: ContextInfo;
  /** the session's to-do list (TodoWrite, Claude desktop's plan, or Claude Code's task files) */
  todos?: TodoItem[];
  /** the app the session runs in ("Terminal", "VS Code", "Claude"…), when the hooks report it; Go to session opens it */
  app?: string;
}

export interface ContextInfo {
  /** tokens in the context after the latest reply (0 right after a compaction, until the next reply) */
  used: number;
  /** the model's context window */
  max: number;
  /** compacting the conversation right now */
  compacting?: boolean;
  /** when the conversation was last compacted, ms since epoch */
  compactedAt?: number;
  /** how many times it was compacted while Agentville watched */
  compactions?: number;
}

export interface TodoItem {
  text: string;
  status: 'pending' | 'in_progress' | 'completed';
  /** the in-progress wording ("Fixing the login form"), when the list gives one */
  doing?: string;
}

/** A town (one repo) as the service describes it to the page. */
export interface TownInfo {
  /** repo root path */
  id: string;
  /** display name: the repo folder (with its parent when two towns in a world share a name) */
  name: string;
  world: string;
  /** the town map it uses (frostpeak, maplewood…) */
  map: string;
  /** it holds its map's spot on the world map (else it's a signpost on the railway) */
  spot: boolean;
  /** the world's first town (the repo that got its map earliest): its landscape decides where the world sits on the planet */
  primary: boolean;
  /** the landscape of its town map (from town.json "land"), e.g. "snow" */
  land?: string;
  /** folder names per building */
  folders: Record<string, string[]>;
  /** buildings renamed in agentville.json */
  names: Record<string, string>;
}

export interface BuildingDef {
  name: string;
  /** where a robot stands when "inside" (image px) */
  door: [number, number];
  /** where the name label is drawn (image px) */
  label: [number, number];
  role?: 'station' | 'root' | 'misc' | 'plaza' | 'commands';
  /** standing spots (plaza): each robot claims one */
  spots?: [number, number][];
  /** robots standing here turn to face this point (plaza: the tree) */
  lookAt?: [number, number];
}

export interface TownData {
  id: string;
  name: string;
  season: string;
  image: string;
  size: [number, number];
  /** robot height in image px at the bottom of the map */
  robotHeight: number;
  /** walking speed in image px per second */
  walkSpeed: number;
  buildings: Record<string, BuildingDef>;
  /** precomputed road paths between doors, key "a|b" (a before b in building order) */
  paths: Record<string, [number, number][]>;
}

export interface RobotMeta {
  frame: { w: number; h: number };
  anchor: { x: number; y: number };
  directions: string[];
  animations: Record<string, { frames: number; fps: number }>;
  colors: Record<string, string>;
}
