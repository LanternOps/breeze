// Apply one decision (W06b B3, #10750).
//
// shadow / off: the decision is recorded and nothing else happens. This path
//   takes no writer, so there is nothing it could write with.
// act:
//   1. Re-read the PR and re-check the decision against it (rule 1 of
//      decide.mjs, the expected head, and that this removal is still the
//      latest). Stale → `skipped`, no write.
//   2. Post the decision comment with its marker at `intent`, unless the
//      operator already posted one for this action and decision.
//   3. Run the mutations in order. Each checks state first, so a re-run after
//      a crash only does what is left. The mode is re-read before each one;
//      if it is no longer `act`, stop → `partial` (the tick keeps it pending).
//   4. Edit the marker to `done`.
import { isSelfRemoval, staleReasons } from './decide.mjs';
import { latestMarker, parseMarkers, renderComment } from './markers.mjs';

export const MODES = new Set(['off', 'shadow', 'act']);
export const MODE_VARIABLE = 'CI_SHEPHERD_MODE';

// Unset → shadow. Unreadable or not one of off|shadow|act → shadow, with a
// warning. Only a readable, exact `act` lets the shepherd write.
// `degraded` is true when the variable could not be read at all (a network
// error or a non-200/404 answer): the tick must not consume work on it.
export async function readModeDetail(gh, repo) {
  let res;
  try {
    res = await gh.rest('GET', `repos/${repo}/actions/variables/${MODE_VARIABLE}`);
  } catch (e) {
    if (e.name === 'BudgetExceeded') throw e;
    return { mode: 'shadow', degraded: true, warning: `${MODE_VARIABLE} unreadable (${e.message}); using shadow` };
  }
  if (res.status === 404) return { mode: 'shadow', degraded: false, warning: null };
  if (res.status !== 200) return { mode: 'shadow', degraded: true, warning: `${MODE_VARIABLE} read failed (${res.status}); using shadow` };
  const value = String(res.body?.value ?? '').trim();
  if (MODES.has(value)) return { mode: value, degraded: false, warning: null };
  return { mode: 'shadow', degraded: false, warning: `${MODE_VARIABLE} has invalid value ${JSON.stringify(value).slice(0, 40)}; using shadow` };
}

export async function readMode(gh, repo, { warn = () => {} } = {}) {
  const r = await readModeDetail(gh, repo);
  if (r.warning) warn(r.warning);
  return r.mode;
}

// Why a decision no longer fits the PR, or null.
export function precheck(decision, snapshot, { selfOps = [], now = null } = {}) {
  const e = decision.expect ?? {};
  if (e.state && snapshot.state !== e.state) return `pr_${String(snapshot.state).toLowerCase()}`;
  if (e.head && snapshot.headSha !== e.head) return 'head_moved';
  // A stuck re-queue dequeues first; once its own dequeue is recorded, a
  // resumed attempt must go on to the enqueue, not stop at "not queued".
  const dequeuedBySelf = selfOps.some((o) => o.pr === decision.pr && o.op === 'dequeue' && Date.parse(o.at) >= Date.parse(decision.at));
  if (e.queued === true && !snapshot.queue && !dequeuedBySelf) return 'not_queued';
  if (e.removalId) {
    const removal = { id: e.removalId, at: decision.removalAt, reason: 'failed_checks', pr: decision.pr };
    const stale = staleReasons(removal, snapshot, { selfOps, now });
    if (stale.length) return stale[0];
    const latest = snapshot.events.filter((ev) => ev.type === 'removed' && !isSelfRemoval(ev, snapshot.pr, selfOps)).at(-1);
    if (latest && latest.id !== e.removalId && Date.parse(latest.at) > Date.parse(decision.removalAt)) return 'newer_removal';
  }
  return null;
}

export function markerOf(decision, status) {
  return {
    v: 1,
    action: decision.actionId,
    pr: decision.pr,
    head: decision.head,
    run: decision.run ?? null,
    attempt: decision.attempt ?? null,
    removal: decision.removalId ?? null,
    class: decision.class ?? null,
    decision: decision.kind,
    hold_reason: decision.holdReason,
    status,
    removals: decision.n,
    limit: decision.limit,
    at: decision.at,
  };
}

// ctx = { mode, repo, viewer, writer, reread(pr) → PrSnapshot,
//   modeNow() → mode, record(entry), onSelfOp(op), clock() → ms, selfOps }.
export async function apply(gh, decision, ctx) {
  const record = (status, extra = {}) => ctx.record?.({ ...decision, mode: ctx.mode, status, ...extra });
  if (ctx.mode !== 'act') {
    record('shadow');
    return { status: 'shadow' };
  }
  if (!ctx.writer) throw new Error('apply: act mode needs a writer');
  if (decision.kind === 'noop' || !decision.mutations.length) {
    record('applied');
    return { status: 'applied' };
  }
  const w = ctx.writer;
  const stillAct = async () => (await ctx.modeNow()) === 'act';

  // Repo-level decisions (breakers): no PR, no marker. The tick keeps their
  // action ids so each runs once.
  if (decision.pr === null) {
    const out = {};
    for (const m of decision.mutations) {
      if (!(await stillAct())) {
        record('partial', { reason: 'mode_changed' });
        return { status: 'partial', reason: 'mode_changed' };
      }
      if (m.op === 'dispatch_main_ci') await w.dispatchMainCi();
      else if (m.op === 'issue_upsert') out.issue = await w.issueUpsert(m.args);
      else throw new Error(`apply: ${m.op} needs a PR`);
    }
    record('applied', out);
    return { status: 'applied', ...out };
  }

  const snap = await ctx.reread(decision.pr);
  const stale = precheck(decision, snap, { selfOps: ctx.selfOps ?? [], now: ctx.clock?.() ?? null });
  if (stale) {
    record('skipped', { reason: stale });
    return { status: 'skipped', reason: stale };
  }

  const markers = parseMarkers(await w.comments(decision.pr), { viewer: ctx.viewer });
  const existing = latestMarker(markers, decision.actionId);
  let commentId;
  if (existing && existing.decision === decision.kind) {
    if (existing.status === 'done') {
      record('applied', { reason: 'already_done' });
      return { status: 'applied', reason: 'already_done' };
    }
    commentId = existing.commentId;
  } else {
    if (!(await stillAct())) {
      record('partial', { reason: 'mode_changed' });
      return { status: 'partial', reason: 'mode_changed' };
    }
    commentId = await w.postComment(decision.pr, renderComment(decision, markerOf(decision, 'intent')));
  }

  const state = { autoMerge: snap.autoMerge, queued: Boolean(snap.queue), labels: new Set(snap.labels) };
  for (const m of decision.mutations) {
    if (m.op === 'comment') continue; // the marker comment posted above
    if (!(await stillAct())) {
      record('partial', { reason: 'mode_changed' });
      return { status: 'partial', reason: 'mode_changed' };
    }
    switch (m.op) {
      case 'disable_auto_merge':
        if (state.autoMerge) await w.disableAutoMerge(snap.id);
        state.autoMerge = false;
        break;
      case 'dequeue':
        if (state.queued) {
          // Recorded before the call: the queue logs this as a `manual`
          // removal by the operator login, which must not read as human intent.
          await ctx.onSelfOp?.({ pr: decision.pr, op: 'dequeue', at: new Date(ctx.clock()).toISOString() });
          await w.dequeue(snap.id);
        }
        state.queued = false;
        break;
      case 'enqueue':
      case 'enable_auto_merge':
        if (!state.queued && !(m.op === 'enable_auto_merge' && state.autoMerge) && snap.state === 'OPEN' && snap.headSha === (decision.expect?.head ?? snap.headSha)) {
          await w.enqueue(decision.pr);
        }
        state.queued = true;
        state.autoMerge = true;
        break;
      case 'label_add':
        if (!state.labels.has(m.args.name)) await w.addLabel(decision.pr, m.args.name);
        state.labels.add(m.args.name);
        break;
      case 'label_remove':
        if (state.labels.has(m.args.name)) await w.removeLabel(decision.pr, m.args.name);
        state.labels.delete(m.args.name);
        break;
      default:
        throw new Error(`apply: unknown op ${m.op}`);
    }
  }
  if (!(await stillAct())) {
    record('partial', { reason: 'mode_changed' });
    return { status: 'partial', reason: 'mode_changed' };
  }
  await w.editComment(commentId, renderComment(decision, markerOf(decision, 'done')));
  record('applied');
  return { status: 'applied' };
}

