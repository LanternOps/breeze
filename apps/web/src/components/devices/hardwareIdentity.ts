// Agent-reported SMBIOS identity strings are often vendor placeholders
// ("System Serial Number", "To be filled by O.E.M."). Shared by the Details
// tab and the page header so neither shows one as a real value.
const hardwareIdentityPlaceholderValues = new Set([
  "0",
  "00000000",
  "000000000000000",
  "123456789",
  "default string",
  "none",
  "null",
  "n/a",
  "na",
  "not applicable",
  "not available",
  "not specified",
  "o.e.m",
  "oem",
  "serial number",
  "system manufacturer",
  "system product name",
  "system serial number",
  "unknown",
]);

export function formatHardwareIdentityValue(value: string | null | undefined): string {
  const trimmed = value?.trim();
  if (!trimmed) return "—";

  const normalized = trimmed
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/\.+$/, "");
  if (
    hardwareIdentityPlaceholderValues.has(normalized) ||
    normalized.includes("to be filled by")
  ) {
    return "—";
  }
  return trimmed;
}

/** The cleaned value, or null when it is missing or a placeholder. */
export function hardwareIdentityOrNull(value: string | null | undefined): string | null {
  const formatted = formatHardwareIdentityValue(value);
  return formatted === "—" ? null : formatted;
}
