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
type RouteRow=Extract<TopologySourceSection,{kind:'routes'}>['rows'][number];
const HALF_DEFAULT_LOW:Readonly<Record<string,string>>={'0.0.0.0/1':'128.0.0.0/1','::/1':'8000::/1'};
const DEFAULT_ROUTE_TYPES=['unicast','on_link'];
export type HalfDefaultPair={low:RouteRow;high:RouteRow;hop:{address:string;zone:string|null;interfaceKey:string|null};factKey:string};
/** Full-tunnel VPN clients cover the whole address space with two half-default
 * routes (0.0.0.0/1 + 128.0.0.0/1, or ::/1 + 8000::/1) instead of replacing the
 * default route (#7820). A pair counts only when both halves sit in the same
 * routing table and share a next hop (address, zone and interface); a lone half
 * is not a default route. `factKey` is a positive key of its own, so the pair is
 * withdrawn as soon as EITHER half disappears — a per-half key would keep the
 * pair supported by the surviving half. Next hops without an address are
 * skipped, as for 0.0.0.0/0. */
export function halfDefaultRoutePairs(rows:readonly RouteRow[]):HalfDefaultPair[]{
 const eligible=rows.filter(row=>DEFAULT_ROUTE_TYPES.includes(row.routeType));
 const pairs=new Map<string,HalfDefaultPair>();
 for(const low of eligible){
  const highPrefix=HALF_DEFAULT_LOW[low.destinationPrefix];if(!highPrefix)continue;
  for(const high of eligible){
   if(high.destinationPrefix!==highPrefix||high.tableKey!==low.tableKey)continue;
   for(const lowHop of low.nextHops){
    if(!lowHop.address)continue;
    const hop={address:lowHop.address,zone:lowHop.zone,interfaceKey:lowHop.interfaceKey??low.interfaceKey};
    if(!high.nextHops.some(h=>h.address===hop.address&&h.zone===hop.zone&&(h.interfaceKey??high.interfaceKey)===hop.interfaceKey))continue;
    const factKey=topologyFactKey(low.rowKey,['half_default',high.rowKey,hop]);
    pairs.set(factKey,{low,high,hop,factKey});
   }
  }
 }
 return [...pairs.values()];
}
/** Dispatches by typed source family (D15.4). Physical families withdraw per
 * row: the row keys are the shared-schema row keys (FDB includes `shared_port`
 * rows), and the physical projector maps each eligible row to exactly one
 * relationship through the same rowKey machinery. */
export function topologyPositiveKeys(section:TopologySourceSection):string[]{
 switch(section.kind){
  case 'interfaces':return section.rows.flatMap(row=>[row.rowKey,...row.addresses.filter(a=>['preferred','deprecated'].includes(a.state)).map(a=>topologyFactKey(row.rowKey,[a.address,a.prefixLength,a.zone]))]);
  case 'routes':return [...section.rows.flatMap(row=>[row.rowKey,...row.nextHops.map(hop=>topologyFactKey(row.rowKey,hop))]),...halfDefaultRoutePairs(section.rows).map(pair=>pair.factKey)];
  case 'rules':case 'resolvers':case 'neighbors':
  case 'lldp':case 'cdp':case 'fdb':case 'snmp_interfaces':
  case 'unifi_device_list':case 'unifi_client_list':case 'unifi_device_details':case 'unifi_statistics':
   return (section.rows as {rowKey:string}[]).map(row=>row.rowKey);
  default:{const unknown:never=section;throw new Error(`unsupported_source_family:${(unknown as {kind:string}).kind}`);}
 }
}
