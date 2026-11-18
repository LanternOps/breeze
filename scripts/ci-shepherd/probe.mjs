// `shepherd.mjs probe --pr <n>` (W06b B3, #10750): the G-act leg. On a
// throwaway PR labelled `ci-shepherd:probe`, in act mode only, it applies a
// synthetic hold and then a resume through apply(), so the real write path
// (auto-merge off, dequeue, labels, the marker edit, enqueue) runs end to end
// with the operator token. It refuses anything else.
import { apply, readMode } from './apply.mjs';
import { LABELS } from './decide.mjs';
import { headPushedAt, prSnapshot } from './facts.mjs';
import { acquireLock, loadState, releaseLock, saveState } from './state.mjs';
import { createWriter, readOnlyGitHub } from './writer.mjs';

const iso = (t) => new Date(t).toISOString().replace(/\.\d{3}Z$/, 'Z');

// It holds the tick's lock (no tick runs beside it) and records its dequeue
// in the tick's state, so the next tick does not read it as human intent.
export async function probe({ gh, repo, pr, exec, stateDir, now = Date.now(), clock = () => Date.now(), record = () => {} }) {
  const lock = acquireLock(stateDir, now);
  if (!lock.ok) return { status: 'refused', reason: `a tick holds the lock (since ${lock.heldSince})` };
  try {
    return await probeLocked({ gh, repo, pr, exec, stateDir, now, clock, record });
  } finally {
    releaseLock(stateDir, lock.token);
  }
}

async function probeLocked({ gh, repo, pr, exec, stateDir, now, clock, record }) {
  const ro = readOnlyGitHub(gh);
  const mode = await readMode(ro, repo);
  if (mode !== 'act') return { status: 'refused', reason: `mode is ${mode}, not act` };
  const snapshot = async (n) => {
    const s = await prSnapshot(ro, { repo, pr: n, withFiles: false });
    return { ...s, headPushedAt: await headPushedAt(ro, { repo, headSha: s.headSha }) };
  };
  const snap = await snapshot(pr);
  if (!snap.labels.includes(LABELS.probe)) return { status: 'refused', reason: `PR lacks the ${LABELS.probe} label` };
  if (snap.state !== 'OPEN' || snap.isFork) return { status: 'refused', reason: 'PR is not an open same-repo PR' };
  const viewer = (await gh.rest('GET', 'user')).body?.login;
  const { state } = loadState(stateDir);
  const selfOps = state.selfOps;
  const ctx = {
    mode,
    repo,
    viewer,
    writer: createWriter({ gh, exec, repo }),
    reread: snapshot,
    modeNow: () => readMode(ro, repo),
    clock,
    selfOps,
    onSelfOp: (op) => {
      selfOps.push(op);
      saveState(stateDir, state);
    },
    record,
  };
  const base = { pr, head: snap.headSha, class: null, signature: null, at: iso(now), expect: { state: 'OPEN', head: snap.headSha } };
  const head12 = snap.headSha.slice(0, 12);
  const hold = {
    ...base,
    actionId: `${pr}:${head12}:probe:${now}`,
    kind: 'hold',
    holdReason: 'probe',
    reasons: ['probe'],
    mutations: [
      { op: 'disable_auto_merge', args: {} },
      { op: 'dequeue', args: {} },
      { op: 'label_add', args: { name: LABELS.hold } },
      { op: 'comment', args: {} },
    ],
  };
  const resume = {
    ...base,
    actionId: `${pr}:${head12}:probe-resume:${now}`,
    kind: 'resume',
    reasons: ['probe'],
    mutations: [
      { op: 'label_remove', args: { name: LABELS.hold } },
      { op: 'enable_auto_merge', args: {} },
      { op: 'comment', args: {} },
    ],
  };
  const held = await apply(gh, hold, ctx);
  if (held.status !== 'applied') return { status: 'failed', step: 'hold', result: held };
  const resumed = await apply(gh, resume, ctx);
  if (resumed.status !== 'applied') return { status: 'failed', step: 'resume', result: resumed };
  return { status: 'applied', calls: gh.calls };
}
