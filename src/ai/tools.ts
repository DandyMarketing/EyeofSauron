import type { Tool } from '@anthropic-ai/sdk/resources/messages.js';

export const queryTools: Tool[] = [
  {
    name: 'query_product_mix',
    description: 'Query product-level sales data for a venue on a given date or date range. Returns item names, quantities sold, sales amounts, categories, and percentage of total sales. Use this to answer questions about what sold, top/bottom sellers, food vs beverage breakdown, category performance, and modifier usage.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Business date in YYYY-MM-DD format',
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
      required: ['venue_slug', 'business_date'],
    },
  },
  {
    name: 'query_daily_operations',
    description: 'Query daily operations summary for a venue: gross/net sales, discounts, taxes, tips, payments, guest count, average check, service fees. Use this for revenue questions, financial summaries, payment breakdowns, discount analysis, and service performance metrics.',
    input_schema: {
      type: 'object' as const,
      properties: {
        venue_slug: {
          type: 'string',
          description: 'Venue identifier: "neon-pigeon", "fat-prince", or "super-firangi"',
        },
        business_date: {
          type: 'string',
          description: 'Business date in YYYY-MM-DD format',
        },
      },
      required: ['venue_slug', 'business_date'],
    },
  },
  {
    name: 'compare_venues',
    description: 'Compare key metrics across venues for the same date. Returns side-by-side gross sales, net sales, guest count, average check, food/beverage split, and discount rates. Use this for benchmarking and cross-venue analysis.',
    input_schema: {
      type: 'object' as const,
      properties: {
        business_date: {
          type: 'string',
          description: 'Business date in YYYY-MM-DD format',
        },
        venue_slugs: {
          type: 'array',
          items: { type: 'string' },
          description: 'Venues to compare. Omit to compare all venues.',
        },
      },
      required: ['business_date'],
    },
  },
];
