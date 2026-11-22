import { useEffect, useRef, useState } from 'react';
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

function isResponsibilityList(value: unknown): value is Responsibility[] {
  return Array.isArray(value) && value.every((r) => r !== null && typeof r === 'object' && Array.isArray((r as Responsibility).contacts));
}

/**
 * Responsibilities resolved for one Site or one Device. Shared by the
 * "Responsible contacts" card and the device header's contact chip.
 * `canRead` false means the caller must render nothing: the route is gated on
 * organizations:read and no request is made without it. `failed` covers an
 * error status, a network error and a body without a `responsibilities` list;
 * `unavailable` marks the failures that are a 403 or 404, which a caller may
 * treat as nothing to show. Changing `reloadKey` asks again.
 */
export function useContactResponsibilities({
  orgId,
  siteId,
  deviceId,
  reloadKey = 0,
}: {
  orgId: string;
  siteId?: string;
  deviceId?: string;
  reloadKey?: number;
}) {
  const { can } = usePermissions();
  const canRead = can('organizations', 'read');
  const [items, setItems] = useState<Responsibility[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  // What the list on screen was loaded for; a reload of the same thing keeps it.
  const loadedFor = useRef<string | null>(null);

  useEffect(() => {
    if (!canRead || !orgId || (!siteId && !deviceId)) return;
    let cancelled = false;
    const identity = `${orgId}|${siteId ?? ''}|${deviceId ?? ''}`;
    // A different site or device: drop the old list. The same one again (a
    // retry): keep it on screen until the new answer lands.
    if (loadedFor.current !== identity) setItems(null);
    loadedFor.current = identity;
    setFailed(false);
    setUnavailable(false);
    const query = deviceId
      ? `deviceId=${encodeURIComponent(deviceId)}`
      : `siteId=${encodeURIComponent(siteId as string)}`;
    fetchWithAuth(`/orgs/organizations/${orgId}/contact-responsibilities?${query}`)
      .then(async (res) => {
        if (!res.ok) {
          // "Not yours to see" / "no such record": an answer, not an outage.
          if (!cancelled && (res.status === 403 || res.status === 404)) setUnavailable(true);
          throw new Error(`HTTP ${res.status}`);
        }
        const data = (await res.json()) as { responsibilities?: unknown } | null;
        // A body without the list is a contract break, not "no contacts".
        if (!isResponsibilityList(data?.responsibilities)) throw new Error('Malformed contact-responsibilities response');
        return data.responsibilities;
      })
      .then((responsibilities) => {
        if (!cancelled) setItems(responsibilities);
      })
      .catch((err) => {
        console.error('[useContactResponsibilities] contacts did not load', err);
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [canRead, orgId, siteId, deviceId, reloadKey]);

  return { canRead, items, failed, unavailable };
}

/** How a contact is named when the record has no name: email, then phone. */
export function contactDisplayName(contact: ResponsibleContact): string | null {
  return contact.name || contact.email || contact.phone || contact.mobile || null;
}
