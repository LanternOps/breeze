/**
 * Copy a configuration policy (#12309, #11776; plan W05b K1), to the same owner
 * or to another organization or the MSP.
 *
 * WHAT A COPY IS
 *  - A new policy, always `inactive`, with no assignments: the body cannot say
 *    otherwise (`copyConfigPolicySchema` has neither field).
 *  - The source's OWN feature links. Inline settings are copied; a linked item
 *    (an update ring, a software policy, a monitor, a script) is referenced, not
 *    cloned (#12309's safer default). Inherited links are not copied: the copy's
 *    own parent, if any, supplies them.
 *  - A link the new owner cannot carry is left behind and listed in `dropped`
 *    with a reason code (owner decision Q2). The copy is not refused for it.
 *
 * ONE PLAN, TWO MODES. `planCopy` decides every link, read-only, before the
 * mode is looked at. A dry run returns that plan; a real run writes exactly its
 * `carried` links. So the dry run and the real run produce the same `dropped`
 * list by construction. A write-time failure rolls the whole copy back and is an
 * error; it never adds to `dropped`.
 *
 * WHO MAY COPY (each check in this order, so no answer is an oracle)
 *  1. `canMutateOrgWideGovernance`: a site-restricted caller cannot create a
 *     policy at all.
 *  2. The source is read with the READ predicate (`getConfigPolicy(…, { access:
 *     'read' })`): a source the caller cannot read is a 404, as on `GET /:id`.
 *  3. The new owner comes from the body and is checked here, never trusted:
 *     write access to that organization, or `canManagePartnerWidePolicies` for
 *     the MSP. A copy stays under the source's MSP.
 *  4. The parent, as on create: readable, compatible with the new owner, and
 *     the create's HP CMSL and vendor-update gates for a parent that arms them.
 *  5. Each carried link re-runs the write's arming gates for this caller: HP
 *     warranty collection, auto-quarantine, security agents and vendor updates.
 *     A refusal there is a 403 in both modes: it is about the caller, not the
 *     owner. Nothing the source's author recorded is carried: HP licence
 *     consent and the auto-quarantine authority are stamped from this session.
 *
 * WHY A REASON IS A CODE. `dropped` is shown to the caller, so it never carries
 * a validator's text (those name ids) or anything about the linked item. A
 * missing item and another tenant's item get the same code.
 *
 * TENANCY. Every read runs in the caller's request context. The writes run in
 * one `withDbTransaction`, with the catch outside it, through the same
 * `createConfigPolicy` and `addFeatureLink` every other writer uses.
 */
import { and, eq } from 'drizzle-orm';
import {
  ORG_SCOPED_ONLY_FEATURE_TYPES,
  type ConfigFeatureType,
} from '@breeze/shared';
import {
  securityAgentsInlineSettingsSchema,
  warrantyHpCmslRequested,
  type ConfigPolicyCopyDropReason,
  type CopyConfigPolicyInput,
} from '@breeze/shared/validators';
import { db, withDbTransaction } from '../db';
import { backupConfigs } from '../db/schema';
import type { AuthContext } from '../middleware/auth';
import type { UserPermissions } from './permissions';
import {
  addFeatureLink,
  createConfigPolicy,
  getConfigPolicy,
  parentPolicyArmsOemUpdates,
  parentPolicyEnablesHpCmslCollection,
  validateFeaturePolicyExists,
  BackupDestinationNotInOrgError,
  WarrantyConsentError,
  PARTNER_LINKABLE_FEATURE_TYPES,
  type FeatureLinkWriteOptions,
} from './configurationPolicy';
import { canManagePartnerWidePolicies, PARTNER_WIDE_WRITE_DENIED_MESSAGE } from './partnerWideAccess';
import { canMutateOrgWideGovernance, SITE_CEILING_WRITE_DENIED_MESSAGE } from './siteCeilingAccess';
import { InvalidParentPolicyError, isCompatibleParent } from './configPolicyOwnership';
import { resolvePartnerIdForOrg } from '../routes/patches/helpers';
import { getMonitorDefinition } from './monitors/monitorService';
import { isMonitorAttachableToOwner } from './monitors/monitorAttachability';
import { normalizeAutomationActions, resolveAutomationReferencesForOwner, type AutomationAction } from './automationRuntime';
import { AutomationReferenceAuthorizationError } from './automationReferenceAuthorization';
import { brandingWriteError } from './helperBranding';
import { checkSecurityRuleSetsWrite } from '../routes/configurationPolicies/securityRuleSetGate';
import { checkSecurityQuarantineWrite } from '../routes/configurationPolicies/securityQuarantineGate';
import { checkHpCmslWriteAllowed } from '../routes/configurationPolicies/hpCmslGate';
import { mayArmSecurityAgents } from '../routes/configurationPolicies/securityAgentsGate';
import {
  checkOemUpdatesArmAllowed,
  mayArmOemUpdates,
  oemUpdatesPreviousForWrite,
} from '../routes/configurationPolicies/oemUpdatesGate';
import { checkSecurityAgentsLinkWrite, SecurityAgentsLinkWriteError } from './securityAgents/securityAgentsLinkWrite';
import { checkOemUpdatesLinkWrite, OemUpdatesLinkWriteError } from './oemUpdates/oemUpdatesLinkWrite';
import { readOwnerCatalog } from './securityAgents/managedPolicyOwnerCatalog';
import { desiredManagedPolicy } from './securityAgents/managedPolicyGenerator';

export type ConfigPolicyCopyDrop = { featureType: ConfigFeatureType; reason: ConfigPolicyCopyDropReason };

export type ConfigPolicyCopyResult =
  | { dryRun: true; carried: ConfigFeatureType[]; dropped: ConfigPolicyCopyDrop[] }
  | { dryRun: false; policyId: string; orgId: string | null; dropped: ConfigPolicyCopyDrop[] };

/** A refusal the route returns as is: `status` and a JSON `body`. */
export class ConfigPolicyCopyRefusedError extends Error {
  constructor(
    readonly status: 400 | 403 | 404,
    readonly body: Record<string, unknown>,
  ) {
    super(typeof body.error === 'string' ? body.error : 'Copy refused');
    this.name = 'ConfigPolicyCopyRefusedError';
  }
}

type CopyOwner = { orgId: string; partnerId: null } | { orgId: null; partnerId: string };

type SourceLink = { featureType: string; featurePolicyId?: string | null; inlineSettings?: unknown };

type CarriedLink = {
  featureType: ConfigFeatureType;
  featurePolicyId: string | null;
  inlineSettings: unknown;
  options: FeatureLinkWriteOptions;
};

type PlanContext = {
  auth: AuthContext;
  permissions: UserPermissions | undefined;
  owner: CopyOwner;
  /** The source policy's organization; null for an MSP-managed source. */
  sourceOrgId: string | null;
  /** The new parent's own links (for vendor updates, the link in effect). */
  parent: { id: string; featureLinks: ReadonlyArray<SourceLink> } | null;
};

type LinkDecision = { carry: CarriedLink } | { drop: ConfigPolicyCopyDropReason };

const refuse = (status: 400 | 403 | 404, body: Record<string, unknown>) => new ConfigPolicyCopyRefusedError(status, body);
const ACCESS_DENIED = { error: 'Access to this organization denied' };
const invalidParent = () => {
  const err = new InvalidParentPolicyError();
  return refuse(400, { error: err.code, message: err.message });
};

function gate(result: { allowed: true } | { allowed: false; body: Record<string, unknown> }): void {
  if (!result.allowed) throw refuse(403, result.body);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** A deep copy, so the plan never shares an object with the source's read. */
function cloneSettings(value: unknown): unknown {
  return value === undefined || value === null ? null : structuredClone(value);
}

export async function copyConfigPolicy(
  auth: AuthContext,
  sourceId: string,
  input: CopyConfigPolicyInput,
  opts: { permissions?: UserPermissions } = {},
): Promise<ConfigPolicyCopyResult> {
  if (!canMutateOrgWideGovernance(auth)) throw refuse(403, { error: SITE_CEILING_WRITE_DENIED_MESSAGE });

  const source = await getConfigPolicy(sourceId, auth, { access: 'read' });
  if (!source) throw refuse(404, { error: 'Configuration policy not found' });

  const { owner, ownerPartnerId } = await resolveCopyOwner(auth, input);

  const sourcePartnerId = source.partnerId ?? (source.orgId ? await resolvePartnerIdForOrg(source.orgId) : null);
  if (!sourcePartnerId || sourcePartnerId !== ownerPartnerId) {
    throw refuse(400, {
      error: 'A copy stays under the MSP that manages the source policy.',
      code: 'COPY_ACROSS_MSPS',
    });
  }

  // Omitted keeps the source's parent; null copies with none.
  const parentId = input.parentPolicyId === undefined ? source.parentPolicyId ?? null : input.parentPolicyId;
  let parent: PlanContext['parent'] = null;
  if (parentId) {
    // The same rule as create: a parent the caller cannot read and a parent the
    // new owner may not inherit from are one 400, so neither is an oracle.
    const row = await getConfigPolicy(parentId, auth, { access: 'read' });
    if (
      !row
      || !isCompatibleParent(
        { orgId: owner.orgId, partnerId: owner.partnerId, orgPartnerId: owner.orgId ? ownerPartnerId : null },
        { id: row.id, orgId: row.orgId, partnerId: row.partnerId, parentPolicyId: row.parentPolicyId },
      )
    ) {
      throw invalidParent();
    }
    // The create's doors (#5511 D4, #11070): a child of an armed parent is armed.
    if (await parentPolicyEnablesHpCmslCollection(parentId)) gate(checkHpCmslWriteAllowed(auth, opts.permissions));
    if (await parentPolicyArmsOemUpdates(parentId)) gate(checkOemUpdatesArmAllowed(auth, opts.permissions));
    parent = { id: row.id, featureLinks: row.featureLinks as ReadonlyArray<SourceLink> };
  }

  const plan = await planCopy(
    { auth, permissions: opts.permissions, owner, sourceOrgId: source.orgId ?? null, parent },
    source.featureLinks as ReadonlyArray<SourceLink>,
  );

  if (input.dryRun) {
    return { dryRun: true, carried: plan.carried.map((link) => link.featureType), dropped: plan.dropped };
  }

  const policyId = await writeCopy(auth, owner, {
    name: input.name,
    description: source.description ?? undefined,
    parentPolicyId: parentId,
  }, plan.carried);
  return { dryRun: false, policyId, orgId: owner.orgId, dropped: plan.dropped };
}

/**
 * The new owner, from the body, checked against this caller. Mirrors the
 * create route's rules, except that an organization caller naming another
 * organization is refused rather than silently ignored.
 */
async function resolveCopyOwner(
  auth: AuthContext,
  input: CopyConfigPolicyInput,
): Promise<{ owner: CopyOwner; ownerPartnerId: string }> {
  if (input.ownerScope === 'partner') {
    // The partner is the caller's own, never a client value.
    if (!auth.partnerId || auth.scope === 'organization') {
      throw refuse(403, { error: 'Partner-wide policies require partner scope' });
    }
    // A partner user with access to only some organizations cannot create a
    // policy that reaches all of them.
    if (!canManagePartnerWidePolicies(auth)) throw refuse(403, { error: PARTNER_WIDE_WRITE_DENIED_MESSAGE });
    return { owner: { orgId: null, partnerId: auth.partnerId }, ownerPartnerId: auth.partnerId };
  }

  let orgId = input.orgId;
  if (auth.scope === 'organization') {
    if (!auth.orgId) throw refuse(403, { error: 'Organization context required' });
    if (orgId && orgId !== auth.orgId) throw refuse(403, ACCESS_DENIED);
    orgId = auth.orgId;
  } else if (auth.scope === 'partner') {
    if (!orgId) {
      const accessible = auth.accessibleOrgIds ?? [];
      const [only] = accessible;
      if (accessible.length !== 1 || !only) {
        throw refuse(400, {
          error: accessible.length === 0
            ? 'No accessible organization to own this policy'
            : 'orgId is required when the partner has multiple organizations',
        });
      }
      orgId = only;
    }
    if (!auth.canAccessOrg(orgId)) throw refuse(403, ACCESS_DENIED);
  } else if (auth.scope === 'system') {
    if (!orgId) throw refuse(400, { error: 'orgId is required' });
  } else {
    throw refuse(403, ACCESS_DENIED);
  }

  const ownerPartnerId = await resolvePartnerIdForOrg(orgId);
  if (!ownerPartnerId) throw refuse(404, { error: 'Organization not found' });
  return { owner: { orgId, partnerId: null }, ownerPartnerId };
}

async function planCopy(
  ctx: PlanContext,
  links: ReadonlyArray<SourceLink>,
): Promise<{ carried: CarriedLink[]; dropped: ConfigPolicyCopyDrop[] }> {
  const carried: CarriedLink[] = [];
  const dropped: ConfigPolicyCopyDrop[] = [];
  // In feature-type order: the links are read with no ORDER BY, and the dry
  // run and the real run must list the same features in the same order.
  const ordered = [...links].sort((a, b) => (a.featureType < b.featureType ? -1 : a.featureType > b.featureType ? 1 : 0));
  // Sequential on purpose: some checks open a savepoint, which must never run
  // beside siblings in a Promise.all.
  for (const link of ordered) {
    const featureType = link.featureType as ConfigFeatureType;
    const decision = await planLink(ctx, featureType, link);
    if ('drop' in decision) dropped.push({ featureType, reason: decision.drop });
    else carried.push(decision.carry);
  }
  return { carried, dropped };
}

async function planLink(ctx: PlanContext, featureType: ConfigFeatureType, link: SourceLink): Promise<LinkDecision> {
  const { auth, permissions, owner } = ctx;
  const partnerOwned = owner.orgId === null;

  // An org-only feature (OneDrive Helper) cannot live on an MSP-managed policy.
  if (partnerOwned && ORG_SCOPED_ONLY_FEATURE_TYPES.has(featureType)) return { drop: 'org_only_feature' };

  // The linked item, validated for the NEW owner exactly as a link write is.
  const featurePolicyId = link.featurePolicyId ?? null;
  if (featurePolicyId) {
    if (partnerOwned && !PARTNER_LINKABLE_FEATURE_TYPES.has(featureType)) return { drop: 'linked_item_unavailable' };
    const validation = await validateFeaturePolicyExists(featureType, featurePolicyId, owner);
    if (!validation.valid) return { drop: 'linked_item_unavailable' };
  }

  let inlineSettings = cloneSettings(link.inlineSettings);
  const options: FeatureLinkWriteOptions = {};
  const carry = (): LinkDecision => ({ carry: { featureType, featurePolicyId, inlineSettings, options } });

  switch (featureType) {
    case 'monitors': {
      const items = isRecord(inlineSettings) && Array.isArray(inlineSettings.items) ? inlineSettings.items : [];
      for (const item of items) {
        const monitorId = isRecord(item) && typeof item.monitorId === 'string' ? item.monitorId : null;
        // A monitor this caller cannot see and one the new owner cannot attach
        // read the same: neither is described.
        if (!monitorId || !(await getMonitorDefinition(monitorId, auth))) return { drop: 'linked_item_unavailable' };
        if (!(await isMonitorAttachableToOwner(monitorId, owner))) return { drop: 'linked_item_unavailable' };
      }
      return carry();
    }

    case 'automation': {
      const items = isRecord(inlineSettings) && Array.isArray(inlineSettings.items) ? inlineSettings.items : [];
      const actions = items.flatMap((item) => normalizeAutomationActions(isRecord(item) ? item.actions ?? [] : []));
      return (await ownerMayUseReferences(owner, actions)) ? carry() : { drop: 'linked_item_unavailable' };
    }

    case 'compliance': {
      // Each remediation script and catalog package must be one the new owner
      // may use, by the same reference rule automations use.
      return (await ownerMayUseReferences(owner, complianceRemediationReferences(inlineSettings)))
        ? carry()
        : { drop: 'linked_item_unavailable' };
    }

    case 'security': {
      const ruleSets = await checkSecurityRuleSetsWrite(owner, inlineSettings);
      if (!ruleSets.ok) {
        return { drop: ruleSets.body.code === 'YARA_RULE_SET_NOT_ATTACHABLE' ? 'linked_item_unavailable' : 'settings_not_valid' };
      }
      // Auto-quarantine moves files with no human in the loop: the copier must
      // hold devices.execute, and the authority stored is the copier's.
      const quarantine = checkSecurityQuarantineWrite(auth, permissions, owner, inlineSettings);
      if (!quarantine.allowed) throw refuse(403, quarantine.body);
      options.executionAuthority = quarantine.executionAuthority;
      return carry();
    }

    case 'backup': {
      const destinationConfigId = isRecord(inlineSettings) && typeof inlineSettings.destinationConfigId === 'string'
        ? inlineSettings.destinationConfigId
        : null;
      if (destinationConfigId) {
        // A destination holds credentials and is org-owned: an MSP-managed
        // policy cannot name one, and another organization's is not usable.
        if (!owner.orgId) return { drop: 'linked_item_unavailable' };
        const [destination] = await db
          .select({ id: backupConfigs.id })
          .from(backupConfigs)
          .where(and(eq(backupConfigs.id, destinationConfigId), eq(backupConfigs.orgId, owner.orgId)))
          .limit(1);
        if (!destination) return { drop: 'linked_item_unavailable' };
      }
      return carry();
    }

    case 'helper': {
      // A copy has no assignments, so only the branding values themselves can fail.
      return brandingWriteError(inlineSettings, []) ? { drop: 'settings_not_valid' } : carry();
    }

    case 'warranty': {
      // The source author's acceptance of HP's licence is theirs, not the
      // copier's: drop it, and addFeatureLink records a fresh one for this user.
      if (isRecord(inlineSettings) && isRecord(inlineSettings.hpCmsl)) {
        const { consent: _consent, ...hpCmsl } = inlineSettings.hpCmsl;
        inlineSettings = { ...inlineSettings, hpCmsl };
      }
      if (warrantyHpCmslRequested(inlineSettings)) gate(checkHpCmslWriteAllowed(auth, permissions));
      return carry();
    }

    case 'security_agents': {
      const armAuthorized = mayArmSecurityAgents(auth, permissions);
      const check = checkSecurityAgentsLinkWrite({ featurePolicyId, inlineSettings, armAuthorized });
      if (!check.ok) {
        if (check.refusal.status === 403) throw refuse(403, check.refusal.body);
        return { drop: 'settings_not_valid' };
      }
      inlineSettings = check.inlineSettings ?? null;
      options.securityAgentsArmAuthorized = armAuthorized;
      // The write generates the software policy from the owner's catalog and
      // refuses when a package is missing; decide that here, not at write time.
      const settings = securityAgentsInlineSettingsSchema.safeParse(inlineSettings);
      if (settings.success) {
        const ownerPolicy = { id: 'copy', name: 'copy', orgId: owner.orgId, partnerId: owner.partnerId };
        const catalog = await readOwnerCatalog(db, ownerPolicy, settings.data);
        const desired = desiredManagedPolicy({ configPolicy: ownerPolicy, settings: settings.data, ...catalog });
        if (desired.missingCatalog.length > 0 || desired.missingBinary.length > 0) return { drop: 'linked_item_unavailable' };
      }
      return carry();
    }

    case 'oem_updates': {
      const armAuthorized = mayArmOemUpdates(auth, permissions);
      const check = checkOemUpdatesLinkWrite({
        featurePolicyId,
        // Compared with the link in effect: the new parent's, for a new link.
        previous: oemUpdatesPreviousForWrite({
          parentPolicyId: ctx.parent?.id ?? null,
          featureLinks: [],
          parentPolicy: ctx.parent ? { featureLinks: ctx.parent.featureLinks } : null,
        }),
        next: inlineSettings,
        armAuthorized,
      });
      if (!check.ok) {
        if (check.refusal.status === 403) throw refuse(403, check.refusal.body);
        return { drop: 'settings_not_valid' };
      }
      inlineSettings = check.inlineSettings ?? null;
      options.oemUpdatesArmAuthorized = armAuthorized;
      return carry();
    }

    case 'onedrive_helper': {
      // The Microsoft 365 tenant and the libraries are the source
      // organization's own (one tenant per organization). In another
      // organization they would name a tenant that is not its own.
      if (owner.orgId !== ctx.sourceOrgId && oneDriveNamesTenant(inlineSettings)) {
        return { drop: 'linked_item_unavailable' };
      }
      return carry();
    }

    // Inline settings with no reference to a tenant's own item, or whose only
    // reference is featurePolicyId, validated above.
    case 'patch':
    case 'maintenance':
    case 'software_policy':
    case 'sensitive_data':
    case 'peripheral_control':
    case 'event_log':
    case 'remote_access':
    case 'pam':
    case 'vulnerability':
    case 'device_lifecycle':
    case 'hardware_monitoring':
    case 'time_sync':
    case 'workload_inventory':
    case 'system_protection':
    case 'containment':
    case 'wake_on_lan':
      return carry();

    default: {
      // Exhaustive: a feature type added later fails to compile here until
      // someone decides how a copy carries it. At run time a type this copy
      // does not know (a retired one) is left behind, never carried unchecked.
      const unclassified: never = featureType;
      void unclassified;
      return { drop: 'settings_not_valid' };
    }
  }
}

/** True when OneDrive Helper settings name a Microsoft 365 tenant or a library. */
function oneDriveNamesTenant(settings: unknown): boolean {
  if (!isRecord(settings)) return false;
  const tenant = typeof settings.tenantAssociationId === 'string' && settings.tenantAssociationId.trim() !== '';
  const libraries = Array.isArray(settings.libraries) && settings.libraries.length > 0;
  return tenant || libraries;
}

/**
 * Script and catalog ids a compliance link's remediations name, as automation
 * actions, so they go through the one reference rule automations use.
 */
function complianceRemediationReferences(settings: unknown): AutomationAction[] {
  const actions: AutomationAction[] = [];
  const items = isRecord(settings) && Array.isArray(settings.items) ? settings.items : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    if (typeof item.remediationScriptId === 'string') {
      actions.push({ type: 'run_script', scriptId: item.remediationScriptId });
    }
    const rules = Array.isArray(item.rules) ? item.rules : [];
    for (const rule of rules) {
      const remediation = isRecord(rule) && isRecord(rule.remediation) ? rule.remediation : null;
      if (!remediation) continue;
      if (remediation.type === 'script' && typeof remediation.scriptId === 'string') {
        actions.push({ type: 'run_script', scriptId: remediation.scriptId });
      } else if (remediation.type === 'software_deploy' && typeof remediation.catalogId === 'string') {
        actions.push({ type: 'deploy_software', catalogId: remediation.catalogId } as AutomationAction);
      }
    }
  }
  return actions;
}

/** Whether the new owner may use every script, package and channel these actions name. */
async function ownerMayUseReferences(owner: CopyOwner, actions: readonly AutomationAction[]): Promise<boolean> {
  if (actions.length === 0) return true;
  try {
    // A savepoint, with the catch outside it, so a refusal never poisons the
    // request transaction.
    await db.transaction((tx) => resolveAutomationReferencesForOwner(tx, owner, actions));
    return true;
  } catch (err) {
    if (err instanceof AutomationReferenceAuthorizationError) return false;
    throw err;
  }
}

async function writeCopy(
  auth: AuthContext,
  owner: CopyOwner,
  data: { name: string; description: string | undefined; parentPolicyId: string | null },
  carried: readonly CarriedLink[],
): Promise<string> {
  const userId = auth.user?.id ?? null;
  try {
    return await withDbTransaction(async () => {
      const policy = await createConfigPolicy(owner, {
        name: data.name,
        ...(data.description !== undefined ? { description: data.description } : {}),
        // Always, whatever the source's state: a copy reaches no device until
        // someone applies and activates it.
        status: 'inactive',
        ...(data.parentPolicyId ? { parentPolicyId: data.parentPolicyId } : {}),
      }, userId);
      for (const link of carried) {
        const added = await addFeatureLink(
          policy.id,
          link.featureType,
          link.featurePolicyId,
          link.inlineSettings,
          { userId },
          undefined,
          link.options,
        );
        // A new policy has no links, so a duplicate means the plan is wrong.
        if (!added) throw new Error(`Copy planned the ${link.featureType} feature twice`);
      }
      return policy.id;
    });
  } catch (err) {
    // The plan ran these checks a moment ago, so reaching one means the data
    // changed in between. The whole copy is rolled back.
    if (err instanceof InvalidParentPolicyError) throw invalidParent();
    if (err instanceof SecurityAgentsLinkWriteError || err instanceof OemUpdatesLinkWriteError) {
      throw refuse(err.status === 403 ? 403 : 400, err.body as Record<string, unknown>);
    }
    if (err instanceof AutomationReferenceAuthorizationError) {
      throw refuse(400, { error: 'Unknown or unauthorized automation reference' });
    }
    if (err instanceof BackupDestinationNotInOrgError) throw refuse(400, { error: err.message, code: err.code });
    if (err instanceof WarrantyConsentError) throw refuse(400, { error: err.message, code: err.code });
    throw err;
  }
}
