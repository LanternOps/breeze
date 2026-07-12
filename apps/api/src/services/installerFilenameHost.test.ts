import { describe, expect, it } from "vitest";
import {
  InstallerFilenameHostError,
  isEncodedWindowsFilenameApiHost,
  macosBundleApiHost,
  windowsFilenameApiHost,
} from "./installerFilenameHost";

describe("windowsFilenameApiHost", () => {
  it("returns the bare hostname for a standard https URL", () => {
    expect(windowsFilenameApiHost("https://us.2breeze.app")).toBe(
      "us.2breeze.app",
    );
  });

  it("elides an explicit default port", () => {
    expect(windowsFilenameApiHost("https://rmm.example.com:443")).toBe(
      "rmm.example.com",
    );
  });

  it("encodes a nonstandard port as host_PORT — never host:port (#2341)", () => {
    // `:` is illegal in Windows filenames; browsers rewrite it at save time
    // and the agent-side parser then never matches, so the device installs
    // unenrolled with no visible error.
    expect(windowsFilenameApiHost("https://rmm.example.com:8443")).toBe(
      "rmm.example.com_8443",
    );
  });

  it("ignores path/query on the server URL", () => {
    expect(windowsFilenameApiHost("https://rmm.example.com:8443/api?x=1")).toBe(
      "rmm.example.com_8443",
    );
  });

  it("throws for a non-https scheme (agent redeems over https only)", () => {
    expect(() => windowsFilenameApiHost("http://rmm.example.com:8080")).toThrow(
      InstallerFilenameHostError,
    );
  });

  it("throws for a bracketed IPv6 host (not expressible in the filename)", () => {
    expect(() => windowsFilenameApiHost("https://[2001:db8::1]:8443")).toThrow(
      InstallerFilenameHostError,
    );
  });

  it("error message points at the property-based install fallback", () => {
    expect(() => windowsFilenameApiHost("http://rmm.example.com")).toThrow(
      /SERVER_URL and ENROLLMENT_KEY/,
    );
  });
});

describe("isEncodedWindowsFilenameApiHost", () => {
  it("accepts bare hosts and host_PORT", () => {
    expect(isEncodedWindowsFilenameApiHost("us.2breeze.app")).toBe(true);
    expect(isEncodedWindowsFilenameApiHost("rmm.example.com_8443")).toBe(true);
  });

  it("rejects host:port and other unsafe forms", () => {
    expect(isEncodedWindowsFilenameApiHost("rmm.example.com:8443")).toBe(false);
    expect(isEncodedWindowsFilenameApiHost("[2001:db8::1]")).toBe(false);
    expect(isEncodedWindowsFilenameApiHost("host_notaport")).toBe(false);
    expect(isEncodedWindowsFilenameApiHost("")).toBe(false);
  });
});

describe("macosBundleApiHost", () => {
  it("returns the hostname for a standard https URL", () => {
    expect(macosBundleApiHost("https://eu.2breeze.app")).toBe("eu.2breeze.app");
  });

  it("returns null for a nonstandard port (Swift parser has no port form)", () => {
    expect(macosBundleApiHost("https://rmm.example.com:8443")).toBeNull();
  });

  it("returns null for non-https schemes", () => {
    expect(macosBundleApiHost("http://rmm.example.com")).toBeNull();
  });

  it("returns null for a bracketed IPv6 host", () => {
    expect(macosBundleApiHost("https://[2001:db8::1]")).toBeNull();
  });
});
