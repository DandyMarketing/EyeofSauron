/**
 * The creative brief for the graphic designer: the key visual (KV).
 *
 * Khai, 23 Nov 2026: "for the plan feature you should also create a creative
 * brief for the graphic designer to do the KV design". Its sections are the
 * team's OWN request form -- the 2024 "Graphic Designer Requests" board in TDC
 * Marketing & PR asked for the concept, the USP/marketing angle, the event
 * date and time, the formats from a fixed list with their sizes, handles and
 * hashtags, print copies and a due date -- plus mood and references, the copy
 * and who approves, decided with Khai the same day.
 *
 * Written by its own forced-tool pass BESIDE the brief and the P&L, from the
 * same transcript, under the same rule: nothing that was not settled. What the
 * conversation left open is listed as open, never filled in -- the designer
 * needs to know what to ask as much as what to make.
 */

/**
 * The formats on the team's request form, with their sizes. "7R" on the board
 * is SevenRooms. The form listed the Instagram story as 1920 x 1080, which is
 * landscape; a story is portrait, so it is written 1080 x 1920 here.
 */
export const KV_FORMATS = [
  'IG Feed (1080 x 1080)',
  'IG Portrait (1080 x 1350)',
  'IG Story / Reel cover (1080 x 1920)',
  'EDM Header',
  'EDM Support (1080 x 1080)',
  'Poster (A3)',
  'GMB Post (1200 x 900)',
  'SevenRooms Offer Banner (1080 x 480)',
  'SevenRooms Widget (1080 x 1200)',
  'Website pop-up',
  'Printed menu',
  'Other',
] as const;

const BASIS = ['settled', 'proposal', 'to fill'] as const;
type Basis = typeof BASIS[number];

export interface KvBrief {
  event_name: string;
  venues: string;
  when: string;
  concept: string;
  key_message: string;
  usp_angle: string;
  audience: string;
  mood: string;
  references: string[];
  colours_and_finish: string;
  avoid: string;
  must_include: string[];
  handles_hashtags: string;
  copy_lines: Array<{ use: string; text: string; basis: Basis }>;
  formats: Array<{ format: string; size: string; use: string; quantity: number | null }>;
  print: Array<{ item: string; size: string; quantity: number | null; notes: string }>;
  deadlines: Array<{ what: string; date: string; basis: Basis }>;
  requested_by: string;
  approver: string;
  open_points: string[];
}

const str = { type: 'string' as const };
const basis = { type: 'string' as const, enum: [...BASIS], description: 'settled = agreed in the conversation; proposal = suggested and not yet agreed; to fill = not discussed.' };

/** The forced tool. Every field the conversation never settled is left empty and named in open_points. */
export function kvBriefTool() {
  return {
    name: 'record_kv_brief',
    description:
      'Write the creative brief the graphic designer works from to make the event key visual (KV). Use ONLY what the planning conversation settled or proposed. ' +
      'Never invent a price, date, partner, name or copy line that was not in the conversation: leave the field empty and say what is missing in open_points. ' +
      'Copy lines quote the conversation where it settled wording; otherwise they are marked proposal. Plain words, written for a designer who was not in the room.',
    input_schema: {
      type: 'object' as const,
      properties: {
        kv: {
          type: 'object' as const,
          properties: {
            event_name: str,
            venues: { type: 'string' as const, description: 'Our venue(s), and any rented or partner space by name.' },
            when: { type: 'string' as const, description: 'Date(s) and times of the event, as settled.' },
            concept: { type: 'string' as const, description: 'The idea in two or three sentences: what the night is and why someone comes.' },
            key_message: { type: 'string' as const, description: 'The one thing a guest must take from the visual in two seconds.' },
            usp_angle: { type: 'string' as const, description: 'The selling point and marketing angle agreed, in the conversation\'s words.' },
            audience: { type: 'string' as const, description: 'Who it is for, as agreed.' },
            mood: { type: 'string' as const, description: 'The look and feel in a few words, or "designer to propose, two routes" if that is what was agreed.' },
            references: { type: 'array' as const, items: str, description: 'References named in the conversation: past posts, brands, moods.' },
            colours_and_finish: str,
            avoid: { type: 'string' as const, description: 'What it must not look like.' },
            must_include: { type: 'array' as const, items: str, description: 'Mandatory elements: venue logo, partner logos and how they sit, booking link or QR, price, T&Cs, age or dress notes -- only those that apply.' },
            handles_hashtags: str,
            copy_lines: {
              type: 'array' as const,
              items: { type: 'object' as const, properties: { use: { type: 'string' as const, description: 'Headline, sub-line, date line, price line, call to action...' }, text: str, basis }, required: ['use', 'text', 'basis'] },
            },
            formats: {
              type: 'array' as const,
              description: 'Every digital format needed, from the team\'s list. "Other" with its size when none fits.',
              items: { type: 'object' as const, properties: {
                format: { type: 'string' as const, enum: [...KV_FORMATS] },
                size: { type: 'string' as const, description: 'Only for Other, or a size that differs from the list.' },
                use: { type: 'string' as const, description: 'Where it runs: launch post, countdown story, offer page...' },
                quantity: { type: ['integer', 'null'] as any, description: 'How many variations, if more than one.' },
              }, required: ['format', 'use'] },
            },
            print: {
              type: 'array' as const,
              description: 'Printed pieces, with quantities only where the conversation gave them.',
              items: { type: 'object' as const, properties: { item: str, size: str, quantity: { type: ['integer', 'null'] as any }, notes: str }, required: ['item'] },
            },
            deadlines: {
              type: 'array' as const,
              description: 'Request date, first draft, final artwork, first post, print sent -- each as settled, or a proposal worked back from the first post.',
              items: { type: 'object' as const, properties: { what: str, date: { type: 'string' as const, description: 'YYYY-MM-DD' }, basis }, required: ['what', 'date', 'basis'] },
            },
            requested_by: str,
            approver: { type: 'string' as const, description: 'Who signs the artwork off.' },
            open_points: { type: 'array' as const, items: str, description: 'What the designer will need and the conversation did not settle.' },
          },
          required: ['event_name', 'concept', 'key_message', 'formats', 'open_points'],
        },
      },
      required: ['kv'],
    },
  };
}

const s = (v: unknown, max = 2000): string => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const list = (v: unknown, max = 30): string[] => (Array.isArray(v) ? v.map(x => s(x, 500)).filter(Boolean).slice(0, max) : []);
const qty = (v: unknown): number | null => (typeof v === 'number' && Number.isInteger(v) && v > 0 && v < 1_000_000 ? v : null);
const basisOf = (v: unknown): Basis => (BASIS as readonly string[]).includes(v as string) ? v as Basis : 'proposal';
const isDate = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v) && !Number.isNaN(Date.parse(v + 'T00:00:00Z'));

/**
 * The tool's output, checked: the schema is the hint, this is the control
 * (the cleanDraft rule). An unknown format becomes Other with its name kept; a
 * date that is not a date is moved to open points rather than shown as one.
 * Null when there is nothing a designer could work from.
 */
export function cleanKvBrief(raw: unknown): KvBrief | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, any>;
  const open = list(r.open_points);
  const deadlines: KvBrief['deadlines'] = [];
  for (const d of Array.isArray(r.deadlines) ? r.deadlines : []) {
    const what = s(d?.what, 200), date = s(d?.date, 20);
    if (!what) continue;
    if (isDate(date)) deadlines.push({ what, date, basis: basisOf(d?.basis) });
    else open.push(`A date for: ${what}${date ? ` (written as "${date}")` : ''}`);
  }
  const formats: KvBrief['formats'] = (Array.isArray(r.formats) ? r.formats : []).map((f: any) => {
    const known = (KV_FORMATS as readonly string[]).includes(f?.format);
    return {
      format: known ? f.format : 'Other',
      size: s(f?.size, 80) || (known ? '' : s(f?.format, 80)),
      use: s(f?.use, 300),
      quantity: qty(f?.quantity),
    };
  }).slice(0, 30);
  const kv: KvBrief = {
    event_name: s(r.event_name, 200),
    venues: s(r.venues, 300),
    when: s(r.when, 300),
    concept: s(r.concept),
    key_message: s(r.key_message, 500),
    usp_angle: s(r.usp_angle),
    audience: s(r.audience),
    mood: s(r.mood),
    references: list(r.references),
    colours_and_finish: s(r.colours_and_finish),
    avoid: s(r.avoid),
    must_include: list(r.must_include),
    handles_hashtags: s(r.handles_hashtags, 500),
    copy_lines: (Array.isArray(r.copy_lines) ? r.copy_lines : [])
      .map((c: any) => ({ use: s(c?.use, 100), text: s(c?.text, 500), basis: basisOf(c?.basis) }))
      .filter((c: { text: string }) => c.text).slice(0, 20),
    formats,
    print: (Array.isArray(r.print) ? r.print : [])
      .map((p: any) => ({ item: s(p?.item, 200), size: s(p?.size, 80), quantity: qty(p?.quantity), notes: s(p?.notes, 300) }))
      .filter((p: { item: string }) => p.item).slice(0, 20),
    deadlines: deadlines.sort((a, b) => a.date.localeCompare(b.date)),
    requested_by: s(r.requested_by, 200),
    approver: s(r.approver, 200),
    open_points: [...new Set(open)],
  };
  if (!kv.concept && !kv.key_message && !kv.formats.length) return null;
  return kv;
}

const fmtDate = (iso: string) => new Date(iso + 'T00:00:00Z')
  .toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
// *italic*, not _italic_: the page's renderer and the Word builder both read asterisks only.
const mark = (b: Basis) => (b === 'settled' ? '' : b === 'proposal' ? ' *(proposal)*' : ' *(to fill)*');
const cell = (v: string) => v.replace(/\|/g, '/').replace(/\n+/g, ' ');

/**
 * The brief as markdown: the ONE text the page shows, the Word file is made
 * from (briefDocx) and Monday's update carries, so the three cannot disagree.
 * A section with nothing in it is left out, except the open points, which say
 * "none" when there are none -- an empty list there is itself information.
 */
export function kvBriefMarkdown(kv: KvBrief): string {
  const out: string[] = [];
  const para = (h: string, v: string) => { if (v) out.push(`## ${h}`, '', v, ''); };
  const bullets = (h: string, v: string[]) => { if (v.length) out.push(`## ${h}`, '', ...v.map(x => `- ${x}`), ''); };

  out.push(`# Key visual brief: ${kv.event_name || 'event'}`, '');
  const facts = [
    kv.venues && `**Where:** ${kv.venues}`,
    kv.when && `**When:** ${kv.when}`,
    kv.requested_by && `**Requested by:** ${kv.requested_by}`,
    kv.approver && `**Signed off by:** ${kv.approver}`,
  ].filter(Boolean) as string[];
  if (facts.length) out.push(facts.join('  \n'), '');

  para('The idea', kv.concept);
  para('The one thing it must say', kv.key_message);
  para('Selling point and angle', kv.usp_angle);
  para('Who it is for', kv.audience);

  const look = [
    kv.mood && `**Mood:** ${kv.mood}`,
    kv.colours_and_finish && `**Colours and finish:** ${kv.colours_and_finish}`,
    kv.avoid && `**Avoid:** ${kv.avoid}`,
  ].filter(Boolean) as string[];
  if (look.length || kv.references.length) {
    out.push('## Look and feel', '');
    if (look.length) out.push(look.join('  \n'), '');
    if (kv.references.length) out.push('References:', '', ...kv.references.map(x => `- ${x}`), '');
  }

  bullets('Must include', kv.must_include);
  para('Handles and hashtags', kv.handles_hashtags);

  if (kv.copy_lines.length) {
    out.push('## Copy', '', '| Where | Words |', '|---|---|',
      ...kv.copy_lines.map(c => `| ${cell(c.use || '-')} | ${cell(c.text)}${mark(c.basis)} |`), '');
  }
  if (kv.formats.length) {
    out.push('## Formats', '', '| Format | Used for | How many |', '|---|---|---|',
      ...kv.formats.map(f => `| ${cell(f.format === 'Other' ? `Other${f.size ? ': ' + f.size : ''}` : f.format + (f.size ? ` (${f.size})` : ''))} | ${cell(f.use || '-')} | ${f.quantity ?? 1} |`), '');
  }
  if (kv.print.length) {
    out.push('## Print', '', '| Piece | Size | Copies | Notes |', '|---|---|---|---|',
      ...kv.print.map(p => `| ${cell(p.item)} | ${cell(p.size || '-')} | ${p.quantity ?? 'to confirm'} | ${cell(p.notes || '-')} |`), '');
  }
  if (kv.deadlines.length) {
    out.push('## Deadlines', '', '| What | When |', '|---|---|',
      ...kv.deadlines.map(d => `| ${cell(d.what)} | ${fmtDate(d.date)}${mark(d.basis)} |`), '');
  }
  out.push('## Still to settle', '', ...(kv.open_points.length ? kv.open_points.map(x => `- ${x}`) : ['- None: everything above was agreed in the plan.']), '');
  out.push('*Written by Sauron from the planning conversation. Anything marked proposal was suggested, not agreed.*');
  return out.join('\n');
}
