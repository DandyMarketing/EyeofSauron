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

// Printed separately from the answer, and labelled, for the same reason the
// web app renders them apart: a figure from the web is not a warehouse figure.
if (result.sources.length > 0) {
  console.log(`\n--- From the web (NOT our data): ${result.sources.length} source(s) ---`);
  for (const s of result.sources) {
    console.log(`  ${s.title ?? s.url}`);
    console.log(`    ${s.url}`);
    console.log(`    "${s.quote}"`);
  }
}
