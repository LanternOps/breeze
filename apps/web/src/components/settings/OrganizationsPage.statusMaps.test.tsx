import { describe, it, expect } from 'vitest';
import { statusColors, statusLabelKeys } from './OrganizationsPage';
import type { Organization } from './organizationTypes';

// Wave 1's final review required the web UI learn a new org status in the same
// wave that first SETS one (`merging`, then `archived`/`purging` in Wave 4) —
// otherwise `statusColors[org.status]` interpolates `undefined` into the badge
// class list and `t(statusLabelKeys[org.status])` renders a missing key.
//
// Kept as a literal list rather than importing the backend's `orgStatusEnum`
// (`apps/api/src/db/schema/orgs.ts`): apps/web has no dependency on apps/api or
// drizzle-orm, so this is the same manual-sync obligation the `Organization`
// status unions in orgStore.ts/organizationTypes.ts
// already carry. Typing this array as `Organization['status'][]` also makes a
// status missing from OrganizationList's union a compile error, not just a
// runtime gap — `tsc --noEmit` catches that half of the contract.
const ALL_ORG_STATUSES: Organization['status'][] = [
  'active',
  'trial',
  'suspended',
  'churned',
  'offboarding',
  'merging',
  'archived',
  'purging',
];

describe('org status maps cover every lifecycle status', () => {
  it.each(ALL_ORG_STATUSES)('OrganizationsPage has a label key and color class for %s', (status) => {
    expect(statusLabelKeys[status]).toBeTruthy();
    expect(statusColors[status]).toBeTruthy();
  });
});
