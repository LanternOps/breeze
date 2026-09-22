import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import BackupProviderConnectionCard, { type BackupProviderConnection } from "./BackupProviderConnectionCard";
import { fetchWithAuth } from "../../stores/auth";
import { showToast } from "../shared/Toast";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));

const fetchMock = vi.mocked(fetchWithAuth);
const toastMock = vi.mocked(showToast);

const res = (payload: unknown, ok = true, status = ok ? 200 : 500): Response =>
  ({ ok, status, statusText: ok ? "OK" : "ERROR", json: vi.fn().mockResolvedValue(payload) }) as unknown as Response;

const connection = (o: Partial<BackupProviderConnection> = {}): BackupProviderConnection => ({
  id: "conn-1", provider: "cove", name: "OliveTech Cove", baseUrl: "https://api.backup.management/jsonapi",
  vendorRootName: "OliveTech", isActive: true, status: "connected", syncIntervalMinutes: 30,
  showProviderNameInPortal: false, lastSyncAt: "2026-09-15T11:50:00.000Z", lastSyncStatus: "success",
  lastSyncError: null, lastSyncCustomers: 12, lastSyncUnmappedCustomers: 2, lastSyncDevices: 340,
  lastSyncUnmappedDevices: 18, lastSyncLinkedDevices: 300, lastSyncAmbiguousDevices: 4,
  hasCredentials: true, ...o,
});

const onChanged = vi.fn();
const onTestResult = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  fetchMock.mockResolvedValue(res({ success: true }));
  vi.spyOn(window, "confirm").mockReturnValue(true);
});

describe("BackupProviderConnectionCard", () => {
  it("shows the counters, including the honesty counters", () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    expect(screen.getByTestId("backup-connection-customers").textContent).toContain("12");
    expect(screen.getByTestId("backup-connection-devices").textContent).toContain("340");
    expect(screen.getByTestId("backup-connection-linked").textContent).toContain("300");
    expect(screen.getByTestId("backup-connection-unmapped-devices").textContent).toContain("18");
    expect(screen.getByTestId("backup-connection-ambiguous").textContent).toContain("4");
  });

  it.each([
    ["success", "backup-connection-badge-active"],
    ["partial", "backup-connection-badge-active"],
    ["running", "backup-connection-badge-syncing"],
    ["error", "backup-connection-badge-error"],
    [null, "backup-connection-badge-pending"],
  ])("renders the %s sync badge", (lastSyncStatus, testId) => {
    render(
      <BackupProviderConnectionCard
        connection={connection({ lastSyncStatus: lastSyncStatus as BackupProviderConnection["lastSyncStatus"] })}
        onChanged={onChanged}
        onTestResult={onTestResult}
      />,
    );
    expect(screen.getByTestId(testId)).toBeInTheDocument();
  });

  it("renders the last sync error in its own box", () => {
    render(
      <BackupProviderConnectionCard
        connection={connection({ lastSyncStatus: "error", lastSyncError: "Login rejected by Cove" })}
        onChanged={onChanged}
        onTestResult={onTestResult}
      />,
    );
    expect(screen.getByTestId("backup-connection-sync-error").textContent).toContain("Login rejected by Cove");
  });

  it("offers Re-enter credentials only when the connection is reauth_required", () => {
    const { rerender } = render(
      <BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />,
    );
    expect(screen.queryByTestId("backup-connection-reauth")).toBeNull();

    rerender(
      <BackupProviderConnectionCard
        connection={connection({ status: "reauth_required" })}
        onChanged={onChanged}
        onTestResult={onTestResult}
      />,
    );
    expect(screen.getByTestId("backup-connection-reauth")).toBeInTheDocument();
  });

  it("POSTs the test endpoint and hands the result up rather than rendering its own modal", async () => {
    fetchMock.mockResolvedValue(res({ success: true, rootName: "OliveTech", customerCount: 12 }));
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);

    fireEvent.click(screen.getByTestId("backup-connection-test"));

    await waitFor(() => expect(onTestResult).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/backup/providers/connections/conn-1/test", { method: "POST" });
    expect(onTestResult.mock.calls[0]![0]).toMatchObject({ success: true, rootName: "OliveTech" });
  });

  it("treats an HTTP-200 {success:false} test as a failure and still surfaces the provider message", async () => {
    fetchMock.mockResolvedValue(res({ success: false, error: "2FA is enabled on this Cove user" }));
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);

    fireEvent.click(screen.getByTestId("backup-connection-test"));

    await waitFor(() => expect(onTestResult).toHaveBeenCalled());
    // runAction toasted it; the modal still opens with the provider's own words.
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(onTestResult.mock.calls[0]![0]).toMatchObject({ success: false, error: "2FA is enabled on this Cove user" });
  });

  it("queues a sync and tells the parent to refetch", async () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-sync"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(fetchMock).toHaveBeenCalledWith("/backup/providers/connections/conn-1/sync", { method: "POST" });
  });

  it("PATCHes only the fields the form changed", async () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-portal-toggle"));
    fireEvent.click(screen.getByTestId("backup-connection-save"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const [url, init] = fetchMock.mock.calls.at(-1)!;
    expect(url).toBe("/backup/providers/connections/conn-1");
    expect((init as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((init as RequestInit).body as string)).toEqual({
      name: "OliveTech Cove", isActive: true, showProviderNameInPortal: true,
    });
  });

  it("never sends an empty credentials object when the password field was left blank", async () => {
    render(
      <BackupProviderConnectionCard connection={connection({ status: "reauth_required" })} onChanged={onChanged} onTestResult={onTestResult} />,
    );
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string)).not.toHaveProperty("credentials");
  });

  it("confirms before deleting and names the connection in the prompt", async () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-delete"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain("OliveTech Cove");
    expect((fetchMock.mock.calls.at(-1)![1] as RequestInit).method).toBe("DELETE");
  });

  it("does not delete when the confirm is dismissed", async () => {
    vi.mocked(window.confirm).mockReturnValue(false);
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-delete"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("toasts and does not call onChanged when the sync request fails", async () => {
    fetchMock.mockResolvedValue(res({ error: "queue unavailable" }, false, 500));
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-sync"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("toasts and does not call onChanged when the save request fails", async () => {
    fetchMock.mockResolvedValue(res({ error: "validation failed" }, false, 500));
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(onChanged).not.toHaveBeenCalled();
  });

  it("toasts and does not call onChanged when the delete request fails", async () => {
    fetchMock.mockResolvedValue(res({ error: "in use" }, false, 500));
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-delete"));
    await waitFor(() => expect(fetchMock).toHaveBeenCalled());
    expect(toastMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
    expect(onChanged).not.toHaveBeenCalled();
  });
});
