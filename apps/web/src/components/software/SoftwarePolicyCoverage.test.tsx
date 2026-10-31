/**
 * #9635 — a device follows ONE software policy, so a policy can be assigned
 * yet govern no device. The coverage badge says so honestly, and Inventory
 * Approve / Deny surface the API's SOFTWARE_POLICY_WOULD_NOT_APPLY refusal
 * (naming the winning policy) instead of a generic failure.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
const showToast = vi.fn();
vi.mock("../shared/Toast", () => ({ showToast: (a: unknown) => showToast(a) }));
vi.mock("./DeviceDrawer", () => ({ default: () => null }));

import SoftwarePolicyCoverageBadge from "./SoftwarePolicyCoverageBadge";
import SoftwareInventory from "./SoftwareInventory";
import { fetchWithAuth } from "../../stores/auth";

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: new Headers({ "content-type": "application/json" }),
  }) as unknown as Response;

const WINNER = {
  policyId: "p-allow",
  name: "Default Allowlist",
  mode: "allowlist",
  partnerWide: false,
  configPolicyId: "c-allow",
  configPolicyName: "Default Allowlist Config",
  deviceCount: 4,
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("SoftwarePolicyCoverageBadge", () => {
  it("shows 'Applies to 0 devices' and the winning policy when every assigned device is overridden", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ data: { assignedDeviceCount: 4, appliesToDeviceCount: 0, overriddenBy: [WINNER] } }),
    );

    render(<SoftwarePolicyCoverageBadge policyId="p-block" />);

    const badge = await screen.findByTestId("software-policy-coverage");
    expect(fetchMock).toHaveBeenCalledWith("/software-policies/p-block/coverage");
    expect(badge.textContent).toContain("Applies to 0 devices");
    expect(screen.getByTestId("software-policy-overridden-by").textContent).toContain(
      '"Default Allowlist"',
    );
  });

  it("shows the governed device count when the policy wins somewhere", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ data: { assignedDeviceCount: 5, appliesToDeviceCount: 3, overriddenBy: [{ ...WINNER, deviceCount: 2 }] } }),
    );

    render(<SoftwarePolicyCoverageBadge policyId="p-allow" />);

    const badge = await screen.findByTestId("software-policy-coverage");
    expect(badge.textContent).toContain("Applies to 3 devices");
    expect(badge.getAttribute("data-state")).toBe("applies");
  });

  it("says coverage is unavailable (not 'fine') when the request fails", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "boom" }, 500));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

    render(<SoftwarePolicyCoverageBadge policyId="p-err" />);

    const badge = await screen.findByTestId("software-policy-coverage");
    expect(badge.getAttribute("data-state")).toBe("unavailable");
    expect(badge.textContent).toContain("Coverage unavailable");
    warn.mockRestore();
  });

  it("labels a partner-wide winner and an unreadable winner", async () => {
    fetchMock.mockResolvedValueOnce(
      json({
        data: {
          assignedDeviceCount: 2,
          appliesToDeviceCount: 0,
          overriddenBy: [
            { ...WINNER, name: "MSP Blocklist", partnerWide: true, deviceCount: 1 },
            { ...WINNER, policyId: null, name: null, deviceCount: 1 },
          ],
        },
      }),
    );

    render(<SoftwarePolicyCoverageBadge policyId="p-y" />);

    const by = await screen.findByTestId("software-policy-overridden-by");
    expect(by.textContent).toContain('partner-wide "MSP Blocklist"');
    expect(by.textContent).toContain("another software policy");
    expect(screen.getByTestId("software-policy-coverage").getAttribute("data-state")).toBe("overridden");
  });

  it("says a policy with no assignment is not assigned, not overridden", async () => {
    fetchMock.mockResolvedValueOnce(
      json({ data: { assignedDeviceCount: 0, appliesToDeviceCount: 0, overriddenBy: [] } }),
    );

    render(<SoftwarePolicyCoverageBadge policyId="p-x" />);

    const badge = await screen.findByTestId("software-policy-coverage");
    expect(badge.getAttribute("data-state")).toBe("unassigned");
    expect(screen.queryByTestId("software-policy-overridden-by")).toBeNull();
  });
});

describe("SoftwareInventory Deny refused by the API (#9635)", () => {
  it("toasts the refusal naming the winning policy and its configuration policy", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/software-inventory/deny" && init?.method === "POST") {
        return json(
          {
            error: "server prose",
            code: "SOFTWARE_POLICY_WOULD_NOT_APPLY",
            policyName: "Default Blocklist",
            mode: "blocklist",
            sameMode: false,
            deviceCount: 4,
            winners: [WINNER],
          },
          409,
        );
      }
      return json({
        data: [
          {
            name: "TeamViewer",
            vendor: "TeamViewer",
            deviceCount: 4,
            versions: [],
            firstSeen: null,
            lastSeen: null,
            policyStatus: "no_policy",
          },
        ],
        pagination: { total: 1 },
      });
    });

    render(<SoftwareInventory />);

    fireEvent.click(await screen.findByTestId("software-inventory-actions-TeamViewer"));
    fireEvent.click(screen.getByTestId("software-inventory-deny"));

    await waitFor(() => expect(showToast).toHaveBeenCalled());
    const toast = showToast.mock.calls.at(-1)![0] as { type: string; message: string };
    expect(toast.type).toBe("error");
    expect(toast.message).toContain('"Default Blocklist"');
    expect(toast.message).toContain('"Default Allowlist"');
    expect(toast.message).toContain('"Default Allowlist Config"');
  });

  it("names the policies a new default list now overrides on success", async () => {
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/software-inventory/approve" && init?.method === "POST") {
        return json(
          {
            success: true,
            policyId: "p-new",
            overrides: [{ ...WINNER, name: "MSP Blocklist", mode: "blocklist", partnerWide: true }],
          },
          201,
        );
      }
      return json({
        data: [
          { name: "Zoom", vendor: null, deviceCount: 4, versions: [], firstSeen: null, lastSeen: null, policyStatus: "no_policy" },
        ],
        pagination: { total: 1 },
      });
    });

    render(<SoftwareInventory />);

    fireEvent.click(await screen.findByTestId("software-inventory-actions-Zoom"));
    fireEvent.click(screen.getByTestId("software-inventory-approve"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "warning", message: expect.stringContaining('"MSP Blocklist"') }),
      ),
    );
  });
});
