import { describe, expect, it } from "vitest";

import en from "../../locales/en/integrations.json";
import {
  BACKUP_PROVIDER_FORMS,
  canSubmitCreate,
  createCredentials,
  getBackupProviderForm,
  rotationCredentials,
  valuesAfterRotation,
} from "./backupProviderForms";

const cove = getBackupProviderForm("cove");
const dropsuite = getBackupProviderForm("dropsuite");
const axcient = getBackupProviderForm("axcient");

describe("BACKUP_PROVIDER_FORMS", () => {
  it("declares exactly cove, dropsuite, axcient", () => {
    expect(BACKUP_PROVIDER_FORMS.map((form) => form.provider)).toEqual(["cove", "dropsuite", "axcient"]);
  });

  it.each([
    ["cove", ["partner-name", "username", "password"]],
    ["dropsuite", ["reseller-token", "auth-token"]],
    ["axcient", ["api-key"]],
  ])("%s renders fields %j", (provider, suffixes) => {
    expect(getBackupProviderForm(provider).fields.map((field) => field.testIdSuffix)).toEqual(suffixes);
  });

  it("falls back to cove for an unknown provider, matching the old non-dropsuite fallthrough", () => {
    expect(getBackupProviderForm("not-a-provider")).toBe(cove);
  });

  it("marks only Dropsuite as SaaS inventory, so an Axcient card keeps device-link counters", () => {
    expect(BACKUP_PROVIDER_FORMS.filter((form) => form.inventory === "saas").map((form) => form.provider)).toEqual(["dropsuite"]);
  });

  it("asks for a base URL on Dropsuite only", () => {
    expect(cove.baseUrl).toBeNull();
    expect(axcient.baseUrl).toBeNull();
    expect(dropsuite.baseUrl).toEqual({ placeholder: "https://dropsuite.us/api/", helpKey: "backupProviders.baseUrlHelp" });
  });

  it("keeps the username autofill guard on Cove (D12)", () => {
    expect(cove.fields.find((field) => field.key === "username")?.autoComplete).toBe("off");
  });

  it("makes the Cove password the only revealable field", () => {
    const revealable = BACKUP_PROVIDER_FORMS.flatMap((form) => form.fields).filter((field) => field.input === "revealable_secret");
    expect(revealable.map((field) => field.key)).toEqual(["password"]);
  });

  it("points every translation key at a real English string (t() cannot check these statically)", () => {
    const strings = en.backupProviders as Record<string, unknown>;
    const keys = BACKUP_PROVIDER_FORMS.flatMap((form) => [
      form.labelKey,
      form.namePlaceholderKey,
      form.helpKey,
      ...(form.reentryHelpKey ? [form.reentryHelpKey] : []),
      ...(form.baseUrl ? [form.baseUrl.helpKey] : []),
      ...form.fields.map((field) => field.labelKey),
    ]);
    for (const key of keys) {
      expect(key.startsWith("backupProviders."), key).toBe(true);
      expect(typeof strings[key.slice("backupProviders.".length)], key).toBe("string");
    }
  });
});

describe("createCredentials", () => {
  it("trims every field except the Cove password", () => {
    expect(createCredentials(cove, { partnerName: " OliveTech ", username: " breeze-ro ", password: " p " })).toEqual({
      partnerName: "OliveTech",
      username: "breeze-ro",
      password: " p ",
    });
    expect(createCredentials(dropsuite, { resellerToken: " r ", authToken: " a " })).toEqual({ resellerToken: "r", authToken: "a" });
    expect(createCredentials(axcient, { apiKey: " k " })).toEqual({ apiKey: "k" });
  });

  it("posts blank Cove identity fields as empty strings, as the old form did", () => {
    expect(createCredentials(cove, { password: "p" })).toEqual({ partnerName: "", username: "", password: "p" });
  });

  it("keeps the field order of the old bodies, so the posted JSON is byte-identical", () => {
    expect(JSON.stringify(createCredentials(cove, { password: "p", username: "u", partnerName: "n" }))).toBe('{"partnerName":"n","username":"u","password":"p"}');
    expect(JSON.stringify(createCredentials(dropsuite, { authToken: "a", resellerToken: "r" }))).toBe('{"resellerToken":"r","authToken":"a"}');
  });

  it("never reads a value that is not one of the provider's own fields", () => {
    const typed = { password: "cove-secret", resellerToken: "reseller-secret", authToken: "auth-secret", apiKey: "test-axcient-key-0000" };
    expect(createCredentials(axcient, typed)).toEqual({ apiKey: "test-axcient-key-0000" });
    expect(createCredentials(dropsuite, typed)).toEqual({ resellerToken: "reseller-secret", authToken: "auth-secret" });
    expect(createCredentials(cove, typed)).toEqual({ partnerName: "", username: "", password: "cove-secret" });
  });
});

describe("canSubmitCreate", () => {
  it("canSubmitCreate: cove needs partner, login and token; dropsuite needs both tokens; axcient needs apiKey", () => {
    expect(canSubmitCreate(cove, {})).toBe(false);
    expect(canSubmitCreate(cove, { partnerName: "n", username: "u" })).toBe(false);
    expect(canSubmitCreate(cove, { password: "p" })).toBe(false);
    expect(canSubmitCreate(cove, { partnerName: "n", username: "u", password: "p" })).toBe(true);

    expect(canSubmitCreate(dropsuite, {})).toBe(false);
    expect(canSubmitCreate(dropsuite, { resellerToken: "r" })).toBe(false);
    expect(canSubmitCreate(dropsuite, { authToken: "a" })).toBe(false);
    expect(canSubmitCreate(dropsuite, { resellerToken: "r", authToken: "a" })).toBe(true);

    expect(canSubmitCreate(axcient, {})).toBe(false);
    expect(canSubmitCreate(axcient, { apiKey: "k" })).toBe(true);
  });

  it("treats a whitespace-only value as blank for every provider", () => {
    // coveCredentialsSchema rejects a blank/whitespace-only token, so the form must too.
    expect(canSubmitCreate(cove, { partnerName: "n", username: "u", password: " " })).toBe(false);
    expect(canSubmitCreate(dropsuite, { resellerToken: " ", authToken: "a" })).toBe(false);
    expect(canSubmitCreate(axcient, { apiKey: "  " })).toBe(false);
  });
});

describe("rotationCredentials", () => {
  it("rotationCredentials: dropsuite partial => incomplete; all blank => null; axcient blank => null", () => {
    expect(rotationCredentials(dropsuite, { resellerToken: "r" })).toEqual({ incomplete: true });
    expect(rotationCredentials(dropsuite, { authToken: "a" })).toEqual({ incomplete: true });
    expect(rotationCredentials(dropsuite, { resellerToken: " ", authToken: "a" })).toEqual({ incomplete: true });
    expect(rotationCredentials(dropsuite, {})).toBeNull();
    expect(rotationCredentials(dropsuite, { resellerToken: " ", authToken: " " })).toBeNull();
    expect(rotationCredentials(axcient, {})).toBeNull();
    expect(rotationCredentials(axcient, { apiKey: "  " })).toBeNull();
  });

  it("replaces a complete set with trimmed values", () => {
    expect(rotationCredentials(dropsuite, { resellerToken: " r ", authToken: " a " })).toEqual({ credentials: { resellerToken: "r", authToken: "a" } });
    expect(rotationCredentials(axcient, { apiKey: " new " })).toEqual({ credentials: { apiKey: "new" } });
  });

  it("sends Axcient the API key and nothing else, whatever else is in state", () => {
    expect(rotationCredentials(axcient, { apiKey: "new", partnerName: "n", username: "u", password: "p" })).toEqual({ credentials: { apiKey: "new" } });
  });

  it("posts the Cove password untrimmed once it is not blank", () => {
    expect(rotationCredentials(cove, { partnerName: " n ", username: " u ", password: " p " })).toEqual({
      credentials: { partnerName: "n", username: "u", password: " p " },
    });
  });

  it("flags a Cove rotation with any identity/token field filled but not all three as incomplete", () => {
    // The API replaces the whole credential set (partnerName + username + password
    // are all required), so a username with a blank password must be blocked, not
    // silently dropped as a "keep stored" success.
    expect(rotationCredentials(cove, { partnerName: "n", username: "u" })).toEqual({ incomplete: true });
    expect(rotationCredentials(cove, { username: "u", password: "" })).toEqual({ incomplete: true });
    expect(rotationCredentials(cove, { password: "p" })).toEqual({ incomplete: true });
    expect(rotationCredentials(cove, { partnerName: "n", username: "u", password: "   " })).toEqual({ incomplete: true });
  });

  it("keeps the stored Cove credential when every field is blank", () => {
    expect(rotationCredentials(cove, {})).toBeNull();
    expect(rotationCredentials(cove, { partnerName: " ", username: "", password: "  " })).toBeNull();
  });

});

describe("BACKUP_PROVIDER_FORMS invariants", () => {
  // An empty or mistyped `requires` would either post blank credentials over a
  // working secret or never rotate at all.
  it.each(BACKUP_PROVIDER_FORMS.map((form) => [form.provider, form] as const))("%s rotation requires real fields", (_provider, form) => {
    const keys = form.fields.map((field) => field.key);
    expect(form.rotation.requires.length).toBeGreaterThan(0);
    for (const key of form.rotation.requires) expect(keys).toContain(key);
    expect(rotationCredentials(form, {})).toBeNull();
  });
});

describe("valuesAfterRotation", () => {
  it("clears secrets and keeps plain text, as the old card did", () => {
    expect(valuesAfterRotation(cove, { partnerName: "n", username: "u", password: "p" })).toEqual({ partnerName: "n", username: "u" });
    expect(valuesAfterRotation(dropsuite, { resellerToken: "r", authToken: "a" })).toEqual({});
    expect(valuesAfterRotation(axcient, { apiKey: "k" })).toEqual({});
  });
});
