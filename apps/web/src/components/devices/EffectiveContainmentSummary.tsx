import { containmentInlineSettingsSchema } from "@breeze/shared";
import { useTranslation } from "react-i18next";
import "../../lib/i18n";

const PROTO_KEYS = {
  tcp: "policies:configurationPolicies.featureTabs.containmentTab.protoTcp",
  udp: "policies:configurationPolicies.featureTabs.containmentTab.protoUdp",
  "udp+tcp": "policies:configurationPolicies.featureTabs.containmentTab.protoBoth",
} as const;

/**
 * The extra destinations a device's winning containment link grants it while isolated (#11101).
 * Parsed with the schema resolveContainmentPolicy uses: that resolver fails closed to the fixed
 * defaults on settings the schema refuses, so listing those rows here would show permits the
 * device does not get.
 */
export default function EffectiveContainmentSummary({ inlineSettings }: { inlineSettings: unknown }) {
  const { t } = useTranslation("devices");
  const parsed = containmentInlineSettingsSchema.safeParse(inlineSettings);

  if (!parsed.success) {
    return (
      <p data-testid="effective-config-containment-invalid" className="mt-3 text-xs text-destructive">
        {t("deviceEffectiveConfigTab.containment.invalid")}
      </p>
    );
  }

  const { extraAllow } = parsed.data;
  if (extraAllow.length === 0) {
    return (
      <p data-testid="effective-config-containment-none" className="mt-3 text-xs text-muted-foreground">
        {t("policies:configurationPolicies.featureTabs.containmentTab.empty")}
      </p>
    );
  }

  return (
    <div className="mt-3 rounded-md border bg-muted/30 px-3 py-2">
      <p className="text-xs font-medium text-muted-foreground">
        {t("deviceEffectiveConfigTab.containment.extraDestinations")}
      </p>
      <ul className="mt-1 space-y-1.5 text-xs text-muted-foreground">
        {extraAllow.map((entry, index) => (
          <li key={index} data-testid={`effective-config-containment-row-${index}`}>
            <span className="break-all font-mono text-foreground">
              {"host" in entry ? entry.host : entry.cidr}
            </span>
            <span className="block break-words">
              {t(/* i18n-dynamic */ PROTO_KEYS[entry.proto])}{" · "}{entry.ports.join(", ")}{" · "}{entry.label}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
