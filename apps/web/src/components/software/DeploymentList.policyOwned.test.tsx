import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));

import DeploymentList from "./DeploymentList";
import { fetchWithAuth } from "../../stores/auth";

const fetchMock = vi.mocked(fetchWithAuth);
const jsonResponse = (payload: unknown): Response =>
  ({
    ok: true,
    status: 200,
    statusText: "OK",
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const COUNTS = {
  pending: 3,
  inProgress: 0,
  completed: 0,
  failed: 0,
  cancelled: 0,
  total: 3,
};

const POLICY_OWNED = {
  id: "dep-policy-1",
  orgId: "org-1",
  name: "Required Apps — auto-install",
  scheduleType: "immediate",
  createdAt: "2026-09-10T10:00:00Z",
  status: "pending",
  softwarePolicyId: "pol-1",
  counts: COUNTS,
};

const MANUAL = {
  id: "dep-manual-1",
  orgId: "org-1",
  name: "Chrome Rollout",
  scheduleType: "immediate",
  createdAt: "2026-09-10T09:00:00Z",
  status: "pending",
  softwarePolicyId: null,
  counts: { ...COUNTS, pending: 1, total: 1 },
};

describe("DeploymentList — policy-owned badge (#5509)", () => {
  it("labels a policy-originated deployment as policy-owned", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse({
        data: [POLICY_OWNED, MANUAL],
        pagination: { page: 1, limit: 20, total: 2 },
      }),
    );
    render(<DeploymentList />);
    await waitFor(() =>
      expect(screen.getByText("Required Apps — auto-install")).toBeInTheDocument(),
    );
    expect(
      screen.getByTestId("deployment-policy-owned-dep-policy-1"),
    ).toHaveTextContent("Policy-owned");
    expect(
      screen.queryByTestId("deployment-policy-owned-dep-manual-1"),
    ).not.toBeInTheDocument();
  });
});
