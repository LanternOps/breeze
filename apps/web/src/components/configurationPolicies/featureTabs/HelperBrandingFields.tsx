import { i18n } from "@/lib/i18n";
import { isReadableBrandColor } from "@breeze/shared/utils/brandContrast";

// Mirrors apps/api/src/services/helperBranding.ts (W1). Text only, counted in
// Unicode code points; colours are strict #RRGGBB. No asset/URL/CSS/HTML field.
export const BRANDING_TEXT_LIMITS = {
  displayName: 60,
  companyName: 60,
  welcomeTitle: 120,
  welcomeMessage: 500,
  supportLabel: 40,
  portalLabel: 40,
} as const;
export const BRANDING_COLOR_FIELDS = ["primaryColor", "accentColor"] as const;

export type BrandingTextField = keyof typeof BRANDING_TEXT_LIMITS;
export type BrandingColorField = (typeof BRANDING_COLOR_FIELDS)[number];
export type BrandingField = BrandingTextField | BrandingColorField;
export type BrandingValues = Partial<Record<BrandingField, string>>;
export type BrandingErrorCode = "tooLong" | "control" | "color" | "contrast";
export type BrandingErrors = Partial<Record<BrandingField, BrandingErrorCode>>;

const FIELD_ORDER: BrandingField[] = [
  "displayName",
  "companyName",
  "welcomeTitle",
  "welcomeMessage",
  "supportLabel",
  "portalLabel",
  "primaryColor",
  "accentColor",
];
// Same class as the server: control, format (bidi), surrogate, private use,
// line/paragraph separators; ZWNJ/ZWJ allowed.
const DISALLOWED_TEXT_CHARS = /(?![‌‍])[\p{Cc}\p{Cf}\p{Cs}\p{Co}\p{Zl}\p{Zp}]/u;
const HEX_COLOR = /^#[0-9A-Fa-f]{6}$/;

const isColorField = (f: BrandingField): f is BrandingColorField =>
  (BRANDING_COLOR_FIELDS as readonly string[]).includes(f);

/** Blank (empty string) means inherit: the field is simply omitted. */
export function cleanBranding(raw: Record<string, string | undefined>): BrandingValues {
  const out: BrandingValues = {};
  for (const f of FIELD_ORDER) {
    const v = raw[f];
    if (v !== undefined && v !== "") out[f] = v;
  }
  return out;
}

export function validateBranding(values: BrandingValues): BrandingErrors {
  const errors: BrandingErrors = {};
  for (const f of FIELD_ORDER) {
    const v = values[f];
    if (v === undefined || v === "") continue;
    if (isColorField(f)) {
      if (!HEX_COLOR.test(v)) errors[f] = "color";
      else if (!isReadableBrandColor(v)) errors[f] = "contrast";
    } else if (DISALLOWED_TEXT_CHARS.test(v)) {
      errors[f] = "control";
    } else if ([...v].length > BRANDING_TEXT_LIMITS[f]) {
      errors[f] = "tooLong";
    }
  }
  return errors;
}

/** Reads only known string branding fields from stored inline settings. */
export function readBranding(raw: unknown): BrandingValues {
  const out: BrandingValues = {};
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return out;
  for (const f of FIELD_ORDER) {
    const v = (raw as Record<string, unknown>)[f];
    if (typeof v === "string" && v !== "") out[f] = v;
  }
  return out;
}

function fieldLabel(f: BrandingField): string {
  switch (f) {
    case "displayName": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingDisplayName");
    case "companyName": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingCompanyName");
    case "welcomeTitle": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingWelcomeTitle");
    case "welcomeMessage": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingWelcomeMessage");
    case "supportLabel": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingSupportLabel");
    case "portalLabel": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingPortalLabel");
    case "primaryColor": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingPrimaryColor");
    case "accentColor": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingAccentColor");
  }
}

function errorText(code: BrandingErrorCode, f: BrandingField): string {
  switch (code) {
    case "tooLong":
      return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingErrorTooLong", {
        max: BRANDING_TEXT_LIMITS[f as BrandingTextField],
      });
    case "control": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingErrorControl");
    case "color": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingErrorColor");
    case "contrast": return i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingErrorContrast");
  }
}

type Props = {
  values: BrandingValues;
  /** Value the parent policy supplies for a blank field, shown as the inherited value. */
  inherited: BrandingValues;
  errors: BrandingErrors;
  disabled?: boolean;
  onChange: (field: BrandingField, value: string) => void;
};

export default function HelperBrandingFields({ values, inherited, errors, disabled, onChange }: Props) {
  return (
    <div className="space-y-4" data-testid="helper-branding">
      <div>
        <h3 className="text-sm font-semibold">
          {i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingTitle")}
        </h3>
        <p className="text-xs text-muted-foreground">
          {i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingHelp")}
        </p>
      </div>
      {FIELD_ORDER.map((f) => {
        const value = values[f] ?? "";
        const err = errors[f];
        const inheritedValue = inherited[f];
        const id = `helper-branding-${f}`;
        const multiline = f === "welcomeMessage";
        const common = {
          id,
          value,
          disabled,
          "data-testid": id,
          "aria-invalid": err ? true : undefined,
          "aria-describedby": `${id}-help`,
          onChange: (e: { target: { value: string } }) => onChange(f, e.target.value),
          className:
            "mt-2 w-full rounded-md border bg-background px-3 text-sm focus:outline-hidden focus:ring-2 focus:ring-ring",
        };
        return (
          <div key={f}>
            <label htmlFor={id} className="text-sm font-medium">
              {fieldLabel(f)}
            </label>
            {multiline ? (
              <textarea {...common} rows={3} className={`${common.className} py-2`} />
            ) : (
              <input
                {...common}
                type="text"
                placeholder={isColorField(f) ? "#RRGGBB" : undefined}
                className={`${common.className} h-10`}
              />
            )}
            <p id={`${id}-help`} className="mt-1 text-xs text-muted-foreground">
              {inheritedValue !== undefined
                ? i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingInheritedFromParent", {
                    value: inheritedValue,
                  })
                : i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingBlankUsesDefault")}
              {!isColorField(f) && (
                <span className="ml-2">
                  {i18n.t("policies:configurationPolicies.featureTabs.helperTab.brandingCharCount", {
                    used: [...value].length,
                    max: BRANDING_TEXT_LIMITS[f],
                  })}
                </span>
              )}
            </p>
            {err && (
              <p role="alert" data-testid={`${id}-error`} className="mt-1 text-xs text-destructive">
                {errorText(err, f)}
              </p>
            )}
          </div>
        );
      })}
    </div>
  );
}
