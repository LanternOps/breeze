import { describe, expect, it } from 'vitest';
import { statusColors, statusLabelKeys } from './orgStatus';
import type { Organization } from '../components/settings/organizationTypes';

/**
 * Status colour is meaning, and meaning has to survive a theme change: the
 * pills use the app's semantic tokens (success / warning / destructive /
 * muted / primary), never raw palette steps, so `active` stays the same green
 * as every other "healthy" in the product and dark mode needs no per-status
 * override.
 */
describe('orgStatus colours', () => {
  it('use semantic tokens, not raw Tailwind palette steps', () => {
    const rawPalette = /\b(?:emerald|green|blue|amber|yellow|red|orange|indigo|gray|slate|zinc)-\d{2,3}\b/;
    for (const [status, classes] of Object.entries(statusColors)) {
      expect(classes, `${status} pill uses a raw palette colour`).not.toMatch(rawPalette);
      expect(classes, `${status} pill carries no dark-mode override (tokens theme themselves)`).not.toMatch(/\bdark:/);
    }
  });

  it('keeps trial off the brand colour so it never reads as a link', () => {
    expect(statusColors.trial).not.toMatch(/\bprimary\b/);
  });
});

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
// status missing from organizationTypes' union a compile error, not just a
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
  it.each(ALL_ORG_STATUSES)('has a label key and color class for %s', (status) => {
    expect(statusLabelKeys[status]).toBeTruthy();
    expect(statusColors[status]).toBeTruthy();
  });
});
