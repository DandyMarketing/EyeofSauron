import 'dotenv/config';
import { supabase } from '../lib/supabase.js';

async function main() {
  // Check if the table exists by querying it
  const { data, error, status, statusText } = await supabase
    .from('hourly_sales')
    .select('*')
    .limit(5);

  console.log('Status:', status, statusText);
  console.log('Error:', error ? JSON.stringify(error) : 'none');
  console.log('Data:', JSON.stringify(data));

  // Also check ingestion_log for hourly entries
  const { data: logs, error: logErr } = await supabase
    .from('ingestion_log')
    .select('*')
    .order('created_at', { ascending: false })
    .limit(5);

  console.log('\nAll recent logs:', JSON.stringify(logs));
  console.log('Log error:', logErr ? JSON.stringify(logErr) : 'none');
}

main();
