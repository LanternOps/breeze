import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
const showToast = vi.fn();
vi.mock("../shared/Toast", () => ({ showToast: (a: unknown) => showToast(a) }));

// The dashboard reads currentOrgId/allOrgs from the org store, whose module
// body calls registerOrgIdProvider() from the (mocked) auth store at import
// time — mock the store itself, matching ComplianceDashboard.ownerScope.test.
const { getJwtClaimsMock, orgState } = vi.hoisted(() => ({
  getJwtClaimsMock: vi.fn(() => ({
    scope: "organization" as const,
    partnerId: "p-1" as string | null,
    orgId: "org-1" as string | null,
  })),
  orgState: {
    current: {
      currentOrgId: "org-1" as string | null,
      allOrgs: false,
      organizations: [{ id: "org-1", name: "Acme" }],
    },
  },
}));
vi.mock("@/lib/authScope", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/authScope")>("@/lib/authScope");
  return { ...actual, getJwtClaims: getJwtClaimsMock };
});
vi.mock("../../stores/orgStore", () => ({
  useOrgStore: (sel?: (s: typeof orgState.current) => unknown) =>
    sel ? sel(orgState.current) : orgState.current,
}));

import ComplianceDashboard from "./ComplianceDashboard";
import { fetchWithAuth } from "../../stores/auth";

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({
    ok,
    status,
    statusText: "OK",
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const OVERVIEW = { total: 0, compliant: 0, violations: 0, unknown: 0 };

function mockEndpoints() {
  fetchMock.mockImplementation((url: string, init?: RequestInit) => {
    if (url.startsWith("/software-policies/compliance/overview"))
      return Promise.resolve(json(OVERVIEW));
    if (url.startsWith("/software-policies/violations"))
      return Promise.resolve(json({ data: [] }));
    if (url.startsWith("/software-policies?"))
      return Promise.resolve(json({ data: [] }));
    if (url === "/software/catalog") return Promise.resolve(json({ data: [] }));
    if (url === "/software-policies" && init?.method === "POST") {
      return Promise.resolve(json({ id: "new-1" }));
    }
    return Promise.resolve(json({ data: [] }));
  });
}

function postBody(): Record<string, unknown> {
  const post = fetchMock.mock.calls.find(
    (c) => c[0] === "/software-policies" && (c[1] as RequestInit)?.method === "POST",
  );
  expect(post).toBeTruthy();
  return JSON.parse((post![1] as RequestInit).body as string);
}

function openCreateAndFill() {
  fireEvent.click(screen.getByText("Create Policy"));
  fireEvent.change(
    screen.getByPlaceholderText("e.g. Block Unauthorized Software"),
    { target: { value: "Required Apps" } },
  );
  fireEvent.change(screen.getByPlaceholderText("Name *"), {
    target: { value: "Zoom" },
  });
}

async function renderLoaded() {
  render(<ComplianceDashboard />);
  await waitFor(() =>
    expect(
      screen.queryByText("Loading software policy compliance..."),
    ).not.toBeInTheDocument(),
  );
}

function armAndSubmit() {
  fireEvent.change(screen.getByLabelText("Mode"), {
    target: { value: "allowlist" },
  });
  fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
  fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
  fireEvent.click(
    screen.getByText("Create Policy", { selector: 'button[type="submit"]' }),
  );
}

describe("ComplianceDashboard — autoInstall arming (#5509)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEndpoints();
  });

  it("sends remediationOptions.autoInstall when armed on an allowlist enforce policy", async () => {
    await renderLoaded();
    openCreateAndFill();
    armAndSubmit();
    await waitFor(() =>
      expect(postBody().remediationOptions).toMatchObject({
        autoInstall: true,
      }),
    );
  });

  it("omits autoInstall when mode is switched away from allowlist, even if the checkbox had been checked", async () => {
    await renderLoaded();
    openCreateAndFill();
    fireEvent.change(screen.getByLabelText("Mode"), {
      target: { value: "allowlist" },
    });
    fireEvent.click(screen.getByLabelText("Enforce (auto-remediate)"));
    fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
    fireEvent.change(screen.getByLabelText("Mode"), {
      target: { value: "blocklist" },
    });
    fireEvent.click(
      screen.getByText("Create Policy", { selector: 'button[type="submit"]' }),
    );
    await waitFor(() =>
      expect(
        (postBody().remediationOptions as Record<string, unknown> | undefined)
          ?.autoInstall,
      ).toBeUndefined(),
    );
  });

  it("forwards each rule's catalogId in the rules payload", async () => {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/software/catalog")
        return Promise.resolve(
          json({ data: [{ id: "cat-1", name: "Zoom", vendor: "Zoom Video" }] }),
        );
      if (url.startsWith("/software-policies/compliance/overview"))
        return Promise.resolve(json(OVERVIEW));
      if (url.startsWith("/software-policies/violations"))
        return Promise.resolve(json({ data: [] }));
      if (url.startsWith("/software-policies?"))
        return Promise.resolve(json({ data: [] }));
      if (url === "/software-policies" && init?.method === "POST")
        return Promise.resolve(json({ id: "new-1" }));
      return Promise.resolve(json({ data: [] }));
    });
    await renderLoaded();
    openCreateAndFill();
    await waitFor(() =>
      expect(
        (screen.getByTestId("software-rule-catalog-0") as HTMLSelectElement)
          .options.length,
      ).toBe(2),
    );
    fireEvent.change(screen.getByTestId("software-rule-catalog-0"), {
      target: { value: "cat-1" },
    });
    fireEvent.click(
      screen.getByText("Create Policy", { selector: 'button[type="submit"]' }),
    );
    await waitFor(() =>
      expect(
        (postBody().rules as { software: Array<{ catalogId?: string }> })
          .software[0].catalogId,
      ).toBe("cat-1"),
    );
  });
});

describe("ComplianceDashboard — catalog fetch failure is not indistinguishable from an empty catalog (#5509)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockCatalog(catalogResponse: Response | Promise<never>) {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/software/catalog")
        return catalogResponse instanceof Promise
          ? catalogResponse
          : Promise.resolve(catalogResponse);
      if (url.startsWith("/software-policies/compliance/overview"))
        return Promise.resolve(json(OVERVIEW));
      if (url.startsWith("/software-policies/violations"))
        return Promise.resolve(json({ data: [] }));
      if (url.startsWith("/software-policies?"))
        return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
  }

  it("tells the operator the catalog could not be loaded when the fetch returns a non-2xx", async () => {
    mockCatalog(json({ error: "boom" }, false, 500));
    await renderLoaded();
    fireEvent.click(screen.getByText("Create Policy"));
    expect(
      await screen.findByTestId("software-catalog-unavailable"),
    ).toHaveTextContent("couldn't be loaded");
  });

  it("tells the operator the catalog could not be loaded when the fetch throws", async () => {
    mockCatalog(Promise.reject(new Error("offline")));
    await renderLoaded();
    fireEvent.click(screen.getByText("Create Policy"));
    expect(
      await screen.findByTestId("software-catalog-unavailable"),
    ).toHaveTextContent("couldn't be loaded");
  });

  it("shows no such notice when the catalog loads and is simply empty", async () => {
    mockCatalog(json({ data: [] }));
    await renderLoaded();
    fireEvent.click(screen.getByText("Create Policy"));
    expect(
      screen.queryByTestId("software-catalog-unavailable"),
    ).not.toBeInTheDocument();
  });
});

describe("ComplianceDashboard — edit-mode arming round-trip (#5509)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  const ARMED_POLICY = {
    id: "pol-1",
    name: "Required Apps",
    orgId: "org-1",
    mode: "allowlist" as const,
    isActive: true,
    enforceMode: true,
    rules: {
      software: [{ name: "Zoom", catalogId: "cat-1" }],
      allowUnknown: false,
    },
    remediationOptions: { autoUninstall: false, autoInstall: true, gracePeriod: 24 },
  };

  function mockEditEndpoints() {
    fetchMock.mockImplementation((url: string) => {
      if (url === "/software-policies/pol-1")
        return Promise.resolve(json({ data: ARMED_POLICY }));
      if (url === "/software-policies/pol-1/install-preview")
        return Promise.resolve(json({ eligibleDeviceCount: 7 }));
      if (url.startsWith("/software-policies/compliance/overview"))
        return Promise.resolve(json(OVERVIEW));
      if (url.startsWith("/software-policies/violations"))
        return Promise.resolve(json({ data: [] }));
      if (url.startsWith("/software-policies?"))
        return Promise.resolve(json({ data: [ARMED_POLICY] }));
      if (url === "/software/catalog")
        return Promise.resolve(
          json({ data: [{ id: "cat-1", name: "Zoom", vendor: "Zoom Video" }] }),
        );
      return Promise.resolve(json({ data: [] }));
    });
  }

  async function openEditModal() {
    mockEditEndpoints();
    render(<ComplianceDashboard />);
    await waitFor(() =>
      expect(screen.getByText("Required Apps")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTitle("Edit"));
    await waitFor(() =>
      expect(screen.getByText("Edit Software Policy")).toBeInTheDocument(),
    );
  }

  it("pre-checks the auto-install checkbox and pre-selects the catalog link for an already-armed policy", async () => {
    await openEditModal();
    expect(screen.getByTestId("policy-auto-install-checkbox")).toBeChecked();
    expect(
      (screen.getByTestId("software-rule-catalog-0") as HTMLSelectElement).value,
    ).toBe("cat-1");
  });

  it("runs the install-preview dry run on open (policyId is only passed in edit mode)", async () => {
    await openEditModal();
    await screen.findByText(
      "This will install missing software on approximately 7 device(s).",
    );
    expect(fetchMock).toHaveBeenCalledWith(
      "/software-policies/pol-1/install-preview",
    );
  });

  it("preserves autoInstall and catalogId in the PATCH body when saving an unchanged armed policy", async () => {
    await openEditModal();
    fireEvent.click(
      screen.getByText("Update Policy", { selector: 'button[type="submit"]' }),
    );
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) =>
          c[0] === "/software-policies/pol-1" &&
          (c[1] as RequestInit)?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      const parsed = JSON.parse((patch![1] as RequestInit).body as string);
      expect(parsed.remediationOptions).toMatchObject({ autoInstall: true });
      expect(parsed.rules.software[0].catalogId).toBe("cat-1");
    });
  });

  it("sends autoInstall: false when the operator disarms an armed policy", async () => {
    await openEditModal();
    fireEvent.click(screen.getByTestId("policy-auto-install-checkbox"));
    fireEvent.click(
      screen.getByText("Update Policy", { selector: 'button[type="submit"]' }),
    );
    await waitFor(() => {
      const patch = fetchMock.mock.calls.find(
        (c) =>
          c[0] === "/software-policies/pol-1" &&
          (c[1] as RequestInit)?.method === "PATCH",
      );
      expect(patch).toBeTruthy();
      expect(
        JSON.parse((patch![1] as RequestInit).body as string).remediationOptions
          .autoInstall,
      ).toBe(false);
    });
  });
});

describe("ComplianceDashboard — honest 403 refusal on arming (#5509)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockRefusal(body: unknown) {
    fetchMock.mockImplementation((url: string, init?: RequestInit) => {
      if (url === "/software-policies" && init?.method === "POST") {
        return Promise.resolve(json(body, false, 403));
      }
      if (url.startsWith("/software-policies/compliance/overview"))
        return Promise.resolve(json(OVERVIEW));
      if (url.startsWith("/software-policies/violations"))
        return Promise.resolve(json({ data: [] }));
      if (url.startsWith("/software-policies?"))
        return Promise.resolve(json({ data: [] }));
      if (url === "/software/catalog")
        return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
  }

  it("shows the MFA-required friendly message on a 403 MFA_REQUIRED refusal, and keeps the modal open", async () => {
    mockRefusal({ error: "MFA required", code: "MFA_REQUIRED" });
    await renderLoaded();
    openCreateAndFill();
    armAndSubmit();
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          message: expect.stringContaining("multi-factor authentication"),
        }),
      ),
    );
    expect(screen.getByText("Create Software Policy")).toBeInTheDocument();
  });

  it("shows the devices.execute-permission friendly message on a 403 DEVICES_EXECUTE_REQUIRED refusal", async () => {
    mockRefusal({
      error: "Arming automatic install requires devices.execute",
      code: "DEVICES_EXECUTE_REQUIRED",
    });
    await renderLoaded();
    openCreateAndFill();
    armAndSubmit();
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "error",
          // The friendly copy, not the server's raw string (which also
          // contains "devices.execute" — asserting on that alone would pass
          // against the unmigrated handler).
          message: expect.stringContaining(
            "devices.execute permission. Ask an administrator",
          ),
        }),
      ),
    );
    expect(screen.getByText("Create Software Policy")).toBeInTheDocument();
  });
});

describe("ComplianceDashboard — install-remediation status display (#5509)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  function mockViolationsWith(complianceOverrides: Record<string, unknown>) {
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/software-policies/compliance/overview"))
        return Promise.resolve(json(OVERVIEW));
      if (url.startsWith("/software-policies/violations")) {
        return Promise.resolve(
          json({
            data: [
              {
                device: { id: "dev-1", hostname: "workstation-1" },
                compliance: {
                  policyId: "pol-1",
                  violations: [{ type: "missing", rule: { name: "Zoom" } }],
                  lastChecked: "2026-09-10T10:00:00Z",
                  ...complianceOverrides,
                },
              },
            ],
          }),
        );
      }
      if (url.startsWith("/software-policies?"))
        return Promise.resolve(json({ data: [] }));
      if (url === "/software/catalog")
        return Promise.resolve(json({ data: [] }));
      return Promise.resolve(json({ data: [] }));
    });
  }

  it("renders nothing extra when installRemediationStatus is absent", async () => {
    mockViolationsWith({});
    await renderLoaded();
    expect(
      screen.queryByTestId("install-remediation-dev-1"),
    ).not.toBeInTheDocument();
  });

  it("renders nothing extra when installRemediationStatus is 'none'", async () => {
    mockViolationsWith({ installRemediationStatus: "none" });
    await renderLoaded();
    expect(
      screen.queryByTestId("install-remediation-dev-1"),
    ).not.toBeInTheDocument();
  });

  it("shows 'gave_up' as a visually distinct terminal state (not styled like 'failed'), with the consecutive attempt count", async () => {
    mockViolationsWith({
      installRemediationStatus: "gave_up",
      installRemediationAttempts: 3,
    });
    render(<ComplianceDashboard />);
    const block = await screen.findByTestId("install-remediation-dev-1");
    expect(block).toHaveTextContent("Gave up after repeated failures");
    expect(block).toHaveTextContent("3 attempt(s)");
    const badge = screen.getByText("Gave up after repeated failures");
    expect(badge.className).toContain("text-destructive");
    expect(badge.className).not.toContain("text-amber-700");
  });

  // Both lookup maps fall back to the 'failed' entry on an unknown key, so a
  // renamed/typo'd status would silently render as "Install failed" — assert
  // each label explicitly rather than inferring from the two interesting ones.
  it.each([
    ["pending", "Install queued"],
    ["in_progress", "Installing…"],
    ["completed", "Installed"],
    ["failed", "Install failed"],
    ["skipped", "Skipped this pass"],
  ])("labels the '%s' status as %s", async (status, label) => {
    mockViolationsWith({ installRemediationStatus: status });
    render(<ComplianceDashboard />);
    const block = await screen.findByTestId("install-remediation-dev-1");
    expect(block).toHaveTextContent(label);
  });

  it("shows the last install-attempt time when present", async () => {
    mockViolationsWith({
      installRemediationStatus: "failed",
      lastInstallRemediationAttempt: "2026-09-10T09:30:00Z",
    });
    render(<ComplianceDashboard />);
    const block = await screen.findByTestId("install-remediation-dev-1");
    expect(block).toHaveTextContent("Last install attempt:");
  });

  it("explains a skipped device with a missing catalog link distinctly from the generic cap/platform hedge", async () => {
    mockViolationsWith({
      installRemediationStatus: "skipped",
      violations: [{ type: "missing", rule: { name: "Zoom" } }],
    });
    render(<ComplianceDashboard />);
    const block = await screen.findByTestId("install-remediation-dev-1");
    expect(block).toHaveTextContent("has no linked catalog item");
  });

  it("falls back to the generic cap/platform hedge for a skipped device whose rule already has a catalog link", async () => {
    mockViolationsWith({
      installRemediationStatus: "skipped",
      violations: [
        { type: "missing", rule: { name: "Zoom", catalogId: "cat-1" } },
      ],
    });
    render(<ComplianceDashboard />);
    const block = await screen.findByTestId("install-remediation-dev-1");
    expect(block).toHaveTextContent("per-pass install cap");
  });
});


describe("ComplianceDashboard — policy list feedback (#6026)", () => {
  beforeEach(() => vi.clearAllMocks());

  function mockPolicy(autoInstall: boolean, checkResponse = json({ jobId: "raw-bullmq-job-123" }), enforceMode = true) {
    fetchMock.mockImplementation((url: string) => {
      if (url.endsWith("/check")) return Promise.resolve(checkResponse);
      if (url.startsWith("/software-policies?")) return Promise.resolve(json({ data: [{
        id: "pol-1", name: "Required Apps", mode: "allowlist", isActive: true,
        enforceMode, remediationOptions: { autoInstall },
      }] }));
      if (url.includes("/overview")) return Promise.resolve(json(OVERVIEW));
      return Promise.resolve(json({ data: [] }));
    });
  }

  it("shows the armed badge on auto-install policies", async () => {
    mockPolicy(true);
    render(<ComplianceDashboard />);
    expect(await screen.findByTestId("policy-autoinstall-badge")).toHaveTextContent("Auto-install armed");
  });

  it("does not show the armed badge when enforcement is off, even with a stale autoInstall flag", async () => {
    mockPolicy(true, undefined, false);
    render(<ComplianceDashboard />);
    await screen.findByText("Required Apps");
    expect(screen.queryByTestId("policy-autoinstall-badge")).not.toBeInTheDocument();
  });

  it("does not show the armed badge on disarmed policies", async () => {
    mockPolicy(false);
    render(<ComplianceDashboard />);
    await screen.findByTestId("policy-check-compliance-pol-1");
    expect(screen.queryByTestId("policy-autoinstall-badge")).not.toBeInTheDocument();
  });

  it("confirms that compliance is queued without exposing the job id", async () => {
    mockPolicy(true);
    render(<ComplianceDashboard />);
    fireEvent.click(await screen.findByTestId("policy-check-compliance-pol-1"));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success", message: "Compliance check queued" }),
    ));
    expect(fetchMock).toHaveBeenCalledWith("/software-policies/pol-1/check", {
      method: "POST", body: "{}",
    });
    expect(JSON.stringify(showToast.mock.calls)).not.toContain("raw-bullmq-job-123");
  });

  it("reports a rejected check without a success toast", async () => {
    mockPolicy(true, json({ error: "Check unavailable" }, false, 500));
    render(<ComplianceDashboard />);
    fireEvent.click(await screen.findByTestId("policy-check-compliance-pol-1"));
    await waitFor(() => expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    ));
    expect(showToast).toHaveBeenCalledTimes(1);
  });
});
