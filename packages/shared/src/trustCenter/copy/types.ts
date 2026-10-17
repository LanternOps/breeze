import type { DeclaredControlId } from '../declaredCatalog';
import type { TelemetryControlId, TrustControlCategory, TrustControlStatus, TrustFramework } from '../types';

/** Per-locale copy for the catalog-driven strings of a trust page (spec §19 item 31). */
export interface TrustCatalogCopy {
  controls: Record<TelemetryControlId | DeclaredControlId, { title: string; description: string }>;
  categories: Record<TrustControlCategory, string>;
  /** framework → crosswalk ref → Breeze's own label for it. Completeness is enforced by copy.test.ts. */
  crosswalk: { [F in TrustFramework]: Record<string, string> };
  statuses: Record<TrustControlStatus | 'current' | 'expired', string>;
}
