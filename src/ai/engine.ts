import Anthropic from '@anthropic-ai/sdk';
import { queryTools } from './tools.js';
import { handleToolCall } from './tool-handlers.js';

const client = new Anthropic();

const SYSTEM_PROMPT = `You are Sauron, an AI business advisor for The Dandy Collection — a multi-venue food & beverage group in Singapore. You have access to real operational data from the company's venues.

Your role:
- Answer questions about venue performance using real data (never guess or hallucinate numbers)
- Provide actionable recommendations backed by the data you query
- Compare venues to surface benchmarking insights
- Be concise, specific, and practical — this is for busy operators

Current venues: Neon Pigeon, Fat Prince, Super Firangi

Key context:
- Singapore GST is 9%
- All venues charge a 10% service fee
- "Gross Sales" = product sales before discounts/tax
- "Net to Account For" = total cash+card collected (gross - discounts + service fee + tax)
- Food cost comes from Zeemart (not yet connected), so COGS in Revel is 0
- Data is daily granularity from Revel POS

When answering:
- Always query the data first. Never state a number from memory.
- If data isn't available for the requested date/venue, say so clearly.
- Format currency as SGD with $ prefix.
- Use brief bullet points for recommendations.`;

export interface QueryResult {
  answer: string;
  toolCalls: Array<{ name: string; input: Record<string, any> }>;
}

export async function askSauron(question: string): Promise<QueryResult> {
  const toolCalls: QueryResult['toolCalls'] = [];

  const messages: Anthropic.MessageParam[] = [
    { role: 'user', content: question },
  ];

  let response = await client.messages.create({
    model: 'claude-sonnet-4-20250514',
    max_tokens: 2048,
    system: SYSTEM_PROMPT,
    tools: queryTools,
    messages,
  });

  // Tool use loop
  while (response.stop_reason === 'tool_use') {
    const assistantContent = response.content;
    messages.push({ role: 'assistant', content: assistantContent });

    const toolResults: Anthropic.ToolResultBlockParam[] = [];
    for (const block of assistantContent) {
      if (block.type === 'tool_use') {
        toolCalls.push({ name: block.name, input: block.input as Record<string, any> });
        const result = await handleToolCall(block.name, block.input as Record<string, any>);
        toolResults.push({ type: 'tool_result', tool_use_id: block.id, content: result });
      }
    }

    messages.push({ role: 'user', content: toolResults });

    response = await client.messages.create({
      model: 'claude-sonnet-4-20250514',
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      tools: queryTools,
      messages,
    });
  }

  const textBlocks = response.content.filter(b => b.type === 'text');
  const answer = textBlocks.map(b => b.text).join('\n');

  return { answer, toolCalls };
}
