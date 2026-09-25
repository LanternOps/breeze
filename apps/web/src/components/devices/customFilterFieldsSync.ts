// Bridges the custom field definitions store to filterFields.ts's live cache
// (issue #6594). Call once near the root of any tree that needs `custom.<key>`
// fields selectable/resolvable — FilterChipBar mounts it for both the chip
// bar and the sentence builder it renders. Every descendant that calls
// getFieldDef()/getAllFilterFields() picks up the merged list automatically
// on the re-render this hook's store subscription triggers once the fetch
// resolves — no prop threading required.
import { useEffect } from 'react';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';
import { customFieldToFilterField, setCustomFilterFields } from './filterFields';

export function useSyncCustomFilterFields(): void {
  const definitions = useCustomFieldDefinitionsStore((s) => s.definitions);
  const fetchCustomFieldDefinitions = useCustomFieldDefinitionsStore((s) => s.fetchCustomFieldDefinitions);

  useEffect(() => {
    void fetchCustomFieldDefinitions();
  }, [fetchCustomFieldDefinitions]);

  // Deliberately NOT a useEffect: an effect runs after commit, one render
  // too late for this render's own children (Chip, FilterAddDropdown,
  // FilterSentenceBuilder) to see the update — they read the cache
  // synchronously via getFieldDef()/getAllFilterFields() during THIS render
  // pass. Writing a plain module variable during render is safe here since
  // it's idempotent (React's dev-mode double-render just writes it twice).
  setCustomFilterFields(definitions.map(customFieldToFilterField));
}
