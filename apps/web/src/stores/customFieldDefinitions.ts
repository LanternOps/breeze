// Custom field DEFINITION catalog (issue #6594): the device list column
// picker, the advanced filter's field dropdown, the filter chip labeler, and
// the device-group rule builder / card chips (via useDeviceFilterFields, #8843)
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

// Bumped whenever the header org/partner scope changes so a response that was
// in flight for the previous scope is discarded instead of repopulating the cache (#8946).
let scopeGeneration = 0;

export const useCustomFieldDefinitionsStore = create<CustomFieldDefinitionsState>()((set, get) => ({
  definitions: [],
  status: 'idle',
  fetchCustomFieldDefinitions: async () => {
    // Idempotent — every consuming surface calls this on mount; only the
    // first caller should hit the network.
    if (get().status === 'loading' || get().status === 'loaded') return;
    const generation = scopeGeneration;
    set({ status: 'loading' });
    try {
      const res = await fetchWithAuth('/custom-fields');
      if (generation !== scopeGeneration) return;
      if (!res.ok) {
        console.error(`Failed to fetch custom field definitions (HTTP ${res.status})`);
        set({ status: 'error' });
        return;
      }
      const body = await res.json();
      if (generation !== scopeGeneration) return;
      set({ definitions: asDefinitionList(body), status: 'loaded' });
    } catch (err) {
      if (generation !== scopeGeneration) return;
      console.error('Failed to load custom field definitions:', err);
      set({ status: 'error' });
    }
  },
}));

// GET /custom-fields is scoped by the header org/partner, so the cache is only
// valid for the scope it was fetched under. On any scope change, drop it and, if
// it had been in use, refetch for the new scope (#8946). orgStore is imported
// lazily (as aiStore does) so this store does not pull orgStore and its auth
// provider registration into every test/module that only needs definitions.
void import('./orgStore')
  .then(({ useOrgStore }) => {
    useOrgStore.subscribe((state, prev) => {
      if (
        state.currentOrgId === prev.currentOrgId &&
        state.currentPartnerId === prev.currentPartnerId &&
        state.allOrgs === prev.allOrgs
      ) {
        return;
      }
      scopeGeneration += 1;
      const wasInUse = useCustomFieldDefinitionsStore.getState().status !== 'idle';
      useCustomFieldDefinitionsStore.setState({ definitions: [], status: 'idle' });
      // Logout/reset clears the whole scope; don't fire an unauthenticated fetch then.
      const scopeResolved = !!(state.currentOrgId || state.currentPartnerId || state.allOrgs);
      if (wasInUse && scopeResolved) void useCustomFieldDefinitionsStore.getState().fetchCustomFieldDefinitions();
    });
  })
  .catch((err) => {
    console.error('Failed to subscribe custom field definitions to org scope changes:', err);
  });
