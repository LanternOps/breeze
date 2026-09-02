import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const fetchWithAuth = vi.fn();
const showToast = vi.fn();
const navigateTo = vi.fn();
let scope: "system" | "partner" | "organization" | null = "partner";
// Finding D: the pull-payments switch and the push-mode row are the same
// authority the invoice-push routes require, so both hide without invoices:write.
let canWriteInvoices = true;

vi.mock("../../stores/auth", () => ({
  fetchWithAuth: (...args: unknown[]) => fetchWithAuth(...args),
}));
vi.mock("../shared/Toast", () => ({
  showToast: (...args: unknown[]) => showToast(...args),
}));
vi.mock("@/lib/navigation", () => ({
  navigateTo: (...args: unknown[]) => navigateTo(...args),
}));
vi.mock("../../lib/permissions", () => ({
  usePermissions: () => ({
    permissions: [],
    can: (resource: string, action: string) =>
      resource === "invoices" && action === "write" ? canWriteInvoices : true,
  }),
}));
vi.mock("../../lib/authScope", () => ({
  loginPathWithNext: () => "/login?next=/integrations",
  getJwtClaims: () => ({ scope, orgId: null, partnerId: "partner-1" }),
}));

import QuickbooksIntegration from "./QuickbooksIntegration";
import { formatDateTime } from "@/lib/dateTimeFormat";

const jsonResponse = (payload: unknown, status = 200): Response =>
  ({
    ok: status >= 200 && status < 300,
    status,
    statusText: status >= 200 && status < 300 ? "OK" : "Error",
    json: vi.fn().mockResolvedValue(payload),
  }) as unknown as Response;

const disconnected = {
  status: "disconnected",
  environment: null,
  pushMode: "auto",
  connectedAt: null,
  lastError: null,
};
const connected = {
  status: "connected",
  environment: "production",
  pushMode: "auto",
  connectedAt: "2026-06-23T00:00:00Z",
  lastError: null,
  // Phase D: GET /accounting/quickbooks carries the reconcile-worker settings
  // and status on BOTH branches (connected and disconnected).
  pullPayments: true,
  lastReconcileAt: null,
};

describe("QuickbooksIntegration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope = "partner";
    canWriteInvoices = true;
    window.history.replaceState({}, "", "/integrations");
  });

  it("renders the not-connected state with a Connect button", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") return jsonResponse(disconnected);
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    expect(
      await screen.findByTestId("quickbooks-status-disconnected"),
    ).toBeTruthy();
    expect(screen.getByTestId("quickbooks-connect")).toBeTruthy();
    expect(screen.queryByTestId("quickbooks-disconnect")).toBeNull();
  });

  it("renders the connected state with disconnect and push-mode controls", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") return jsonResponse(connected);
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    expect(
      await screen.findByTestId("quickbooks-status-connected"),
    ).toBeTruthy();
    expect(screen.getByTestId("quickbooks-disconnect")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-pushmode-auto")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-pushmode-manual")).toBeTruthy();
  });

  it("switching push mode PATCHes the settings endpoint", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url === "/accounting/quickbooks/settings" &&
          init?.method === "PATCH"
        ) {
          return jsonResponse({ ...connected, pushMode: "manual" });
        }
        if (url === "/accounting/quickbooks") return jsonResponse(connected);
        return jsonResponse({}, 404);
      },
    );

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-pushmode-manual"));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/settings",
        expect.objectContaining({ method: "PATCH" }),
      ),
    );
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("Connect requests an authUrl from the connect endpoint", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") return jsonResponse(disconnected);
      if (url === "/accounting/quickbooks/connect") {
        return jsonResponse({
          authUrl: "https://appcenter.intuit.com/connect/oauth2?state=x",
        });
      }
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-connect"));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/connect",
      ),
    );
  });

  it("renders the reauth-required state with a Reconnect CTA and last error", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") {
        return jsonResponse({
          status: "reauth_required",
          environment: "production",
          pushMode: "auto",
          connectedAt: "2026-06-23T00:00:00Z",
          lastError: "refresh token expired",
        });
      }
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    expect(await screen.findByTestId("quickbooks-status-reauth")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-last-error")).toHaveTextContent(
      "refresh token expired",
    );
    expect(screen.getByTestId("quickbooks-connect")).toHaveTextContent(
      "Reconnect",
    );
    expect(screen.queryByTestId("quickbooks-disconnect")).toBeNull();
  });

  it("shows a partner-scope-only message for org-scope users and never calls the API", async () => {
    scope = "organization";

    render(<QuickbooksIntegration />);

    expect(await screen.findByTestId("quickbooks-org-scope")).toBeTruthy();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("renders the home currency and an unknown multi-currency line before a refresh", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks")
        return jsonResponse({ ...connected, homeCurrency: "USD" });
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    expect(await screen.findByTestId("quickbooks-home-currency")).toHaveTextContent("USD");
    // GET /accounting/quickbooks does not carry the realm flag — it is only
    // learned from a settings refresh, so "unknown" is the honest initial read.
    expect(screen.getByTestId("quickbooks-multi-currency")).toHaveTextContent("Unknown");
  });

  it("Refresh settings POSTs the refresh route and re-renders currency + multi-currency", async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/accounting/quickbooks/settings/refresh" && init?.method === "POST") {
        return jsonResponse({ homeCurrency: "GBP", multiCurrencyEnabled: true });
      }
      if (url === "/accounting/quickbooks")
        return jsonResponse({ ...connected, homeCurrency: "USD" });
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-settings-refresh"));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/settings/refresh",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    await waitFor(() =>
      expect(screen.getByTestId("quickbooks-home-currency")).toHaveTextContent("GBP"),
    );
    expect(screen.getByTestId("quickbooks-multi-currency")).toHaveTextContent("Yes");
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("renders a multi-currency No when the realm reports the feature off", async () => {
    fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/accounting/quickbooks/settings/refresh" && init?.method === "POST") {
        return jsonResponse({ homeCurrency: "USD", multiCurrencyEnabled: false });
      }
      if (url === "/accounting/quickbooks") return jsonResponse(connected);
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-settings-refresh"));

    await waitFor(() =>
      expect(screen.getByTestId("quickbooks-multi-currency")).toHaveTextContent("No"),
    );
  });
});

// ─── Phase D: payment pull-back controls ────────────────────────────────────
describe("QuickbooksIntegration — payment pull-back (Phase D)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope = "partner";
    canWriteInvoices = true;
    window.history.replaceState({}, "", "/integrations");
  });

  it("renders the pull-payments switch from status and PATCHes { pullPayments: false } when turned off", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url === "/accounting/quickbooks/settings" &&
          init?.method === "PATCH"
        ) {
          return jsonResponse({ ...connected, pullPayments: false });
        }
        if (url === "/accounting/quickbooks") return jsonResponse(connected);
        return jsonResponse({}, 404);
      },
    );

    render(<QuickbooksIntegration />);

    const toggle = await screen.findByTestId("quickbooks-pullpayments");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ pullPayments: false }),
        }),
      ),
    );
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("quickbooks-pullpayments").getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });

  it("toasts an error and leaves the switch on when the PATCH fails", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url === "/accounting/quickbooks/settings" &&
          init?.method === "PATCH"
        ) {
          return jsonResponse({ error: "boom" }, 500);
        }
        if (url === "/accounting/quickbooks") return jsonResponse(connected);
        return jsonResponse({}, 404);
      },
    );

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-pullpayments"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      ),
    );
    // The switch is driven by the SERVER-confirmed value, so a rejected PATCH
    // leaves it reading the setting QuickBooks actually still has.
    expect(
      screen.getByTestId("quickbooks-pullpayments").getAttribute("aria-checked"),
    ).toBe("true");
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("renders Never for a connection that has never reconciled", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") return jsonResponse(connected);
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    expect(
      await screen.findByTestId("quickbooks-last-reconcile"),
    ).toHaveTextContent("Never");
  });

  it("renders the formatted timestamp once a reconcile has run", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") {
        return jsonResponse({
          ...connected,
          lastReconcileAt: "2026-09-01T10:00:00Z",
        });
      }
      return jsonResponse({}, 404);
    });

    render(<QuickbooksIntegration />);

    const line = await screen.findByTestId("quickbooks-last-reconcile");
    expect(line).toHaveTextContent(formatDateTime("2026-09-01T10:00:00Z"));
    expect(line).not.toHaveTextContent("Never");
  });

  it("Sync now POSTs the reconcile route and reports a queued job as a success", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url === "/accounting/quickbooks/reconcile" &&
          init?.method === "POST"
        ) {
          return jsonResponse({ enqueued: true });
        }
        if (url === "/accounting/quickbooks") return jsonResponse(connected);
        return jsonResponse({}, 404);
      },
    );

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-reconcile-now"));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/reconcile",
        expect.objectContaining({ method: "POST" }),
      ),
    );
    expect(showToast).toHaveBeenCalledWith({
      type: "success",
      message: "Payment sync queued.",
    });
  });

  it("never reports { enqueued: false } as a success — the queue refused the job", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url === "/accounting/quickbooks/reconcile" &&
          init?.method === "POST"
        ) {
          // 200 with enqueued:false — Redis was down, or the jobId was still
          // held. The route answers honestly; the UI must not launder that
          // into "queued".
          return jsonResponse({ enqueued: false });
        }
        if (url === "/accounting/quickbooks") return jsonResponse(connected);
        return jsonResponse({}, 404);
      },
    );

    render(<QuickbooksIntegration />);
    fireEvent.click(await screen.findByTestId("quickbooks-reconcile-now"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        type: "warning",
        message: "Payment sync could not be queued. Try again shortly.",
      }),
    );
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("hides the pull-payments switch and the push-mode row without invoices:write", async () => {
    canWriteInvoices = false;
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === "/accounting/quickbooks" ? jsonResponse(connected) : jsonResponse({}, 404),
    );

    render(<QuickbooksIntegration />);

    // The panel still renders — this is a control-level gate, not a page gate.
    expect(await screen.findByTestId("quickbooks-environment")).toBeTruthy();
    expect(screen.queryByTestId("quickbooks-pullpayments")).toBeNull();
    expect(screen.queryByTestId("quickbooks-pushmode")).toBeNull();
    expect(screen.queryByTestId("quickbooks-pushmode-manual")).toBeNull();
  });

  it("shows both controls again when invoices:write is granted", async () => {
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === "/accounting/quickbooks" ? jsonResponse(connected) : jsonResponse({}, 404),
    );

    render(<QuickbooksIntegration />);

    expect(await screen.findByTestId("quickbooks-pullpayments")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-pushmode")).toBeTruthy();
  });

  it("renders none of the pull-back controls for an org-scoped user", async () => {
    scope = "organization";

    render(<QuickbooksIntegration />);

    expect(await screen.findByTestId("quickbooks-org-scope")).toBeTruthy();
    expect(screen.queryByTestId("quickbooks-pullpayments")).toBeNull();
    expect(screen.queryByTestId("quickbooks-last-reconcile")).toBeNull();
    expect(screen.queryByTestId("quickbooks-reconcile-now")).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});
