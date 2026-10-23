// A session's to-do list from the tools that carry one: TodoWrite (Claude Code) and the Claude
// desktop app's update_plan (a whole list, or steps like "advance") and wrap_up (ticks it all off).
// Claude Code's newer task tools keep their list in files (see taskFiles in transcript.ts).
import type { TodoItem } from '../src/types';
import { todoStatus } from './transcript';

const MAX_ITEMS = 50;

/** The list after a tool call, or undefined if the call doesn't change it. */
export function applyTodos(prev: TodoItem[] | undefined, tool: string | undefined, input: Record<string, any> | undefined): TodoItem[] | undefined {
  const name = tool ?? '';
  const i = input ?? {};
  if (name === 'TodoWrite') return Array.isArray(i.todos) ? items(i.todos) : undefined;
  if (/__wrap_up$/.test(name)) return prev?.length ? prev.map((t) => ({ ...t, status: 'completed' as const })) : undefined;
  if (!/__update_plan$/.test(name)) return;
  if (Array.isArray(i.items)) return items(i.items);
  if (!prev?.length) return;
  // steps on the current list (1-based): advance = finish the step in progress and start the next pending one
  const list = prev.map((t) => ({ ...t }));
  if (i.advance === true) {
    const cur = list.findIndex((t) => t.status === 'in_progress');
    if (cur >= 0) list[cur].status = 'completed';
    const next = list.findIndex((t, k) => t.status === 'pending' && k > cur);
    if (next >= 0) list[next].status = 'in_progress';
  }
  for (const n of Array.isArray(i.done) ? i.done : []) if (list[n - 1]) list[n - 1].status = 'completed';
  if (typeof i.start === 'number' && list[i.start - 1]) {
    for (const t of list) if (t.status === 'in_progress') t.status = 'completed';
    list[i.start - 1].status = 'in_progress';
  }
  return list;
}

/** The step in progress, in its "doing" wording when there is one. */
export function currentTodo(list: TodoItem[] | undefined): string | undefined {
  const t = list?.find((x) => x.status === 'in_progress');
  return t ? (t.doing ?? t.text) : undefined;
}

function items(raw: any[]): TodoItem[] {
  const out: TodoItem[] = [];
  for (const x of raw.slice(0, MAX_ITEMS)) {
    if (!x || typeof x !== 'object') continue;
    const text = [x.content, x.subject, x.step, x.title, x.text, x.description].find((v) => typeof v === 'string' && v.trim());
    if (!text) continue;
    const item: TodoItem = { text: text.trim().slice(0, 120), status: todoStatus(x.status) };
    if (typeof x.activeForm === 'string' && x.activeForm.trim()) item.doing = x.activeForm.trim().slice(0, 120);
    out.push(item);
  }
  return out;
}
