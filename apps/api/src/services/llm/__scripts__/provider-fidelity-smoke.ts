/**
 * CLI wrapper around the provider tool-call fidelity harness (#3922 phase 2).
 *
 * Runs the same two-stage check the MFA-gated platform-admin verify route runs
 * (direct @anthropic-ai/sdk tool round-trip + a real Agent SDK subprocess
 * round-trip) against a candidate catalog endpoint, WITHOUT touching the
 * database or recording a verification. Use it to smoke a prospective
 * OpenRouter / LiteLLM / vLLM endpoint before adding it to the catalog.
 *
 * A verification is only ever recorded through the admin route — this script
 * cannot make an endpoint listable.
 *
 * Usage:
 *   LLM_FIDELITY_BASE_URL=https://openrouter.ai/api \
 *   LLM_FIDELITY_AUTH_MODE=bearer \
 *   LLM_FIDELITY_PROVIDER_MODEL=anthropic/claude-sonnet-4-6 \
 *   LLM_FIDELITY_API_KEY=sk-... \
 *   pnpm --filter @breeze/api exec tsx src/services/llm/__scripts__/provider-fidelity-smoke.ts
 *
 * Exit code 0 only when every stage passed. A skipped stage (e.g. no Agent SDK
 * binary in this environment) exits non-zero by design — it is not a pass.
 */

import { runFidelityCheck, FIDELITY_HARNESS_VERSION } from '../providerFidelityHarness';
import { envStr } from '../../../utils/envStr';

const BASE_URL = envStr('LLM_FIDELITY_BASE_URL', '');
const AUTH_MODE = envStr('LLM_FIDELITY_AUTH_MODE', 'x-api-key');
const PROVIDER_MODEL = envStr('LLM_FIDELITY_PROVIDER_MODEL', '');
const API_KEY = envStr('LLM_FIDELITY_API_KEY', '');

function fail(message: string): never {
  console.error(`Error: ${message}`);
  process.exit(2);
}

async function main(): Promise<void> {
  if (!BASE_URL) fail('LLM_FIDELITY_BASE_URL is required.');
  if (!PROVIDER_MODEL) fail('LLM_FIDELITY_PROVIDER_MODEL is required (the id the ENDPOINT expects).');
  if (!API_KEY) fail('LLM_FIDELITY_API_KEY is required (transient test key; never persisted).');
  if (AUTH_MODE !== 'x-api-key' && AUTH_MODE !== 'bearer') {
    fail(`LLM_FIDELITY_AUTH_MODE must be 'x-api-key' or 'bearer', got '${AUTH_MODE}'.`);
  }
  if (!BASE_URL.startsWith('https://')) {
    fail('LLM_FIDELITY_BASE_URL must be an https:// URL — the catalog rejects anything else.');
  }

  console.log('==========================================');
  console.log(' Provider tool-call fidelity harness');
  console.log('==========================================');
  console.log(`Endpoint       : ${BASE_URL}`);
  console.log(`Auth mode      : ${AUTH_MODE}`);
  console.log(`Provider model : ${PROVIDER_MODEL}`);
  console.log(`Harness version: ${FIDELITY_HARNESS_VERSION}`);
  console.log('');

  const startedAt = performance.now();
  const result = await runFidelityCheck({
    baseUrl: BASE_URL,
    authMode: AUTH_MODE,
    providerModel: PROVIDER_MODEL,
    apiKey: API_KEY,
  });
  const totalMs = performance.now() - startedAt;

  console.log('------------------------------------------');
  console.log(' Steps');
  console.log('------------------------------------------');
  for (const step of result.steps) {
    console.log(`${step.ok ? 'PASS' : 'FAIL'}  ${step.name}${step.detail ? ` — ${step.detail}` : ''}`);
  }
  console.log('');
  console.log(`Total time : ${totalMs.toFixed(0)} ms`);
  console.log('');

  if (!result.passed) {
    console.error('Fidelity check FAILED — this endpoint/model must not be verified.');
    process.exit(1);
  }
  console.log('Fidelity check PASSED.');
  process.exit(0);
}

main().catch((err) => {
  // The harness itself does not throw for provider failures, so anything here
  // is a harness/environment fault — never report it as a pass.
  console.error('Fatal:', err instanceof Error ? err.message : err);
  process.exit(2);
});
