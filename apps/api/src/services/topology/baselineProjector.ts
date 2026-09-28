import { canonicalFactValue, topologyFactKey } from './collectionFactKeys';
import { createHash } from 'node:crypto';
import { topologyCidrSchema, type NodeKind, type RelationshipKind } from '@breeze/shared';
import { canonicalIdentityKey } from './identity';
import { stableLegacyId } from './legacyProjection';
import { outcomeHasPositives } from './collectionTypes';
import { emptyProjection, type BaselineProjectionInput, type TopologyProjectionDelta } from './reconciliationTypes';

const opaque = (value:unknown)=>createHash('sha256').update(JSON.stringify(canonicalFactValue(value))).digest('hex');
/** Pure OS evidence projection. Prefixes and routes imply no physical link. */
export function projectBaselineTopology(input:BaselineProjectionInput):TopologyProjectionDelta {
  const delta=emptyProjection();
  const {scope,source,run,snapshot,originNodeId}=input;
  if (!outcomeHasPositives(snapshot.section.outcome)) return delta;
  const context=opaque([source.producerId,source.contextKey]);
  const node=(kind:NodeKind,material:unknown,label:string,prefix?:string)=>{
    const sourceKey=`os:${context}:${opaque(material)}`;
    const identityKey=canonicalIdentityKey(scope,kind,sourceKey);
    const old=input.nodes.find(n=>n.identityKey===identityKey);
    const id=old?.id??stableLegacyId(identityKey);
    delta.nodes.push({...scope,id,kind,identityKey,identityMaterial:{version:1,kind,sourceKey},lifecycle:'active',
      firstObservedAt:old?.firstObservedAt??run.effectiveAt,lastObservedAt:run.effectiveAt,
      attributes:{label,...(prefix?{prefix,addressFamily:prefix.includes(':')?6 as const:4 as const}:{})}});
    return id;
  };
  const interfaceFor=(key:string)=>[...delta.interfaces,...input.interfaces].find(i=>i.ownerNodeId===originNodeId&&i.interfaceKey===key&&i.epoch===source.producerEpoch)?.id??null;
  const relationship=(kind:RelationshipKind,rowKey:string,targetNodeId:string,interfaceId:string|null,material:unknown,evidence:'observed'|'inferred')=>{
    const sourceKey=`os:${context}:${opaque([kind,originNodeId,material])}`;
    const canonicalKey=canonicalIdentityKey(scope,kind,sourceKey);
    const old=input.relationships.find(r=>r.canonicalKey===canonicalKey);
    const id=old?.id??stableLegacyId(canonicalKey);
    delta.relationships.push({...scope,id,kind,canonicalKey,identityMaterial:{version:1,kind,sourceKey},sourceNodeId:originNodeId,targetNodeId,
      sourceInterfaceId:interfaceId,targetInterfaceId:null,logicalContext:{contextKey:context,...(interfaceId?{interfaceId}:{})},
      directness:'unknown',confidence:evidence==='observed'?'high':'low',evidenceClass:evidence,lifecycle:'active',
      firstSupportedAt:old?.firstSupportedAt??run.effectiveAt,lastSupportedAt:run.effectiveAt,supportCount:1n,attributes:{method:'os_network_context'}});
    const observationId=stableLegacyId(`${run.id}:${rowKey}:${id}`);
    const freshUntil=new Date(run.effectiveAt.getTime()+Math.max(run.expectedIntervalSeconds*3,900)*1000);
    delta.observations.push({...scope,id:observationId,runId:run.id,observationKey:opaque([rowKey,id]),subjectNodeId:originNodeId,
      subjectInterfaceId:interfaceId,relationshipId:id,method:'os_network_context',evidenceClass:evidence,attributes:{rowKey,contextKey:source.contextKey},
      observedAt:run.observedAt,effectiveAt:run.effectiveAt,receivedAt:run.receivedAt,freshUntil});
    delta.support.push({...scope,relationshipId:id,sourceId:source.id,latestObservationId:observationId,producerEpoch:source.producerEpoch,
      sequence:run.sequence,contentDigest:run.contentDigest,firstPositiveAt:run.effectiveAt,lastPositiveAt:run.effectiveAt,effectiveAt:run.effectiveAt,freshUntil,lifecycle:'active',completeMissCount:0});
  };
  const section=snapshot.section;
  if (section.kind==='interfaces') {
    for (const row of section.rows) {
      const old=input.interfaces.find(i=>i.ownerNodeId===originNodeId&&i.interfaceKey===row.interfaceKey&&i.epoch===source.producerEpoch);
      const id=old?.id??stableLegacyId(opaque([scope,originNodeId,row.interfaceKey,source.producerEpoch]));
      delta.interfaces.push({...scope,id,ownerNodeId:originNodeId,interfaceKey:row.interfaceKey,epoch:source.producerEpoch,kind:row.kind,
        name:row.name,osIndex:String(row.osIndex),addresses:row.addresses,lastObservedAt:run.effectiveAt,lastOutcome:section.outcome});
      for (const address of row.addresses) {
        if (!['preferred','deprecated'].includes(address.state)) continue;
        const prefix=topologyCidrSchema.parse(`${address.address}/${address.prefixLength}`);
        const networkId=node('network',['prefix',prefix,address.zone],prefix,prefix);
        relationship('network_member',topologyFactKey(row.rowKey,[address.address,address.prefixLength,address.zone]),networkId,id,[row.interfaceKey,prefix,address.zone],'inferred');
      }
    }
    for (const row of section.rows) if(row.parentInterfaceKey) {
      const value=delta.interfaces.find(i=>i.interfaceKey===row.interfaceKey)!;
      value.parentInterfaceId=interfaceFor(row.parentInterfaceKey);
    }
  }
  if (section.kind==='routes') for (const row of section.rows) {
    if (!['0.0.0.0/0','::/0'].includes(row.destinationPrefix)||!['unicast','on_link'].includes(row.routeType)) continue;
    for (const hop of row.nextHops) {
      // An on-link/unknown gateway is presentation-only, never a canonical device.
      if (!hop.address) continue;
      const key=hop.interfaceKey??row.interfaceKey;
      const interfaceId=key?interfaceFor(key):null;
      const gateway=node('gateway',['gateway',row.family,hop.address,hop.zone,key],hop.address);
      relationship('default_route',topologyFactKey(row.rowKey,hop),gateway,interfaceId,[row.rowKey,row.tableKey,row.metric,hop],'observed');
    }
  }
  return delta;
}
