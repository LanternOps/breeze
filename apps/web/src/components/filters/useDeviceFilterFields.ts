// The device filter field catalog a FilterBuilder should offer: the static
// catalog (mirrors the backend filterEngine) plus every org/partner custom
// field definition as a `custom.<key>` field (#6594, #8843). The filter engine
// synthesises `custom.<key>` fields at evaluation time, so any FilterBuilder
// whose filter is evaluated by it should use this instead of the bare
// DEFAULT_FILTER_FIELDS — otherwise custom fields cannot be picked.
//
// Definitions come from the shared custom field definitions store, so every
// mounted consumer shares one GET /custom-fields; the fetch is idempotent.
import { useEffect, useMemo } from 'react';
import type { FilterFieldDefinition } from '@breeze/shared';
import { FILTER_FIELDS } from './filterFields';
import { customFieldToFilterField } from '../devices/filterFields';
import { useCustomFieldDefinitionsStore } from '../../stores/customFieldDefinitions';

export function useDeviceFilterFields(): FilterFieldDefinition[] {
  const definitions = useCustomFieldDefinitionsStore((s) => s.definitions);
  const fetchCustomFieldDefinitions = useCustomFieldDefinitionsStore((s) => s.fetchCustomFieldDefinitions);

  useEffect(() => {
    void fetchCustomFieldDefinitions();
  }, [fetchCustomFieldDefinitions]);

  return useMemo(
    () =>
      definitions.length > 0
        ? [...FILTER_FIELDS, ...definitions.map(customFieldToFilterField)]
        : FILTER_FIELDS,
    [definitions]
  );
}
