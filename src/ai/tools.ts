import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

export const queryTools: Tool[] = [
  {
    name: 'query_product_mix',
    description: 'Query product-level sales data for a venue on a given date or date range. Returns item names, quantities sold, sales amounts, categories, and percentage of total sales. Use this to answer questions about what sold, top/bottom sellers, food vs beverage breakdown, category performance, and modifier usage. For date ranges, results are aggregated across all dates.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
        row_type: {
          type: 'string',
          enum: ['Product', 'Modifier', 'all'],
          description: 'Filter by row type. Default "Product" to avoid double-counting modifiers.',
        },
        class: {
          type: 'string',
          enum: ['Food', 'Beverage', 'all'],
          description: 'Filter by class. Use "all" to see both.',
        },
        order_by: {
          type: 'string',
          enum: ['sales_desc', 'sales_asc', 'qty_desc', 'qty_asc', 'name'],
          description: 'Sort order. Default sales_desc (top sellers first).',
        },
        limit: {
          type: 'number',
          description: 'Max rows to return. Default 20.',
        },
      },
      required: ['venue_slug'],
    },
  },
  {
    name: 'query_daily_operations',
    description: 'Query daily operations summary for a venue: gross/net sales, discounts, taxes, tips, payments, covers, average check, average spend per head, service fees. Supports single date or date range. IMPORTANT — two different systems of record: REVENUE always comes from Revel (the POS), and COVERS always come from SevenRooms (the reservation system), because Revel cannot break covers down by meal period. avg_spend_per_head is Revel gross_sales divided by SevenRooms covers — revenue per PERSON, and the metric to lead with. avg_check is revenue per BILL and moves with party size, so report it as secondary context, never on its own. covers_by_meal_period splits covers into brunch/lunch/dinner. Also returns walk_in_covers, no_show_covers and cancelled_covers, which only SevenRooms can see. The covers_check / covers_sop_review fields compare SevenRooms covers against Revel\'s paid-guest count: a gap means the floor team did not log walk-ins or adjust party sizes, so it is a data-entry issue to raise with the venue, NOT a reason to doubt the revenue figure. If covers are null, SevenRooms data has not been ingested for that date. A day flagged closed:true had zero sales and zero transactions, meaning the venue did not open — Firangi Superstar closes every Sunday. Always describe such a day as a closure, never as a decline or a bad day, and never include it when averaging; trading_days and avg_daily_gross already exclude them.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
      },
      required: ['venue_slug'],
    },
  },
  {
    name: 'compare_venues',
    description: 'Compare key metrics across venues for the same date or date range. Returns side-by-side gross sales, net sales, covers, average check, average spend per head, food/beverage split, and discount rates. Revenue comes from Revel (the POS); covers come from SevenRooms (the reservation system), including a covers_by_meal_period breakdown. avg_spend_per_head is Revel gross_sales divided by SevenRooms covers — revenue per PERSON, and the metric to lead with. avg_check is revenue per BILL and moves with party size, so report it as secondary context, never on its own. revel_guests and covers_check are included for transparency — a large covers_check variance means that venue is not logging walk-ins properly, which is worth flagging separately from performance. For date ranges, metrics are totalled across the period. Use this for benchmarking and cross-venue analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
        venue_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Venues to compare. Omit to compare all venues.',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_meal_period_sales',
    description: 'Query sales breakdown by meal period (lunch/brunch/dinner) for a venue. Returns, per meal period: sales, transactions (BILLS, not people), covers (PEOPLE, from SevenRooms), avg_check (revenue per bill), avg_spend_per_cover (revenue per person) and avg_party_size. avg_spend_per_cover is the metric that matters for comparing venues or meal periods — avg_check rises simply because parties are bigger, so quoting it alone misleads. Lead with spend per cover, quote avg check alongside. Never call a transaction count a cover count. If covers are null, SevenRooms data is missing for those dates — say so rather than falling back to avg_check as if it were the same thing. Derived from hourly sales data. Use this to answer questions about lunch vs dinner performance, brunch sales on weekends, or meal period trends. Note: Fat Prince Saturday/Sunday lunch is labelled "brunch", Firangi Superstar Saturday lunch is labelled "brunch".',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
      },
      required: ['venue_slug'],
    },
  },
  {
    name: 'query_reservations',
    description: 'Query reservation and covers data from SevenRooms for one venue or all venues. This is the ONLY source of booking-level detail — use it for any question about reservations, walk-ins, no-shows, cancellations, booking channels, party sizes, VIPs, or table turn times. Revel (the POS) cannot answer these. Returns: total bookings and covers, a brunch/lunch/dinner split, walk-in vs reservation covers, no-show and cancellation counts and rates, a breakdown by booking channel (booked_by — e.g. "Walk In", "Google Reserve Integration", "Booking Widget", or a staff member\'s name), average party size (computed on the same basis as the covers figure, so it excludes cancellations — a fully cancelled day returns null, not an average), bookings alongside active_bookings (bookings counts every record including cancellations; active_bookings excludes them, so quote active_bookings next to covers or the two will not reconcile), VIP count, and average table turn time in minutes. USE THIS FOR UPCOMING BOOKINGS TOO — Sauron is an operations tool, so questions like \'how many covers do we have tonight\', \'what does the weekend look like\' or \'how is next week booking up\' are answered here. Reservation data is ingested about 60 days forward. For a future date the response has period:\'upcoming\' and covers means EXPECTED covers (booked and not yet cancelled), not people who have dined — say so when reporting it, and never present a forward book as achieved covers. expected_covers and completed_covers are always both returned so you can be precise. For TODAY the period is \'today_in_progress\' and covers likewise means expected covers, because service is only part-done — completed_covers tells you how many have finished dining so far, so answer \'X booked tonight, Y already seated or finished\'. Status no_bookings_yet on a future date means an empty book, not a fault. Note covers are the booked party size, so they may differ slightly from the POS guest count; that variance is reported as covers_check and reflects floor data-entry, not a revenue problem. When a venue has no reservations for a date, the response carries a status field that has already checked Revel and distinguishes the cases — "venue_closed" means the venue was shut and there is nothing to investigate (Firangi Superstar closes every Sunday, so state that plainly and do NOT suggest chasing the venue team), "data_gap" means the POS took money and served guests so reservations really are missing and it is worth escalating, "minimal_pos_activity" means a trivial non-service transaction, and "awaiting_revel" means Revel has not landed for that date yet and it should be re-checked tomorrow. Report whichever case applies rather than hedging between them.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi". Omit to return all three venues side by side.',
        },
        business_date: {
          type: 'string',
          description: 'Single business date in YYYY-MM-DD format. Use this OR start_date/end_date, not both.',
        },
        start_date: {
          type: 'string',
          description: 'Start of date range (inclusive) in YYYY-MM-DD format. Use with end_date.',
        },
        end_date: {
          type: 'string',
          description: 'End of date range (inclusive) in YYYY-MM-DD format. Use with start_date.',
        },
      },
      required: [],
    },
  },
  {
    name: 'query_hourly_sales',
    description: 'Query hour-by-hour sales breakdown for a venue on a specific date. Shows transactions, items sold, average check, and sales for each hour. Use this to understand peak hours, quiet periods, and hourly sales patterns.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Business date in YYYY-MM-DD format.',
        },
      },
      required: ['venue_slug', 'business_date'],
    },
  },
  {
    name: 'list_available_data',
    description: 'List which dates have data for each venue. Use this FIRST when unsure what data is available, or when a query returns no results. Shows the most recent dates with operations summaries and product mix data.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Optional: filter to a specific venue. Omit to see all venues.',
        },
      },
      required: [],
    },
  },
  {
    name: 'create_chart',
    description: 'Draw a chart from warehouse data and show it to the user. Call this WHENEVER the answer covers a trend over time — several weeks, months or years — because a line is far easier to read than a column of numbers. Also use it to compare venues side by side. You supply only the metric, venues, dates and chart type; the server re-queries the warehouse and plots the real figures, so never put numbers in this call and never describe a chart you have not created. The chart appears above your reply — reference it and interpret it in words (what moved, when, and why it matters), do not just restate every value. Available metrics: gross_sales, net_sales, avg_check, covers, avg_spend_per_head, walk_in_pct, no_show_rate. Days when a venue was closed are plotted as a gap rather than a zero, and returned as closed_days — mention a closure if it is visible in the chart, but never read it as a sales collapse. Bucketing is chosen automatically — daily under ~5 weeks, weekly under ~4 months, monthly beyond — so a multi-month request produces a readable monthly line rather than hundreds of daily points. To answer "which days of the week are slow / busy", set granularity to "day_of_week": that returns seven bars averaging every Monday, every Tuesday and so on across the range, which is the only way to see the weekly pattern — a daily line over several months is unreadable and cannot answer it. The reply for a day_of_week chart carries every weekday value in by_weekday, so quote those figures rather than estimating from the picture. You may call this more than once for different metrics.',
    input_schema: {
      type: 'object' as const,
      properties: {
        metric: {
          type: 'string',
          enum: ['gross_sales', 'net_sales', 'avg_check', 'covers', 'avg_spend_per_head', 'walk_in_pct', 'no_show_rate'],
          description: 'What to plot. Revenue metrics come from Revel; covers, walk-in and no-show come from SevenRooms.',
        },
        start_date: { type: 'string', description: 'Start of range (inclusive), YYYY-MM-DD.' },
        end_date: { type: 'string', description: 'End of range (inclusive), YYYY-MM-DD.' },
        venue_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Venues to plot: "neon-pigeon", "fat-prince", "super-firangi". Omit for all three, which draws one line per venue for comparison.',
        },
        granularity: {
          type: 'string',
          enum: ['day', 'week', 'month', 'day_of_week'],
          description: 'How to bucket the data. Omit for time-series questions and the server picks day/week/month from the range length — usually correct. Set "day_of_week" ONLY for questions about the weekly pattern (which days trade well or badly): it collapses the whole range into seven bars, Monday to Sunday, each the AVERAGE of that weekday, and ignores the calendar order entirely. Note "by day" is ambiguous in plain English — if the user is asking which days of the week are quiet, they mean day_of_week, not daily granularity.',
        },
        chart_type: {
          type: 'string',
          enum: ['line', 'bar'],
          description: 'Use "line" for anything over time (the default). Use "bar" only for comparing a handful of discrete buckets.',
        },
        title: { type: 'string', description: 'Optional title. Omit for a sensible default.' },
      },
      required: ['metric', 'start_date', 'end_date'],
    },
  },
  {
    name: 'web_search',
    description: 'Search the web for external context to enrich your analysis. Use this for: industry benchmarks (e.g. "average food cost % casual dining Singapore"), local events or holidays that may impact sales, F&B trends, weather data, competitive analysis, or any external reference that would strengthen a recommendation. Do NOT use this for internal data — use the database tools for that.',
    input_schema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search query. Be specific, e.g. "average food cost percentage casual dining Singapore 2026" or "public holidays Singapore August 2026".',
        },
      },
      required: ['query'],
    },
  },
];
