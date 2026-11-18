import { describe, expect, it } from 'vitest';
import { scanEnglishCatalogue, type VocabularyRule } from './aiVocabularyGuard';

// Spec §6: the chat door is "Breeze AI" (speaking as Wisp under a grant).
const CHAT_RULES: VocabularyRule[] = [
  { name: 'AI Assistant', pattern: /\bAI Assistant\b/ },
  { name: 'Breeze AI Assistant', pattern: /\bBreeze AI Assistant\b/ },
  { name: 'AI assistant (lowercase)', pattern: /\bAI assistant\b/ },
  { name: 'the assistant', pattern: /\bthe assistant\b/i },
  { name: 'AI chat', pattern: /\bAI chat\b/ },
  { name: 'Breeze AI chat', pattern: /\bBreeze AI chat\b/ },
  { name: 'Wisp chats', pattern: /\bWisp chats\b/ },
];

const ALLOW = new Set<string>([
  // Breeze AI for Office names the product in the same string or heading (spec §6):
  'ai:aiForOfficePage.description',
  'ai:policyEditor.assistant',
  'ai:policyEditor.whoCanUse',
]);

describe('AI vocabulary — chat family', () => {
  it('retired chat nouns do not appear in the English catalogue', () => {
    expect(scanEnglishCatalogue(CHAT_RULES, ALLOW)).toEqual([]);
  });
});
