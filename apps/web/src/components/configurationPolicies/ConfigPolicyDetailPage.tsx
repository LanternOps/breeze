import { useState, useEffect, useLayoutEffect, useCallback, useMemo, useRef } from "react";
import { ArrowLeft, Info } from "lucide-react";
import Breadcrumbs from "../layout/Breadcrumbs";
import { useJwtClaims } from "@/lib/authScope";
import { extractApiError } from "@/lib/apiError";
import { useHashTab } from "@/lib/useHashState";
import { fetchWithAuth, useAuthStore } from "../../stores/auth";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { showToast } from "../shared/Toast";
import { Drawer } from "../shared/Drawer";
import { ConfirmDialog } from "../shared/ConfirmDialog";
import { useUnsavedGuard } from "../settings/partnerSettings/useUnsavedGuard";
import AppliesToStrip from "./AppliesToStrip";
import { parseAppliesTo } from "./appliesToSummary";
// The web layer only aliases the bare `@breeze/shared` root and the
// `/reportPdf` subpath (see apps/web/vitest.config.ts + tsconfig.json) — the
// `/constants` subpath isn't wired up here, so import from the root, which
// re-exports it.
import { ORG_SCOPED_ONLY_FEATURE_TYPES } from '@breeze/shared';
import type { FeatureType, FeatureLink, ParentPolicySummary } from './featureTabs/types';
import { FEATURE_META } from './featureTabs/types';
import { useFeatureLink } from './featureTabs/useFeatureLink';
import { FeatureDirtyReporterContext, FeatureReadOnlyContext } from './featureTabs/featureEditing';
import AppliesToPanel from './appliesTo/AppliesToPanel';
import { fetchPolicyReach, type ConfigPolicyReach } from './appliesTo/appliesToApi';
import type { PickerOwner } from './appliesTo/TargetPicker';
import FeatureRail, { type RailKey } from './page/FeatureRail';
import { FIRST_RAIL_FEATURE } from './page/featureState';
import PolicyHeader from './page/PolicyHeader';
import PolicyDetailsForm, { type PolicyDetails } from './page/PolicyDetailsForm';
import PolicyStateActions from './page/PolicyStateActions';
import type { PolicyStatus } from './page/PolicyHeader';
import { FeaturePolicyContext, type FeaturePolicyInfo } from './featureTabs/featurePolicyContext';
import { resolveViewerAccess } from './page/viewerAccess';
import { configFeatureLabel } from './configPolicyLabels';
import PolicyFeatureEditor from './page/PolicyFeatureEditor';
import ComplianceStatusTab from './ComplianceStatusTab';
import { usePageItemName } from '../layout/usePageItemName';

type PolicyDetail = {
  id: string;
  name: string;
  description?: string;
  status: "active" | "inactive" | "archived";
  orgId: string | null;
  partnerId: string | null;
  // Owning org's name, joined in by the API for org-owned policies.
  orgName?: string | null;
  createdAt?: string;
  updatedAt?: string;
  featureLinks: FeatureLink[];
  parentPolicyId: string | null;
  parentPolicy: ParentPolicySummary | null;
  childPolicies: { id: string; name: string }[];
  // Where the policy applies (#12306). Absent when the API is a release
  // behind; parsed with parseAppliesTo, which turns that into "unknown".
  appliesTo?: unknown;
  // What the caller may do with this policy (W03a). Absent when the API is a
  // release behind; parsed with parsePolicyAccess.
  access?: unknown;
};

// Which features the page offers. Derived from FEATURE_META keys (not a
// hand-listed subset) so it stays in lockstep with the canonical registry
// (#2004); featureTypeParity.test.ts asserts it. The rail orders them.
export const FEATURE_TYPES = Object.keys(FEATURE_META) as FeatureType[];

const SECTIONS: RailKey[] = [...FEATURE_TYPES, "compliance_status"];

// Preserve saved links to the retired tabs and canonicalize their hashes.
export const LEGACY_TAB_ALIASES: Record<'alert_rule' | 'monitoring', 'monitors'> = {
  alert_rule: 'monitors',
  monitoring: 'monitors',
};

// The Assignments tab became the always-visible Applies-to strip (#12306).
// Old `#assignments` links keep working: they open the strip's drawer over
// whichever feature was showing.
const APPLIES_TO_HASH_ALIAS = 'assignments';
// The Overview tab became the header and its details form (#12469). Old
// `#overview` links land on the first feature with the details form open.
const OVERVIEW_HASH_ALIAS = 'overview';

type HashRequest = RailKey | keyof typeof LEGACY_TAB_ALIASES | typeof APPLIES_TO_HASH_ALIAS | typeof OVERVIEW_HASH_ALIAS;
const HASH_REQUESTS: HashRequest[] = [
  ...SECTIONS,
  ...(Object.keys(LEGACY_TAB_ALIASES) as (keyof typeof LEGACY_TAB_ALIASES)[]),
  APPLIES_TO_HASH_ALIAS,
  OVERVIEW_HASH_ALIAS,
];

// Adopt the hash before paint on the client, as useHashTab does; useEffect on
// the server, where layout effects warn.
const useIsomorphicLayoutEffect = typeof window === "undefined" ? useEffect : useLayoutEffect;

const replaceHash = (section: RailKey) => {
  window.history.replaceState(
    window.history.state,
    '',
    `${window.location.pathname}${window.location.search}#${section}`,
  );
};

type ConfigPolicyDetailPageProps = {
  policyId?: string;
};
export default function ConfigPolicyDetailPage({
  policyId,
}: ConfigPolicyDetailPageProps) {
  useTranslation("policies");
  // The hash is a request; `shown` is the feature on screen. Keeping them
  // apart lets an alias (`#assignments`, `#overview`, a retired tab id) be
  // resolved without mounting the wrong feature first. The hash is not
  // available during SSR, so both start at the server-rendered default
  // (#2421).
  const [requested, setRequested] = useHashTab<HashRequest>(HASH_REQUESTS, FIRST_RAIL_FEATURE);
  const [shown, setShown] = useState<RailKey>(FIRST_RAIL_FEATURE);
  const shownRef = useRef<RailKey>(shown);
  shownRef.current = shown;
  // The Applies-to drawer is an overlay, not a navigable view, so its open
  // state is local; only the legacy `#assignments` alias opens it from a URL.
  const [appliesToOpen, setAppliesToOpen] = useState(false);
  // The panel holds a staged draft; while it is dirty the drawer will not close
  // (Apply or Discard first).
  const [appliesToDirty, setAppliesToDirty] = useState(false);
  // The details form (name, description, status) under the header.
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [detailsDirty, setDetailsDirty] = useState(false);
  // Unsaved changes on the open feature (plan D16): FeatureTabShell reports
  // them. The ref is what the hash handler and the rail read synchronously.
  const [featureDirty, setFeatureDirtyState] = useState(false);
  const featureDirtyRef = useRef(false);
  const setFeatureDirty = useCallback((dirty: boolean) => {
    featureDirtyRef.current = dirty;
    setFeatureDirtyState(dirty);
  }, []);
  // A switch away from a dirty feature, waiting on Discard or Stay.
  const [pendingSwitch, setPendingSwitch] = useState<{ target: RailKey; openDetails: boolean } | null>(null);
  // The policy's device count (#12467). null = unknown (not loaded, or the read
  // failed): the counts are left out and the page stays usable.
  const [reach, setReach] = useState<ConfigPolicyReach | null>(null);

  useIsomorphicLayoutEffect(() => {
    const current = shownRef.current;
    let target: RailKey;
    const openDetails = requested === OVERVIEW_HASH_ALIAS;
    if (requested === APPLIES_TO_HASH_ALIAS) {
      target = current;
      setAppliesToOpen(true);
    } else if (requested === OVERVIEW_HASH_ALIAS) {
      target = FIRST_RAIL_FEATURE;
    } else if (Object.prototype.hasOwnProperty.call(LEGACY_TAB_ALIASES, requested)) {
      target = LEGACY_TAB_ALIASES[requested as keyof typeof LEGACY_TAB_ALIASES];
    } else {
      target = requested as RailKey;
    }
    if (target !== current && featureDirtyRef.current) {
      // The hash moved off a feature with unsaved changes (back button, a
      // link, a typed hash). Keep the feature on screen and its URL, and ask.
      replaceHash(current);
      setRequested(current);
      setPendingSwitch({ target, openDetails });
      return;
    }
    if (openDetails) setDetailsOpen(true);
    if (requested !== target) {
      // Canonicalize the alias, and reset the request so the same alias
      // arriving again still registers as a change.
      replaceHash(target);
      setRequested(target);
    }
    setShown(target);
  }, [requested, setRequested]);

  // Reflect the selected feature in the URL hash so it is deep-linkable and
  // the contextual help button resolves to the right per-feature doc.
  const goToSection = useCallback(
    (id: RailKey) => {
      if (typeof window !== "undefined") window.location.hash = id;
      setRequested(id);
      setShown(id);
    },
    [setRequested],
  );
  const selectSection = useCallback(
    (id: RailKey) => {
      if (id === shownRef.current) return;
      if (featureDirtyRef.current) {
        setPendingSwitch({ target: id, openDetails: false });
        return;
      }
      goToSection(id);
    },
    [goToSection],
  );
  const discardAndSwitch = useCallback(() => {
    const pending = pendingSwitch;
    setPendingSwitch(null);
    if (!pending) return;
    setFeatureDirty(false);
    goToSection(pending.target);
    if (pending.openDetails) setDetailsOpen(true);
  }, [pendingSwitch, goToSection, setFeatureDirty]);
  // Browser unload, Astro soft navigation and keyboard chords (#12469).
  useUnsavedGuard(
    featureDirty || detailsDirty,
    i18n.t("policies:configurationPolicies.configPolicyDetailPage.unsavedLeaveConfirm"),
  );
  const [policy, setPolicy] = useState<PolicyDetail | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  // Feature links state (fetched on mount, not gated by the open feature)
  const [featureLinks, setFeatureLinks] = useState<FeatureLink[]>([]);
  // Removal affordance for a leftover feature link on a gated (org-only)
  // feature — see the gated panel below. MSP-managed policies can't author
  // these features, but a link may pre-date the restriction (or arrive via
  // backfill); the editor is never rendered for gated features, so without
  // this the link would be stuck with no way to view or remove it.
  const {
    remove: removeGatedLink,
    saving: removingGatedLink,
    error: gatedRemoveError,
  } = useFeatureLink(policyId ?? "");
  // Policy-level parent (#5080). `parent_policy_id` is a persisted, validated
  // column returned by the API, and the API embeds the parent's assembled
  // feature links on `policy.parentPolicy` (no second fetch, no `?linked=`).
  const linkedPolicyId = policy?.parentPolicyId ?? null;
  const parentFeatureLinks = policy?.parentPolicy?.featureLinks ?? [];
  // The parent embed is fetched server-side without the org-scoped
  // `policyAccessCondition` filter (see spec "API"), so an MSP-managed parent
  // is always present in `policy.parentPolicy` — but an org-scoped caller
  // still can't OPEN that policy's own page (it 404s under
  // `policyAccessCondition`). Only link when the caller is partner-scoped or
  // the parent is owned by the same org as this policy. `useJwtClaims` (not
  // the one-shot `getJwtClaims()`) because this is a rendered decision that
  // must not freeze a cold-load's pre-token answer; unresolved fails closed
  // to the non-partner branch, which still allows the same-org case through.
  const jwtClaims = useJwtClaims();
  const isPartnerScope =
    jwtClaims.status === "resolved" &&
    jwtClaims.claims.scope === "partner" &&
    !!jwtClaims.claims.partnerId;
  const canOpenParent =
    isPartnerScope || (policy?.parentPolicy != null && policy.parentPolicy.orgId === policy.orgId);
  // What this viewer may change (spec "States", Viewer). UX only: every write
  // route re-checks on the server.
  const permissions = useAuthStore((s) => s.user?.permissions);
  const canManagePartnerWide = useAuthStore((s) => s.user?.canManagePartnerWide);
  const viewer = useMemo(
    () =>
      resolveViewerAccess({
        access: policy?.access,
        policyOrgId: policy?.orgId ?? null,
        claims: jwtClaims,
        permissions,
        canManagePartnerWide,
      }),
    [policy?.access, policy?.orgId, jwtClaims, permissions, canManagePartnerWide],
  );
  const readOnly = !viewer.canEdit;
  const fetchPolicy = useCallback(async () => {
    if (!policyId) return;
    try {
      setLoading(true);
      setError(undefined);
      const response = await fetchWithAuth(
        `/configuration-policies/${policyId}`,
      );
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            errBody,
            i18n.t(
              "policies:configurationPolicies.configPolicyDetailPage.failedToFetchPolicy",
            ),
          ),
        );
      }
      const data = await response.json();
      setPolicy(data);
      setFeatureLinks(data.featureLinks ?? []);
    } catch (err) {
      setError(err instanceof Error ? err.message : "An error occurred");
    } finally {
      setLoading(false);
    }
  }, [policyId]);
  // Re-read the policy without the loading swap, so the open feature stays
  // mounted. Used after the Applies-to drawer closes and after a details save
  // (the PATCH answers with a bare row that lacks parentPolicy, childPolicies
  // and appliesTo).
  const refreshPolicy = useCallback(async () => {
    if (!policyId) return;
    try {
      const response = await fetchWithAuth(`/configuration-policies/${policyId}`);
      if (!response.ok) throw new Error(`${response.status}`);
      const data = await response.json();
      setPolicy(data);
    } catch {
      // Where the policy applies may have changed, so the summary on screen
      // can no longer be trusted: show it as unknown rather than keep a claim
      // (e.g. "Not applied") that may now be false, and say so.
      setPolicy((prev) => (prev ? { ...prev, appliesTo: undefined } : prev));
      showToast({
        type: "warning",
        message: i18n.t(
          "policies:configurationPolicies.configPolicyDetailPage.refreshAppliesToFailed",
        ),
      });
    }
  }, [policyId]);
  const closeAppliesTo = useCallback(() => {
    setAppliesToOpen(false);
    void refreshPolicy();
  }, [refreshPolicy]);
  // Only the newest read may set the count: a slow first read must not land
  // over the one taken after an Apply.
  const reachReq = useRef(0);
  const loadReach = useCallback(async () => {
    if (!policyId) return;
    const req = ++reachReq.current;
    try {
      const next = await fetchPolicyReach(policyId);
      if (req === reachReq.current) setReach(next);
    } catch (err) {
      console.warn("[configuration policies] reach read failed", err);
      if (req === reachReq.current) setReach(null);
    }
  }, [policyId]);
  useEffect(() => {
    void loadReach();
  }, [loadReach]);
  // An Apply committed: re-read where the policy applies and its count. The
  // drawer stays open on the reloaded draft.
  const handleApplied = useCallback(() => {
    // The old count describes the targets before the Apply: drop it until the
    // new read answers, so nothing (e.g. a "0 matching" warning) uses it.
    setReach(null);
    void refreshPolicy();
    void loadReach();
  }, [refreshPolicy, loadReach]);
  const policyOrgId = policy?.orgId ?? null;
  const policyOrgName = policy?.orgName ?? null;
  const appliesToOwner = useMemo<PickerOwner>(
    () => (policyOrgId ? { kind: "org", orgId: policyOrgId, orgName: policyOrgName } : { kind: "msp" }),
    [policyOrgId, policyOrgName],
  );
  const fetchFeatureLinks = useCallback(async () => {
    if (!policyId) return;
    try {
      const response = await fetchWithAuth(
        `/configuration-policies/${policyId}/features`,
      );
      if (!response.ok) {
        const errBody = await response.json().catch(() => null);
        throw new Error(
          extractApiError(
            errBody,
            i18n.t(
              "policies:configurationPolicies.configPolicyDetailPage.failedToFetchFeatures",
            ),
          ),
        );
      }
      const data = await response.json();
      setFeatureLinks(Array.isArray(data.data) ? data.data : []);
    } catch {
      // silent — feature links already loaded from policy fetch
    }
  }, [policyId]);
  useEffect(() => {
    fetchPolicy();
  }, [fetchPolicy]);
  // Fetch feature links eagerly on mount
  useEffect(() => {
    fetchFeatureLinks();
  }, [fetchFeatureLinks]);
  const handleDetailsSaved = useCallback(
    (next: PolicyDetails) => {
      // The save succeeded: show it now, even if the re-read below fails.
      setPolicy((prev) =>
        prev ? { ...prev, name: next.name, description: next.description || undefined } : prev,
      );
      setDetailsOpen(false);
      setDetailsDirty(false);
      void refreshPolicy();
    },
    [refreshPolicy],
  );
  // Activate / Deactivate / Archive / Restore committed (#12470). The PATCH
  // answers with a bare row, so show the new status now and re-read the rest.
  const handleStatusChanged = useCallback(
    (next: PolicyStatus) => {
      setPolicy((prev) => (prev ? { ...prev, status: next } : prev));
      void refreshPolicy();
    },
    [refreshPolicy],
  );
  // What every feature's Save, Remove and Reset state (#12470): the reach,
  // and the parent an inherited feature comes from.
  const policyStatus = policy?.status;
  const childPolicyCount = policy?.childPolicies?.length ?? 0;
  const parentSummary = policy?.parentPolicy ?? null;
  const featurePolicyInfo = useMemo<FeaturePolicyInfo | null>(
    () =>
      policyStatus
        ? {
            reach: { status: policyStatus, reach, childPolicyCount },
            parent: parentSummary
              ? {
                  name: parentSummary.name,
                  href: canOpenParent ? `/configuration-policies/${parentSummary.id}` : null,
                }
              : null,
          }
        : null,
    [policyStatus, reach, childPolicyCount, parentSummary, canOpenParent],
  );
  const handleLinkChanged = useCallback(
    (link: FeatureLink | null, featureType: FeatureType) => {
      setFeatureLinks((prev) => {
        if (link === null) {
          return prev.filter((l) => l.featureType !== featureType);
        }
        const idx = prev.findIndex((l) => l.featureType === featureType);
        if (idx >= 0) {
          const next = [...prev];
          next[idx] = link;
          return next;
        }
        return [...prev, link];
      });
    },
    [],
  );
  const linkFor = (t: FeatureType) =>
    featureLinks.find((l) => l.featureType === t);
  // MSP-managed ("all organizations") policies carry orgId === null (#1724).
  // A fixed, small set of feature types are fundamentally org-scoped and the
  // API rejects them with a 400 on an MSP-managed policy — see
  // ORG_SCOPED_ONLY_FEATURE_TYPES in @breeze/shared, shared with
  // apps/api/src/routes/configurationPolicies/featureLinks.ts. Gate them here
  // so the page never offers an edit that can't be saved (#2101). `policy`
  // may still be null while the first read is in flight.
  const isPartnerWide = policy?.orgId === null;
  const isGatedFeature = (ft: FeatureType) =>
    isPartnerWide && ORG_SCOPED_ONLY_FEATURE_TYPES.has(ft);
  usePageItemName(policy?.name);

  if (loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <div className="text-center">
          <div className="h-8 w-8 animate-spin rounded-full border-4 border-primary border-t-transparent mx-auto" />
          <p className="mt-4 text-sm text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.configPolicyDetailPage.loadingPolicy",
            )}
          </p>
        </div>
      </div>
    );
  }
  if (error && !policy) {
    return (
      <div className="rounded-lg border border-destructive/40 bg-destructive/10 p-6 text-center">
        <p className="text-sm text-destructive">{error}</p>
        <a
          href="/configuration-policies"
          className="mt-4 inline-block rounded-md bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90"
        >
          {i18n.t(
            "policies:configurationPolicies.configPolicyDetailPage.backToList",
          )}
        </a>
      </div>
    );
  }
  if (!policy) return null;
  const shownFeature = shown === "compliance_status" ? null : shown;
  const sectionLabel = shownFeature
    ? configFeatureLabel(shownFeature)
    : i18n.t("policies:configurationPolicies.configPolicyDetailPage.complianceStatus");
  const renderGatedFeature = (ft: FeatureType) => {
    const feature = configFeatureLabel(ft);
    return (
      <div
        data-testid="config-policy-feature-unavailable"
        className="flex items-start gap-3 rounded-lg border border-dashed bg-muted/30 p-6 text-sm text-muted-foreground"
      >
        <Info className="mt-0.5 h-4 w-4 shrink-0" aria-hidden="true" />
        <div>
          <p className="font-medium text-foreground">
            {i18n.t("policies:configurationPolicies.configPolicyDetailPage.gatedFeatureUnavailable", { feature })}
          </p>
          <p className="mt-1">
            {i18n.t("policies:configurationPolicies.configPolicyDetailPage.gatedFeatureReason", { feature })}
          </p>
          {/* A gated feature never renders its editor, so a leftover link
              (pre-dating the restriction) needs a removal path here or it
              would be permanently stuck. A read-only viewer gets no control. */}
          {linkFor(ft) && (
            <div className="mt-4">
              <p className="text-warning">
                {i18n.t(
                  "policies:configurationPolicies.configPolicyDetailPage.thisPolicyStillCarriesAnExisting",
                )}{" "}
                {feature.toLowerCase()}
                {i18n.t(
                  "policies:configurationPolicies.configPolicyDetailPage.configurationThatWillNeverBeApplied",
                )}
              </p>
              {gatedRemoveError && (
                <p className="mt-2 text-destructive">{gatedRemoveError}</p>
              )}
              {!readOnly && (
                <button
                  type="button"
                  disabled={removingGatedLink}
                  onClick={async () => {
                    const link = linkFor(ft);
                    if (!link) return;
                    const ok = await removeGatedLink(link.id);
                    if (ok) handleLinkChanged(null, ft);
                  }}
                  className="mt-2 h-9 rounded-md border border-destructive/40 px-3 text-sm font-medium text-destructive transition hover:bg-destructive/10 disabled:opacity-50"
                >
                  {removingGatedLink
                    ? i18n.t("policies:configurationPolicies.configPolicyDetailPage.removing")
                    : i18n.t("policies:configurationPolicies.configPolicyDetailPage.removeConfiguration")}
                </button>
              )}
            </div>
          )}
        </div>
      </div>
    );
  };
  return (
    <div className="space-y-6">
      <Breadcrumbs
        items={[
          {
            label: i18n.t(
              "policies:configurationPolicies.configPolicyDetailPage.configurationPolicies",
            ),
            href: "/configuration-policies",
          },
          {
            label:
              policy.name ||
              i18n.t(
                "policies:configurationPolicies.configPolicyDetailPage.policy",
              ),
          },
        ]}
      />
      {/* Header: name, state and the facts the Overview tab used to hold. */}
      <div className="flex items-start gap-4">
        <a
          href="/configuration-policies"
          className="inline-flex h-8 w-8 shrink-0 items-center justify-center rounded-md border hover:bg-muted"
          aria-label={i18n.t(
            "policies:configurationPolicies.configPolicyDetailPage.backToList",
          )}
        >
          <ArrowLeft className="h-4 w-4" />
        </a>
        <PolicyHeader
          name={policy.name}
          description={policy.description}
          status={policy.status}
          orgId={policy.orgId}
          orgName={policy.orgName}
          parentPolicy={policy.parentPolicy}
          childPolicies={policy.childPolicies ?? []}
          canOpenParent={canOpenParent}
          readOnly={readOnly}
          readOnlyReason={viewer.reason}
          onEditDetails={readOnly ? undefined : () => setDetailsOpen(true)}
          actions={
            policyId && (
              <PolicyStateActions
                policyId={policyId}
                status={policy.status}
                reach={reach}
                childPolicyCount={policy.childPolicies?.length ?? 0}
                readOnly={readOnly}
                onChanged={handleStatusChanged}
              />
            )
          }
        />
      </div>

      {detailsOpen && !readOnly && policyId && (
        <PolicyDetailsForm
          policyId={policyId}
          initial={{ name: policy.name, description: policy.description ?? "" }}
          onSaved={handleDetailsSaved}
          onCancel={() => setDetailsOpen(false)}
          onDirtyChange={setDetailsDirty}
        />
      )}

      {error && (
        <div className="rounded-md border border-destructive/40 bg-destructive/10 px-3 py-2 text-sm text-destructive">
          {error}
        </div>
      )}

      {/* Where the policy applies: visible while any feature is open (#12306). */}
      <AppliesToStrip
        summary={parseAppliesTo(policy.appliesTo)}
        status={policy.status}
        onEdit={readOnly ? undefined : () => setAppliesToOpen(true)}
        reach={reach}
      />

      {/* The feature rail replaces the tab strip; the open feature sits beside it. */}
      <div className="grid gap-6 lg:grid-cols-[240px_minmax(0,1fr)]">
        <FeatureRail
          activeKey={shown}
          ownLinks={featureLinks}
          parentLinks={parentFeatureLinks}
          isGated={isGatedFeature}
          dirtyKey={featureDirty ? shown : null}
          onNavigate={selectSection}
        />
        <section
          aria-label={sectionLabel}
          data-testid="config-policy-feature-panel"
          className="min-w-0 space-y-6"
        >
          <FeatureDirtyReporterContext.Provider value={setFeatureDirty}>
          <FeatureReadOnlyContext.Provider value={readOnly}>
          <FeaturePolicyContext.Provider value={featurePolicyInfo}>
            {shownFeature &&
              (isGatedFeature(shownFeature) ? (
                renderGatedFeature(shownFeature)
              ) : (
                <PolicyFeatureEditor
                  featureType={shownFeature}
                  policyId={policyId!}
                  featureLinks={featureLinks}
                  parentFeatureLinks={parentFeatureLinks}
                  linkedPolicyId={linkedPolicyId}
                  orgId={policy.orgId}
                  partnerId={policy.partnerId}
                  onLinkChanged={handleLinkChanged}
                />
              ))}
          </FeaturePolicyContext.Provider>
          </FeatureReadOnlyContext.Provider>
          </FeatureDirtyReporterContext.Provider>
          {/* Compliance Status: read-only results; the `compliance` feature is the rule editor. */}
          {shown === "compliance_status" && policyId && <ComplianceStatusTab policyId={policyId} />}
        </section>
      </div>

      {/* Leaving a feature with unsaved changes asks first (#12469). */}
      <ConfirmDialog
        open={pendingSwitch !== null}
        onClose={() => setPendingSwitch(null)}
        onConfirm={discardAndSwitch}
        title={i18n.t("policies:configurationPolicies.configPolicyDetailPage.discardChangesTitle")}
        message={i18n.t("policies:configurationPolicies.configPolicyDetailPage.discardChangesMessage", {
          feature: sectionLabel,
        })}
        confirmLabel={i18n.t("policies:configurationPolicies.configPolicyDetailPage.discardChanges")}
        cancelLabel={i18n.t("policies:configurationPolicies.configPolicyDetailPage.stayOnFeature")}
        variant="warning"
        confirmTestId="config-policy-discard-confirm"
      />

      {/* The one applies-to editor, in a drawer so the feature stays in view
          (#12467). It stages changes and commits them with one Apply; while
          the draft is dirty the drawer will not close. A read-only viewer has
          no Edit, and `#assignments` does not open it for them. */}
      <Drawer
        open={appliesToOpen && !readOnly}
        onClose={closeAppliesTo}
        title={i18n.t(
          "policies:configurationPolicies.configPolicyDetailPage.appliesToDrawerTitle",
        )}
        width="max-w-2xl"
        dataTestId="config-policy-applies-to-drawer"
        closeDisabled={appliesToDirty}
        closeDisabledReason={i18n.t(
          "policies:configurationPolicies.configPolicyDetailPage.appliesToCloseBlocked",
        )}
      >
        {policyId && !readOnly && (
          <AppliesToPanel
            policyId={policyId}
            owner={appliesToOwner}
            summary={parseAppliesTo(policy.appliesTo)}
            reach={reach}
            onDirtyChange={setAppliesToDirty}
            onApplied={handleApplied}
          />
        )}
      </Drawer>
    </div>
  );
}
