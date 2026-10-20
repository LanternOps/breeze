// The device filter field catalog for a FilterBuilder: FILTER_FIELDS (the
// static catalog, mirroring the backend filterEngine) plus every org/partner
// custom field definition as a `custom.<key>` field (#6594, #8843). The filter
// engine synthesises `custom.<key>` fields at evaluation time; a builder given
// only FILTER_FIELDS / DEFAULT_FILTER_FIELDS cannot offer them.
//
// Used by DeviceFilterBar and the device-group rule builders (CreateGroupModal,
// DeviceGroupsPage). DeviceTargetSelector, ScriptExecutionModal and
// ReportBuilder still pass DEFAULT_FILTER_FIELDS.
//
// Definitions come from the shared custom field definitions store: consumers
// share one GET /custom-fields (re-attempted on the next mount after an error).
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
