import 'dotenv/config';
import { supabase } from '../lib/supabase.js';

async function main() {
  const { count, error } = await supabase
    .from('hourly_sales')
    .select('*', { count: 'exact', head: true });

  console.log('hourly_sales row count:', count ?? 0);
  if (error) console.log('Error:', error.message);

  const { data: recent } = await supabase
    .from('hourly_sales')
    .select('venue_id, business_date, meal_period, hour, sales')
    .order('created_at', { ascending: false })
    .limit(5);

  if (recent && recent.length > 0) {
    console.log('Recent rows:', JSON.stringify(recent, null, 2));
  } else {
    console.log('No hourly_sales data in database yet.');
  }

  const { data: logs } = await supabase
    .from('ingestion_log')
    .select('filename, status, error_message, created_at')
    .eq('report_type', 'hourly_sales')
    .order('created_at', { ascending: false })
    .limit(5);

  if (logs && logs.length > 0) {
    console.log('\nHourly sales ingestion logs:');
    for (const l of logs) {
      console.log(`  ${l.filename} → ${l.status} ${l.error_message ?? ''}`);
    }
  } else {
    console.log('\nNo hourly_sales ingestion log entries.');
  }
}

main();
