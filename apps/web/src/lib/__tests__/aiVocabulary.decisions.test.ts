import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanEnglishCatalogue, type VocabularyRule } from './aiVocabularyGuard';

const DECISION_RULES: VocabularyRule[] = [
  // #10198: every AI approval surface, not just the ai/approvals/aiOperator
  // namespaces, and in any case — the leftovers were lowercase badges,
  // "refused" toasts and AI screens living in security/settings/scripts.
  {
    name: 'Reject/Refuse/Decline for AI approvals',
    pattern: /\b(reject(s|ed|ing|ions?)?|refuse[sd]?|decline[sd]?)\b/i,
    keyPrefixes: [
      'ai:',
      'approvals:',
      'aiOperator:',
      'security:aiRisk',
      'settings:aiAgentsRuns.',
      'settings:aiUsagePage.',
      'scripts:scriptAiMessages.',
    ],
  },
  { name: 'remediation reject', pattern: /\bReject\b/, namespaces: ['common'] },
  { name: 'inbox for Approvals', pattern: /\binbox\b/i, namespaces: ['aiOperator', 'settings'] },
  { name: 'cents', pattern: /¢/ },
  { name: 'Assessments', pattern: /\bAssessments?\b/, namespaces: ['admin', 'ai'] },
  { name: 'Auto-Execute tier wording', pattern: /Auto-Execute/ },
];

const ALLOW = new Set<string>([
  // A model declining to answer a turn (a model refusal), not an approval decision:
  'ai:aiTurnModel.fellBack',
  // The automated script reviewer's verdict (approve / changes / reject) is a
  // recommendation, not a person's approval decision (#10399, #10198):
  'ai:scriptProposal.reviewVerdictReject',
  'security:aiRiskScriptProposalsPanel.humanApprovedAfterReject',
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
