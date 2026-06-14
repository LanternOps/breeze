#!/usr/bin/env node
// Renders manifest.template.xml -> manifest.xml from env / .env / CLI flags.
//   node scripts/generate-manifest.mjs [--base-url https://localhost:3000] [--out manifest.xml]
// Precedence: process.env > .env file > defaults. Fails loudly on unreplaced tokens.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function loadDotEnv(file) {
  if (!existsSync(file)) return {};
  const out = {};
  for (const line of readFileSync(file, 'utf8').split('\n')) {
    if (line.trim().startsWith('#')) continue;
    const m = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
    if (!m) continue;
    out[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = { ...loadDotEnv(path.join(root, '.env')), ...process.env };
const args = process.argv.slice(2);
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i === -1 ? undefined : args[i + 1];
};

const baseUrl = (argValue('--base-url') ?? env.ADDIN_BASE_URL ?? 'https://localhost:3000').replace(/\/$/, '');
const apiBaseUrl = (env.VITE_API_BASE_URL ?? 'http://localhost:3001').replace(/\/$/, '');
const clientId = env.VITE_CLIENT_AI_ENTRA_CLIENT_ID ?? env.CLIENT_AI_ENTRA_CLIENT_ID ?? '00000000-0000-0000-0000-000000000000';
// Stable add-in identity GUID. Override per environment (dev vs prod must differ
// or Office caches collide across hosts).
const addinId = env.ADDIN_MANIFEST_ID ?? 'b7f3a9d2-4c61-4e0a-9f4e-2d8a51c0a9b3';
const supportUrl = env.ADDIN_SUPPORT_URL ?? 'https://breezermm.com';
const baseHost = new URL(baseUrl).host;

if (clientId === '00000000-0000-0000-0000-000000000000') {
  console.warn('[generate-manifest] WARNING: VITE_CLIENT_AI_ENTRA_CLIENT_ID is not set — SSO will not work with the placeholder GUID.');
}

const template = readFileSync(path.join(root, 'manifest.template.xml'), 'utf8');
const output = template
  .replaceAll('{{ADDIN_ID}}', addinId)
  .replaceAll('{{BASE_URL}}', baseUrl)
  .replaceAll('{{BASE_HOST}}', baseHost)
  .replaceAll('{{API_BASE_URL}}', apiBaseUrl)
  .replaceAll('{{SUPPORT_URL}}', supportUrl)
  .replaceAll('{{CLIENT_AI_ENTRA_CLIENT_ID}}', clientId);

const leftover = output.match(/{{[A-Z_]+}}/g);
if (leftover) {
  console.error(`[generate-manifest] Unreplaced placeholders: ${[...new Set(leftover)].join(', ')}`);
  process.exit(1);
}

const outPath = path.join(root, argValue('--out') ?? 'manifest.xml');
writeFileSync(outPath, output);
console.log(`[generate-manifest] wrote ${outPath} (base: ${baseUrl}, clientId: ${clientId.slice(0, 8)}…)`);
