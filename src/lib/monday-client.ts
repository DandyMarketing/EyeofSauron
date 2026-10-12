/**
 * Reading and writing the activation boards for "Send to Monday".
 *
 * The board list is confined to ONE workspace -- TDC Marketing & PR, where
 * every venue's activation board lives (Khai, 12 Oct 2026: "for planning this
 * should be in tdc marketing and PR"). Sauron's Monday key can see more than
 * that, including boards of guest details; a planner choosing where twenty
 * tasks land has no business being offered those. The workspace is checked
 * again on every preview and send, not only when the list is drawn.
 *
 * Writes as whoever owns MONDAY_API_TOKEN. The preview says who that is and
 * whether they are a member of the board, so a refusal is known before a write
 * is attempted.
 */

import {
  findColumns, historicalOffsets, columnValues,
  type BoardColumns, type MondayUser, type TemplateStep, type PreviewItem,
} from './monday-plan.js';

const MONDAY_API = 'https://api.monday.com/v2';

export const PLANNING_WORKSPACE_ID = process.env.MONDAY_PLANNING_WORKSPACE_ID || '5127390';

async function gql<T>(query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const token = process.env.MONDAY_API_TOKEN;
  if (!token) throw new Error('MONDAY_API_TOKEN is not set');
  const res = await fetch(MONDAY_API, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: token, 'API-Version': '2024-10' },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Monday.com ${res.status}: ${(await res.text()).slice(0, 300)}`);
  const json = await res.json() as { data?: T; errors?: Array<{ message: string }>; error_message?: string };
  if (json.errors?.length) throw new Error(`Monday.com: ${json.errors.map(e => e.message).join('; ')}`);
  if (json.error_message) throw new Error(`Monday.com: ${json.error_message}`);
  return json.data as T;
}

export interface PlanningBoard { id: string; name: string; folder: string | null }

/**
 * Every real board in the planning workspace. "Subitems of ..." boards,
 * documents and custom objects are Monday's internals, not places a person
 * puts tasks.
 */
export async function listPlanningBoards(): Promise<PlanningBoard[]> {
  const boards: PlanningBoard[] = [];
  let folders = new Map<string, string>();
  for (let page = 1; page <= 10; page++) {
    const d = await gql<{ boards: Array<{ id: string; name: string; type: string; board_folder_id: string | null }>; folders?: Array<{ id: string; name: string }> }>(
      `query ($ws: [ID!], $page: Int!) {
        boards(workspace_ids: $ws, state: active, limit: 100, page: $page) { id name type board_folder_id }
        ${page === 1 ? 'folders(workspace_ids: $ws) { id name }' : ''}
      }`,
      { ws: [PLANNING_WORKSPACE_ID], page },
    );
    if (d.folders) folders = new Map(d.folders.map(f => [String(f.id), f.name]));
    for (const b of d.boards ?? []) {
      if (b.type !== 'board') continue;
      boards.push({ id: String(b.id), name: b.name, folder: b.board_folder_id ? folders.get(String(b.board_folder_id)) ?? null : null });
    }
    if ((d.boards ?? []).length < 100) break;
  }
  return boards.sort((a, b) => a.name.localeCompare(b.name));
}

export interface BoardForPlan {
  id: string;
  name: string;
  workspace_id: string;
  columns: BoardColumns;
  groups: Array<{ id: string; title: string }>;
  template: TemplateStep[];
  templateGroup: string | null;
  history: Map<string, { days_before: number; n: number }>;
  subscribers: string[];
  permissions: string;
}

const people = (value: string | null): number[] => {
  try { return (JSON.parse(value ?? 'null')?.personsAndTeams ?? []).filter((p: any) => p.kind === 'person').map((p: any) => Number(p.id)); }
  catch { return []; }
};

/**
 * One board: its columns, groups, the Event Template's steps with their
 * standing owners, and the deadlines of past events for the planner's
 * reference. All of it in board order, which is the template's order.
 */
export async function readBoardForPlan(boardId: string): Promise<BoardForPlan> {
  const head = await gql<{ boards: Array<any> }>(
    `query ($id: [ID!]) { boards(ids: $id) {
      id name workspace_id permissions
      subscribers { id }
      columns { id title type settings_str }
      groups { id title }
    } }`,
    { id: [boardId] },
  );
  const b = head.boards?.[0];
  if (!b) throw new Error('That board was not found, or Sauron\'s Monday account cannot see it.');
  // Checked BEFORE a single item is read: a board outside the planning
  // workspace (guest details among them) is refused unopened.
  if (String(b.workspace_id) !== PLANNING_WORKSPACE_ID) {
    throw new Error(`"${b.name}" is outside TDC Marketing & PR, so Sauron will not send to it.`);
  }
  const columns = findColumns((b.columns ?? []).map((c: any) => {
    let settings: any = null;
    try { settings = JSON.parse(c.settings_str ?? 'null'); } catch { /* none */ }
    return { id: c.id, title: c.title, type: c.type, settings };
  }));
  const groups = (b.groups ?? []).map((g: any) => ({ id: String(g.id), title: String(g.title) }));
  const templateGroup = groups.find((g: { title: string }) => /^event template$/i.test(g.title.trim()))?.id ?? null;

  // Every item, for the template and the history. A board is a few hundred
  // items; the page size is 500 and the cursor is followed regardless.
  const colIds = [columns.owner, columns.assigned, columns.deadline].filter(Boolean) as string[];
  const items: Array<{ name: string; group: string; values: Record<string, string | null>; text: Record<string, string | null> }> = [];
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const q: { boards?: Array<{ items_page: any }>; next_items_page?: any } = cursor
      ? await gql(`query ($c: String!, $cols: [String!]) { next_items_page(limit: 500, cursor: $c) { cursor items { name group { id } column_values(ids: $cols) { id text value } } } }`, { c: cursor, cols: colIds })
      : await gql(`query ($id: [ID!], $cols: [String!]) { boards(ids: $id) { items_page(limit: 500) { cursor items { name group { id } column_values(ids: $cols) { id text value } } } } }`, { id: [boardId], cols: colIds });
    const pageData: any = cursor ? q.next_items_page : q.boards?.[0]?.items_page;
    for (const it of pageData?.items ?? []) {
      const values: Record<string, string | null> = {};
      const text: Record<string, string | null> = {};
      for (const cv of it.column_values ?? []) { values[cv.id] = cv.value; text[cv.id] = cv.text; }
      items.push({ name: it.name, group: String(it.group?.id ?? ''), values, text });
    }
    cursor = pageData?.cursor ?? null;
    if (!cursor) break;
  }

  const template: TemplateStep[] = templateGroup
    ? items.filter(i => i.group === templateGroup).map(i => ({
        name: i.name,
        owner_ids: columns.owner ? people(i.values[columns.owner]) : [],
        assigned_ids: columns.assigned ? people(i.values[columns.assigned]) : [],
      }))
    : [];

  const titleOf = new Map<string, string>(groups.map((g: { id: string; title: string }) => [g.id, g.title]));
  const history = historicalOffsets(items.map(i => ({
    group_title: titleOf.get(i.group) ?? '',
    name: i.name,
    // A date with a time reads "2026-10-14 09:00"; the day is the first ten.
    deadline: columns.deadline ? ((i.text[columns.deadline] ?? '').slice(0, 10) || null) : null,
  })));

  return {
    id: String(b.id), name: b.name, workspace_id: String(b.workspace_id),
    columns, groups, template, templateGroup, history,
    subscribers: (b.subscribers ?? []).map((s: any) => String(s.id)),
    permissions: String(b.permissions ?? ''),
  };
}

/** The account's people, and who the key writes as. Guests are left out. */
export async function readPeople(): Promise<{ users: MondayUser[]; me: MondayUser; account: string | null }> {
  const d = await gql<{ users: Array<{ id: string; name: string; email: string | null }>; me: { id: string; name: string; email: string | null; account?: { slug: string } } }>(
    'query { users(limit: 1000, kind: non_guests) { id name email } me { id name email account { slug } } }',
  );
  return {
    users: (d.users ?? []).map(u => ({ id: String(u.id), name: u.name, email: u.email ?? null })),
    me: { id: String(d.me.id), name: d.me.name, email: d.me.email ?? null },
    account: d.me.account?.slug ?? null,
  };
}

/**
 * Create the group and its items, in order.
 *
 * Items are created one after another, each placed after the last, because
 * the checklist's order is part of it and Monday's default placement is not a
 * promise. A failure part-way STOPS and says how far it got: the group and the
 * items already made are left for a person to see rather than deleted, because
 * deleting things on somebody else's board is a worse failure than an
 * incomplete list.
 */
export async function createGroupWithItems(
  board: BoardForPlan, title: string, items: Array<Pick<PreviewItem, 'name' | 'deadline' | 'owner_ids' | 'assigned_ids'>>,
): Promise<{ group_id: string; created: number; item_ids: string[]; error?: string }> {
  const anchor = board.groups.find(g => /active tasks/i.test(g.title));
  const g = await gql<{ create_group: { id: string } }>(
    anchor
      ? 'mutation ($b: ID!, $n: String!, $r: String!) { create_group(board_id: $b, group_name: $n, relative_to: $r, position_relative_method: before_at) { id } }'
      : 'mutation ($b: ID!, $n: String!) { create_group(board_id: $b, group_name: $n) { id } }',
    anchor ? { b: board.id, n: title, r: anchor.id } : { b: board.id, n: title },
  );
  const groupId = String(g.create_group.id);

  let previous: string | null = null;
  let created = 0;
  const itemIds: string[] = [];
  for (const item of items) {
    try {
      const vars: Record<string, unknown> = {
        b: board.id, g: groupId, n: item.name,
        v: JSON.stringify(columnValues(item, board.columns)),
      };
      const r: { create_item: { id: string } } = previous
        ? await gql('mutation ($b: ID!, $g: String!, $n: String!, $v: JSON, $p: ID!) { create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v, position_relative_method: after_at, relative_to: $p) { id } }', { ...vars, p: previous })
        : await gql('mutation ($b: ID!, $g: String!, $n: String!, $v: JSON) { create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v) { id } }', vars);
      previous = String(r.create_item.id);
      itemIds.push(previous);
      created++;
    } catch (e: any) {
      return { group_id: groupId, created, item_ids: itemIds, error: `Stopped at "${item.name}": ${e?.message ?? e}` };
    }
  }
  return { group_id: groupId, created, item_ids: itemIds };
}

/**
 * An update on an item, with a file attached to it. The activation boards
 * have no Files column, so an update is where a file can go -- and the
 * update's text means the content can be read without opening the file.
 *
 * Files go to Monday's separate /v2/file endpoint as multipart, the file under
 * `variables[file]` (Monday's documented form). The update is written first;
 * if the file then fails, the update stays and the error says so.
 */
export async function postUpdateWithFile(
  itemId: string, html: string, file: { name: string; type: string; data: Buffer | ArrayBuffer } | null,
): Promise<void> {
  const u = await gql<{ create_update: { id: string } }>(
    'mutation ($i: ID!, $b: String!) { create_update(item_id: $i, body: $b) { id } }',
    { i: itemId, b: html },
  );
  if (!file) return;
  const token = process.env.MONDAY_API_TOKEN!;
  const form = new FormData();
  form.append('query', `mutation ($file: File!) { add_file_to_update(update_id: ${Number(u.create_update.id)}, file: $file) { id } }`);
  form.append('variables[file]', new Blob([file.data as any], { type: file.type }), file.name);
  const res = await fetch(`${MONDAY_API}/file`, { method: 'POST', headers: { Authorization: token, 'API-Version': '2024-10' }, body: form });
  const json = await res.json().catch(() => ({})) as { errors?: Array<{ message: string }>; error_message?: string; data?: unknown };
  if (!res.ok || json.errors?.length || json.error_message) {
    throw new Error(`the update was posted but the file was not: ${json.errors?.[0]?.message ?? json.error_message ?? res.status}`);
  }
}
