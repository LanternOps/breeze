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

  // D9: the test route persists status (e.g. reauth_required) right away, but
  // the card was never told to refetch — it kept showing "Active" until a full
  // page reload. Test must tell the parent to refetch on BOTH outcomes so the
  // badge/reauth banner reflect reality immediately.
  it("tells the parent to refetch after a successful test", async () => {
    fetchMock.mockResolvedValue(res({ success: true, rootName: "OliveTech", customerCount: 12 }));
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);

    fireEvent.click(screen.getByTestId("backup-connection-test"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
  });

  it("tells the parent to refetch after a failed test so the reauth state shows immediately", async () => {
    fetchMock.mockResolvedValue(res({ success: false, error: "Cove login was rejected", reauth: true }));
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);

    fireEvent.click(screen.getByTestId("backup-connection-test"));

    await waitFor(() => expect(onChanged).toHaveBeenCalled());
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

  it("lets a healthy connection open the credential form proactively", () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    expect(screen.queryByTestId("backup-connection-password")).toBeNull();
    fireEvent.click(screen.getByTestId("backup-connection-rotate"));
    expect(screen.getByTestId("backup-connection-password")).toBeInTheDocument();
    expect(screen.queryByTestId("backup-connection-rotate")).toBeNull();
  });

  it("lets a healthy connection cancel a half-typed rotation, clearing the fields", () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-rotate"));
    fireEvent.change(screen.getByTestId("backup-connection-username"), { target: { value: "x" } });
    fireEvent.click(screen.getByTestId("backup-connection-rotate-cancel"));
    expect(screen.queryByTestId("backup-connection-username")).toBeNull();
    fireEvent.click(screen.getByTestId("backup-connection-rotate"));
    expect(screen.getByTestId("backup-connection-username")).toHaveValue("");
  });

  it("does not render the proactive rotate button on a reauth_required connection", () => {
    render(<BackupProviderConnectionCard connection={connection({ status: "reauth_required" })} onChanged={onChanged} onTestResult={onTestResult} />);
    expect(screen.queryByTestId("backup-connection-rotate")).toBeNull();
  });

  it("blocks a Cove rotation that has a new username but a blank password, and never PATCHes it", () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-rotate"));
    fireEvent.change(screen.getByTestId("backup-connection-username"), { target: { value: "new-user" } });
    expect(screen.getByTestId("backup-connection-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("PATCHes the full Cove credential set once partner, username and token are all entered", async () => {
    render(<BackupProviderConnectionCard connection={connection()} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-rotate"));
    fireEvent.change(screen.getByTestId("backup-connection-partner-name"), { target: { value: "Acme" } });
    fireEvent.change(screen.getByTestId("backup-connection-username"), { target: { value: "new-user" } });
    fireEvent.change(screen.getByTestId("backup-connection-password"), { target: { value: "tok" } });
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(JSON.parse((fetchMock.mock.calls.at(-1)![1] as RequestInit).body as string).credentials).toEqual({
      partnerName: "Acme", username: "new-user", password: "tok",
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

  it("does not let browser autofill offer the operator's own login for the edit-credentials username/password (D12 follow-up)", () => {
    render(
      <BackupProviderConnectionCard connection={connection({ status: "reauth_required" })} onChanged={onChanged} onTestResult={onTestResult} />,
    );
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    expect(screen.getByTestId("backup-connection-username")).toHaveAttribute("autoComplete", "off");
    expect(screen.getByTestId("backup-connection-password")).toHaveAttribute("autoComplete", "new-password");
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

describe("Dropsuite card", () => {
  function renderCard() {
    render(<BackupProviderConnectionCard connection={connection({ provider: "dropsuite", status: "reauth_required" })} onChanged={onChanged} onTestResult={onTestResult} />);
  }

  it("labels its provider and workloads without device-link counters", () => {
    renderCard();
    expect(screen.getByTestId("backup-connection-provider")).toHaveTextContent("NinjaOne SaaS Backup (Dropsuite)");
    expect(screen.getByTestId("backup-connection-devices")).toHaveTextContent("Workloads");
    expect(screen.getByTestId("backup-connection-customers")).toHaveTextContent("Customers");
    expect(screen.getByTestId("backup-connection-unmapped-devices")).toHaveTextContent("Unmapped workloads");
    expect(screen.queryByTestId("backup-connection-linked")).toBeNull();
    expect(screen.queryByTestId("backup-connection-ambiguous")).toBeNull();
  });

  it("PATCHes both masked token fields and clears them after saving", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    expect(screen.queryByTestId("backup-connection-password")).toBeNull();
    for (const field of ["reseller-token", "auth-token"]) {
      expect(screen.getByTestId(`backup-connection-${field}`)).toHaveAttribute("type", "password");
      expect(screen.getByTestId(`backup-connection-${field}`)).toHaveAttribute("autoComplete", "new-password");
      fireEvent.change(screen.getByTestId(`backup-connection-${field}`), { target: { value: field } });
    }
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string).credentials).toEqual({ resellerToken: "reseller-token", authToken: "auth-token" });
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    expect(screen.getByTestId("backup-connection-auth-token")).toHaveValue("");
    expect(screen.getByTestId("backup-connection-reseller-token")).toHaveValue("");
  });

  it("keeps stored credentials when both tokens are blank and requires a complete replacement", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    expect(screen.getByTestId("backup-connection-auth-token")).toHaveValue("");
    fireEvent.change(screen.getByTestId("backup-connection-auth-token"), { target: { value: "new-token" } });
    expect(screen.getByTestId("backup-connection-save")).toBeDisabled();
    fireEvent.change(screen.getByTestId("backup-connection-auth-token"), { target: { value: "" } });
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string)).not.toHaveProperty("credentials");
  });

  it("treats whitespace in one token as blank when deciding the replacement is incomplete", () => {
    renderCard();
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    fireEvent.change(screen.getByTestId("backup-connection-reseller-token"), { target: { value: " " } });
    fireEvent.change(screen.getByTestId("backup-connection-auth-token"), { target: { value: "new-token" } });
    expect(screen.getByTestId("backup-connection-save")).toBeDisabled();
  });

  it("shows the Dropsuite re-entry help and uses the workloads delete copy", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    expect(screen.getByText("Leave both tokens blank to keep the stored credentials, or enter both to replace them.")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("backup-connection-delete"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain("synced workloads");
  });
});

describe("Cove rotate semantics", () => {
  function renderCard(provider = "cove") {
    render(<BackupProviderConnectionCard connection={connection({ provider, status: "reauth_required" })} onChanged={onChanged} onTestResult={onTestResult} />);
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
  }
  const type = (field: string, value: string) => fireEvent.change(screen.getByTestId(`backup-connection-${field}`), { target: { value } });
  const lastBody = () => fetchMock.mock.calls.at(-1)![1]!.body as string;

  it("posts all three fields in order, trimming identity and not the password", async () => {
    renderCard();
    type("partner-name", " OliveTech ");
    type("username", " breeze-ro ");
    type("password", " s3cret ");
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(lastBody()).toBe('{"name":"OliveTech Cove","isActive":true,"showProviderNameInPortal":false,"credentials":{"partnerName":"OliveTech","username":"breeze-ro","password":" s3cret "}}');
  });

  it("refuses to save when the username is filled and the password blank, rather than dropping the username", () => {
    renderCard();
    type("username", "someone-else");
    expect(screen.getByTestId("backup-connection-save")).toBeDisabled();
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("keeps the stored credential on a whitespace-only password", async () => {
    renderCard();
    type("password", "   ");
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(JSON.parse(lastBody())).not.toHaveProperty("credentials");
  });

  it("keeps Save enabled while every credential field is blank (keeps the stored set)", () => {
    renderCard();
    expect(screen.getByTestId("backup-connection-save")).not.toBeDisabled();
  });

  it("clears the password after saving and keeps the partner name and username", async () => {
    renderCard();
    type("partner-name", "OliveTech");
    type("username", "breeze-ro");
    type("password", "s3cret");
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(screen.queryByTestId("backup-connection-password")).toBeNull();
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    expect(screen.getByTestId("backup-connection-password")).toHaveValue("");
    expect(screen.getByTestId("backup-connection-partner-name")).toHaveValue("OliveTech");
    expect(screen.getByTestId("backup-connection-username")).toHaveValue("breeze-ro");
  });

  it("toggles the password between masked and plain", () => {
    renderCard();
    expect(screen.getByTestId("backup-connection-password")).toHaveAttribute("type", "password");
    fireEvent.click(screen.getByTestId("backup-connection-password-toggle"));
    expect(screen.getByTestId("backup-connection-password")).toHaveAttribute("type", "text");
  });

  it("renders the Cove form for an unknown provider, matching the old fallthrough", () => {
    renderCard("not-a-provider");
    expect(screen.getByTestId("backup-connection-password")).toBeInTheDocument();
    expect(screen.getByTestId("backup-connection-linked")).toBeInTheDocument();
  });
});

describe("Axcient card", () => {
  function renderCard(o: Partial<BackupProviderConnection> = {}) {
    render(
      <BackupProviderConnectionCard
        connection={connection({ provider: "axcient", name: "Main Axcient", baseUrl: "https://axapi.axcient.com/x360recover", status: "reauth_required", ...o })}
        onChanged={onChanged}
        onTestResult={onTestResult}
      />,
    );
  }

  it("rotates an Axcient key with apiKey only", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    fireEvent.change(screen.getByTestId("backup-connection-api-key"), { target: { value: " new " } });
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    const body = JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string);
    expect(body.credentials).toEqual({ apiKey: "new" });
    expect(body.credentials).not.toHaveProperty("partnerName");
    expect(body.credentials).not.toHaveProperty("username");
    expect(body.credentials).not.toHaveProperty("password");
  });

  it("keeps the stored Axcient key when the field is blank", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    expect(screen.getByTestId("backup-connection-api-key")).toHaveValue("");
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(JSON.parse(fetchMock.mock.calls.at(-1)![1]!.body as string)).not.toHaveProperty("credentials");
  });

  it("labels an Axcient card with device-link counters (endpoint inventory)", () => {
    renderCard();
    expect(screen.getByTestId("backup-connection-provider")).toHaveTextContent("Axcient x360Recover");
    expect(screen.getByTestId("backup-connection-linked")).toBeInTheDocument();
    expect(screen.getByTestId("backup-connection-ambiguous")).toBeInTheDocument();
    expect(screen.getByTestId("backup-connection-devices")).toHaveTextContent("Devices");
    expect(screen.getByTestId("backup-connection-unmapped-devices")).toHaveTextContent("Unmapped devices");
  });

  it("renders a masked key field with its re-entry help, and no Cove or Dropsuite fields", () => {
    renderCard();
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    expect(screen.getByTestId("backup-connection-api-key")).toHaveAttribute("type", "password");
    expect(screen.getByTestId("backup-connection-api-key")).toHaveAttribute("autoComplete", "new-password");
    expect(screen.getByText("Leave the API key blank to keep the stored key, or enter a new one to replace it.")).toBeInTheDocument();
    for (const absent of ["partner-name", "username", "password", "password-toggle", "reseller-token", "auth-token"]) {
      expect(screen.queryByTestId(`backup-connection-${absent}`)).toBeNull();
    }
  });

  it("clears the key after saving", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    fireEvent.change(screen.getByTestId("backup-connection-api-key"), { target: { value: "new" } });
    fireEvent.click(screen.getByTestId("backup-connection-save"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    fireEvent.click(screen.getByTestId("backup-connection-reauth"));
    expect(screen.getByTestId("backup-connection-api-key")).toHaveValue("");
  });

  it("uses the device delete copy", async () => {
    renderCard();
    fireEvent.click(screen.getByTestId("backup-connection-delete"));
    await waitFor(() => expect(onChanged).toHaveBeenCalled());
    expect(vi.mocked(window.confirm).mock.calls[0]![0]).toContain("synced devices");
  });
});
