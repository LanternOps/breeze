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
const POLICY = {
  id: "pol-1",
  name: "Standard apps",
  mode: "allowlist",
  isActive: true,
  enforceMode: false,
  rules: { software: [{ name: "Chrome" }] },
};

function mockEndpoints() {
  fetchMock.mockImplementation((url: string) => {
    if (url.startsWith("/software-policies/compliance/overview"))
      return Promise.resolve(json(OVERVIEW));
    if (url.startsWith("/software-policies/violations"))
      return Promise.resolve(json({ data: [] }));
    if (url.startsWith("/software-policies?"))
      return Promise.resolve(json({ data: [POLICY] }));
    if (url === `/software-policies/${POLICY.id}/remediate/preview`)
      return Promise.resolve(
        json({
          policy: POLICY,
          deviceIds: ["dev-1"],
          deviceCount: 1,
          uninstallCount: 1,
          software: [{ name: "Zoom", deviceCount: 1 }],
          softwareDistinctCount: 1,
          sampleDevices: [
            { deviceId: "dev-1", hostname: "alpha", uninstalls: [{ name: "Zoom" }] },
          ],
          totalTargetDevices: 1,
          capped: false,
          maxDevices: 500,
        }),
      );
    return Promise.resolve(json({ data: [] }));
  });
}

describe("ComplianceDashboard — Remediate (#3616)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockEndpoints();
  });

  it("renders Remediate as a labelled button that opens a confirmation instead of POSTing", async () => {
    render(<ComplianceDashboard />);
    const button = await screen.findByTestId(`policy-remediate-${POLICY.id}`);
    // A text label, not a tooltip-only icon (incident #3381).
    expect(button.textContent).toContain("Remediate");

    fireEvent.click(button);

    await screen.findByTestId("software-remediate-preview");
    const posted = fetchMock.mock.calls.filter(
      ([url, init]) =>
        String(url).endsWith("/remediate") &&
        (init as RequestInit | undefined)?.method === "POST",
    );
    expect(posted).toHaveLength(0);
  });
});
