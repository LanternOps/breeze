import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { scanEnglishCatalogue, type VocabularyRule } from './aiVocabularyGuard';

/**
 * AI surface cohesion W02 (#10133, spec §11.1): the noun for Operator work is
 * "AI task", always qualified. "Operator" must never mean software in the app.
 */
const TASK_RULES: VocabularyRule[] = [
  {
    name: 'Operator as software',
    pattern: /\b(AI )?[Oo]perator\b(?! targets)/,
    namespaces: ['aiOperator', 'checklists', 'devices', 'tickets', 'ai', 'approvals', 'alerts'],
  },
  { name: 'bare "Operator step"', pattern: /\bOperator step/ },
  { name: 'workflow in AI-task copy', pattern: /\bworkflow\b/i, namespaces: ['aiOperator'] },
  { name: 'delegate to', pattern: /\b[Dd]elegate to the Operator\b/ },
];

// Person-sense "operator" (comparison operators in alert rules, filters) stays.
const ALLOW = new Set<string>([
  'alerts:alertRuleForm.operator',
  'alerts:alertRuleForm.invalidOperator',
  'alerts:notificationChannelForm.alertValueValueIsValueThresholdValue',
  'devices:filterValueEditor.operator',
  // `{{operator}}` is an interpolation placeholder name (a count), not copy; renaming it
  // would change the caller and all 8 locales for no user-visible gain.
  'checklists:templates.saveAs.skipped',
]);

describe('AI vocabulary — tasks family (#10133)', () => {
  it('the Operator is never software in the English catalogue', () => {
    expect(scanEnglishCatalogue(TASK_RULES, ALLOW)).toEqual([]);
  });

  it('the Operator page titles are not hard-coded in the .astro files', () => {
    const pagesDir = join(__dirname, '..', '..', 'pages', 'operator');
    for (const rel of ['index.astro', join('tasks', '[taskId].astro')]) {
      const source = readFileSync(join(pagesDir, rel), 'utf8');
      expect(source, rel).not.toContain('title="Operator');
    }
  });
});
