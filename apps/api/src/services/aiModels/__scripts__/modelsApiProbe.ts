#!/usr/bin/env tsx
// apps/api/src/services/aiModels/__scripts__/modelsApiProbe.ts (the shebang must stay on line 1)
/**
 * AI model registry W01 spike (#7599): what the Anthropic Models API returns
 * for this key, and which per-call options the Messages API accepts.
 *
 *   ANTHROPIC_API_KEY=… npx tsx src/services/aiModels/__scripts__/modelsApiProbe.ts \
 *     [--probe-geo --geo-model <id>] [--probe-fast --fast-model <id>] [--out file.json]
 *
 * Costs:
 * - Listing models is free.
 * - `--probe-geo` sends three 16-token requests.
 * - `--probe-fast` sends one 16-token fast-mode request at premium rates.
 *
 * Output holds model metadata and API error text only. Never the key.
 */
import Anthropic from '@anthropic-ai/sdk';
import { writeFile } from 'node:fs/promises';

function supportedLeaves(value: unknown, prefix = ''): Array<{ path: string; supported: boolean }> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return [];
  const record = value as Record<string, unknown>;
  const out: Array<{ path: string; supported: boolean }> = [];
  if (typeof record.supported === 'boolean') out.push({ path: prefix || '(root)', supported: record.supported });
  for (const [key, child] of Object.entries(record)) {
    if (key === 'supported') continue;
    out.push(...supportedLeaves(child, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function describeError(error: unknown): { status: number | null; message: string } {
  return {
    status: error instanceof Anthropic.APIError ? (error.status ?? null) : null,
    message: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300),
  };
}

async function main(): Promise<void> {
  const apiKey = process.env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) throw new Error('ANTHROPIC_API_KEY is required');
  // Forced origin and no auth token: the probe answers questions about the
  // Anthropic API itself, never about a gateway named in ANTHROPIC_BASE_URL.
  const client = new Anthropic({ apiKey, authToken: null, baseURL: 'https://api.anthropic.com' });

  const models: Array<Record<string, unknown>> = [];
  for await (const model of client.models.list({ limit: 100 })) {
    models.push({
      id: model.id,
      displayName: model.display_name,
      maxInputTokens: model.max_input_tokens,
      maxOutputTokens: model.max_tokens,
      topLevelCapabilityKeys: Object.keys(model.capabilities ?? {}).sort(),
      leaves: supportedLeaves(model.capabilities),
    });
  }
  const report: Record<string, unknown> = { at: new Date().toISOString(), models };

  if (process.argv.includes('--probe-geo')) {
    const geoModel = argValue('--geo-model');
    if (!geoModel) throw new Error('--probe-geo needs --geo-model <id>');
    const geo: Array<Record<string, unknown>> = [];
    for (const value of ['us', 'global', 'eu']) {
      try {
        const response = await client.messages.create({
          model: geoModel,
          max_tokens: 16,
          inference_geo: value,
          messages: [{ role: 'user', content: 'Reply OK.' }],
        });
        geo.push({ geo: value, accepted: true, servedGeo: (response.usage as { inference_geo?: unknown }).inference_geo ?? null });
      } catch (error) {
        geo.push({ geo: value, accepted: false, ...describeError(error) });
      }
    }
    report.geo = geo;
  }

  if (process.argv.includes('--probe-fast')) {
    const fastModel = argValue('--fast-model');
    if (!fastModel) throw new Error('--probe-fast needs --fast-model <id>');
    try {
      const response = await client.beta.messages.create({
        model: fastModel,
        max_tokens: 16,
        speed: 'fast',
        betas: ['fast-mode-2026-02-01'],
        messages: [{ role: 'user', content: 'Reply OK.' }],
      });
      report.fast = { accepted: true, servedSpeed: (response.usage as { speed?: unknown }).speed ?? null };
    } catch (error) {
      report.fast = { accepted: false, ...describeError(error) };
    }
  }

  console.log(JSON.stringify(report, null, 2));
  const out = argValue('--out');
  if (out) await writeFile(out, JSON.stringify(report, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
