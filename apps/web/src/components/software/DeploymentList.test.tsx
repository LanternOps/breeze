import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import DeploymentList from "./DeploymentList";
import { fetchWithAuth } from "../../stores/auth";

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: vi.fn(),
}));

const showToast = vi.fn();
vi.mock("../shared/Toast", () => ({ showToast: (a: unknown) => showToast(a) }));

const fetchMock = vi.mocked(fetchWithAuth);

const jsonResponse = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({
    ok,
    status,
    statusText: ok ? "OK" : "ERROR",
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const DEP_IN_PROGRESS = {
  id: "dep-1",
  orgId: "org-1",
  name: "Chrome Rollout",
  scheduleType: "immediate",
  createdAt: "2026-07-20T10:00:00Z",
  status: "in_progress",
  // 4 of 6 terminal → 67%
  counts: { pending: 1, inProgress: 1, completed: 3, failed: 1, cancelled: 0, total: 6 },
};

const DEP_PENDING = {
  id: "dep-2",
  orgId: "org-1",
  name: "Zoom Update",
  scheduleType: "scheduled",
  scheduledAt: "2026-08-01T09:00:00Z",
  createdAt: "2026-07-21T10:00:00Z",
  status: "pending",
  counts: { pending: 4, inProgress: 0, completed: 0, failed: 0, cancelled: 0, total: 4 },
};

const DEP_COMPLETED = {
  id: "dep-3",
  orgId: "org-1",
  name: "Firefox Patch",
  scheduleType: "maintenance",
  createdAt: "2026-07-19T10:00:00Z",
  status: "completed",
  counts: { pending: 0, inProgress: 0, completed: 2, failed: 0, cancelled: 0, total: 2 },
};

const listPayload = (data: unknown[], total = data.length) => ({
  data,
  pagination: { page: 1, limit: 20, total },
});

describe("DeploymentList", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    showToast.mockReset();
  });

  it("fetches page 1 from the API and renders the returned rows", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(listPayload([DEP_IN_PROGRESS, DEP_PENDING, DEP_COMPLETED])),
    );

    render(<DeploymentList />);

    expect(await screen.findByText("Chrome Rollout")).toBeInTheDocument();
    expect(screen.getByText("Zoom Update")).toBeInTheDocument();
    expect(screen.getByText("Firefox Patch")).toBeInTheDocument();
    expect(fetchMock).toHaveBeenCalledWith("/software/deployments?page=1&limit=20");

    // Status badges use the canonical status for logic and i18n for display.
    expect(screen.getAllByText("In progress").length).toBeGreaterThan(0);
  });

  it("renders the progress bar for an in_progress deployment (canonical status, not translated text)", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(listPayload([DEP_IN_PROGRESS, DEP_COMPLETED])),
    );

    render(<DeploymentList />);
    await screen.findByText("Chrome Rollout");

    // Regression: the old code compared item.status against i18n.t(...running3)
    // ("running"), so the bar never rendered for real API statuses.
    const progress = screen.getByTestId("deployment-progress-dep-1");
    expect(progress).toHaveTextContent("67%");
    // Terminal rows show no progress bar.
    expect(screen.queryByTestId("deployment-progress-dep-3")).not.toBeInTheDocument();
  });

  it("shows Cancel only for pending/in_progress rows and cancels via POST + refetch", async () => {
    let listCalls = 0;
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (url.startsWith("/software/deployments?")) {
        listCalls++;
        return Promise.resolve(
          jsonResponse(listPayload([DEP_IN_PROGRESS, DEP_PENDING, DEP_COMPLETED])),
        );
      }
      if (url.includes("/cancel") && options?.method === "POST") {
        return Promise.resolve(jsonResponse({ data: { ...DEP_PENDING, status: "cancelled" }, cancelledQueuedCommands: 1 }));
      }
      return Promise.resolve(jsonResponse({ data: null }));
    });

    render(<DeploymentList />);
    await screen.findByText("Zoom Update");

    // Regression: the old code compared item.status against i18n.t(...pending),
    // so the Cancel button never rendered. Canonical statuses restore it.
    expect(screen.getByTestId("deployment-cancel-dep-2")).toBeInTheDocument();
    expect(screen.getByTestId("deployment-cancel-dep-1")).toBeInTheDocument();
    expect(screen.queryByTestId("deployment-cancel-dep-3")).not.toBeInTheDocument();

    fireEvent.click(screen.getByTestId("deployment-cancel-dep-2"));

    await waitFor(() =>
      expect(fetchMock).toHaveBeenCalledWith(
        "/software/deployments/dep-2/cancel?orgId=org-1",
        { method: "POST", body: JSON.stringify({}) },
      ),
    );
    // runAction surfaced the outcome and the list was refetched.
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" })),
    );
    await waitFor(() => expect(listCalls).toBe(2));
  });

  it("does not select the row when Cancel is clicked", async () => {
    fetchMock.mockImplementation((url: string, options?: RequestInit) => {
      if (options?.method === "POST") {
        return Promise.resolve(jsonResponse({ data: DEP_PENDING, cancelledQueuedCommands: 0 }));
      }
      return Promise.resolve(jsonResponse(listPayload([DEP_PENDING])));
    });
    const onSelectDeployment = vi.fn();

    render(<DeploymentList onSelectDeployment={onSelectDeployment} />);
    await screen.findByText("Zoom Update");

    fireEvent.click(screen.getByTestId("deployment-cancel-dep-2"));
    await waitFor(() => expect(showToast).toHaveBeenCalled());
    expect(onSelectDeployment).not.toHaveBeenCalled();
  });

  it("fires onSelectDeployment with the deployment id on row click", async () => {
    fetchMock.mockResolvedValue(jsonResponse(listPayload([DEP_IN_PROGRESS])));
    const onSelectDeployment = vi.fn();

    render(<DeploymentList onSelectDeployment={onSelectDeployment} />);
    await screen.findByText("Chrome Rollout");

    fireEvent.click(screen.getByTestId("deployment-row-dep-1"));
    expect(onSelectDeployment).toHaveBeenCalledWith("dep-1");
  });

  it("refetches when refreshToken changes", async () => {
    fetchMock.mockResolvedValue(jsonResponse(listPayload([DEP_COMPLETED])));

    const { rerender } = render(<DeploymentList refreshToken={0} />);
    await screen.findByText("Firefox Patch");
    expect(fetchMock).toHaveBeenCalledTimes(1);

    rerender(<DeploymentList refreshToken={1} />);
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
  });

  it("filters client-side on canonical status values", async () => {
    fetchMock.mockResolvedValue(
      jsonResponse(listPayload([DEP_IN_PROGRESS, DEP_COMPLETED])),
    );

    render(<DeploymentList />);
    await screen.findByText("Chrome Rollout");

    fireEvent.change(screen.getByTestId("deployment-status-filter"), {
      target: { value: "completed" },
    });

    expect(screen.queryByText("Chrome Rollout")).not.toBeInTheDocument();
    expect(screen.getByText("Firefox Patch")).toBeInTheDocument();
  });

  it("shows an error state with retry when the fetch fails", async () => {
    fetchMock.mockResolvedValueOnce(jsonResponse({ error: "boom" }, false));
    render(<DeploymentList />);

    expect(await screen.findByTestId("deployment-list-retry")).toBeInTheDocument();

    fetchMock.mockResolvedValueOnce(jsonResponse(listPayload([DEP_COMPLETED])));
    fireEvent.click(screen.getByTestId("deployment-list-retry"));
    expect(await screen.findByText("Firefox Patch")).toBeInTheDocument();
  });
});
