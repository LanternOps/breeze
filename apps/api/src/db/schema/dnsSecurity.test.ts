import { describe, expect, it } from 'vitest';
import {
  DNS_CONTENT_CATEGORIES,
  DNS_THREAT_CATEGORIES,
  dnsThreatCategoryEnum,
  isDnsThreatCategory
} from './dnsSecurity';

// #6692 — the dns_threat_category enum mixes security threats with
// content-policy categories. The type-level split must partition the enum
// (every value in exactly one bucket, `unknown` in neither) so a new enum
// value can't silently land outside the threat/content decision.
describe('DNS category grouping (#6692)', () => {
  it('partitions every enum value into threat, content, or unknown exactly once', () => {
    const threat = new Set<string>(DNS_THREAT_CATEGORIES);
    const content = new Set<string>(DNS_CONTENT_CATEGORIES);
    for (const value of dnsThreatCategoryEnum.enumValues) {
      const buckets = [threat.has(value), content.has(value), value === 'unknown'].filter(Boolean);
      expect(buckets, value).toHaveLength(1);
    }
    expect(threat.size + content.size + 1).toBe(dnsThreatCategoryEnum.enumValues.length);
  });

  it('classifies only threat categories as threats', () => {
    expect([...DNS_THREAT_CATEGORIES].sort()).toEqual(
      ['adware', 'botnet', 'cryptomining', 'malware', 'phishing', 'ransomware', 'spam']
    );
    expect([...DNS_CONTENT_CATEGORIES].sort()).toEqual(
      ['adult_content', 'gambling', 'social_media', 'streaming']
    );
    for (const c of DNS_THREAT_CATEGORIES) expect(isDnsThreatCategory(c)).toBe(true);
    for (const c of DNS_CONTENT_CATEGORIES) expect(isDnsThreatCategory(c)).toBe(false);
    expect(isDnsThreatCategory('unknown')).toBe(false);
    expect(isDnsThreatCategory('not-a-category')).toBe(false);
    expect(isDnsThreatCategory(null)).toBe(false);
    expect(isDnsThreatCategory(undefined)).toBe(false);
  });
});
