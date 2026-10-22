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
  /** repo folder name (live mode) */
  project?: string;
  /** when the session (or subagent) appeared, ms since epoch */
  startedAt?: number;
  /** last Claude Code event for this session, ms since epoch */
  lastActive?: number;
  /** latest actions, newest first (at most 8) */
  recent?: { t: number; text: string }[];
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
