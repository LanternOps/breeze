import { useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import '@/lib/i18n';

// Audit rows carry a stable machine `resourceType` (`saved_filter`,
// `patch_compliance_report`, ...). Showing that token as a target read as a
// bug (#9856), so it is rendered through the `admin:audit.resourceTypes`
// catalog, keyed by the stored type. `auditResourceType.test.ts` scans the API
// source and fails when a type the API can write has no label.
//
// The catch-all audit middleware derives a type from the first URL segment
// (`getResourceTypeFromPath` in apps/api/src/index.ts), so the set is open:
// anything the catalog misses is humanized rather than printed raw.

const ACRONYMS: Readonly<Record<string, string>> = {
  ai: 'AI',
  api: 'API',
  mcp: 'MCP',
  sso: 'SSO',
  dns: 'DNS',
  edr: 'EDR',
  psa: 'PSA',
  pam: 'PAM',
  sla: 'SLA',
};

function humanize(type: string): string {
  const words = type
    .split(/[\s._-]+/)
    .filter(Boolean)
    .map((word) => {
      const lower = word.toLowerCase();
      return Object.hasOwn(ACRONYMS, lower) ? ACRONYMS[lower]! : lower;
    });
  if (words.length === 0) return '';
  const first = words[0]!;
  words[0] = first.charAt(0).toUpperCase() + first.slice(1);
  return words.join(' ');
}

/**
 * Human label for an audit resource type. `labels` is the translated catalog
 * (see `useAuditResourceTypeFormatter`); without it, or for a type it does not
 * cover, the type is humanized. Returns '-' when there is no type at all.
 */
export function formatAuditResourceType(
  type: string | null | undefined,
  labels?: Record<string, string>,
): string {
  const trimmed = type?.trim();
  if (!trimmed) return '-';
  const label = labels && Object.hasOwn(labels, trimmed) ? labels[trimmed] : undefined;
  return label ?? (humanize(trimmed) || '-');
}

/** Locale-aware `formatAuditResourceType`. */
export function useAuditResourceTypeFormatter(): (type: string | null | undefined) => string {
  const { t } = useTranslation('admin');

  const labels = useMemo(() => {
    const raw = t('audit.resourceTypes', { returnObjects: true }) as unknown;
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) return undefined;
    const entries = Object.entries(raw as Record<string, unknown>).filter(
      (entry): entry is [string, string] => typeof entry[1] === 'string' && entry[1].trim() !== '',
    );
    return entries.length > 0 ? Object.fromEntries(entries) : undefined;
  }, [t]);

  return useCallback((type: string | null | undefined) => formatAuditResourceType(type, labels), [labels]);
}
