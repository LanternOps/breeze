import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanEnglishCatalogue, type VocabularyRule } from './aiVocabularyGuard';

const DECISION_RULES: VocabularyRule[] = [
  { name: 'Reject/Decline for AI approvals', pattern: /\b(Reject(ed)?|Decline(d)?)\b/, namespaces: ['ai', 'approvals', 'aiOperator'] },
  { name: 'remediation reject', pattern: /\bReject\b/, namespaces: ['common'] },
  { name: 'inbox for Approvals', pattern: /\binbox\b/i, namespaces: ['aiOperator', 'settings'] },
  { name: 'cents', pattern: /¢/ },
  { name: 'Assessments', pattern: /\bAssessments?\b/, namespaces: ['admin', 'ai'] },
  { name: 'Auto-Execute tier wording', pattern: /Auto-Execute/ },
];

const ALLOW = new Set<string>([
  // Gmail mailbox settings describe a mail inbox, not Approvals:
  'settings:gmailMailbox.handling.off',
  'settings:gmailMailbox.handling.onArchive',
  'settings:gmailMailbox.handling.onLabelOnly',
  'settings:gmailMailbox.handling.archiveField',
  'settings:gmailMailbox.handling.error.not_queued',
  'settings:gmailMailbox.handling.error.failed',
]);

describe('AI decisions vocabulary (#10134)', () => {
  it('AI decisions are Approve / Deny, in Approvals, in dollars, with the four tier names', () => {
    expect(scanEnglishCatalogue(DECISION_RULES, ALLOW)).toEqual([]);
  });

  it('tier labels live in the locale catalogue, not in tierConfig.ts', () => {
    const src = readFileSync(join(__dirname, '..', '..', 'components', 'ai-risk', 'tierConfig.ts'), 'utf8');
    expect(src).not.toMatch(/label: '(Auto-Execute|Requires Approval|Blocked)/);
  });
});
