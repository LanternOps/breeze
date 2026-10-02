import { describe,expect,it } from 'vitest';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { projectBaselineTopology } from './baselineProjector';
import { topologyPositiveKeys } from './collectionFactKeys';
import type { BaselineProjectionInput as TopologyProjectionInput } from './reconciliationTypes';
const scope={orgId:'10000000-0000-4000-8000-000000000001',siteId:'20000000-0000-4000-8000-000000000001'};
function fixture():TopologyProjectionInput{
 const report=networkContextFixture();
 return {scope,originNodeId:'30000000-0000-4000-8000-000000000001',nodes:[],relationships:[],interfaces:[],
 source:{id:'40000000-0000-4000-8000-000000000001',producerId:'50000000-0000-4000-8000-000000000001',producerEpoch:'epoch',contextKey:'main'} as TopologyProjectionInput['source'],
 run:{id:'60000000-0000-4000-8000-000000000001',sequence:'1',contentDigest:'a'.repeat(64),observedAt:new Date(0),effectiveAt:new Date(0),receivedAt:new Date(0),expectedIntervalSeconds:300} as TopologyProjectionInput['run'],
 snapshot:{section:report.sections.find(s=>s.kind==='interfaces')!} as TopologyProjectionInput['snapshot']};
}
describe('baseline projection',()=>{
 it('keeps prefixes observer-local and preserves all default route alternatives',()=>{
  const f=fixture(),interfaces=projectBaselineTopology(f);const report=networkContextFixture();
  const routes=projectBaselineTopology({...f,interfaces:interfaces.interfaces,snapshot:{...f.snapshot,section:report.sections.find(s=>s.kind==='routes')!}});
  expect(interfaces.relationships.every(r=>r.kind==='network_member'&&r.evidenceClass==='inferred')).toBe(true);
  expect(routes.relationships.length).toBeGreaterThan(0);
  expect(routes.relationships.every(r=>r.kind==='default_route'&&r.sourceNodeId===f.originNodeId)).toBe(true);
  const other=projectBaselineTopology({...f,source:{...f.source,producerId:crypto.randomUUID()}});
  expect(other.nodes[0]!.id).not.toBe(interfaces.nodes[0]!.id);
 });
 it('emits no facts for failed reads or unidentified gateways',()=>{
  const f=fixture();expect(projectBaselineTopology({...f,snapshot:{...f.snapshot,section:{...f.snapshot.section,rows:[],rowCount:0,outcome:'failed'}}}).relationships).toEqual([]);
  const section=networkContextFixture().sections.find(s=>s.kind==='routes')!;
  if(section.kind==='routes')for(const row of section.rows)for(const hop of row.nextHops)hop.address=null;
  expect(projectBaselineTopology({...f,snapshot:{...f.snapshot,section}}).nodes).toEqual([]);
 });
});

// #7820: full-tunnel VPN clients install 0.0.0.0/1 + 128.0.0.0/1 (or ::/1 + 8000::/1)
// instead of replacing the default route. Only a complete pair on one hop is a default route.
describe('half-default route pairs',()=>{
 type Hop={address:string|null;zone:string|null;interfaceKey:string|null;weight:number|null};
 type RouteRow={rowKey:string;family:'ipv4'|'ipv6';destinationPrefix:string;interfaceKey:string|null;tableKey:string;routeType:string;metric:number|null;nextHops:Hop[];osFlags:number};
 const ifaceRow=(key:string,kind:string,address:string,prefixLength:number,family:'ipv4'|'ipv6')=>({rowKey:key,interfaceKey:key,osIndex:1,name:key,kind,adminState:'up',operState:'up',mtu:1500,
  addresses:[{address,prefixLength,family,zone:null,state:'preferred',assignment:'static'}]});
 const route=(rowKey:string,destinationPrefix:string,interfaceKey:string|null,address:string|null,over:Partial<RouteRow>={}):RouteRow=>({rowKey,
  family:destinationPrefix.includes(':')?'ipv6':'ipv4',destinationPrefix,interfaceKey,tableKey:'main',routeType:'unicast',metric:0,
  nextHops:[{address,zone:null,interfaceKey,weight:null}],osFlags:0,...over});
 /** Projects eth0 (LAN), tun0 and tun1 first so route rows can resolve their interfaces. */
 function project(rows:RouteRow[],family:'ipv4'|'ipv6'='ipv4'){
  const f=fixture();
  const ifaces=family==='ipv4'?[ifaceRow('if-1','ethernet','192.0.2.10',24,'ipv4'),ifaceRow('tun0','tunnel','10.8.0.2',24,'ipv4'),ifaceRow('tun1','tunnel','10.9.0.2',24,'ipv4')]
   :[ifaceRow('if-1','ethernet','2001:db8::10',64,'ipv6'),ifaceRow('tun0','tunnel','2001:db8:8::2',64,'ipv6'),ifaceRow('tun1','tunnel','2001:db8:9::2',64,'ipv6')];
  const interfaces=projectBaselineTopology({...f,snapshot:{...f.snapshot,section:{kind:'interfaces',contextKey:'default',addressFamily:family,contentDigest:'b'.repeat(64),outcome:'complete',rowCount:3,rows:ifaces}} as never});
  const section={kind:'routes',contextKey:'default',addressFamily:family,contentDigest:'c'.repeat(64),outcome:'complete',rowCount:rows.length,rows};
  const delta=projectBaselineTopology({...f,interfaces:interfaces.interfaces,snapshot:{...f.snapshot,section} as never});
  const ifaceId=(key:string)=>interfaces.interfaces.find(i=>i.interfaceKey===key)!.id;
  return {delta,section,ifaceId,gatewayAddress:(id:string)=>delta.nodes.find(n=>n.id===id)?.attributes?.label};
 }
 const lan=route('lan-default','0.0.0.0/0','if-1','192.0.2.1');
 it('projects the IPv4 pair as one default route on the tunnel interface, alongside the LAN default',()=>{
  const {delta,ifaceId,gatewayAddress}=project([lan,route('vpn-low','0.0.0.0/1','tun0','10.8.0.1'),route('vpn-high','128.0.0.0/1','tun0','10.8.0.1')]);
  expect(delta.relationships).toHaveLength(2);
  expect(delta.relationships.every(r=>r.kind==='default_route'&&r.evidenceClass==='observed')).toBe(true);
  const vpn=delta.relationships.find(r=>gatewayAddress(r.targetNodeId)==='10.8.0.1')!;
  expect(vpn.sourceInterfaceId).toBe(ifaceId('tun0'));
  expect(vpn.logicalContext?.interfaceId).toBe(ifaceId('tun0'));
  expect(vpn.attributes).toEqual({method:'os_network_context',halfDefault:true});
  const lanRoute=delta.relationships.find(r=>gatewayAddress(r.targetNodeId)==='192.0.2.1')!;
  expect(lanRoute.sourceInterfaceId).toBe(ifaceId('if-1'));
  expect(lanRoute.attributes).toEqual({method:'os_network_context'});
  expect(delta.observations).toHaveLength(2);expect(delta.support).toHaveLength(2);
 });
 it('yields one default route per next hop present in both halves',()=>{
  const hops:Hop[]=[{address:'10.8.0.1',zone:null,interfaceKey:'tun0',weight:1},{address:'10.8.0.254',zone:null,interfaceKey:'tun0',weight:1}];
  const {delta,gatewayAddress}=project([route('vpn-low','0.0.0.0/1','tun0',null,{nextHops:hops}),
   route('vpn-high','128.0.0.0/1','tun0',null,{nextHops:[...hops,{address:'10.8.0.9',zone:null,interfaceKey:'tun0',weight:1}]})]);
  expect(delta.relationships.map(r=>gatewayAddress(r.targetNodeId)).sort()).toEqual(['10.8.0.1','10.8.0.254']);
 });
 it('matches the next hop on its effective interface (hop interface, else the row interface)',()=>{
  const viaRow=(rowKey:string,prefix:string,hopInterface:string|null)=>route(rowKey,prefix,'tun0',null,{nextHops:[{address:'10.8.0.1',zone:null,interfaceKey:hopInterface,weight:null}]});
  const paired=project([viaRow('a','0.0.0.0/1',null),viaRow('b','128.0.0.0/1','tun0')]);
  expect(paired.delta.relationships).toHaveLength(1);
  expect(paired.delta.relationships[0]!.sourceInterfaceId).toBe(paired.ifaceId('tun0'));
  expect(project([viaRow('a','0.0.0.0/1',null),viaRow('b','128.0.0.0/1','tun1')]).delta.relationships).toEqual([]);
 });
 it('maps the same pair to the same relationship regardless of row order',()=>{
  const rows=[route('vpn-low','0.0.0.0/1','tun0','10.8.0.1'),route('vpn-high','128.0.0.0/1','tun0','10.8.0.1')];
  expect(project(rows).delta.relationships[0]!.id).toBe(project([...rows].reverse()).delta.relationships[0]!.id);
 });
 it('treats a single half as no default route',()=>{
  expect(project([route('vpn-low','0.0.0.0/1','tun0','10.8.0.1')]).delta.relationships).toEqual([]);
  expect(project([route('vpn-high','128.0.0.0/1','tun0','10.8.0.1')]).delta.relationships).toEqual([]);
  expect(project([route('vpn-high','8000::/1','tun0','2001:db8:8::1')],'ipv6').delta.relationships).toEqual([]);
 });
 it('never pairs halves on different interfaces, next hops or tables',()=>{
  expect(project([route('a','0.0.0.0/1','tun0','10.8.0.1'),route('b','128.0.0.0/1','tun1','10.8.0.1')]).delta.relationships).toEqual([]);
  expect(project([route('a','0.0.0.0/1','tun0','10.8.0.1'),route('b','128.0.0.0/1','tun0','10.8.0.2')]).delta.relationships).toEqual([]);
  expect(project([route('a','0.0.0.0/1','tun0','10.8.0.1'),route('b','128.0.0.0/1','tun0','10.8.0.1',{tableKey:'vpn'})]).delta.relationships).toEqual([]);
 });
 it('emits nothing when the tunnel interface cannot be resolved, so the pair never folds into a LAN group',()=>{
  const unattributed=project([route('a','0.0.0.0/1',null,'10.8.0.1'),route('b','128.0.0.0/1',null,'10.8.0.1')]).delta;
  expect(unattributed.relationships).toEqual([]);expect(unattributed.nodes).toEqual([]);
  expect(project([route('a','0.0.0.0/1','tun9','10.8.0.1'),route('b','128.0.0.0/1','tun9','10.8.0.1')]).delta.relationships).toEqual([]);
 });
 it('ignores halves that are not unicast/on-link routes or have no gateway address',()=>{
  expect(project([route('a','0.0.0.0/1','tun0','10.8.0.1',{routeType:'blackhole'}),route('b','128.0.0.0/1','tun0','10.8.0.1')]).delta.relationships).toEqual([]);
  expect(project([route('a','0.0.0.0/1','tun0',null,{routeType:'on_link'}),route('b','128.0.0.0/1','tun0',null,{routeType:'on_link'})]).delta.relationships).toEqual([]);
 });
 it('projects the IPv6 pair (::/1 + 8000::/1) on the tunnel interface',()=>{
  const {delta,ifaceId,gatewayAddress}=project([route('v6-low','::/1','tun0','2001:db8:8::1'),route('v6-high','8000::/1','tun0','2001:db8:8::1')],'ipv6');
  expect(delta.relationships).toHaveLength(1);
  const vpn=delta.relationships[0]!;
  expect(gatewayAddress(vpn.targetNodeId)).toBe('2001:db8:8::1');
  expect(vpn.sourceInterfaceId).toBe(ifaceId('tun0'));
  expect(vpn.attributes?.halfDefault).toBe(true);
 });
 it('withdraws when either half disappears: its row key is positive only while both halves are present',()=>{
  const low=route('vpn-low','0.0.0.0/1','tun0','10.8.0.1'),high=route('vpn-high','128.0.0.0/1','tun0','10.8.0.1');
  const {delta,section}=project([lan,low,high]);
  const vpn=delta.relationships.find(r=>r.attributes?.halfDefault)!;
  const observations=delta.observations.filter(o=>o.relationshipId===vpn.id);
  // Exactly one row key supports the pair, so a miss on it is not masked by a surviving half.
  expect(observations).toHaveLength(1);
  const rowKey=String(observations[0]!.attributes.rowKey);
  expect(topologyPositiveKeys(section as never)).toContain(rowKey);
  for (const remaining of [[lan,low],[lan,high],[lan]]) expect(topologyPositiveKeys({...section,rows:remaining,rowCount:remaining.length} as never)).not.toContain(rowKey);
 });
});
