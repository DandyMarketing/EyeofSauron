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
  findColumns, historicalOffsets, columnValues, updateValues, detailUpdateHtml,
  type BoardColumns, type SendItem, type BoardItem, type ItemUpdate, type MondayUser, type TemplateStep, type PreviewItem,
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
  /** What is already in each group, in board order: names, the items, and the last one. */
  groupItems: Map<string, { names: string[]; lastId: string | null; items: BoardItem[] }>;
  /**
   * The board's sub-item board and its columns, found by title like the
   * parent's. Null when the board has no sub-items: the planner's tasks then
   * go in as items, as before.
   */
  subBoardId: string | null;
  subColumns: BoardColumns | null;
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

  // Sub-items live on a board of their own, with their own column ids.
  let subBoardId: string | null = null;
  let subColumns: BoardColumns | null = null;
  const subCol = (b.columns ?? []).find((c: any) => c.type === 'subtasks');
  try { subBoardId = subCol ? String(JSON.parse(subCol.settings_str ?? '{}')?.boardIds?.[0] ?? '') || null : null; } catch { subBoardId = null; }
  if (subBoardId) {
    const sb = await gql<{ boards: Array<{ columns: Array<{ id: string; title: string; type: string; settings_str: string | null }> }> }>(
      'query ($id: [ID!]) { boards(ids: $id) { columns { id title type settings_str } } }', { id: [subBoardId] },
    );
    subColumns = findColumns((sb.boards?.[0]?.columns ?? []).map(c => {
      let settings: any = null;
      try { settings = JSON.parse(c.settings_str ?? 'null'); } catch { /* none */ }
      return { id: c.id, title: c.title, type: c.type, settings };
    }));
  }
  const templateGroup = groups.find((g: { title: string }) => /^event template$/i.test(g.title.trim()))?.id ?? null;

  // Every item, for the template and the history. A board is a few hundred
  // items; the page size is 500 and the cursor is followed regardless.
  const colIds = [columns.owner, columns.assigned, columns.deadline, columns.status].filter(Boolean) as string[];
  const subIds = subColumns ? [subColumns.owner, subColumns.assigned, subColumns.deadline, subColumns.status].filter(Boolean) as string[] : [];
  type Raw = { id: string; name: string; values: Record<string, string | null>; text: Record<string, string | null> };
  const items: Array<Raw & { group: string; subitems: Raw[] }> = [];
  const raw = (it: any): Raw => {
    const values: Record<string, string | null> = {};
    const text: Record<string, string | null> = {};
    for (const cv of it.column_values ?? []) { values[cv.id] = cv.value; text[cv.id] = cv.text; }
    return { id: String(it.id), name: it.name, values, text };
  };
  const fields = `id name group { id } column_values(ids: $cols) { id text value }${subColumns ? ' subitems { id name column_values(ids: $subs) { id text value } }' : ''}`;
  let cursor: string | null = null;
  for (let page = 0; page < 20; page++) {
    const subVar = subColumns ? ', $subs: [String!]' : '';
    const q: { boards?: Array<{ items_page: any }>; next_items_page?: any } = cursor
      ? await gql(`query ($c: String!, $cols: [String!]${subVar}) { next_items_page(limit: 500, cursor: $c) { cursor items { ${fields} } } }`, { c: cursor, cols: colIds, ...(subColumns ? { subs: subIds } : {}) })
      : await gql(`query ($id: [ID!], $cols: [String!]${subVar}) { boards(ids: $id) { items_page(limit: 500) { cursor items { ${fields} } } } }`, { id: [boardId], cols: colIds, ...(subColumns ? { subs: subIds } : {}) });
    const pageData: any = cursor ? q.next_items_page : q.boards?.[0]?.items_page;
    for (const it of pageData?.items ?? []) {
      items.push({ ...raw(it), group: String(it.group?.id ?? ''), subitems: (it.subitems ?? []).map(raw) });
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

  const asBoardItem = (it: Raw, cols: BoardColumns): BoardItem => ({
    id: it.id, name: it.name,
    deadline: cols.deadline ? ((it.text[cols.deadline] ?? '').slice(0, 10) || null) : null,
    owner_ids: cols.owner ? people(it.values[cols.owner]) : [],
    assigned_ids: cols.assigned ? people(it.values[cols.assigned]) : [],
    status: cols.status ? (it.text[cols.status] || null) : null,
  });
  const groupItems = new Map<string, { names: string[]; lastId: string | null; items: BoardItem[] }>();
  for (const it of items) {
    const g = groupItems.get(it.group) ?? { names: [], lastId: null, items: [] };
    g.names.push(it.name); g.lastId = it.id;
    g.items.push({ ...asBoardItem(it, columns), subitems: subColumns ? it.subitems.map(x => asBoardItem(x, subColumns!)) : [] });
    groupItems.set(it.group, g);
  }

  return {
    groupItems, subBoardId, subColumns,
    id: String(b.id), name: b.name, workspace_id: String(b.workspace_id),
    columns, groups, template, templateGroup, history,
    subscribers: (b.subscribers ?? []).map((s: any) => String(s.id)),
    permissions: String(b.permissions ?? ''),
  };
}

/**
 * The account's people -- members AND guests -- and who the key writes as.
 * Guests were left out until 13 Oct 2026, and most of the venue team are
 * guests (Corbin, Marcus, Byron, Lovely...), so "Corbin" matched nobody.
 */
export async function readPeople(): Promise<{ users: MondayUser[]; me: MondayUser; account: string | null }> {
  const d = await gql<{ users: Array<{ id: string; name: string; email: string | null }>; me: { id: string; name: string; email: string | null; account?: { slug: string } } }>(
    'query { users(limit: 1000, kind: all) { id name email } me { id name email account { slug } } }',
  );
  return {
    users: (d.users ?? []).map(u => ({ id: String(u.id), name: u.name, email: u.email ?? null })),
    me: { id: String(d.me.id), name: d.me.name, email: d.me.email ?? null },
    account: d.me.account?.slug ?? null,
  };
}

/**
 * Names of people no longer active on Monday. They are not in the normal user
 * list, so a template step that still carries one can only say "a person"
 * unless they are looked up here. Best effort: a failure names nobody.
 */
export async function readInactiveNames(ids: number[]): Promise<Map<number, string>> {
  if (ids.length === 0) return new Map();
  try {
    const d = await gql<{ users: Array<{ id: string; name: string }> }>(
      'query ($ids: [ID!]) { users(ids: $ids, non_active: true) { id name } }', { ids },
    );
    return new Map((d.users ?? []).map(u => [Number(u.id), u.name]));
  } catch {
    return new Map();
  }
}

/**
 * Create the group and its items, in order -- or FINISH a group already there.
 *
 * Items are created one after another, each placed after the last, because
 * the checklist's order is part of it and Monday's default placement is not a
 * promise. `existing` is a group with this name already on the board: items
 * whose names are already in it are skipped and the rest are added after its
 * last item, so sending again completes a half-made group instead of
 * duplicating it (13 Oct 2026: 7 of 39 made, then stopped).
 *
 * A person Monday will not accept -- a deactivated account on the board's own
 * template ("unable to assign person") -- costs that item its people, not the
 * whole send: the item is made without them and the note says so. Any other
 * failure STOPS and says how far it got, leaving what was made rather than
 * deleting from somebody's board.
 *
 * `item_ids` lines up with `items`: null for an item skipped or not reached.
 */
export async function createGroupWithItems(
  board: BoardForPlan, title: string,
  items: SendItem[],
  existing?: { groupId: string; names: string[]; lastId: string | null; items?: BoardItem[] },
  /** Names for the people tagged in a sub-item's detail update. */
  nameOf: (id: number) => string = id => `#${id}`,
): Promise<{ group_id: string; created: number; skipped: number; item_ids: Array<string | null>; notes: string[]; error?: string }> {
  let groupId: string;
  let previous: string | null = null;
  if (existing) {
    groupId = existing.groupId;
    previous = existing.lastId;
  } else {
    const anchor = board.groups.find(g => /active tasks/i.test(g.title));
    const g = await gql<{ create_group: { id: string } }>(
      anchor
        ? 'mutation ($b: ID!, $n: String!, $r: String!) { create_group(board_id: $b, group_name: $n, relative_to: $r, position_relative_method: before_at) { id } }'
        : 'mutation ($b: ID!, $n: String!) { create_group(board_id: $b, group_name: $n) { id } }',
      anchor ? { b: board.id, n: title, r: anchor.id } : { b: board.id, n: title },
    );
    groupId = String(g.create_group.id);
  }

  const key = (n: string) => n.trim().toLowerCase();
  const already = new Set((existing?.names ?? []).map(key));
  const itemIds: Array<string | null> = items.map(() => null);
  const notes: string[] = [];
  let created = 0;
  let skipped = 0;

  // Parents by name: what is in the group already, then what this run makes.
  const parentId = new Map<string, string>();
  const subNames = new Map<string, Set<string>>();
  for (const it of existing?.items ?? []) {
    parentId.set(key(it.name), it.id);
    subNames.set(it.id, new Set((it.subitems ?? []).map(x => key(x.name))));
  }

  const peopleRefused = (e: any) => /assign person|person with id/i.test(String(e?.message ?? e));
  const make = (item: typeof items[number], withPeople: boolean) => {
    const vals = columnValues(withPeople ? item : { ...item, owner_ids: [], assigned_ids: [] }, board.columns);
    const vars: Record<string, unknown> = { b: board.id, g: groupId, n: item.name, v: JSON.stringify(vals) };
    return previous
      ? gql<{ create_item: { id: string } }>('mutation ($b: ID!, $g: String!, $n: String!, $v: JSON, $p: ID!) { create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v, position_relative_method: after_at, relative_to: $p) { id } }', { ...vars, p: previous })
      : gql<{ create_item: { id: string } }>('mutation ($b: ID!, $g: String!, $n: String!, $v: JSON) { create_item(board_id: $b, group_id: $g, item_name: $n, column_values: $v) { id } }', vars);
  };
  const makeSub = (item: typeof items[number], parent: string, withPeople: boolean) => {
    const vals = columnValues(withPeople ? item : { ...item, owner_ids: [], assigned_ids: [] }, board.subColumns!);
    return gql<{ create_subitem: { id: string } }>(
      'mutation ($p: ID!, $n: String!, $v: JSON) { create_subitem(parent_item_id: $p, item_name: $n, column_values: $v) { id } }',
      { p: parent, n: item.name, v: JSON.stringify(vals) },
    );
  };

  // Top-level items first, in order, so every parent exists before its sub-items.
  const isSub = (it: typeof items[number]) => !!(it.parent && board.subBoardId && board.subColumns);
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (isSub(item)) continue;
    if (already.has(key(item.name))) { skipped++; continue; }
    try {
      let r: { create_item: { id: string } };
      try {
        r = await make(item, true);
      } catch (e: any) {
        if (!peopleRefused(e)) throw e;
        r = await make(item, false);
        notes.push(`"${item.name}" was added without its people: Monday refused one of them (often an account no longer active). Assign it on the board.`);
      }
      previous = String(r.create_item.id);
      itemIds[i] = previous;
      parentId.set(key(item.name), previous);
      created++;
    } catch (e: any) {
      return { group_id: groupId, created, skipped, item_ids: itemIds, notes, error: `Stopped at "${item.name}": ${e?.message ?? e}` };
    }
  }

  // Then the planner's tasks, each under its parent.
  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!isSub(item)) continue;
    const pid = parentId.get(key(item.parent!));
    if (!pid) {
      notes.push(`"${item.name}" was not added: its parent "${item.parent}" is not in the group.`);
      continue;
    }
    const under = subNames.get(pid) ?? new Set<string>();
    // Its own name, or the long name an earlier send used before names were shortened.
    if ([item.name, ...(item.aliases ?? [])].some(n => under.has(key(n)))) { skipped++; continue; }
    try {
      let r: { create_subitem: { id: string } };
      try {
        r = await makeSub(item, pid, true);
      } catch (e: any) {
        if (!peopleRefused(e)) throw e;
        r = await makeSub(item, pid, false);
        notes.push(`"${item.name}" was added without its people: Monday refused one of them. Assign it on the board.`);
      }
      // Not added to `under`: that holds what was there BEFORE this send, so
      // two tasks with the same name (one per person, as the plan sometimes
      // writes them) are both made rather than the second skipped.
      itemIds[i] = String(r.create_subitem.id);
      created++;
      /**
       * The full task as an update, tagging everyone on the sub-item (Khai,
       * 13 Oct 2026). A failure here costs the note, never the sub-item.
       */
      if (item.detail) {
        const people = [...new Set([...item.owner_ids, ...item.assigned_ids])];
        try {
          await gql(
            'mutation ($i: ID!, $b: String!, $m: [UpdateMention]) { create_update(item_id: $i, body: $b, mentions_list: $m) { id } }',
            { i: itemIds[i], b: detailUpdateHtml(item.detail, item.deadline, people.map(nameOf)), m: people.map(id => ({ id: String(id), type: 'User' })) },
          );
        } catch (e: any) {
          notes.push(`"${item.name}" was made, but its detail note was not posted: ${e?.message ?? e}`);
        }
      }
    } catch (e: any) {
      return { group_id: groupId, created, skipped, item_ids: itemIds, notes, error: `Stopped at "${item.name}": ${e?.message ?? e}` };
    }
  }
  return { group_id: groupId, created, skipped, item_ids: itemIds, notes };
}

/**
 * Change items already on the board: only the ticked fields, one item at a
 * time. Same rule as creating: a person Monday refuses costs that item its
 * people (the date still goes), any other failure stops and says how far it
 * got. The status is never touched.
 */
export async function updateItems(
  board: BoardForPlan, updates: Array<ItemUpdate & { name?: string; sub?: boolean }>,
): Promise<{ updated: number; notes: string[]; error?: string }> {
  const notes: string[] = [];
  let updated = 0;
  // A sub-item is written on the sub-item board, with that board's columns.
  const write = (u: { sub?: boolean }, itemId: string, vals: Record<string, unknown>) => gql(
    'mutation ($b: ID!, $i: ID!, $v: JSON!) { change_multiple_column_values(board_id: $b, item_id: $i, column_values: $v) { id } }',
    { b: u.sub ? board.subBoardId : board.id, i: itemId, v: JSON.stringify(vals) },
  );
  for (const u of updates) {
    const cols = u.sub ? board.subColumns : board.columns;
    if (!cols || (u.sub && !board.subBoardId)) continue;
    const vals = updateValues(u, cols);
    if (!Object.keys(vals).length) continue;
    try {
      try {
        await write(u, u.item_id, vals);
      } catch (e: any) {
        if (!/assign person|person with id/i.test(String(e?.message ?? e)) || !u.deadline) throw e;
        await write(u, u.item_id, updateValues({ deadline: u.deadline }, cols));
        notes.push(`"${u.name ?? u.item_id}": the date was changed but not the people -- Monday refused one of them. Assign it on the board.`);
      }
      updated++;
    } catch (e: any) {
      return { updated, notes, error: `Stopped changing items at "${u.name ?? u.item_id}": ${e?.message ?? e}` };
    }
  }
  return { updated, notes };
}

/** The text of an item's recent updates, newest first, to avoid posting one twice. */
export async function itemUpdateTexts(itemId: string): Promise<string[]> {
  const d = await gql<{ items: Array<{ updates: Array<{ body: string | null; text_body: string | null }> }> }>(
    'query ($i: [ID!]) { items(ids: $i) { updates(limit: 25) { body text_body } } }',
    { i: [itemId] },
  );
  return (d.items?.[0]?.updates ?? []).map(u => u.text_body || u.body || '');
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
