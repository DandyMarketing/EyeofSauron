import { createClient } from '@supabase/supabase-js';
import { rowCapFetch } from './paged.js';

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;

if (!url || !key) {
  throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY in environment');
}

// rowCapFetch logs any unpaged read that comes back at the 1,000-row cap.
export const supabase = createClient(url, key, { global: { fetch: rowCapFetch } });
