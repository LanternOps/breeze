// Custom field DEFINITION catalog (issue #6594): the device list column
// picker, the advanced filter's field dropdown, and the filter chip labeler
// all need to know which custom fields exist for the current org/partner
// scope. GET /custom-fields already returns exactly that, scoped correctly
// by the request's auth context (same endpoint DeviceInfoTab uses to render
// the device-detail "Custom fields" section) — this store just caches it so
// every consuming surface shares one fetch instead of each re-requesting.
import { create } from 'zustand';
import { fetchWithAuth } from './auth';

export interface CustomFieldDefinition {
  id: string;
  orgId: string | null;
  partnerId: string | null;
  name: string;
  fieldKey: string;
  type: 'text' | 'number' | 'boolean' | 'dropdown' | 'date';
  options: {
    choices?: Array<{ label: string; value: string } | string>;
  } | null;
  required: boolean;
  defaultValue: unknown;
  deviceTypes: string[] | null;
}

function asDefinitionList(data: unknown): CustomFieldDefinition[] {
  const rows = Array.isArray(data)
    ? data
    : data && typeof data === 'object' && Array.isArray((data as { data?: unknown }).data)
      ? (data as { data: unknown[] }).data
      : [];
  return rows.filter(
    (row): row is CustomFieldDefinition =>
      !!row && typeof row === 'object' && typeof (row as CustomFieldDefinition).fieldKey === 'string'
  );
}

interface CustomFieldDefinitionsState {
  definitions: CustomFieldDefinition[];
  status: 'idle' | 'loading' | 'loaded' | 'error';
  fetchCustomFieldDefinitions: () => Promise<void>;
}

export const useCustomFieldDefinitionsStore = create<CustomFieldDefinitionsState>()((set, get) => ({
  definitions: [],
  status: 'idle',
  fetchCustomFieldDefinitions: async () => {
    // Idempotent — every consuming surface calls this on mount; only the
    // first caller should hit the network.
    if (get().status === 'loading' || get().status === 'loaded') return;
    set({ status: 'loading' });
    try {
      const res = await fetchWithAuth('/custom-fields');
      if (!res.ok) {
        console.error(`Failed to fetch custom field definitions (HTTP ${res.status})`);
        set({ status: 'error' });
        return;
      }
      const body = await res.json();
      set({ definitions: asDefinitionList(body), status: 'loaded' });
    } catch (err) {
      console.error('Failed to load custom field definitions:', err);
      set({ status: 'error' });
    }
  },
}));
