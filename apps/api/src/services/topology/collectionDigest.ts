import { createHash, timingSafeEqual } from 'node:crypto';
import { canonicalizeTopologyContext, canonicalizeTopologySection, networkContextV1Schema, type NetworkContextFull } from '@breeze/shared';
import { sourceKey, type AuthenticatedTopologyProducer, type NormalizedTopologyReport } from './collectionTypes';

export function topologyContextDigest(report: NetworkContextFull, sourceIdentity: string): string {
  return createHash('sha256').update(canonicalizeTopologyContext(report,sourceIdentity)).digest('hex');
}
export function topologySectionDigest(report: NetworkContextFull, section: NetworkContextFull['sections'][number], sourceIdentity: string): string {
  return createHash('sha256').update(canonicalizeTopologySection(report,section,sourceIdentity)).digest('hex');
}
function matches(expected: string, actual: string): boolean {
  return expected.length === actual.length && timingSafeEqual(Buffer.from(expected),Buffer.from(actual));
}
/** Authority is rechecked by ingestion; this pure function grants no DB access. */
export function normalizeNetworkContext(producer: AuthenticatedTopologyProducer, payload: unknown): NormalizedTopologyReport[] {
  const report = networkContextV1Schema.parse(payload);
  if (report.producerEpoch !== producer.producerEpoch) throw new Error('producer_epoch_changed');
  if (report.reportKind === 'unchanged') return [{reportKind:'unchanged',confirmation:{...report,key:{protocol:'envelope',contextKey:'root',addressFamily:'any'}}}];
  if (!matches(topologyContextDigest(report,producer.sourceIdentity),report.contentDigest)) throw new Error('content_digest_mismatch');
  return report.sections.map(section => {
    if (!matches(topologySectionDigest(report,section,producer.sourceIdentity),section.contentDigest)) throw new Error('section_digest_mismatch');
    return {reportKind:'full',snapshot:{key:sourceKey(section),snapshotId:report.snapshotId,producerEpoch:report.producerEpoch,
      sequence:report.sequence,capturedAt:report.capturedAt,captureAgeAtSendMs:report.captureAgeAtSendMs,
      expectedIntervalSeconds:report.expectedIntervalSeconds,contentDigest:section.contentDigest,manifest:report.contextManifest,section}};
  });
}
