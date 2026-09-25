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
export type TopologyKnownKeyRetention={keys:string[];capacity:'ok'|'exceeded';required:number};
/** Keys a source may still withdraw. Current positives sort first. Capacity is
 * explicit (D13): physical admission rejects `exceeded` rather than dropping a
 * key's withdrawal. M1 OS network context keeps the bounded `keys` list — a
 * churning host's dropped old key only loses its explicit withdrawal and its
 * support still ages out — because rejecting would stall the heartbeat channel. */
export function retainTopologyKnownKeys(previous:string[],positives:string[],withdrawn:PendingTopologyMiss[]):TopologyKnownKeyRetention {
  const gone=new Set(withdrawn.flatMap(miss=>miss.rowKeys));
  const all=[...new Set([...positives,...previous])].filter(key=>!gone.has(key));
  return all.length>TOPOLOGY_KNOWN_KEY_LIMIT?{keys:all.slice(0,TOPOLOGY_KNOWN_KEY_LIMIT),capacity:'exceeded',required:all.length}:{keys:all,capacity:'ok',required:all.length};
}

/** Mirrors the CHECK constraints on topology_collection_sources / _runs. */
export const TOPOLOGY_BASELINE_MAX_BYTES=1048576;
export const TOPOLOGY_PENDING_MISSES_MAX_BYTES=524288;
/** Byte length of Postgres' jsonb text rendering (`octet_length(x::text)`):
 * `{"k": v, "k2": v2}` / `[a, b]` — one space after every `:` and `,`. */
export function jsonbTextBytes(value:unknown):number {
  const walk=(v:unknown):number=>{
    if(Array.isArray(v))return v.length?2+v.reduce((n:number,item)=>n+walk(item),0)+2*(v.length-1):2;
    if(v&&typeof v==='object'){
      const entries=Object.entries(v);
      return entries.length?2+entries.reduce((n,[k,child])=>n+Buffer.byteLength(JSON.stringify(k))+2+walk(child),0)+2*(entries.length-1):2;
    }
    return Buffer.byteLength(JSON.stringify(v));
  };
  const json=JSON.stringify(value);
  return json===undefined?0:walk(JSON.parse(json));
}
export type TopologyRetainedCapacity={ok:true}|{ok:false;reason:'snapshot_budget_exceeded';exceeded:'run_snapshot'|'current_baseline'|'published_baseline'|'pending_misses';bytes:number;limit:number};
// `_lastCapture` added by later confirmations; `inputRevision` stamped on new transitions.
const CURRENT_BASELINE_HEADROOM=512, TRANSITION_HEADROOM=48;
// Publication stores `_rowRelationships: {"<rowKey>": ["<uuid>"]}`; physical rows map to exactly one relationship.
const ROW_RELATIONSHIP_ENTRY_BYTES=2+40+2;
/** Whole retained source state (D13): the run snapshot, the current baseline with
 * its known keys, the publication baseline with its row->relationship map, and
 * the pending misses must all fit the stored limits BEFORE admission. Over
 * capacity is a coverage gap; accepted support is never evicted to make room. */
export function assessTopologyRetainedCapacity(input:{snapshot:object;knownKeys:string[];pendingMisses:object;newTransitions?:number}):TopologyRetainedCapacity {
  const snapshotBytes=jsonbTextBytes(input.snapshot);
  const keyBytes=input.knownKeys.reduce((n,key)=>n+Buffer.byteLength(JSON.stringify(key))+2,0);
  const checks:[Extract<TopologyRetainedCapacity,{ok:false}>['exceeded'],number,number][]=[
    ['run_snapshot',snapshotBytes,TOPOLOGY_BASELINE_MAX_BYTES],
    ['current_baseline',jsonbTextBytes({...input.snapshot,_knownKeys:input.knownKeys})+CURRENT_BASELINE_HEADROOM,TOPOLOGY_BASELINE_MAX_BYTES],
    ['published_baseline',snapshotBytes+24+keyBytes+input.knownKeys.length*ROW_RELATIONSHIP_ENTRY_BYTES,TOPOLOGY_BASELINE_MAX_BYTES],
    ['pending_misses',jsonbTextBytes(input.pendingMisses)+(input.newTransitions??0)*TRANSITION_HEADROOM,TOPOLOGY_PENDING_MISSES_MAX_BYTES],
  ];
  for(const [exceeded,bytes,limit] of checks)if(bytes>limit)return {ok:false,reason:'snapshot_budget_exceeded',exceeded,bytes,limit};
  return {ok:true};
}
