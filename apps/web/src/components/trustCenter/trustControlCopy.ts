// Catalog copy for the Trust Center editor (category labels, control titles and descriptions). W02a moved it
// here out of TrustControlsSection so W02h can localize it in ONE file; until then it returns the catalog's
// English (spec §19 item 4), for telemetry and declared controls alike.
import { useMemo } from 'react';
import {
  declaredControlById,
  trustControlById,
  type DeclaredControlId,
  type TelemetryControlId,
  type TrustControlCategory,
} from '@breeze/shared';

const CATEGORY_LABEL: Record<TrustControlCategory, string> = {
  endpoint_protection: 'Endpoint protection',
  patching_hardening: 'Patching and hardening',
  identity_access: 'Identity and access',
  data_protection: 'Data protection',
  monitoring: 'Monitoring',
  governance: 'Governance and response',
};

export interface TrustControlCopy {
  categoryLabel(c: TrustControlCategory): string;
  controlTitle(id: TelemetryControlId | DeclaredControlId): string;
  controlDescription(id: TelemetryControlId | DeclaredControlId): string;
}

function definition(id: TelemetryControlId | DeclaredControlId) {
  return trustControlById(id as TelemetryControlId) ?? declaredControlById(id as DeclaredControlId);
}

const ENGLISH: TrustControlCopy = {
  categoryLabel: (c) => CATEGORY_LABEL[c],
  controlTitle: (id) => definition(id)?.title ?? id,
  controlDescription: (id) => definition(id)?.description ?? '',
};

export function useTrustControlCopy(): TrustControlCopy {
  return useMemo(() => ENGLISH, []);
}
