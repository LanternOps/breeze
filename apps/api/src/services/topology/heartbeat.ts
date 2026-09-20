import { parseNetworkContextReport } from '@breeze/shared';
import { db, assertInTransaction } from '../../db';
import { negotiateTopologyContext } from './collectionAuthority';
import { ingestTopologyNetworkContext } from './collectionIngest';
import type { TopologyIngestReceipt } from './collectionTypes';

type Input={networkContextV1?:unknown;networkContextReset?:unknown};
/** Report-local savepoints keep malformed topology data from breaking legacy
 * heartbeat delivery. Authority always comes from the authenticated device. */
export async function topologyHeartbeat(device:{id:string;orgId:string;siteId:string},input:Input){
  assertInTransaction('topologyHeartbeat');
  const reset=input.networkContextReset;
  const previousEpoch=reset&&typeof reset==='object'&&'previousEpoch' in reset&&typeof reset.previousEpoch==='string'&&reset.previousEpoch.length<=255?reset.previousEpoch:undefined;
  const config=await db.transaction(()=>negotiateTopologyContext(device.id,previousEpoch?{previousEpoch}:undefined));
  let receipt:TopologyIngestReceipt|undefined;
  if(input.networkContextV1!==undefined){
    const parsed=parseNetworkContextReport(input.networkContextV1);
    if(!parsed.accepted)receipt={accepted:false,reason:parsed.reason,sourceReceipts:[]};
    else if(!config.producerEpoch)receipt={accepted:false,reason:'materialization_disabled',sourceReceipts:[]};
    else try{
      receipt=await ingestTopologyNetworkContext({scope:{orgId:device.orgId,siteId:device.siteId},producerId:device.id,producerKind:'agent',producerEpoch:config.producerEpoch,
        configurationRevision:config.configurationRevision!,sourceIdentity:config.sourceIdentity!},parsed.report);
    }catch(error){
      const reason=error instanceof Error?error.message:'';
      const expected=new Set(['producer_epoch_changed','producer_scope_changed','producer_unavailable','content_digest_mismatch','section_digest_mismatch','materialization_disabled']);
      if(!expected.has(reason))throw error;
      receipt={producerEpoch:config.producerEpoch,accepted:false,reason,sourceReceipts:[]};
    }
  }
  // The agent discards a rejected capture only when the rejection names it;
  // an unnamed rejection leaves it resending the same bytes every heartbeat.
  if(receipt){
    const claimed=input.networkContextV1&&typeof input.networkContextV1==='object'&&'sequence' in input.networkContextV1?input.networkContextV1.sequence:undefined;
    if(typeof claimed==='string'&&/^(0|[1-9]\d{0,19})$/.test(claimed))receipt.reportSequence=claimed;
    if(config.producerEpoch)receipt.producerEpoch??=config.producerEpoch;
  }
  return {config,receipt};
}
