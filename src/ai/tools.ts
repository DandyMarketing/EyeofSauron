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
    description: 'Query daily operations summary for a venue: gross/net sales, discounts, taxes, tips, payments, covers, average check, average spend per head, service fees. Supports single date or date range. IMPORTANT — two different systems of record: REVENUE always comes from Revel (the POS), and COVERS always come from SevenRooms (the reservation system), because Revel cannot break covers down by meal period. avg_spend_per_head is Revel gross_sales divided by SevenRooms covers. covers_by_meal_period splits covers into brunch/lunch/dinner. Also returns walk_in_covers, no_show_covers and cancelled_covers, which only SevenRooms can see. The covers_check / covers_sop_review fields compare SevenRooms covers against Revel\'s paid-guest count: a gap means the floor team did not log walk-ins or adjust party sizes, so it is a data-entry issue to raise with the venue, NOT a reason to doubt the revenue figure. If covers are null, SevenRooms data has not been ingested for that date.',
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
    description: 'Compare key metrics across venues for the same date or date range. Returns side-by-side gross sales, net sales, covers, average check, average spend per head, food/beverage split, and discount rates. Revenue comes from Revel (the POS); covers come from SevenRooms (the reservation system), including a covers_by_meal_period breakdown. avg_spend_per_head is Revel gross_sales divided by SevenRooms covers. revel_guests and covers_check are included for transparency — a large covers_check variance means that venue is not logging walk-ins properly, which is worth flagging separately from performance. For date ranges, metrics are totalled across the period. Use this for benchmarking and cross-venue analysis.',
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
    description: 'Query sales breakdown by meal period (lunch/brunch/dinner) for a venue. Derived from hourly sales data. Use this to answer questions about lunch vs dinner performance, brunch sales on weekends, or meal period trends. Note: Fat Prince Saturday/Sunday lunch is labelled "brunch", Super Firangi Saturday lunch is labelled "brunch".',
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
