import type {
  PortalAccessPolicyRowValues,
  PortalAccessPolicyValues,
  PortalAccessPolicyView,
  PortalPolicySource,
  PortalSignInCapabilities,
} from '@breeze/shared';

/** Test fixture: a policy view as the W03a routes return it. */
export const BREEZE_DEFAULTS: PortalAccessPolicyValues = {
  entraEnabled: false,
  googleEnabled: false,
  passwordMode: 'allowed',
  selfRegistrationMode: 'off',
  ssoNewPersonMode: 'approval',
  ssoSessionMaxHours: 12,
};

const EMPTY_ROW: PortalAccessPolicyRowValues = {
  entraEnabled: null,
  googleEnabled: null,
  passwordMode: null,
  selfRegistrationMode: null,
  ssoNewPersonMode: null,
  ssoSessionMaxHours: null,
};

export function makePolicyView(opts: {
  kind?: 'org' | 'partner';
  values?: Partial<PortalAccessPolicyRowValues>;
  inherited?: Partial<PortalAccessPolicyValues>;
  inheritedSource?: Exclude<PortalPolicySource, 'org'>;
  capabilities?: Partial<PortalSignInCapabilities>;
  passwordModeFallback?: boolean;
  entraTenantProven?: boolean | null;
  canEdit?: boolean;
} = {}): PortalAccessPolicyView {
  const kind = opts.kind ?? 'org';
  const values = { ...EMPTY_ROW, ...opts.values };
  const inheritedValues = { ...BREEZE_DEFAULTS, ...opts.inherited };
  const inheritedSource = opts.inheritedSource ?? (kind === 'org' ? 'partner' : 'default');
  const inherited = Object.fromEntries(
    Object.entries(inheritedValues).map(([k, v]) => [k, { value: v, source: inheritedSource }]),
  ) as PortalAccessPolicyView['inherited'];
  const effective = Object.fromEntries(
    Object.entries(inheritedValues).map(([k, v]) => {
      const own = values[k as keyof PortalAccessPolicyRowValues];
      return [k, own !== null ? { value: own, source: kind } : { value: v, source: inheritedSource }];
    }),
  ) as PortalAccessPolicyView['effective'];
  return {
    owner: { kind, id: kind === 'org' ? 'org-1' : 'partner-1' },
    values,
    inherited,
    effective,
    passwordModeFallback: opts.passwordModeFallback ?? false,
    capabilities: { entra: false, google: false, selfRegistration: false, ...opts.capabilities },
    entraTenantProven: opts.entraTenantProven !== undefined ? opts.entraTenantProven : (kind === 'partner' ? null : false),
    canEdit: opts.canEdit ?? true,
  };
}
