import 'dotenv/config';
import { supabase } from '../lib/supabase.js';

async function main() {
  const { data, error } = await supabase
    .from('ingestion_log')
    .select('filename, report_type, status, error_message, created_at')
    .order('created_at', { ascending: false })
    .limit(20);

  if (error) {
    console.log('Error:', error.message);
    return;
  }

  if (!data || data.length === 0) {
    console.log('No ingestion logs at all.');
    return;
  }

  console.log('Recent ingestion logs:');
  for (const l of data) {
    console.log(`  ${l.created_at} | ${l.report_type} | ${l.status} | ${l.filename}${l.error_message ? ' | ' + l.error_message : ''}`);
  }
}

main();
