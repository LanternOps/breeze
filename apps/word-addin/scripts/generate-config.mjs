#!/usr/bin/env node
// Writes public/config.json (served at /config.json) from env / .env / CLI flags.
//   node scripts/generate-config.mjs [--api-base-url https://us.2breeze.app] [--client-id <guid>] [--out public/config.json]
// Precedence: CLI flag > process.env > .env file > localhost default.
// This is a DEPLOY-TIME utility. The committed public/config.json holds localhost
// defaults so the shipped bundle stays deployment-neutral; each deployment runs
// this (or serves its own config.json) with its real API origin + Entra client ID.
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

const apiBaseUrl = (
  argValue('--api-base-url') ??
  env.VITE_API_BASE_URL ??
  'http://localhost:3001'
).replace(/\/+$/, '');
const clientId =
  argValue('--client-id') ??
  env.VITE_CLIENT_AI_ENTRA_CLIENT_ID ??
  env.CLIENT_AI_ENTRA_CLIENT_ID ??
  '';

const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:|\/|$)/.test(apiBaseUrl);
if (!clientId && !isLocalhost) {
  console.error(
    `[generate-config] ERROR: entraClientId is empty for a non-localhost apiBaseUrl (${apiBaseUrl}). ` +
      'SSO cannot work — pass --client-id <guid> (or set VITE_CLIENT_AI_ENTRA_CLIENT_ID).',
  );
  process.exit(1);
}
if (!clientId) {
  console.warn('[generate-config] WARNING: entraClientId is empty (localhost dev) — SSO will not work until set.');
}

const outPath = path.join(root, argValue('--out') ?? 'public/config.json');
writeFileSync(outPath, `${JSON.stringify({ apiBaseUrl, entraClientId: clientId }, null, 2)}\n`);
console.log(`[generate-config] wrote ${outPath} (api: ${apiBaseUrl}, clientId: ${clientId.slice(0, 8) || '∅'}…)`);
