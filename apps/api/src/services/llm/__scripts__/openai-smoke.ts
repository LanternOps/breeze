/**
 * Smoke test pour OpenAICompatibleProvider, hors flow Breeze.
 *
 * Verifie que le provider parle correctement a vLLM en streaming SSE :
 *   - connexion + auth
 *   - reception de chunks content_delta au fil de l'eau
 *   - terminaison propre via message_end avec usage
 *
 * Usage :
 *   MCP_LLM_BASE_URL=http://192.168.30.121:8000/v1 \
 *   MCP_LLM_API_KEY=changeme \
 *   MCP_LLM_MODEL=qwen3.6-27b \
 *   pnpm --filter @breeze/api exec tsx src/services/llm/__scripts__/openai-smoke.ts
 */

import { OpenAICompatibleProvider } from '../openaiCompatibleProvider';
import type { ChatMessage } from '../types';

const BASE_URL = process.env.MCP_LLM_BASE_URL ?? 'http://192.168.30.121:8000/v1';
const API_KEY = process.env.MCP_LLM_API_KEY ?? 'changeme';
const MODEL = process.env.MCP_LLM_MODEL ?? 'qwen3.6-27b';
const PRICE_IN = Number(process.env.MCP_LLM_PRICE_INPUT_PER_M_USD ?? '0');
const PRICE_OUT = Number(process.env.MCP_LLM_PRICE_OUTPUT_PER_M_USD ?? '0');

async function main(): Promise<void> {
  console.log('==========================================');
  console.log(' OpenAICompatibleProvider smoke test');
  console.log('==========================================');
  console.log(`Endpoint : ${BASE_URL}`);
  console.log(`Model    : ${MODEL}`);
  console.log(`Price    : in=${PRICE_IN}/M  out=${PRICE_OUT}/M`);
  console.log('');

  const provider = new OpenAICompatibleProvider({
    baseUrl: BASE_URL,
    apiKey: API_KEY,
    priceInputPerMUsd: PRICE_IN,
    priceOutputPerMUsd: PRICE_OUT,
  });

  const messages: ChatMessage[] = [
    {
      role: 'system',
      content: 'You are a concise assistant. Always answer in one short sentence.',
    },
    {
      role: 'user',
      content: 'Name three colors and explain in one sentence why blue is calming.',
    },
  ];

  const abortController = new AbortController();
  let chunkCount = 0;
  let firstChunkAt: number | null = null;
  let textBuf = '';
  let messageStarted = false;
  let messageEnded = false;
  let inputTokens: number | null = null;
  let outputTokens: number | null = null;
  let sawError = false;

  const startedAt = performance.now();

  try {
    const stream = provider.chatStream(messages, {
      model: MODEL,
      signal: abortController.signal,
    });

    for await (const event of stream) {
      if (firstChunkAt === null) {
        firstChunkAt = performance.now();
      }
      chunkCount += 1;

      switch (event.type) {
        case 'message_start':
          messageStarted = true;
          break;
        case 'content_delta':
          textBuf += event.delta;
          process.stdout.write(event.delta);
          break;
        case 'message_end':
          messageEnded = true;
          inputTokens = event.inputTokens;
          outputTokens = event.outputTokens;
          break;
        case 'error':
          sawError = true;
          console.error(`\n[ERROR] ${event.message}`);
          break;
        default: {
          const exhaustive: never = event;
          console.log(`\n[unknown event] ${JSON.stringify(exhaustive)}`);
        }
      }
    }
  } catch (err) {
    sawError = true;
    console.error('\n[EXCEPTION]', err);
  }

  const totalMs = performance.now() - startedAt;
  const ttftMs = firstChunkAt !== null ? firstChunkAt - startedAt : null;

  const costUsd =
    inputTokens !== null && outputTokens !== null
      ? (inputTokens * PRICE_IN + outputTokens * PRICE_OUT) / 1_000_000
      : null;

  console.log('\n');
  console.log('------------------------------------------');
  console.log(' Summary');
  console.log('------------------------------------------');
  console.log(`Events received  : ${chunkCount}`);
  console.log(`message_start    : ${messageStarted ? 'yes' : 'no'}`);
  console.log(`message_end      : ${messageEnded ? 'yes' : 'no'}`);
  console.log(`TTFT             : ${ttftMs !== null ? ttftMs.toFixed(0) + ' ms' : 'n/a'}`);
  console.log(`Total time       : ${totalMs.toFixed(0)} ms`);
  console.log(`Text length      : ${textBuf.length} chars`);
  console.log(`Input tokens     : ${inputTokens ?? 'n/a'}`);
  console.log(`Output tokens    : ${outputTokens ?? 'n/a'}`);
  console.log(`Cost USD         : ${costUsd !== null ? costUsd.toFixed(8) : 'n/a'}`);
  console.log(`Errors           : ${sawError ? 'YES' : 'no'}`);
  console.log('');

  const failed =
    sawError ||
    chunkCount === 0 ||
    textBuf.length === 0 ||
    !messageStarted ||
    !messageEnded;

  if (failed) {
    console.error('Smoke test FAILED.');
    process.exit(1);
  }
  console.log('Smoke test PASSED.');
  process.exit(0);
}

main().catch((err) => {
  console.error('Fatal:', err);
  process.exit(1);
});
