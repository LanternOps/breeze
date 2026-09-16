import { useEffect, useState } from "react";
import { useForm, useFieldArray } from "react-hook-form";
import { z } from "zod";
import { zodResolver } from "@hookform/resolvers/zod";
import { Plus, Trash2 } from "lucide-react";
import { useTranslation } from "react-i18next";
import { i18n } from "@/lib/i18n";
import { fetchWithAuth } from "../../stores/auth";
const softwareRuleSchema = z.object({
  name: z.string().min(1, "Software name is required").max(500),
  vendor: z.string().max(200).optional().or(z.literal("")),
  minVersion: z.string().max(100).optional().or(z.literal("")),
  maxVersion: z.string().max(100).optional().or(z.literal("")),
  reason: z.string().max(1000).optional().or(z.literal("")),
  // Links this rule to a software-catalog item so an armed autoInstall
  // policy has something concrete to install (#5509). Empty string = no
  // link, matching the other optional string fields' convention above.
  catalogId: z.string().optional().or(z.literal("")),
});
const policyFormSchema = z.object({
  name: z.string().min(1, "Policy name is required").max(200),
  description: z.string().max(4000).optional().or(z.literal("")),
  mode: z.enum(["allowlist", "blocklist", "audit"]),
  // Ownership axis (#2126, mirrors config policies #1724): 'partner' =
  // partner-wide / all-orgs template. Only surfaced on create for
  // partner-scope users (showOwnerScope); the server derives the partner
  // from the caller's own token.
  ownerScope: z.enum(["organization", "partner"]).optional(),
  software: z
    .array(softwareRuleSchema)
    .min(1, "At least one software rule is required"),
  allowUnknown: z.boolean().optional(),
  enforceMode: z.boolean(),
  autoUninstall: z.boolean().optional(),
  // Arms desired-state install remediation (#5505). Only meaningful on an
  // allowlist policy — 'missing' violations, the only kind autoInstall acts
  // on, are only ever emitted for allowlist rule mismatches.
  autoInstall: z.boolean().optional(),
  gracePeriod: z.coerce.number().int().min(0).max(2160).optional(),
});
export type PolicyFormValues = z.infer<typeof policyFormSchema>;
export type CatalogOption = { id: string; name: string; vendor?: string };
type DryRunState =
  | { status: "idle" }
  | { status: "loading" }
  | { status: "ready"; eligibleDeviceCount: number }
  | { status: "unavailable" };
type PolicyFormProps = {
  onSubmit?: (values: PolicyFormValues) => void | Promise<void>;
  onCancel?: () => void;
  defaultValues?: Partial<PolicyFormValues>;
  submitLabel?: string;
  loading?: boolean;
  /** Show the ownership-scope selector (create-only, partner-scope users). */
  showOwnerScope?: boolean;
  /** Existing policy id when editing — undefined while creating (#5509).
   *  Feeds the install dry-run preview; a brand-new policy has no id to
   *  query yet. */
  policyId?: string;
  /** Software catalog items available to link a rule to. Fetched once by the
   *  parent (ComplianceDashboard); an empty array degrades the picker to "no
   *  catalog items" rather than blocking the form (#5509). */
  catalogItems?: CatalogOption[];
  /** True when the catalog fetch failed. An empty picker then means "we could
   *  not load it", not "this org has no catalog items" — the two must not look
   *  alike, or the authoring warning blames the operator for a broken feed. */
  catalogUnavailable?: boolean;
};
export default function PolicyForm({
  onSubmit,
  onCancel,
  defaultValues,
  submitLabel = "Save Policy",
  loading,
  showOwnerScope = false,
  policyId,
  catalogItems = [],
  catalogUnavailable = false,
}: PolicyFormProps) {
  useTranslation("policies");
  const {
    register,
    handleSubmit,
    control,
    watch,
    formState: { errors, isSubmitting },
  } = useForm<PolicyFormValues>({
    resolver: zodResolver(policyFormSchema) as never,
    defaultValues: {
      name: "",
      description: "",
      mode: "blocklist",
      software: [
        {
          name: "",
          vendor: "",
          minVersion: "",
          maxVersion: "",
          reason: "",
          catalogId: "",
        },
      ],
      allowUnknown: false,
      enforceMode: false,
      autoUninstall: false,
      autoInstall: false,
      gracePeriod: 24,
      ...defaultValues,
    },
  });
  const { fields, append, remove } = useFieldArray({
    control,
    name: "software",
  });
  const watchMode = watch("mode");
  const watchEnforceMode = watch("enforceMode");
  const watchAutoInstall = watch("autoInstall");
  const watchSoftware = watch("software");
  // Deliberately NOT memoised: react-hook-form mutates the watched array in
  // place, so its identity is stable across edits and a useMemo keyed on it
  // would serve a stale count after a catalog link is chosen (#5509).
  const rulesWithoutCatalog = watchSoftware.filter(
    (rule) => !rule.catalogId,
  ).length;
  const [dryRun, setDryRun] = useState<DryRunState>({ status: "idle" });
  useEffect(() => {
    if (
      !policyId ||
      watchMode !== "allowlist" ||
      !watchEnforceMode ||
      !watchAutoInstall
    ) {
      return;
    }
    let cancelled = false;
    setDryRun({ status: "loading" });
    (async () => {
      try {
        // The preview is advisory only and never blocks arming: any non-2xx
        // (including a 404) degrades to "unavailable". The real blast-radius
        // bound is the worker's per-pass install cap, not this number.
        const response = await fetchWithAuth(
          `/software-policies/${policyId}/install-preview`,
        );
        if (cancelled) return;
        if (!response.ok) {
          setDryRun({ status: "unavailable" });
          return;
        }
        const payload = await response.json();
        const count = Number(
          (payload as { eligibleDeviceCount?: unknown })?.eligibleDeviceCount,
        );
        if (cancelled) return;
        if (!Number.isFinite(count)) {
          setDryRun({ status: "unavailable" });
          return;
        }
        setDryRun({ status: "ready", eligibleDeviceCount: count });
      } catch (err) {
        // The UI says "unavailable" honestly either way, but without a log a
        // genuinely 500ing endpoint is indistinguishable from an unshipped one.
        console.warn(
          "[PolicyForm] install-preview dry run failed; showing it as unavailable:",
          err,
        );
        if (!cancelled) setDryRun({ status: "unavailable" });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [policyId, watchMode, watchEnforceMode, watchAutoInstall]);
  const isLoading = loading ?? isSubmitting;
  return (
    <form
      onSubmit={handleSubmit(async (values) => {
        await onSubmit?.(values);
      })}
      className="space-y-4"
    >
      {/* Ownership scope — partner-scope creators only (#2126) */}
      {showOwnerScope && (
        <fieldset
          className="space-y-2 rounded-md border p-4"
          data-testid="software-policy-owner"
        >
          <legend className="px-1 text-xs font-medium uppercase text-muted-foreground">
            {i18n.t("policies:software.policyForm.scope")}
          </legend>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              value="partner"
              {...register("ownerScope")}
              data-testid="software-policy-owner-partner"
            />
            {i18n.t("policies:software.policyForm.allOrganizations")}
            <span className="text-muted-foreground">
              {i18n.t("policies:software.policyForm.partnerWideTemplate")}
            </span>
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="radio"
              value="organization"
              {...register("ownerScope")}
              data-testid="software-policy-owner-org"
            />
            {i18n.t("policies:software.policyForm.thisOrganizationOnly")}
          </label>
        </fieldset>
      )}

      {/* Basic Info */}
      <div className="grid gap-4 md:grid-cols-2">
        <div className="space-y-2">
          <label htmlFor="policy-name" className="text-sm font-medium">
            {i18n.t("policies:software.policyForm.policyName")}
          </label>
          <input
            id="policy-name"
            placeholder={i18n.t(
              "policies:software.policyForm.eGBlockUnauthorizedSoftware",
            )}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register("name")}
          />
          {errors.name && (
            <p className="text-sm text-destructive">{errors.name.message}</p>
          )}
        </div>

        <div className="space-y-2">
          <label htmlFor="policy-mode" className="text-sm font-medium">
            {i18n.t("policies:software.policyForm.mode")}
          </label>
          <select
            id="policy-mode"
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register("mode")}
          >
            <option value="blocklist">
              {i18n.t("policies:software.policyForm.blocklist")}
            </option>
            <option value="allowlist">
              {i18n.t("policies:software.policyForm.allowlist")}
            </option>
            <option value="audit">
              {i18n.t("policies:software.policyForm.auditOnly")}
            </option>
          </select>
        </div>

        <div className="space-y-1 md:col-span-2">
          <label htmlFor="policy-description" className="text-sm font-medium">
            {i18n.t("common:labels.description")}
          </label>
          <input
            id="policy-description"
            placeholder={i18n.t(
              "policies:software.policyForm.describeThePurposeOfThisPolicy",
            )}
            className="h-10 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
            {...register("description")}
          />
        </div>
      </div>

      {/* Software Rules */}
      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold">
            {i18n.t("policies:software.policyForm.softwareRules")}
            <span className="ml-2 font-normal text-xs text-muted-foreground">
              (
              {watchMode === "allowlist"
                ? i18n.t("policies:software.policyForm.allow")
                : watchMode === "blocklist"
                  ? i18n.t("policies:software.policyForm.block")
                  : i18n.t("policies:software.policyForm.audit")}
              )
            </span>
          </h3>
          <button
            type="button"
            onClick={() =>
              append({
                name: "",
                vendor: "",
                minVersion: "",
                maxVersion: "",
                reason: "",
                catalogId: "",
              })
            }
            className="inline-flex items-center gap-1 rounded-md border px-2 py-1 text-xs font-medium hover:bg-muted"
          >
            <Plus className="h-3 w-3" />
            {i18n.t("common:actions.add")}
          </button>
        </div>

        {errors.software?.root && (
          <p className="text-xs text-destructive">
            {errors.software.root.message}
          </p>
        )}

        {fields.length > 0 ? (
          <div className="space-y-2">
            {fields.map((field, index) => (
              <div
                key={field.id}
                className="flex items-center gap-2 rounded-md border bg-muted/20 px-3 py-2"
              >
                <div className="flex-1 grid gap-2 sm:grid-cols-2 md:grid-cols-6">
                  <input
                    placeholder={i18n.t("policies:software.policyForm.name")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.name`)}
                  />
                  <input
                    placeholder={i18n.t("policies:software.policyForm.vendor")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.vendor`)}
                  />
                  <input
                    placeholder={i18n.t("policies:software.policyForm.minVer")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.minVersion`)}
                  />
                  <input
                    placeholder={i18n.t("policies:software.policyForm.maxVer")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.maxVersion`)}
                  />
                  <input
                    placeholder={i18n.t("policies:software.policyForm.reason")}
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    {...register(`software.${index}.reason`)}
                  />
                  <select
                    className="h-8 w-full rounded-md border bg-background px-2 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                    title={i18n.t("policies:software.policyForm.catalogLink")}
                    data-testid={`software-rule-catalog-${index}`}
                    {...register(`software.${index}.catalogId`)}
                  >
                    <option value="">
                      {i18n.t("policies:software.policyForm.catalogLinkNone")}
                    </option>
                    {catalogItems.map((item) => (
                      <option key={item.id} value={item.id}>
                        {item.vendor
                          ? `${item.name} (${item.vendor})`
                          : item.name}
                      </option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  onClick={() => remove(index)}
                  disabled={fields.length <= 1}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md hover:bg-muted text-destructive disabled:opacity-30"
                  title={i18n.t("policies:software.policyForm.removeRule")}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                </button>
              </div>
            ))}
            {errors.software &&
              !errors.software.root &&
              fields.some((_, i) => errors.software?.[i]?.name) && (
                <p className="text-xs text-destructive">
                  {i18n.t(
                    "policies:software.policyForm.softwareNameIsRequiredForAllRules",
                  )}
                </p>
              )}
          </div>
        ) : (
          <div className="rounded-md border border-dashed p-4 text-center">
            <p className="text-sm text-muted-foreground">
              {i18n.t(
                "policies:software.policyForm.noSoftwareRulesDefinedClickAddTo",
              )}
            </p>
          </div>
        )}

        {catalogUnavailable && (
          <p
            className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
            data-testid="software-catalog-unavailable"
          >
            {i18n.t("policies:software.policyForm.catalogUnavailable")}
          </p>
        )}

        {watchMode === "allowlist" && (
          <label className="flex items-center gap-2 px-1">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border"
              {...register("allowUnknown")}
            />
            <span className="text-sm">
              {i18n.t(
                "policies:software.policyForm.allowUnknownSoftwareNotInTheAllowlist",
              )}
            </span>
          </label>
        )}
      </div>

      {/* Policy Settings */}
      <div className="rounded-md border bg-muted/20 p-3 space-y-3">
        <h3 className="text-sm font-semibold">
          {i18n.t("policies:software.policyForm.policySettings")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {i18n.t(
            "policies:software.policyForm.assignThisPolicyToDevicesViaConfiguration",
          )}
        </p>
        <div className="grid gap-3 md:grid-cols-2 items-center">
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              className="h-4 w-4 rounded border-border"
              {...register("enforceMode")}
            />
            <span className="text-sm">
              {i18n.t("policies:software.policyForm.enforceAutoRemediate")}
            </span>
          </label>

          {watchEnforceMode && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                {...register("autoUninstall")}
              />
              <span className="text-sm">
                {i18n.t("policies:software.policyForm.autoUninstall")}
              </span>
            </label>
          )}

          {watchEnforceMode && watchMode === "allowlist" && (
            <label className="flex items-center gap-2">
              <input
                type="checkbox"
                className="h-4 w-4 rounded border-border"
                data-testid="policy-auto-install-checkbox"
                {...register("autoInstall")}
              />
              <span className="text-sm">
                {i18n.t("policies:software.policyForm.autoInstall")}
              </span>
            </label>
          )}
        </div>

        {watchEnforceMode &&
          watchMode === "allowlist" &&
          watchAutoInstall &&
          rulesWithoutCatalog > 0 && (
            <p
              className="rounded-md border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs text-amber-700"
              data-testid="autoinstall-catalog-warning"
            >
              {i18n.t("policies:software.policyForm.autoInstallCatalogWarning", {
                count: rulesWithoutCatalog,
                total: watchSoftware.length,
              })}
            </p>
          )}

        {watchEnforceMode && watchMode === "allowlist" && watchAutoInstall && (
          <div
            className="rounded-md border border-blue-500/30 bg-blue-500/5 px-3 py-2 text-xs"
            data-testid="autoinstall-dry-run"
          >
            {!policyId ? (
              <p className="text-muted-foreground">
                {i18n.t("policies:software.policyForm.dryRunNewPolicy")}
              </p>
            ) : dryRun.status === "loading" ? (
              <p className="text-muted-foreground">
                {i18n.t("policies:software.policyForm.dryRunLoading")}
              </p>
            ) : dryRun.status === "ready" && dryRun.eligibleDeviceCount === 0 ? (
              // The preview exposes only a count, not configuration-policy linkage.
              <p>
                {i18n.t("policies:software.policyForm.dryRunUnassigned")}{" "}
                <a
                  data-testid="autoinstall-assignment-link"
                  href="/configuration-policies"
                  className="text-primary underline underline-offset-2"
                >
                  {i18n.t("policies:software.policyForm.manageAssignments")}
                </a>
              </p>
            ) : dryRun.status === "ready" ? (
              <p>
                {i18n.t("policies:software.policyForm.dryRunResult", {
                  count: dryRun.eligibleDeviceCount,
                })}
              </p>
            ) : (
              <p className="text-muted-foreground">
                {i18n.t("policies:software.policyForm.dryRunUnavailable")}
              </p>
            )}
          </div>
        )}

        {watchEnforceMode && (
          <div className="space-y-1">
            <div className="flex items-center gap-3">
              <label
                htmlFor="grace-period"
                className="text-xs font-medium text-muted-foreground shrink-0"
              >
                {i18n.t("policies:software.policyForm.gracePeriodHours")}
              </label>
              <input
                id="grace-period"
                aria-describedby="policy-grace-period-help"
                type="number"
                min={0}
                max={2160}
                className="h-9 w-24 rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring"
                {...register("gracePeriod")}
              />
              <span className="text-xs text-muted-foreground">
                {i18n.t("policies:software.policyForm.max2160h")}
              </span>
            </div>
            <p id="policy-grace-period-help" data-testid="policy-grace-period-help" className="text-xs text-muted-foreground">
              {i18n.t("policies:software.policyForm.gracePeriodHelp")}
            </p>
          </div>
        )}
      </div>

      {/* Form Actions */}
      <div className="flex justify-end gap-3 pt-2">
        <button
          type="button"
          onClick={onCancel}
          className="h-9 rounded-md border bg-background px-4 text-sm font-medium text-foreground transition hover:bg-muted"
        >
          {i18n.t("common:actions.cancel")}
        </button>
        <button
          type="submit"
          disabled={isLoading}
          className="flex h-9 items-center justify-center rounded-md bg-primary px-4 text-sm font-medium text-primary-foreground transition hover:opacity-90 disabled:cursor-not-allowed disabled:opacity-60"
        >
          {isLoading
            ? i18n.t("policies:software.policyForm.saving")
            : submitLabel}
        </button>
      </div>
    </form>
  );
}
