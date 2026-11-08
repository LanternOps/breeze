// W07a (#10751): partition the integration suite's files across shards by
// recorded file timing instead of vitest's file-count sharding.
//
// vitest's BaseSequencer.shard hashes every path and slices the sorted list
// into equal COUNTS of files. File cost is long-tailed (3 s to over 100 s), so
// equal counts gave a slowest/mean shard ratio of 1.38 at p50 (2026-11-08).
// apps/api/vitest.integration.config.ts's TimingSequencer calls timingShard()
// below, which packs files by recorded seconds (longest-processing-time greedy)
// from the committed table at TIMINGS_PATH. `test-timings.mjs refresh`
// regenerates that table from CI job logs.
//
// Every shard computes the WHOLE plan from the same file list and table, then
// keeps its own slice; the plan's digest, logged and uploaded by every shard,
// proves they agreed. A missing or invalid table falls back to vitest's own
// sharding with a warning (today's behaviour). Anything else that is wrong — a
// file in no shard, in two, or outside the repository — throws, which fails
// the shard before a single test runs.
import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

export const TIMINGS_PATH = '.github/ci-timings/integration.json';
export const REPO_ROOT = normalize(join(dirname(fileURLToPath(import.meta.url)), '../..'));
export const INTEGRATION_CONFIG = 'apps/api/vitest.integration.config.ts';
// Below this share of files with a recorded timing, the shard log asks for a refresh.
export const STALE_BELOW = 0.9;

export class ShardPlanError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ShardPlanError';
  }
}

// A repo-relative posix key for a vitest module id (absolute) or a table key
// (already relative). Throws for anything outside the repository.
export function toRepoKey(path, repoRoot = REPO_ROOT) {
  const slashed = String(path).replace(/\\/g, '/');
  const root = String(repoRoot).replace(/\\/g, '/').replace(/\/+$/, '');
  let relative;
  if (slashed.startsWith('/') || /^[A-Za-z]:\//.test(slashed)) {
    if (!slashed.startsWith(`${root}/`)) throw new ShardPlanError(`${path} is outside the repository ${repoRoot}`);
    relative = slashed.slice(root.length + 1);
  } else {
    relative = slashed;
  }
  const key = posix.normalize(relative);
  if (key === '.' || key === '..' || key.startsWith('../') || key.startsWith('/')) {
    throw new ShardPlanError(`${path} is outside the repository ${repoRoot}`);
  }
  return key;
}

// Nearest-rank quantile of an ascending list.
export function quantile(sorted, q) {
  if (!sorted.length) throw new RangeError('quantile of an empty list');
  return sorted[Math.min(sorted.length, Math.max(1, Math.ceil(q * sorted.length))) - 1];
}

const isSeconds = v => typeof v === 'number' && Number.isFinite(v) && v >= 0;
const isPlainObject = v => v !== null && typeof v === 'object' && !Array.isArray(v);

// The committed table, or null when it is absent or malformed in any way.
// Unknown files weigh the p75 of the known weights: new files are usually
// small, so this over-weights them, which errs toward a lighter shard.
export function loadTimings(text) {
  if (typeof text !== 'string') return null;
  let data;
  try { data = JSON.parse(text); } catch { return null; }
  if (!isPlainObject(data) || data.schema !== 1 || !isPlainObject(data.files)) return null;
  const weights = Object.values(data.files);
  if (!weights.length || !weights.every(isSeconds)) return null;
  const overhead = data.overhead ?? {};
  if (!isPlainObject(overhead)) return null;
  for (const [shard, seconds] of Object.entries(overhead)) {
    if (!/^[1-9]\d*$/.test(shard) || !isSeconds(seconds)) return null;
  }
  return {
    timings: { ...data.files },
    overhead: { ...overhead },
    defaultSeconds: quantile([...weights].sort((a, b) => a - b), 0.75),
  };
}

// Whole tenths of a second: integer arithmetic keeps every shard's greedy
// choices identical, with no float accumulation to break a tie differently.
const tenths = seconds => Math.round(seconds * 10);
const weigher = ({ timings = {}, defaultSeconds = 1 }) => file => tenths(Object.hasOwn(timings, file) ? timings[file] : defaultSeconds);
const byPath = (a, b) => (a < b ? -1 : a > b ? 1 : 0);

// Longest-processing-time greedy: heaviest file first (ties by path), each to
// the least-loaded shard (ties to the lowest index). Shard i starts at
// overhead[i + 1] seconds, for work only that shard does (shard 1's extra
// steps). The result does not depend on input order; each shard is sorted.
export function partition(files, { count, timings = {}, defaultSeconds = 1, overhead = {} } = {}) {
  if (!Number.isInteger(count) || count < 1) throw new ShardPlanError(`invalid shard count ${count}`);
  if (new Set(files).size !== files.length) throw new ShardPlanError('duplicate file in the partition input');
  const weight = weigher({ timings, defaultSeconds });
  const loads = Array.from({ length: count }, (_, i) => tenths(overhead[String(i + 1)] ?? 0));
  const plan = loads.map(() => []);
  const ordered = files.map(file => [weight(file), file]).sort((a, b) => b[0] - a[0] || byPath(a[1], b[1]));
  for (const [w, file] of ordered) {
    let best = 0;
    for (let i = 1; i < count; i++) if (loads[i] < loads[best]) best = i;
    plan[best].push(file);
    loads[best] += w;
  }
  return plan.map(shard => shard.sort(byPath));
}

// Projected seconds of file work per shard (overhead excluded).
export function planLoads(plan, { timings = {}, defaultSeconds = 1 } = {}) {
  const weight = weigher({ timings, defaultSeconds });
  return plan.map(shard => shard.reduce((sum, file) => sum + weight(file), 0) / 10);
}

export function planDigest(plan) {
  return createHash('sha256').update(JSON.stringify(plan)).digest('hex');
}

// Every file of the run in exactly one shard, and nothing else.
export function assertPartition(plan, files) {
  const expected = new Set(files);
  const seen = new Map();
  for (const shard of plan) for (const file of shard) seen.set(file, (seen.get(file) ?? 0) + 1);
  const list = xs => `${xs.slice(0, 10).join(', ')}${xs.length > 10 ? ` (+${xs.length - 10} more)` : ''}`;
  const missing = files.filter(f => !seen.has(f));
  if (missing.length) throw new ShardPlanError(`file(s) in no shard: ${list(missing)}`);
  const twice = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
  if (twice.length) throw new ShardPlanError(`file(s) in more than one shard: ${list(twice)}`);
  const strangers = [...seen.keys()].filter(f => !expected.has(f));
  if (strangers.length) throw new ShardPlanError(`file(s) in the plan but not in the run: ${list(strangers)}`);
}

// The sequencer core. `specs` are vitest TestSpecifications (only `moduleId`
// is read); returns this shard's specs, or `fallback()` without a usable table.
export function timingShard(specs, { index, count, repoRoot = REPO_ROOT, timingsText, fallback, log = console.log, writePlan } = {}) {
  if (!Number.isInteger(count) || count < 1 || !Number.isInteger(index) || index < 1 || index > count) {
    throw new ShardPlanError(`invalid shard ${index}/${count}`);
  }
  const table = loadTimings(timingsText);
  if (!table) {
    log(`::warning title=Shard timing unavailable::${TIMINGS_PATH} is missing or invalid, so shard ${index}/${count} uses vitest's file-count sharding.`);
    return fallback();
  }
  const byKey = new Map();
  for (const spec of specs) {
    const key = toRepoKey(spec.moduleId, repoRoot);
    if (byKey.has(key)) throw new ShardPlanError(`${key} was handed to the sequencer twice`);
    byKey.set(key, spec);
  }
  const keys = [...byKey.keys()];
  const plan = partition(keys, { count, ...table });
  assertPartition(plan, keys);
  const mine = plan[index - 1];
  const loads = planLoads(plan, table);
  const digest = planDigest(plan);
  const known = keys.filter(k => Object.hasOwn(table.timings, k)).length;
  log(`shard-plan: shard=${index}/${count} files=${mine.length}/${keys.length} known=${known}/${keys.length} `
    + `projected=${Math.round(loads[index - 1])}s max=${Math.round(Math.max(...loads))}s planDigest=${digest}`);
  if (keys.length && known / keys.length < STALE_BELOW) {
    log(`::warning title=Shard timing stale::Only ${known}/${keys.length} integration files have a recorded timing; run \`node .github/scripts/test-timings.mjs refresh\`.`);
  }
  writePlan?.({ index, count, total: keys.length, files: mine, projectedSeconds: loads[index - 1], planDigest: digest });
  return mine.map(key => byKey.get(key));
}

// ── The integration suite's file list, from its vitest config ───────────────

function globRegex(glob) {
  if (/[{}[\]!()]/.test(glob)) throw new ShardPlanError(`unsupported glob syntax in ${glob}`);
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*' && glob[i + 1] === '*') {
      i++;
      if (glob[i + 1] === '/') { i++; re += '(?:.*/)?'; } else re += '.*';
    } else if (c === '*') re += '[^/]*';
    else if (c === '?') re += '[^/]';
    else re += c.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

// The first `<name>: [ ... ]` string list in the config, comments dropped.
function configList(source, name) {
  const code = source.split('\n').filter(line => !/^\s*\/\//.test(line)).join('\n');
  const body = code.match(new RegExp(`\\b${name}:\\s*\\[([\\s\\S]*?)\\]`))?.[1];
  if (body === undefined) throw new ShardPlanError(`cannot parse ${name} from ${INTEGRATION_CONFIG}`);
  return [...body.replace(/\/\/[^\n]*/g, '').matchAll(/'([^']+)'|"([^"]+)"/g)].map(m => m[1] ?? m[2]);
}

function walk(dir, prefix, out) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === 'dist') continue;
    const rel = `${prefix}${entry.name}`;
    if (entry.isDirectory()) walk(join(dir, entry.name), `${rel}/`, out);
    else if (entry.isFile()) out.push(rel);
  }
  return out;
}

// Repo-relative paths of the files `vitest run --config vitest.integration.config.ts`
// resolves: test.include minus test.exclude, relative to apps/api. Only `*`,
// `**` and `?` globs are supported; anything else throws rather than guess.
export function integrationTestFiles(repoRoot = REPO_ROOT) {
  const source = readFileSync(join(repoRoot, INTEGRATION_CONFIG), 'utf8');
  const include = configList(source, 'include').map(globRegex);
  const exclude = configList(source, 'exclude').map(globRegex);
  return walk(join(repoRoot, 'apps/api/src'), 'src/', [])
    .filter(f => include.some(re => re.test(f)) && !exclude.some(re => re.test(f)))
    .map(f => `apps/api/${f}`)
    .sort(byPath);
}
