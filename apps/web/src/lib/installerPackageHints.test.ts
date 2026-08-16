import { describe, expect, it } from "vitest";
import {
  applyOsHint,
  installerExt,
  osForInstaller,
} from "./installerPackageHints";

describe("installerExt", () => {
  it("resolves known extensions from file names", () => {
    expect(installerExt("setup.msi")).toBe("msi");
    expect(installerExt("Setup.MSI")).toBe("msi");
    expect(installerExt("app.dmg")).toBe("dmg");
    expect(installerExt("pkg_1.2.3.deb")).toBe("deb");
  });

  it("resolves extensions from URLs, ignoring query and fragment", () => {
    expect(installerExt("https://example.com/dl/pkg-1.0.msi?sig=abc#x")).toBe(
      "msi",
    );
    expect(installerExt("https://example.com/mac/App.pkg")).toBe("pkg");
  });

  it("returns null for unknown or missing extensions", () => {
    expect(installerExt("")).toBeNull();
    expect(installerExt("https://example.com/download")).toBeNull();
    expect(installerExt("archive.zip")).toBeNull();
    expect(installerExt("https://example.com/msi/")).toBeNull();
  });
});

describe("osForInstaller", () => {
  it("maps extensions to OS", () => {
    expect(osForInstaller("a.msi")).toBe("windows");
    expect(osForInstaller("a.exe")).toBe("windows");
    expect(osForInstaller("a.dmg")).toBe("macos");
    expect(osForInstaller("a.pkg")).toBe("macos");
    expect(osForInstaller("a.deb")).toBe("linux");
    expect(osForInstaller("a.zip")).toBeNull();
  });
});

describe("applyOsHint", () => {
  const blank = { supportedOs: [] as string[] };

  it("auto-selects the OS from the extension", () => {
    expect(applyOsHint(blank, "setup.msi")).toEqual({
      supportedOs: ["windows"],
    });
    expect(applyOsHint(blank, "https://example.com/app.dmg")).toEqual({
      supportedOs: ["macos"],
    });
  });

  it("never overwrites a user-set OS", () => {
    expect(applyOsHint({ supportedOs: ["linux"] }, "setup.msi")).toEqual({});
  });

  it("is an empty patch for unknown extensions", () => {
    expect(applyOsHint(blank, "https://example.com/download")).toEqual({});
    expect(applyOsHint(blank, "archive.zip")).toEqual({});
  });

  // The msiexec prefill deliberately lives in installerArgsPrefill, keyed on the
  // explicit fileType selector so it stays retractable. Deriving it here as well
  // would resurrect the stale-`msiexec /i`-on-a-non-MSI bug that path prevents.
  it("does not touch silent-args fields", () => {
    const patch = applyOsHint(blank, "setup.msi");
    expect(patch).not.toHaveProperty("silentInstallArgs");
    expect(patch).not.toHaveProperty("silentUninstallArgs");
  });
});
