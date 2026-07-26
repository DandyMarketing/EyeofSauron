import 'dotenv/config';
import { askSauron } from '../ai/engine.js';

const question = process.argv.slice(2).join(' ');
if (!question) {
  console.log('Usage: npm run ask "What were the top sellers at Fat Prince on 2026-07-23?"');
  process.exit(0);
}

console.log(`Question: ${question}\n`);
const result = await askSauron(question);

console.log('--- Answer ---');
console.log(result.answer);
console.log(`\n--- Tool calls made: ${result.toolCalls.length} ---`);
for (const tc of result.toolCalls) {
  console.log(`  ${tc.name}(${JSON.stringify(tc.input)})`);
}
