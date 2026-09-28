import { createHash } from 'node:crypto';
import type { TopologySourceSection } from './collectionTypes';
export function canonicalFactValue(value:unknown):unknown {
 if(Array.isArray(value))return value.map(canonicalFactValue);
 if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).sort(([a],[b])=>a.localeCompare(b)).map(([key,child])=>[key,canonicalFactValue(child)]));
 return value;
}
/** Compound rows can contain several independently withdrawn graph facts. */
export function topologyFactKey(rowKey:string,detail:unknown):string {
 return createHash('sha256').update(JSON.stringify(canonicalFactValue([rowKey,detail]))).digest('hex');
}
/** Dispatches by typed source family (D15.4). Physical families withdraw per
 * row: the row keys are the shared-schema row keys (FDB includes `shared_port`
 * rows), and the physical projector maps each eligible row to exactly one
 * relationship through the same rowKey machinery. */
export function topologyPositiveKeys(section:TopologySourceSection):string[]{
 switch(section.kind){
  case 'interfaces':return section.rows.flatMap(row=>[row.rowKey,...row.addresses.filter(a=>['preferred','deprecated'].includes(a.state)).map(a=>topologyFactKey(row.rowKey,[a.address,a.prefixLength,a.zone]))]);
  case 'routes':return section.rows.flatMap(row=>[row.rowKey,...row.nextHops.map(hop=>topologyFactKey(row.rowKey,hop))]);
  case 'rules':case 'resolvers':case 'neighbors':
  case 'lldp':case 'cdp':case 'fdb':case 'snmp_interfaces':
  case 'unifi_device_list':case 'unifi_client_list':case 'unifi_device_details':case 'unifi_statistics':
   return (section.rows as {rowKey:string}[]).map(row=>row.rowKey);
  default:{const unknown:never=section;throw new Error(`unsupported_source_family:${(unknown as {kind:string}).kind}`);}
 }
}
