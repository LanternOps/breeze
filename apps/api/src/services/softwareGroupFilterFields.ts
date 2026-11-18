/** Shared by inventory ingest and software-change events; kept dependency-free to avoid cycles. */
export const SOFTWARE_GROUP_FILTER_FIELDS = [
  'software.installed',
  'software.notInstalled',
  'software.version',
  'software.vendor',
] as const;

export type SoftwareGroupFilterField = typeof SOFTWARE_GROUP_FILTER_FIELDS[number];
