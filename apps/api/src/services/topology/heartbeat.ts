import { parseNetworkContextReport } from '@breeze/shared';
import { assertInTransaction } from '../../db';
import { negotiateTopologyContext } from './collectionAuthority';
import { ingestTopologyNetworkContext } from './collectionIngest';
import type { TopologyIngestReceipt } from './collectionTypes';

type Input={networkContextV1?:unknown;networkContextReset?:unknown};
type NegotiatedConfig=Awaited<ReturnType<typeof negotiateTopologyContext>>;
const EXPECTED_INGEST_REJECTIONS=new Set(['producer_epoch_changed','producer_scope_changed','producer_unavailable','content_digest_mismatch','section_digest_mismatch','materialization_disabled']);

/** Report-local savepoints keep malformed topology data from breaking legacy
 * heartbeat delivery. Authority always comes from the authenticated device.
 * The CALLER isolates this call in its own savepoint (heartbeat.ts); a second,
 * inner one around negotiation bought nothing — a negotiation error aborts the
 * whole call either way (#8053 W1a-1). Ingest keeps its own. */
export async function topologyHeartbeat(device:{id:string;orgId:string;siteId:string},input:Input){
  assertInTransaction('topologyHeartbeat');
  const reset=input.networkContextReset;
  const previousEpoch=reset&&typeof reset==='object'&&'previousEpoch' in reset&&typeof reset.previousEpoch==='string'&&reset.previousEpoch.length<=255?reset.previousEpoch:undefined;
  const config=await negotiateTopologyContext(device.id,previousEpoch?{previousEpoch}:undefined);
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
      if(!EXPECTED_INGEST_REJECTIONS.has(reason))throw error;
      receipt={producerEpoch:config.producerEpoch,accepted:false,reason,sourceReceipts:[]};
    }
  }
  return {config,receipt:nameReceipt(receipt,input,config)};
}

/** The device-row facts negotiateTopologyContext's activeDevice() refuses on. */
export type TopologyProducerRow={isEphemeral:boolean;agentTokenSuspendedAt:Date|null;agentTokenHash:string|null};

/** #8053 W1a-1 — what topologyHeartbeat returns when the org's materialization
 * flag is off, without the DB: negotiation then answers `{acceptedNetworkContextVersions:[]}`
 * and ingests nothing. The one DB-dependent outcome on that path — the
 * activeDevice() refusal — is re-derived from the caller's device row and
 * thrown with the same message, so the caller's catch behaves identically. */
export function topologyHeartbeatWithoutMaterialization(device:TopologyProducerRow,input:Input){
  if(device.isEphemeral||device.agentTokenSuspendedAt!==null||!device.agentTokenHash)throw new Error('producer_unavailable');
  const config:NegotiatedConfig={acceptedNetworkContextVersions:[]};
  let receipt:TopologyIngestReceipt|undefined;
  if(input.networkContextV1!==undefined){
    const parsed=parseNetworkContextReport(input.networkContextV1);
    receipt=parsed.accepted?{accepted:false,reason:'materialization_disabled',sourceReceipts:[]}:{accepted:false,reason:parsed.reason,sourceReceipts:[]};
  }
  return {config,receipt:nameReceipt(receipt,input,config)};
}

// The agent discards a rejected capture only when the rejection names it;
// an unnamed rejection leaves it resending the same bytes every heartbeat.
function nameReceipt(receipt:TopologyIngestReceipt|undefined,input:Input,config:NegotiatedConfig){
  if(receipt){
    const claimed=input.networkContextV1&&typeof input.networkContextV1==='object'&&'sequence' in input.networkContextV1?input.networkContextV1.sequence:undefined;
    if(typeof claimed==='string'&&/^(0|[1-9]\d{0,19})$/.test(claimed))receipt.reportSequence=claimed;
    if(config.producerEpoch)receipt.producerEpoch??=config.producerEpoch;
  }
  return receipt;
}
