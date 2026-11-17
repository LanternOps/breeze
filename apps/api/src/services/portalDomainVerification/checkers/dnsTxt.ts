/**
 * Portal registration W5 (#11382): DNS TXT domain-verification checker.
 * The partner publishes `breeze-verification=<token>` at `_breeze-verify.<domain>`.
 * The value prefix is distinct from SSO's `breeze-domain-verify=` so one record
 * can never satisfy both proofs.
 */
import { lookupTxtValues, ownershipTxtRecordName } from '../../emailDomains/dnsOwnershipProof';
import type { DomainVerificationChecker } from '../types';

export const PORTAL_DOMAIN_TXT_PREFIX = 'breeze-verification=';

export function portalDomainTxtRecord(
  domain: string,
  token: string,
): { recordName: string; recordValue: string } {
  return {
    recordName: ownershipTxtRecordName(domain),
    recordValue: `${PORTAL_DOMAIN_TXT_PREFIX}${token}`,
  };
}

export const dnsTxtChecker: DomainVerificationChecker = {
  method: 'dns_txt',
  async check(target) {
    if (target.verificationToken === null) return { status: 'fail', reason: 'record_missing' };
    const { recordName, recordValue } = portalDomainTxtRecord(target.domain, target.verificationToken);
    const lookup = await lookupTxtValues(recordName);
    if (lookup.kind === 'unavailable') return { status: 'unavailable', reason: lookup.reason };
    if (lookup.kind === 'answer' && lookup.values.includes(recordValue)) {
      return { status: 'pass', evidence: { via: 'dns_txt', recordName } };
    }
    return { status: 'fail', reason: 'record_missing' };
  },
};
