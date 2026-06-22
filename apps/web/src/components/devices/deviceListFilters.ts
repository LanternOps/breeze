// Shared client-side ("inline") filter state for the Devices page. Owned by
// DevicesPage and threaded into BOTH DeviceFilterToolbar (the search box) and
// DeviceList (the filtering).
//
// In the chip-centric model every structured filter (status/os/role/org/site/
// group/CPU/etc.) lives in the single server-resolved FilterConditionGroup and
// renders as an editable chip. The ONLY inline/instant client filter left is
// device search (display name or hostname), so this object now carries just
// `search`.

export interface ListFilters {
  search: string;
}

export const DEFAULT_LIST_FILTERS: ListFilters = {
  search: '',
};
