/**
 * Static inventory of every env name the API source reads. TEST SUPPORT ONLY:
 * imported by the env coverage ratchet (envInventory.test.ts) and the compose
 * coverage guard (config/envReadComposeCoverage.test.ts), never by runtime code.
 *
 * Scan: every .ts file under apps/api/src except *.test.ts, src/__tests__/ and
 * this directory (its status code names env vars on purpose and would otherwise
 * keep stale names alive). Plus every ENV_SCHEMA_KEYS key and every builtin
 * extension enableEnvVar, enumerated from the source of truth.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { ENV_SCHEMA_KEYS } from '../../config/validate';
import { BUILTINS } from '../../extensions/builtinRegistry';

const SRC_DIR = join(__dirname, '..', '..');
const SELF_DIR = relative(SRC_DIR, __dirname).split(sep).join('/');

const NAME = String.raw`([A-Z][A-Z0-9_]*)(?![A-Za-z0-9_])`;

/**
 * Every env read shape the codebase uses. Each regex captures the name in
 * group 1 or 2. Spec invariant 1 lists the first two shapes; the rest were
 * found by the W01 inventory (see the plan's "Ratchet scan shapes" table).
 */
export const SCAN_SHAPES: Readonly<Record<string, RegExp>> = {
  // process.env.X, process.env['X'], process.env["X"]
  processEnv: new RegExp(String.raw`\bprocess\.env(?:\.${NAME}|\[\s*['"]${NAME}['"]\s*\])`, 'g'),
  // Literal first (or second, after a prefix/label arg) argument to any helper whose name contains
  // Env/env/Knob/TimeoutMs: envFlag, envInt, envStr, envFloat, getEnvString, positiveIntEnv,
  // cronFromEnv, envString, envHours, parsePositiveIntEnv(LOG_PREFIX, 'X'), resolveMsKnob,
  // parseTransportTimeoutMs, platformEnv, positiveIntFromEnv, readPositiveIntEnv, ...
  envHelper: new RegExp(
    String.raw`(?<![\w$])[\w$]*(?:[Ee]nv|Knob|TimeoutMs)[\w$]*\(\s*(?:[A-Za-z_$][\w$.]*\s*,\s*)?['"]${NAME}['"]`,
    'g',
  ),
  // An env object passed around as `env` or `source`: env.X, source.X, env['X'], source?.X
  envAlias: new RegExp(String.raw`(?<![\w$])(?:env|source)(?:\??\.${NAME}|\[\s*['"]${NAME}['"]\s*\])`, 'g'),
  // Helpers that take the env object first: required(source, 'X'), requiredEnum(source, 'X', ...)
  envObjectArg: new RegExp(String.raw`(?<![\w$])[A-Za-z_$][\w$]*\(\s*(?:process\.env|env|source)\s*,\s*['"]${NAME}['"]`, 'g'),
  // Named constants holding an env name: const MAX_ATTEMPTS_ENV = 'X', UNSAFE_DB_ROLE_OPT_OUT_ENV = 'X'
  envNameConst: new RegExp(String.raw`\b[A-Z0-9_]*ENV[A-Z0-9_]*\s*(?::\s*string\s*)?=\s*['"]${NAME}['"]`, 'g'),
};

/**
 * Tokens the scan produces that are not env names. Each must still be produced
 * by the scan (envInventory.test.ts checks this), so this list cannot rot either.
 */
export const SCAN_NOISE: Readonly<Record<string, string>> = {
  BUCKET: "suffix in envFor(region, 'BUCKET') (services/artifacts/blobStorage.ts); real names ARTIFACT_S3_BUCKET_{US,EU} are schema keys",
  ENDPOINT: "suffix in envFor(region, 'ENDPOINT') (services/artifacts/blobStorage.ts); real names are schema keys",
  REGION: "suffix in envFor(region, 'REGION') (services/artifacts/blobStorage.ts); real names are schema keys",
  KEY: 'docblock text `env.KEY` in config/validate.ts (ENV_SCHEMA_KEYS comment)',
  X: 'docblock example `process.env.X` (utils/envFloat.ts, routes/installer.ts, ...)',
  SOME_TTL_MINUTES: 'docblock anti-example `process.env.SOME_TTL_MINUTES` in utils/envInt.ts',
};

function productionSourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const absolute = join(dir, entry.name);
    const rel = relative(SRC_DIR, absolute).split(sep).join('/');
    if (entry.isDirectory()) {
      if (rel === '__tests__' || rel === SELF_DIR) return [];
      return productionSourceFiles(absolute);
    }
    if (!entry.isFile() || !entry.name.endsWith('.ts') || entry.name.endsWith('.test.ts')) return [];
    return [absolute];
  });
}

/** Every token the scan produces, SCAN_NOISE included (callers filter it). */
export function scanApiEnvNames(): Set<string> {
  const names = new Set<string>();
  for (const file of productionSourceFiles(SRC_DIR)) {
    const source = readFileSync(file, 'utf8');
    for (const shape of Object.values(SCAN_SHAPES)) {
      for (const match of source.matchAll(shape)) {
        const name = match[1] ?? match[2];
        if (name) names.add(name);
      }
    }
  }
  for (const key of ENV_SCHEMA_KEYS) names.add(key);
  for (const builtin of BUILTINS) names.add(builtin.enableEnvVar);
  return names;
}
