import { describe,expect,it } from 'vitest';
import { networkContextFixture } from '../../../../../packages/shared/src/testing/topologyFixtures';
import { projectBaselineTopology } from './baselineProjector';
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
