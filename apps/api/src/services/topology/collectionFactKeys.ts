import { createHash } from 'node:crypto';
import type { TopologyContextSection } from '@breeze/shared';
export function canonicalFactValue(value:unknown):unknown {
 if(Array.isArray(value))return value.map(canonicalFactValue);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,canonicalFactValue(child)]));
 return value;
}
/** Compound rows can contain several independently withdrawn graph facts. */
export function topologyFactKey(rowKey:string,detail:unknown):string {
 return createHash('sha256').update(JSON.stringify(canonicalFactValue([rowKey,detail]))).digest('hex');
}
export function topologyPositiveKeys(section:TopologyContextSection):string[]{
 if(section.kind==='interfaces')return section.rows.flatMap(row=>[row.rowKey,...row.addresses.filter(a=>['preferred','deprecated'].includes(a.state)).map(a=>topologyFactKey(row.rowKey,[a.address,a.prefixLength,a.zone]))]);
 if(section.kind==='routes')return section.rows.flatMap(row=>[row.rowKey,...row.nextHops.map(hop=>topologyFactKey(row.rowKey,hop))]);
 return section.rows.map(row=>row.rowKey);
}
