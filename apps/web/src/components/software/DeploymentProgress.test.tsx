import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import DeploymentProgress, {
  DEPLOYMENT_POLL_INTERVAL_MS,
} from "./DeploymentProgress";
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

const DEP_ID = "dep-1";

const detailPayload = (
  status: string,
  counts: Partial<{
    pending: number;
    inProgress: number;
    completed: number;
    failed: number;
    cancelled: number;
    total: number;
  }> = {},
) => ({
  data: {
    id: DEP_ID,
    orgId: "org-1",
    name: "Chrome Rollout",
    scheduleType: "immediate",
    createdAt: "2026-07-20T10:00:00Z",
    status,
    counts: {
      pending: 0,
      inProgress: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
      total: 0,
      ...counts,
    },
  },
});

const RESULT_COMPLETED = {
  id: "res-1",
  deploymentId: DEP_ID,
  deviceId: "device-1",
  status: "completed",
  startedAt: "2026-07-20T10:01:00Z",
  completedAt: "2026-07-20T10:05:00Z",
  exitCode: 0,
  output: null,
  errorMessage: null,
  retryCount: 0,
  deviceCommandId: null,
  hostname: "WS-01",
  queuedOffline: false,
};

const RESULT_QUEUED_OFFLINE = {
  id: "res-2",
  deploymentId: DEP_ID,
  deviceId: "device-2",
  status: "pending",
  startedAt: null,
  completedAt: null,
  exitCode: null,
  output: null,
  errorMessage: null,
  retryCount: 0,
  deviceCommandId: "cmd-1",
  hostname: "WS-02",
  queuedOffline: true,
};

const RESULT_FAILED_NO_HOSTNAME = {
  id: "res-3",
  deploymentId: DEP_ID,
  deviceId: "device-3-uuid",
  status: "failed",
  startedAt: "2026-07-20T10:01:00Z",
  completedAt: "2026-07-20T10:02:00Z",
  exitCode: 1603,
  output: null,
  errorMessage: "Insufficient disk space",
  retryCount: 0,
  deviceCommandId: null,
  hostname: null,
  queuedOffline: false,
};

function routeFetch(opts: {
  detail: unknown;
  results?: unknown;
  onMutation?: (url: string) => unknown;
  counters?: { detail?: () => void; results?: () => void };
}) {
  fetchMock.mockImplementation((url: string, options?: RequestInit) => {
    if (options?.method === "POST") {
      return Promise.resolve(jsonResponse(opts.onMutation?.(url) ?? {}));
    }
    if (url.startsWith(`/software/deployments/${DEP_ID}/results`)) {
      opts.counters?.results?.();
      return Promise.resolve(
        jsonResponse(opts.results ?? { data: [], total: 0 }),
      );
    }
    if (url === `/software/deployments/${DEP_ID}`) {
      opts.counters?.detail?.();
      return Promise.resolve(jsonResponse(opts.detail));
    }
    return Promise.resolve(jsonResponse({ data: null }));
  });
}

describe("DeploymentProgress", () => {
  beforeEach(() => {
    fetchMock.mockReset();
    showToast.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders the deployment detail, per-device rows, and the queued-offline state", async () => {
    routeFetch({
      detail: detailPayload("in_progress", {
        pending: 1,
        inProgress: 0,
        completed: 1,
        failed: 1,
        total: 3,
      }),
      results: {
        data: [RESULT_COMPLETED, RESULT_QUEUED_OFFLINE, RESULT_FAILED_NO_HOSTNAME],
        total: 3,
      },
    });

    render(<DeploymentProgress deploymentId={DEP_ID} />);

    expect(await screen.findByText("Chrome Rollout")).toBeInTheDocument();
    expect(screen.getByText("WS-01")).toBeInTheDocument();
    // queuedOffline rows say so instead of a bare pending state.
    expect(screen.getByText("Queued — device offline")).toBeInTheDocument();
    // hostname falls back to the device id.
    expect(screen.getByText("device-3-uuid")).toBeInTheDocument();
    expect(screen.getByText("Insufficient disk space")).toBeInTheDocument();
    expect(screen.getByText("1603")).toBeInTheDocument();

    // Overall: 2 of 3 rows terminal → 67%.
    expect(screen.getByTestId("deployment-percent")).toHaveTextContent("67%");
    expect(screen.getByTestId("deployment-tile-completed")).toHaveTextContent("1");
    expect(screen.getByTestId("deployment-tile-failed")).toHaveTextContent("1");
  });

  it("polls every 5s while in_progress", async () => {
    vi.useFakeTimers();
    let detailCalls = 0;
    routeFetch({
      detail: detailPayload("in_progress", { inProgress: 1, total: 1 }),
      counters: { detail: () => detailCalls++ },
    });

    render(<DeploymentProgress deploymentId={DEP_ID} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(detailCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEPLOYMENT_POLL_INTERVAL_MS);
    });
    expect(detailCalls).toBe(2);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEPLOYMENT_POLL_INTERVAL_MS);
    });
    expect(detailCalls).toBe(3);
  });

  it("does not poll once the aggregate status is terminal", async () => {
    vi.useFakeTimers();
    let detailCalls = 0;
    routeFetch({
      detail: detailPayload("completed", { completed: 2, total: 2 }),
      counters: { detail: () => detailCalls++ },
    });

    render(<DeploymentProgress deploymentId={DEP_ID} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(detailCalls).toBe(1);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEPLOYMENT_POLL_INTERVAL_MS * 3);
    });
    expect(detailCalls).toBe(1);
  });

  it("stops polling on unmount", async () => {
    vi.useFakeTimers();
    let detailCalls = 0;
    routeFetch({
      detail: detailPayload("in_progress", { inProgress: 1, total: 1 }),
      counters: { detail: () => detailCalls++ },
    });

    const { unmount } = render(<DeploymentProgress deploymentId={DEP_ID} />);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(detailCalls).toBe(1);

    unmount();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(DEPLOYMENT_POLL_INTERVAL_MS * 3);
    });
    expect(detailCalls).toBe(1);
  });

  it("shows the auto-refresh indicator only while polling is active", async () => {
    routeFetch({
      detail: detailPayload("in_progress", { inProgress: 1, total: 1 }),
    });
    const { unmount } = render(<DeploymentProgress deploymentId={DEP_ID} />);
    expect(await screen.findByTestId("deployment-auto-refresh")).toBeInTheDocument();
    unmount();

    fetchMock.mockReset();
    routeFetch({
      detail: detailPayload("completed", { completed: 1, total: 1 }),
    });
    render(<DeploymentProgress deploymentId={DEP_ID} />);
    expect(await screen.findByText("Chrome Rollout")).toBeInTheDocument();
    expect(screen.queryByTestId("deployment-auto-refresh")).not.toBeInTheDocument();
  });

  it("retries failed devices via runAction and refetches", async () => {
    let detailCalls = 0;
    const mutations: string[] = [];
    routeFetch({
      detail: detailPayload("completed_with_errors", {
        completed: 1,
        failed: 1,
        total: 2,
      }),
      onMutation: (url) => {
        mutations.push(url);
        return { retriedDeviceIds: ["device-3-uuid"], skippedDeviceIds: [] };
      },
      counters: { detail: () => detailCalls++ },
    });

    render(<DeploymentProgress deploymentId={DEP_ID} />);
    await screen.findByText("Chrome Rollout");
    expect(detailCalls).toBe(1);

    const retryButton = screen.getByTestId("deployment-retry-failed");
    expect(retryButton).toBeEnabled();
    fireEvent.click(retryButton);

    await waitFor(() =>
      expect(mutations).toContain(`/software/deployments/${DEP_ID}/retry?orgId=org-1`),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/software/deployments/${DEP_ID}/retry?orgId=org-1`,
      { method: "POST" },
    );
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" })),
    );
    await waitFor(() => expect(detailCalls).toBe(2));
  });

  it("disables Retry failed when no devices failed", async () => {
    routeFetch({
      detail: detailPayload("completed", { completed: 2, total: 2 }),
    });

    render(<DeploymentProgress deploymentId={DEP_ID} />);
    await screen.findByText("Chrome Rollout");
    expect(screen.getByTestId("deployment-retry-failed")).toBeDisabled();
  });

  it("cancels a cancellable deployment via runAction", async () => {
    const mutations: string[] = [];
    routeFetch({
      detail: detailPayload("pending", { pending: 2, total: 2 }),
      onMutation: (url) => {
        mutations.push(url);
        return { data: {}, cancelledQueuedCommands: 2 };
      },
    });

    render(<DeploymentProgress deploymentId={DEP_ID} />);
    await screen.findByText("Chrome Rollout");

    fireEvent.click(screen.getByTestId("deployment-cancel"));
    await waitFor(() =>
      expect(mutations).toContain(`/software/deployments/${DEP_ID}/cancel?orgId=org-1`),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      `/software/deployments/${DEP_ID}/cancel?orgId=org-1`,
      { method: "POST", body: JSON.stringify({}) },
    );
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(expect.objectContaining({ type: "success" })),
    );
  });

  it("hides Cancel once the deployment is terminal", async () => {
    routeFetch({
      detail: detailPayload("cancelled", { cancelled: 2, total: 2 }),
    });

    render(<DeploymentProgress deploymentId={DEP_ID} />);
    await screen.findByText("Chrome Rollout");
    expect(screen.queryByTestId("deployment-cancel")).not.toBeInTheDocument();
  });

  it("fires onBack from the back button", async () => {
    routeFetch({
      detail: detailPayload("completed", { completed: 1, total: 1 }),
    });
    const onBack = vi.fn();

    render(<DeploymentProgress deploymentId={DEP_ID} onBack={onBack} />);
    await screen.findByText("Chrome Rollout");

    fireEvent.click(screen.getByTestId("deployment-back"));
    expect(onBack).toHaveBeenCalled();
  });
});
