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
  it("canSubmitCreate: cove needs only password; dropsuite needs both tokens; axcient needs apiKey", () => {
    expect(canSubmitCreate(cove, {})).toBe(false);
    expect(canSubmitCreate(cove, { partnerName: "n", username: "u" })).toBe(false);
    expect(canSubmitCreate(cove, { password: "p" })).toBe(true);

    expect(canSubmitCreate(dropsuite, {})).toBe(false);
    expect(canSubmitCreate(dropsuite, { resellerToken: "r" })).toBe(false);
    expect(canSubmitCreate(dropsuite, { authToken: "a" })).toBe(false);
    expect(canSubmitCreate(dropsuite, { resellerToken: "r", authToken: "a" })).toBe(true);

    expect(canSubmitCreate(axcient, {})).toBe(false);
    expect(canSubmitCreate(axcient, { apiKey: "k" })).toBe(true);
  });

  it("judges a whitespace-only value by the field's own trim flag", () => {
    // The old Cove button tested `!form.password`, untrimmed.
    expect(canSubmitCreate(cove, { password: " " })).toBe(true);
    // The old Dropsuite button tested `.trim()`.
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

  it("treats a whitespace-only Cove password as blank on rotation, unlike create", () => {
    // The old card tested `password.trim()` here while the create button tested
    // `!form.password`. The difference is deliberate to preserve.
    expect(rotationCredentials(cove, { password: "   " })).toBeNull();
    expect(canSubmitCreate(cove, { password: "   " })).toBe(true);
  });

  it("posts the Cove password untrimmed once it is not blank", () => {
    expect(rotationCredentials(cove, { partnerName: " n ", username: " u ", password: " p " })).toEqual({
      credentials: { partnerName: "n", username: "u", password: " p " },
    });
  });

  it("keeps the stored Cove credential when the identity fields are filled but the password is blank", () => {
    expect(rotationCredentials(cove, { partnerName: "n", username: "u" })).toBeNull();
    expect(rotationCredentials(cove, { username: "u", password: "" })).toBeNull();
  });

  it("rotates Cove on a password alone, with blank identity fields, as the old card did", () => {
    expect(rotationCredentials(cove, { password: "p" })).toEqual({ credentials: { partnerName: "", username: "", password: "p" } });
  });
});

describe("valuesAfterRotation", () => {
  it("clears secrets and keeps plain text, as the old card did", () => {
    expect(valuesAfterRotation(cove, { partnerName: "n", username: "u", password: "p" })).toEqual({ partnerName: "n", username: "u" });
    expect(valuesAfterRotation(dropsuite, { resellerToken: "r", authToken: "a" })).toEqual({});
    expect(valuesAfterRotation(axcient, { apiKey: "k" })).toEqual({});
  });
});
