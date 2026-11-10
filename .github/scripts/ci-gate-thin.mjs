// The thin queue selection the pinned CI Gate publishes (W05, #10749).
//
// `ci-gate.mjs select` runs before the entry's CI fans out. It decides here which
// jobs the entry may skip, writes that as ci-gate-selection.json, and the gate
// uploads it. CI's `changes` job may read it (W05b) and `verify` judges the entry
// against exactly that file. A selection only ever removes jobs:
// thin_skip = would_skip ∩ THINNABLE ∩ the base ci-success's case labels.
//
// Any doubt means mode=full. The kill switch is the repository variable
// CI_THIN_QUEUE: `enforce` thins, `shadow` publishes the real list but runs
// everything, and anything else (unset included) is thin_disabled.
//
// The gate's own checks (pinning, fetching, base flags, the W04 selection, reading
// an artifact) are passed in by ci-gate.mjs, so this module imports no gate code.
import { JOB_CLASSES } from './queue-selection.mjs';

export const SELECTION_FILE = 'ci-gate-selection.json';
export const selectionArtifact = attempt => `ci-gate-selection-attempt-${attempt}`;
// One thin-eligible entry in AUDIT_MODULUS runs full under enforce, so misses keep
// being measured on exact queue shas.
export const AUDIT_MODULUS = 5;
const THIN_QUEUE_ON = ['enforce', 'shadow'];
const MODES = ['thin', 'shadow', 'full'];
export const SELECTION_KEYS = Object.freeze(['schema', 'repository', 'head_sha', 'base_sha', 'head_ref', 'policy_digest', 'gate_run',
  'gate_attempt', 'source_attempt', 'mode', 'reason', 'thin_skip', 'would_skip', 'thin_queue']);

// The only jobs thin may ever skip: W04's build, unit, integration and reader
// classes. Every one is needed only by ci-success, so skipping it skips nothing else.
export const THINNABLE = Object.freeze([...Object.keys(JOB_CLASSES.build), ...Object.keys(JOB_CLASSES.unit),
  ...JOB_CLASSES.integration, ...JOB_CLASSES.readers]);

const JOB_ID = /^[a-z0-9-]+$/;
const isSha = value => typeof value === 'string' && /^[a-f\d]{40}$/i.test(value);
const isCount = value => Number.isSafeInteger(value) && value > 0;
const toCount = value => /^[1-9]\d*$/.test(value ?? '') ? Number(value) : null;
const isNames = value => Array.isArray(value) && value.every(name => typeof name === 'string');
const firstLine = error => String(error?.message ?? error).split('\n')[0].slice(0, 300);

// What ci-success reads as THIN_SKIP: '' for none, else ",a,b," so that
// contains(',<id>,') cannot match part of another id.
export function thinSkipValue(list) {
  for (const job of list) if (typeof job !== 'string' || !JOB_ID.test(job)) throw Error(`thin_skip: not a job id: ${JSON.stringify(job)}`);
  const jobs = [...new Set(list)].sort();
  return jobs.length ? `,${jobs.join(',')},` : '';
}

export const readsThinSkip = aggregator => Object.entries(aggregator.env)
  .some(([name, ref]) => name === 'THIN_SKIP' && ref.kind === 'changes' && ref.key === 'thin_skip');

// The W05 block in a ci-success script (the `aggregator` from extractAggregator):
//
//   for thin_job in ${THIN_SKIP//,/ }; do
//     case "${thin_job}" in
//       test-web) [[ "${TEST_WEB_RESULT}" != "skipped" ]] || TEST_WEB_RESULT=success ;;
//     esac
//   done
//
// Returns its case labels, the jobs that base can count as satisfied when skipped.
// Anything else (no block, a second one, one after the blocking condition, an arm
// in another shape or touching another job's result) is [], which runs everything.
const LOOP = 'for thin_job in ${THIN_SKIP//,/ }; do';
const ARM = /^([a-z0-9-]+)\) \[\[ "\$\{(\w+)\}" != "skipped" \]\] \|\| (\w+)=success ;;$/;
export function thinnableAtBase(aggregator) {
  if (!readsThinSkip(aggregator)) return [];
  const lines = aggregator.script.split('\n').map(line => line.trim()).filter(line => line && !line.startsWith('#'));
  const at = lines.indexOf(LOOP);
  const blocking = lines.findIndex(line => line.startsWith('if [['));
  if (at < 0 || lines.lastIndexOf(LOOP) !== at || (blocking >= 0 && blocking < at) || lines[at + 1] !== 'case "${thin_job}" in') return [];
  const labels = [];
  for (let index = at + 2; index < lines.length; index++) {
    if (lines[index] === 'esac') return lines[index + 1] === 'done' ? labels : [];
    const arm = lines[index].match(ARM);
    const ref = arm && aggregator.env[arm[2]];
    if (!arm || arm[2] !== arm[3] || ref?.kind !== 'result' || ref.job !== arm[1] || labels.includes(arm[1])) return [];
    labels.push(arm[1]);
  }
  return [];
}

export const inAuditSample = head => isSha(head) && parseInt(head.slice(-8), 16) % AUDIT_MODULUS === 0;

// Why a selection body is not usable, or null. Every field of `expected` must match exactly.
export function selectionFailure(value, expected) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return 'not an object';
  if (JSON.stringify(Object.keys(value).sort()) !== JSON.stringify([...SELECTION_KEYS].sort())) return 'keys';
  if (value.schema !== 1) return 'schema';
  for (const [key, want] of Object.entries(expected)) if (value[key] !== want) return key;
  if (typeof value.repository !== 'string' || typeof value.head_ref !== 'string' || typeof value.thin_queue !== 'string') return 'strings';
  if (!isSha(value.head_sha) || !isSha(value.base_sha)) return 'shas';
  if (![value.gate_run, value.gate_attempt, value.source_attempt].every(isCount)) return 'run or attempt';
  if (!MODES.includes(value.mode)) return 'mode';
  if (typeof value.reason !== 'string' || !/^\w*$/.test(value.reason)) return 'reason';
  if (!isNames(value.thin_skip) || !value.thin_skip.every(job => JOB_ID.test(job))) return 'thin_skip';
  if (!isNames(value.would_skip)) return 'would_skip';
  if (value.policy_digest !== null && !/^[a-f\d]{64}$/.test(value.policy_digest)) return 'policy_digest';
  return null;
}

// The fields that bind a selection to one entry and one gate attempt, from the step's env.
export const bindingOf = env => ({ repository: env.GITHUB_REPOSITORY ?? '', head_sha: env.HEAD_SHA ?? '', base_sha: env.BASE_SHA ?? '',
  head_ref: env.HEAD_REF ?? '', gate_run: toCount(env.GITHUB_RUN_ID), gate_attempt: toCount(env.GITHUB_RUN_ATTEMPT) });

// A full selection, which is always safe to publish: it skips nothing.
export function fullSelection(env, reason, extra = {}) {
  const { repository, head_sha, base_sha, head_ref, gate_run, gate_attempt } = bindingOf(env);
  return { published: { schema: 1, repository, head_sha, base_sha, head_ref, policy_digest: null, gate_run, gate_attempt,
    source_attempt: gate_attempt, mode: 'full', reason, thin_skip: [], would_skip: [], thin_queue: env.THIN_QUEUE ?? '' },
  shadow: {}, wouldReason: null, wouldThinSkip: null, ...extra };
}

// Attempt 1 decides. Each check runs only if the ones before it passed; the
// first that fails is the reason. `wouldReason` and `wouldThinSkip` are what
// enforce would publish, for the log only: a full selection publishes no list,
// so nothing that reads the file can skip a job while the kill switch is off.
function decide(io, env, gate) {
  const out = fullSelection(env, '');
  const { published } = out;
  const head = env.HEAD_SHA, base = env.BASE_SHA;
  const check = () => {
    const unpinned = gate.pinFailure(io, env.GITHUB_WORKFLOW_SHA);
    if (unpinned) return { reason: 'not_pinned', detail: unpinned };
    if (!isSha(base) || !isSha(head)) return { reason: 'base_unreadable', detail: 'invalid revision' };
    for (const [name, sha] of [['base', base], ['head', head]]) {
      const cause = gate.fetchFailure(io, sha);
      if (cause) return { reason: 'base_unreadable', detail: `cannot fetch ${name} ${sha}: ${cause}` };
    }
    const flags = gate.flagsAt(io, base, head);
    if (!flags) return { reason: 'no_base_flags' };
    const shadow = gate.queueSelection(io, env, flags);
    if (!isNames(shadow.would_skip)) throw Error('the selection has no would_skip list');
    out.shadow = shadow;
    published.would_skip = shadow.would_skip;
    published.policy_digest = /^[a-f\d]{64}$/.test(shadow.policy_digest ?? '') ? shadow.policy_digest : null;
    if (shadow.mode !== 'shadow') return { reason: /^\w+$/.test(shadow.reason ?? '') ? shadow.reason : 'error' };
    const aggregator = gate.aggregatorAt(io, base);
    const labels = aggregator ? thinnableAtBase(aggregator) : [];
    if (!labels.length) return { reason: 'thin_unsupported_at_base' };
    out.wouldThinSkip = [...new Set(shadow.would_skip.filter(job => THINNABLE.includes(job) && labels.includes(job)))].sort();
    if (!out.wouldThinSkip.length) return { reason: 'nothing_to_skip' };
    if (inAuditSample(head)) return { reason: 'audit_sample' };
    return { reason: '' };
  };
  const { reason, detail } = check();
  const queue = published.thin_queue;
  out.wouldReason = reason;
  if (detail) out.detail = detail;
  if (!THIN_QUEUE_ON.includes(queue)) published.reason = 'thin_disabled';
  else if (reason && !(reason === 'audit_sample' && queue === 'shadow')) published.reason = reason;
  else Object.assign(published, { mode: queue === 'enforce' ? 'thin' : 'shadow', thin_skip: out.wouldThinSkip });
  return out;
}

// A re-run publishes attempt 1's selection, never a new one: CI may already have
// skipped jobs under it. Without a usable one it is full, which can eject the
// entry if CI did skip; that is the fail-closed direction.
function republish(io, env, gate, attempt) {
  const binding = bindingOf(env);
  let first = null, why = null;
  try { first = gate.readArtifact(io, binding.repository, binding.gate_run, selectionArtifact(1), SELECTION_FILE); }
  catch (error) { why = `unreadable: ${firstLine(error)}`; }
  why ??= first === null ? 'not found' : selectionFailure(first, { ...binding, gate_attempt: 1, source_attempt: 1 });
  if (why) return fullSelection(env, 'attempt1_selection_missing', { detail: `attempt 1 selection: ${why}` });
  return { published: { ...first, gate_attempt: attempt, source_attempt: 1 },
    shadow: { would_skip: first.would_skip, policy_digest: first.policy_digest }, wouldReason: null, wouldThinSkip: null };
}

// gate: { pinFailure, fetchFailure, flagsAt, queueSelection, aggregatorAt, readArtifact }.
// Throws on a bug; ci-gate.mjs turns that into mode=full reason=error.
export function choose(io, env, gate) {
  const attempt = toCount(env.GITHUB_RUN_ATTEMPT);
  if (!attempt) throw Error(`GITHUB_RUN_ATTEMPT is not an attempt: ${JSON.stringify(env.GITHUB_RUN_ATTEMPT ?? null)}`);
  return attempt === 1 ? decide(io, env, gate) : republish(io, env, gate, attempt);
}
