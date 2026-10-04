/**
 * The pure half of the dashboard: the shape of a venue's week, and the group
 * roll-up over it.
 *
 * SPLIT FROM dashboard.ts SO IT CAN BE TESTED. That file imports
 * `supabaseAdmin`, which throws at module load without credentials, so a test
 * importing it for one pure function cannot run at all -- and the roll-up is
 * precisely the part worth testing, because every figure on a group line is a
 * chance to average something that should have been summed.
 *
 * Same split as src/lib/staffany-probe.ts against its script: logic here, IO
 * there.
 */

import { movement } from './dashboard-window.js';
import { serviceNote, syncAge, type ServiceDay } from './service-day.js';

const round2 = (n: number) => Math.round(n * 100) / 100;

export interface VenueWeek {
  venue_id: string;
  venue: string;
  slug: string;

  /** Week to date. Null where the venue has no data for the window at all. */
  gross_sales: number;
  food_bev_sales: number;
  food_sales: number;
  beverage_sales: number;
  food_pct: number | null;
  net_sales: number;
  service_charge: number;
  total_discounts: number;
  discount_rate_pct: number | null;
  covers: number | null;
  transactions: number;
  avg_spend_per_head: number | null;
  avg_check: number | null;

  /** Days the venue actually traded, and days it was shut. */
  trading_days: number;
  closed_days: string[];

  /** The same figures a week earlier, and the movement between them. */
  prior: { net_sales: number; covers: number | null; avg_spend_per_head: number | null };
  change: {
    net_sales: ReturnType<typeof movement>;
    covers: ReturnType<typeof movement>;
    avg_spend_per_head: ReturnType<typeof movement>;
  };

  /**
   * One point per day. Closed days are null, never zero.
   *
   * Carries the SPLIT as well as the total, so one chart can show the daily
   * shape and the food/beverage mix together. The mix is defined on food plus
   * beverage, so `gross_sales` is that figure and the two parts sum to it
   * exactly -- a stack whose segments do not add up to its own label is worse
   * than no stack at all.
   */
  daily: Array<{
    date: string;
    net_sales: number | null;
    gross_sales: number | null;
    food_sales: number | null;
    beverage_sales: number | null;
    covers: number | null;
  }>;

  /**
   * Covers either side of today, EACH ON ITS OWN BASIS -- a past day settled,
   * today a point-in-time snapshot, a future day the book. See service-day.ts
   * for why those are three different measurements and must not be compared
   * without saying which is which.
   *
   * `closed` matters more than it looks. Firangi Superstar shuts every
   * Sunday, and a forward book showing that Sunday as 0 reads as a venue
   * nobody has booked -- BUILD_LOG 3.2 is a closed day plotted as a
   * catastrophic trading day, and a zero in a row of numbers is the same
   * mistake in a different shape.
   */
  service: ServiceDay[];
  /**
   * When the reservations behind today's snapshot were last written. Null when
   * today has no bookings at all, so it is never presented as freshness that
   * was measured.
   */
  synced_at: string | null;
  /** That staleness in words, measured on the server's clock. See syncAge(). */
  synced_label: string | null;
  synced_stale: boolean;
  /** The sentence under the strip, composed server-side like every figure. */
  service_note: string;
}

/**
 * The group line, for somebody who can see every venue.
 *
 * SUMMED, NOT AVERAGED, and the rates are recomputed from the summed parts
 * rather than averaged across venues. An average of three discount rates
 * weights a quiet Tuesday venue the same as a busy one and is not a figure
 * anybody can act on.
 */
export function rollUp(rows: VenueWeek[], now: Date = new Date()): VenueWeek {
  const add = (f: (r: VenueWeek) => number | null) =>
    rows.reduce((n, r) => n + (f(r) ?? 0), 0);

  // Null only when EVERY venue is null — one venue missing SevenRooms should
  // not blank the group, but it must not silently count as zero either.
  const coversKnown = rows.filter(r => r.covers !== null);
  const covers = coversKnown.length > 0 ? coversKnown.reduce((n, r) => n + r.covers!, 0) : null;
  const priorKnown = rows.filter(r => r.prior.covers !== null);
  const priorCovers = priorKnown.length > 0 ? priorKnown.reduce((n, r) => n + r.prior.covers!, 0) : null;

  const foodBev = round2(add(r => r.food_bev_sales));
  const gross = round2(add(r => r.gross_sales));
  const net = round2(add(r => r.net_sales));
  const priorNet = round2(rows.reduce((n, r) => n + r.prior.net_sales, 0));
  const discounts = round2(add(r => r.total_discounts));
  const transactions = add(r => r.transactions);
  const sph = covers && covers > 0 ? round2(foodBev / covers) : null;
  const priorSph = priorCovers && priorCovers > 0
    ? round2(rows.reduce((n, r) => n + (r.prior.covers ? r.prior.net_sales : 0), 0) / priorCovers)
    : null;

  // One point per date across every venue.
  const byDate = new Map<string, { net: number; gross: number; food: number; bev: number; covers: number | null }>();
  for (const r of rows) {
    for (const d of r.daily) {
      const e = byDate.get(d.date) ?? { net: 0, gross: 0, food: 0, bev: 0, covers: null };
      e.net += d.net_sales ?? 0;
      e.gross += d.gross_sales ?? 0;
      e.food += d.food_sales ?? 0;
      e.bev += d.beverage_sales ?? 0;
      if (d.covers !== null) e.covers = (e.covers ?? 0) + d.covers;
      byDate.set(d.date, e);
    }
  }
  /**
   * A group day is only "closed" when EVERY venue is shut that weekday, which
   * today is never -- but summing covers across a day one venue is shut must
   * not mark the group closed.
   *
   * THE BASIS IS CARRIED, NEVER RECOMPUTED. Every venue in one payload shares
   * one `today`, so a given date is on the same basis for all of them; taking
   * the first venue's label is correct and recomputing it here would be a
   * second place for the rule to drift.
   */
  const serviceByDate = new Map<string, ServiceDay>();
  for (const r of rows) for (const u of r.service) {
    const e = serviceByDate.get(u.date);
    if (!e) {
      // Cloned, including the snapshot, so summing into it cannot mutate a
      // venue's own figures -- the group is an additional row, not a rewrite.
      serviceByDate.set(u.date, {
        ...u,
        snapshot: u.snapshot ? { ...u.snapshot } : undefined,
      });
      continue;
    }
    e.covers += u.covers;
    e.closed = e.closed && u.closed;
    if (e.snapshot && u.snapshot) {
      e.snapshot.finished += u.snapshot.finished;
      e.snapshot.in_house += u.snapshot.in_house;
      e.snapshot.to_come += u.snapshot.to_come;
      e.snapshot.bookings_to_come += u.snapshot.bookings_to_come;
      e.snapshot.lost += u.snapshot.lost;
      e.snapshot.unaccounted += u.snapshot.unaccounted;
      /**
       * TRACKED ONLY IF EVERY VENUE TRACKS. One venue marking tables and
       * another not makes the group's in-house figure part observation and
       * part diary, and the weaker of the two is what the reader must be told
       * -- a group line claiming the floor when a third of it is guesswork is
       * the more confident error.
       */
      e.snapshot.seating_tracked = e.snapshot.seating_tracked && u.snapshot.seating_tracked;
    }
  }
  const service = [...serviceByDate.values()].sort((a, b) => a.date.localeCompare(b.date));

  /**
   * The OLDEST sync across the venues, because the group line is only as fresh
   * as its stalest part. Taking the newest would let one healthy venue vouch
   * for two whose ingest has stopped.
   */
  const oldestSync = rows.map(r => r.synced_at).filter((s): s is string => !!s).sort()[0] ?? null;
  const age = syncAge(oldestSync, now);

  return {
    venue_id: 'group',
    venue: 'All venues',
    slug: 'group',
    gross_sales: gross,
    food_bev_sales: foodBev,
    food_sales: round2(add(r => r.food_sales)),
    beverage_sales: round2(add(r => r.beverage_sales)),
    food_pct: foodBev > 0 ? round2(add(r => r.food_sales) / foodBev * 100) : null,
    net_sales: net,
    service_charge: round2(add(r => r.service_charge)),
    total_discounts: discounts,
    discount_rate_pct: gross > 0 ? round2(discounts / gross * 100) : null,
    covers,
    transactions,
    avg_spend_per_head: sph,
    avg_check: transactions > 0 ? round2(net / transactions) : null,
    trading_days: Math.max(...rows.map(r => r.trading_days)),
    closed_days: [],
    prior: { net_sales: priorNet, covers: priorCovers, avg_spend_per_head: priorSph },
    change: {
      net_sales: movement(net, priorNet || null),
      covers: movement(covers, priorCovers),
      avg_spend_per_head: movement(sph, priorSph),
    },
    daily: [...byDate.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([date, e]) => ({
        date,
        net_sales: round2(e.net),
        gross_sales: round2(e.gross),
        food_sales: round2(e.food),
        beverage_sales: round2(e.bev),
        covers: e.covers,
      })),
    service,
    synced_at: oldestSync,
    synced_label: age.label,
    synced_stale: age.stale,
    /**
     * RECOMPOSED FROM THE MERGED SNAPSHOT, not borrowed from a venue. One
     * venue's sentence describes one venue's room, and on the group line it
     * would be three times too small while reading as a total.
     */
    service_note: serviceNote(service.find(d => d.basis === 'snapshot'), null),
  };
}

