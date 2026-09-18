import { useTranslation } from "react-i18next";
import { cn } from "@/lib/utils";
import { DEVICE_ROLES, getDeviceRoleLabel } from "@/lib/deviceRoles";
import HelpTooltip from "../shared/HelpTooltip";
import { i18n } from "@/lib/i18n";

export const OS_FILTER_OPTIONS = [
  {
    value: "windows",
    labelKey: "policies:configurationPolicies.assignmentsTab.windows",
  },
  {
    value: "macos",
    labelKey: "policies:configurationPolicies.assignmentsTab.macOS",
  },
  {
    value: "linux",
    labelKey: "policies:configurationPolicies.assignmentsTab.linux",
  },
] as const;

export function assignmentFilterPayload(
  roleFilter: string[],
  osFilter: string[],
): { roleFilter?: string[]; osFilter?: string[] } {
  return {
    ...(roleFilter.length > 0 ? { roleFilter } : {}),
    ...(osFilter.length > 0 ? { osFilter } : {}),
  };
}

function osLabel(value: string, translate: (key: string) => string): string {
  const option = OS_FILTER_OPTIONS.find((o) => o.value === value);
  return option ? translate(option.labelKey) : value;
}

function toggleValue(current: string[], value: string): string[] {
  return current.includes(value)
    ? current.filter((item) => item !== value)
    : [...current, value];
}

type FilterPickerProps = {
  roleFilter: string[];
  osFilter: string[];
  onRoleFilterChange: (next: string[]) => void;
  onOsFilterChange: (next: string[]) => void;
  disabled?: boolean;
};

export function AssignmentRoleOsFilters({
  roleFilter,
  osFilter,
  onRoleFilterChange,
  onOsFilterChange,
  disabled = false,
}: FilterPickerProps) {
  const { t } = useTranslation(["policies", "common"]);

  return (
    <div className="grid gap-4 sm:grid-cols-2">
      <div>
        <label className="text-sm font-medium">
          {i18n.t("policies:configurationPolicies.assignmentsTab.roleFilter")}
          <span className="text-xs text-muted-foreground">
            {i18n.t("policies:configurationPolicies.assignmentsTab.optional")}
          </span>
          <HelpTooltip
            text={i18n.t(
              "policies:configurationPolicies.assignmentsTab.restrictThisAssignmentToDevicesWithSpecific",
            )}
          />
        </label>
        <div className="mt-2 flex flex-wrap gap-2 rounded-md border bg-background p-2 min-h-10">
          {DEVICE_ROLES.map((role) => {
            const isSelected = roleFilter.includes(role);
            return (
              <button
                key={role}
                type="button"
                disabled={disabled}
                onClick={() => onRoleFilterChange(toggleValue(roleFilter, role))}
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition",
                  isSelected
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted bg-muted/30 text-muted-foreground hover:bg-muted/60",
                )}
              >
                {getDeviceRoleLabel(role)}
              </button>
            );
          })}
        </div>
        {roleFilter.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.assignmentsTab.noRestrictionAppliesToAllDeviceRoles",
            )}
          </p>
        )}
      </div>
      <div>
        <label className="text-sm font-medium">
          {i18n.t("policies:configurationPolicies.assignmentsTab.oSFilter")}
          <span className="text-xs text-muted-foreground">
            {i18n.t("policies:configurationPolicies.assignmentsTab.optional2")}
          </span>
        </label>
        <div className="mt-2 flex flex-wrap gap-2 rounded-md border bg-background p-2 min-h-10">
          {OS_FILTER_OPTIONS.map((os) => {
            const isSelected = osFilter.includes(os.value);
            return (
              <button
                key={os.value}
                type="button"
                disabled={disabled}
                onClick={() =>
                  onOsFilterChange(toggleValue(osFilter, os.value))
                }
                className={cn(
                  "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-medium transition",
                  isSelected
                    ? "border-primary bg-primary/10 text-primary"
                    : "border-muted bg-muted/30 text-muted-foreground hover:bg-muted/60",
                )}
              >
                {t(/* i18n-dynamic */ os.labelKey)}
              </button>
            );
          })}
        </div>
        {osFilter.length === 0 && (
          <p className="mt-1 text-xs text-muted-foreground">
            {i18n.t(
              "policies:configurationPolicies.assignmentsTab.noRestrictionAppliesToAllOperatingSystems",
            )}
          </p>
        )}
      </div>
    </div>
  );
}

type BadgeProps = {
  roleFilter?: string[] | null;
  osFilter?: string[] | null;
};

export function AssignmentFilterBadges({ roleFilter, osFilter }: BadgeProps) {
  const { t } = useTranslation(["policies"]);
  const roles = roleFilter ?? [];
  const oses = osFilter ?? [];
  const unrestricted = roles.length === 0 && oses.length === 0;

  return (
    <div className="flex flex-wrap gap-1">
      {unrestricted && (
        <span className="text-xs text-muted-foreground">
          {i18n.t("policies:configurationPolicies.assignmentsTab.allDevices")}
        </span>
      )}
      {roles.map((role) => (
        <span
          key={role}
          className="inline-flex items-center rounded-full border border-purple-500/40 bg-purple-500/10 px-2 py-0.5 text-xs font-medium text-purple-700"
        >
          {getDeviceRoleLabel(role)}
        </span>
      ))}
      {oses.map((os) => (
        <span
          key={os}
          className="inline-flex items-center rounded-full border border-blue-500/40 bg-blue-500/10 px-2 py-0.5 text-xs font-medium text-blue-700"
        >
          {osLabel(os, t)}
        </span>
      ))}
    </div>
  );
}
