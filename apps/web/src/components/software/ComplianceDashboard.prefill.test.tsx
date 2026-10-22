import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));
vi.mock("@/lib/authScope", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/authScope")>("@/lib/authScope");
  return {
    ...actual,
    getJwtClaims: vi.fn(() => ({ scope: "organization", partnerId: "p-1", orgId: "org-1" })),
  };
});
vi.mock("../../stores/orgStore", () => {
  const state = { currentOrgId: "org-1", allOrgs: false, organizations: [{ id: "org-1", name: "Acme" }] };
  return { useOrgStore: (sel?: (s: typeof state) => unknown) => (sel ? sel(state) : state) };
});

import ComplianceDashboard from "./ComplianceDashboard";
import { fetchWithAuth } from "../../stores/auth";

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown): Response =>
  ({ ok: true, status: 200, statusText: "OK", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

describe("ComplianceDashboard create-policy prefill (#9636)", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    fetchMock.mockImplementation((url: string) => {
      if (url.startsWith("/software-policies/compliance/overview"))
        return Promise.resolve(json({ total: 0, compliant: 0, violations: 0, unknown: 0 }));
      return Promise.resolve(json({ data: [] }));
    });
  });

  it("opens the create form pre-filled with the title, mode and rule", async () => {
    render(<ComplianceDashboard prefill={{ name: "Zoom", vendor: "Zoom Inc", mode: "allowlist" }} />);
    const name = await screen.findByPlaceholderText("e.g. Block Unauthorized Software");
    await waitFor(() => expect((name as HTMLInputElement).value).toBe("Zoom Policy"));
    expect((screen.getByLabelText("Mode") as HTMLSelectElement).value).toBe("allowlist");
    expect((screen.getByPlaceholderText("Name *") as HTMLInputElement).value).toBe("Zoom");
    expect((screen.getByPlaceholderText("Vendor") as HTMLInputElement).value).toBe("Zoom Inc");
  });

  it("a plain Create Policy click (no prefill) opens a blank form", async () => {
    render(<ComplianceDashboard />);
    fireEvent.click(await screen.findByText("Create Policy"));
    const name = await screen.findByPlaceholderText("e.g. Block Unauthorized Software");
    expect((name as HTMLInputElement).value).toBe("");
  });

  it("re-mounts the form when a second prefill arrives", async () => {
    const { rerender } = render(<ComplianceDashboard prefill={{ name: "Zoom" }} />);
    const name = await screen.findByPlaceholderText("e.g. Block Unauthorized Software");
    await waitFor(() => expect((name as HTMLInputElement).value).toBe("Zoom Policy"));
    fireEvent.change(name, { target: { value: "Edited by user" } });
    rerender(<ComplianceDashboard prefill={{ name: "Slack" }} />);
    await waitFor(() =>
      expect(
        (screen.getByPlaceholderText("e.g. Block Unauthorized Software") as HTMLInputElement).value,
      ).toBe("Slack Policy"),
    );
  });
});
