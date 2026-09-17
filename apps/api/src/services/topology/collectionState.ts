import type { TopologyCaptureTime, PendingTopologyMiss, PendingTopologyLifecycle } from './collectionTypes';
import { compareTopologySequences } from './sequence';

export function effectiveTopologyCapture(capturedAt: string, ageMs: number | null, cadence: number, receivedAt: Date): TopologyCaptureTime {
  const captured = Date.parse(capturedAt);
  if (ageMs === null || !Number.isFinite(captured) || captured > receivedAt.getTime()+300_000) return {effectiveAt:null,freshUntil:null};
  const effectiveAt = new Date(Math.min(captured,receivedAt.getTime()-ageMs));
  return {effectiveAt,freshUntil:new Date(effectiveAt.getTime()+Math.max(3*cadence,900)*1000)};
}

/** An unchanged real read can supply the qualifying second miss without history. */
export function qualifyTopologyMiss(pending: PendingTopologyMiss | null, input: {
  digest: string; sequence: string; effectiveAt: Date | null; outcome: string;
}): PendingTopologyMiss | null {
  if (!pending || pending.qualifyingSequence || input.outcome !== 'complete' || !input.effectiveAt
    || pending.digest !== input.digest || compareTopologySequences(input.sequence,pending.firstSequence) <= 0
    || input.effectiveAt.getTime()-Date.parse(pending.firstEffectiveAt)<300_000) return pending;
  return {...pending,qualifyingSequence:input.sequence,qualifyingEffectiveAt:input.effectiveAt.toISOString()};
}

export type TopologyAbsenceState = { active: PendingTopologyMiss[]; transitions: PendingTopologyMiss[]; lifecycle?:PendingTopologyLifecycle[] };
export function readTopologyAbsence(value: Record<string,unknown>): TopologyAbsenceState {
  return {active:Array.isArray(value.active)?value.active as PendingTopologyMiss[]:[],transitions:Array.isArray(value.transitions)?value.transitions as PendingTopologyMiss[]:[],lifecycle:Array.isArray(value.lifecycle)?value.lifecycle as PendingTopologyLifecycle[]:[]};
}
/** Preserve already accepted transitions until publication even when a later
 * positive arrives. Only unresolved streaks are invalidated by quota gaps. */
export function advanceTopologyAbsence(state: TopologyAbsenceState,input:{
  sequence:string;digest:string;effectiveAt:Date|null;outcome:string;positiveKeys:string[];previousKeys:string[];
  generation:string;
}): {state:TopologyAbsenceState;newTransitions:PendingTopologyMiss[]} {
  const positive=new Set(input.positiveKeys);
  let active=state.active.map(group=>({...group,rowKeys:group.rowKeys.filter(key=>!positive.has(key))})).filter(group=>group.rowKeys.length>0);
  const newTransitions:PendingTopologyMiss[]=[];
  if (input.outcome==='complete' && input.effectiveAt) {
    const retained=new Set(active.flatMap(group=>group.rowKeys));
    const missing=input.previousKeys.filter(key=>!positive.has(key)&&!retained.has(key));
    if (missing.length) active.push({generation:input.generation,firstSequence:input.sequence,firstEffectiveAt:input.effectiveAt.toISOString(),digest:input.digest,rowKeys:missing});
    active=active.map(group=>{
      const next=qualifyTopologyMiss({...group,digest:input.digest},input)!;
      if (next.qualifyingSequence && !group.qualifyingSequence) newTransitions.push(next);
      return next;
    // A queued withdrawal is owned by `transitions`; keeping its streak as well
    // would retain every key a churning section has ever dropped.
    }).filter(group=>!group.qualifyingSequence);
  }
  return {state:{...state,active,transitions:[...state.transitions,...newTransitions]},newTransitions};
}

export const TOPOLOGY_KNOWN_KEY_LIMIT=16384;
/** Keys a source may still withdraw. Current positives sort first so the cap
 * only costs an old key its explicit withdrawal; its support still ages out. */
export function retainTopologyKnownKeys(previous:string[],positives:string[],withdrawn:PendingTopologyMiss[]):string[] {
  const gone=new Set(withdrawn.flatMap(miss=>miss.rowKeys));
  return [...new Set([...positives,...previous])].filter(key=>!gone.has(key)).slice(0,TOPOLOGY_KNOWN_KEY_LIMIT);
}
