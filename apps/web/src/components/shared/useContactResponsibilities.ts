import { useEffect, useState } from 'react';
import { fetchWithAuth } from '../../stores/auth';
import { usePermissions } from '../../lib/permissions';

export type ResponsibilityScope = 'device_group' | 'site' | 'organization';

export type ResponsibleContact = {
  contactId: string;
  name: string | null;
  email: string | null;
  phone: string | null;
  mobile: string | null;
  title: string | null;
  isPrimary: boolean;
};

export type Responsibility = {
  role: string;
  level: ResponsibilityScope;
  contacts: ResponsibleContact[];
};

/**
 * Responsibilities resolved for one Site or one Device. Shared by the
 * "Responsible contacts" card and the device header's contact chip.
 * `canRead` false means the caller must render nothing: the route is gated on
 * organizations:read and no request is made without it.
 */
export function useContactResponsibilities({ orgId, siteId, deviceId }: { orgId: string; siteId?: string; deviceId?: string }) {
  const { can } = usePermissions();
  const canRead = can('organizations', 'read');
  const [items, setItems] = useState<Responsibility[] | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!canRead || !orgId || (!siteId && !deviceId)) return;
    let cancelled = false;
    setItems(null);
    setFailed(false);
    const query = deviceId
      ? `deviceId=${encodeURIComponent(deviceId)}`
      : `siteId=${encodeURIComponent(siteId as string)}`;
    fetchWithAuth(`/orgs/organizations/${orgId}/contact-responsibilities?${query}`)
      .then(async (res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        return res.json() as Promise<{ responsibilities: Responsibility[] }>;
      })
      .then((data) => {
        if (!cancelled) setItems(data.responsibilities ?? []);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, orgId, siteId, deviceId]);

  return { canRead, items, failed };
}

/** How a contact is named when the record has no name: email, then phone. */
export function contactDisplayName(contact: ResponsibleContact): string | null {
  return contact.name || contact.email || contact.phone || contact.mobile || null;
}
