// Owner: W02f. Suggests subprocessor rows from what Breeze already knows the org runs (security products, backup,
// Microsoft 365). Suggestions are only a prefill for the editor: nothing reaches the public page until the
// publisher saves the list and publishes (Ruling 20).
import { eq } from 'drizzle-orm';
import type { TrustSubprocessorInput } from '@breeze/shared';
import { db } from '../../db';
import { trustPageSubprocessors } from '../../db/schema';
import { loadPostureEvidence, TRUST_PAGE_EVIDENCE_POLICY } from '../postureEvidence';

export type SubprocessorSuggestion = TrustSubprocessorInput;

const M365_PRODUCT = 'microsoft 365';
const M365_PURPOSE = 'Microsoft 365 — identity and productivity';

function classify(product: string, category: string): { source: SubprocessorSuggestion['source']; purpose: string } | null {
  switch (category) {
    case 'antivirus':
    case 'edr':
    case 'mdr':
      return { source: 'security_product', purpose: 'Endpoint security' };
    case 'dns_filtering':
      return { source: 'security_product', purpose: 'DNS filtering' };
    case 'backup':
      return { source: 'backup', purpose: 'Backup' };
    case 'identity':
      // Only Microsoft 365 is a connected tenant integration with an enum source; other identity providers are manual.
      return product.trim().toLowerCase() === M365_PRODUCT ? { source: 'm365', purpose: M365_PURPOSE } : null;
    default:
      return null;
  }
}

export async function suggestSubprocessors(orgId: string, asOf: Date): Promise<SubprocessorSuggestion[]> {
  const [evidence, saved] = await Promise.all([
    loadPostureEvidence({ version: 1, kind: 'unrestricted', orgId }, TRUST_PAGE_EVIDENCE_POLICY, asOf),
    db.select({ sourceKey: trustPageSubprocessors.sourceKey }).from(trustPageSubprocessors).where(eq(trustPageSubprocessors.orgId, orgId)),
  ]);
  const taken = new Set(saved.map((r) => r.sourceKey).filter((k): k is string => !!k));
  const out: SubprocessorSuggestion[] = [];
  for (const p of evidence.report.productEvidence) {
    if (!p.active) continue;
    const c = classify(p.product, p.category);
    if (!c) continue;
    const name = p.product.trim().slice(0, 200);
    const sourceKey = `${c.source}:${name.toLowerCase()}`.slice(0, 120);
    if (!name || taken.has(sourceKey)) continue;
    taken.add(sourceKey);
    out.push({ name, purpose: c.purpose, location: null, websiteUrl: null, source: c.source, sourceKey });
  }
  return out;
}
