import { TRUST_CONTROL_CATALOG } from '../controlCatalog';
import { DECLARED_CONTROL_CATALOG } from '../declaredCatalog';
import { FRAMEWORK_CROSSWALK } from '../frameworkCrosswalk';
import type { TrustCatalogCopy } from './types';

// English is generated from the catalogs and the crosswalk so it stays single-sourced (spec §19.4).
const controls = Object.fromEntries(
  [...TRUST_CONTROL_CATALOG, ...DECLARED_CONTROL_CATALOG].map((c) => [c.id, { title: c.title, description: c.description }]),
) as TrustCatalogCopy['controls'];

const crosswalk = Object.fromEntries(
  Object.entries(FRAMEWORK_CROSSWALK).map(([fw, refs]) => [fw, Object.fromEntries(Object.entries(refs).map(([ref, e]) => [ref, e.label]))]),
) as TrustCatalogCopy['crosswalk'];

export const en: TrustCatalogCopy = {
  controls,
  categories: {
    endpoint_protection: 'Endpoint protection',
    patching_hardening: 'Patching & hardening',
    identity_access: 'Identity & access',
    data_protection: 'Data protection',
    monitoring: 'Monitoring',
    governance: 'Governance and response',
  },
  crosswalk,
  statuses: {
    met: 'Met', attention: 'Needs attention', not_met: 'Not met', not_assessed: 'Not assessed',
    current: 'Current', expired: 'Expired',
  },
};
