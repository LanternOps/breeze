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

import AccountingConnectionPanel from "./AccountingConnectionPanel";
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

describe("AccountingConnectionPanel", () => {
it('mounts the fee form in the connected accounting card',async()=>{
  fetchWithAuth.mockImplementation(async(url:string)=>url==='/accounting/quickbooks'
    ?jsonResponse({...connected,autopayEnabled:true,feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null,feeAccountingErrorCount:1})
    :jsonResponse({data:[],count:0}));
  render(<AccountingConnectionPanel provider="quickbooks"/>);
  expect(await screen.findByTestId('autopay-accounting-fees')).toBeInTheDocument();
  expect(screen.getByTestId('autopay-accounting-fee-ref')).toHaveValue('fee-item');
  expect(screen.getByTestId('autopay-accounting-fee-attention')).toBeInTheDocument();
});

it('hides fee configuration with rollout off but retains ordinary settings and debt attention',async()=>{
  fetchWithAuth.mockImplementation(async(url:string)=>url==='/accounting/quickbooks'
    ?jsonResponse({...connected,autopayEnabled:false,feeIncomeItemRef:'fee-item',feeIncomeAccountRef:null,feeAccountingErrorCount:1})
    :jsonResponse({data:[],count:0}));
  render(<AccountingConnectionPanel provider="quickbooks"/>);
  expect(await screen.findByTestId('autopay-accounting-fee-attention')).toBeInTheDocument();
  expect(screen.queryByTestId('autopay-accounting-fees')).toBeNull();
  expect(screen.queryByTestId('autopay-accounting-fee-ref')).toBeNull();
  expect(screen.queryByTestId('autopay-accounting-fee-save')).toBeNull();
  expect(screen.getByTestId('quickbooks-pushmode-manual')).toBeInTheDocument();
});

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

    render(<AccountingConnectionPanel provider="quickbooks" />);

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

    render(<AccountingConnectionPanel provider="quickbooks" />);

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

    render(<AccountingConnectionPanel provider="quickbooks" />);
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

    render(<AccountingConnectionPanel provider="quickbooks" />);
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

    render(<AccountingConnectionPanel provider="quickbooks" />);

    expect(await screen.findByTestId("quickbooks-status-reauth")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-last-error")).toHaveTextContent(
      "refresh token expired",
    );
    expect(screen.getByTestId("quickbooks-connect")).toHaveTextContent(
      "Reconnect",
    );
    // The instance may no longer have this provider configured, in which
    // case Reconnect can never succeed — Disconnect must stay available so
    // the partner can switch providers instead of getting stuck (#7183-ish).
    expect(screen.getByTestId("quickbooks-disconnect")).toBeTruthy();
  });

  it("reauth-required Disconnect calls the disconnect endpoint", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (url === "/accounting/quickbooks" && init?.method !== "POST") {
          return jsonResponse({
            status: "reauth_required",
            environment: "production",
            pushMode: "auto",
            connectedAt: "2026-06-23T00:00:00Z",
            lastError: "refresh token expired",
          });
        }
        if (
          url === "/accounting/quickbooks/disconnect" &&
          init?.method === "POST"
        ) {
          return jsonResponse({});
        }
        return jsonResponse({}, 404);
      },
    );

    render(<AccountingConnectionPanel provider="quickbooks" />);
    fireEvent.click(await screen.findByTestId("quickbooks-disconnect"));

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/disconnect",
        expect.objectContaining({ method: "POST" }),
      ),
    );
  });

  it("shows a partner-scope-only message for org-scope users and never calls the API", async () => {
    scope = "organization";

    render(<AccountingConnectionPanel provider="quickbooks" />);

    expect(await screen.findByTestId("quickbooks-org-scope")).toBeTruthy();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });

  it("renders the home currency and an unknown multi-currency line before a refresh", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks")
        return jsonResponse({ ...connected, homeCurrency: "USD" });
      return jsonResponse({}, 404);
    });

    render(<AccountingConnectionPanel provider="quickbooks" />);

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

    render(<AccountingConnectionPanel provider="quickbooks" />);
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

    render(<AccountingConnectionPanel provider="quickbooks" />);
    fireEvent.click(await screen.findByTestId("quickbooks-settings-refresh"));

    await waitFor(() =>
      expect(screen.getByTestId("quickbooks-multi-currency")).toHaveTextContent("No"),
    );
  });

  it("calls the provider-scoped API for its provider prop", async () => {
    fetchWithAuth.mockImplementation(async (url: string) =>
      jsonResponse(url === "/accounting/quickbooks" ? disconnected : { count: 0, data: [] }));
    render(<AccountingConnectionPanel provider="quickbooks" />);
    await waitFor(() => expect(fetchWithAuth).toHaveBeenCalledWith("/accounting/quickbooks"));
  });

  it("toasts success on the OAuth return for its own provider and strips the params", async () => {
    window.history.replaceState({}, "", "/integrations?accounting=quickbooks&connected=1#accounting");
    fetchWithAuth.mockImplementation(async (url: string) =>
      jsonResponse(url === "/accounting/quickbooks" ? connected : { count: 0, data: [] }));
    render(<AccountingConnectionPanel provider="quickbooks" />);
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({ type: "success", message: "QuickBooks connected." }),
    );
    expect(window.location.search).toBe("");
    expect(window.location.hash).toBe("#accounting");
  });

  // Ruling R5: the callback reports a one-provider-per-partner conflict as
  // `error=provider_conflict`; the panel names it instead of the generic
  // "connection failed", which would send the operator to retry a connect
  // that can only fail again.
  it("toasts the specific provider-conflict error on the OAuth return", async () => {
    window.history.replaceState({}, "", "/integrations?accounting=quickbooks&error=provider_conflict#accounting");
    fetchWithAuth.mockImplementation(async (url: string) =>
      jsonResponse(url === "/accounting/quickbooks" ? disconnected : { count: 0, data: [] }));
    render(<AccountingConnectionPanel provider="quickbooks" />);
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        type: "error",
        message:
          "Another accounting system is already connected for this partner. Disconnect it before connecting QuickBooks.",
      }),
    );
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ message: "QuickBooks connection failed. Please try again." }),
    );
    expect(window.location.search).toBe("");
  });

  it.each(["exchange_failed", "persist_failed"])(
    "keeps the generic connection-failed toast for error=%s",
    async (error) => {
      window.history.replaceState({}, "", `/integrations?accounting=quickbooks&error=${error}#accounting`);
      fetchWithAuth.mockImplementation(async (url: string) =>
      jsonResponse(url === "/accounting/quickbooks" ? disconnected : { count: 0, data: [] }));
      render(<AccountingConnectionPanel provider="quickbooks" />);
      await waitFor(() =>
        expect(showToast).toHaveBeenCalledWith({
          type: "error",
          message: "QuickBooks connection failed. Please try again.",
        }),
      );
    },
  );

  it("ignores an OAuth return addressed to a different provider", async () => {
    window.history.replaceState({}, "", "/integrations?accounting=xero&error=provider_conflict#accounting");
    fetchWithAuth.mockImplementation(async (url: string) =>
      jsonResponse(url === "/accounting/quickbooks" ? disconnected : { count: 0, data: [] }));
    render(<AccountingConnectionPanel provider="quickbooks" />);
    await screen.findByTestId("quickbooks-connect");
    expect(showToast).not.toHaveBeenCalled();
    expect(window.location.search).toBe("?accounting=xero&error=provider_conflict");
  });

  it("toasts a warning to pick a Xero organisation on ?select_tenant=1 and strips the query params", async () => {
    window.history.replaceState({}, "", "/integrations?accounting=xero&select_tenant=1#xero");
    fetchWithAuth.mockImplementation(async (url: string) =>
      jsonResponse(url === "/accounting/xero" ? { ...disconnected, status: "pending_tenant" } : { count: 0, data: [] }));
    render(<AccountingConnectionPanel provider="xero" />);
    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        type: "warning",
        message: "Choose which Xero organisation to connect.",
      }),
    );
    expect(window.location.search).toBe("");
  });
});

// ─── Phase D: payment pull-back controls ────────────────────────────────────
describe("AccountingConnectionPanel — payment pull-back (Phase D)", () => {
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

    render(<AccountingConnectionPanel provider="quickbooks" />);

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

    render(<AccountingConnectionPanel provider="quickbooks" />);
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

    render(<AccountingConnectionPanel provider="quickbooks" />);

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

    render(<AccountingConnectionPanel provider="quickbooks" />);

    const line = await screen.findByTestId("quickbooks-last-reconcile");
    expect(line).toHaveTextContent(formatDateTime("2026-09-01T10:00:00Z"));
    expect(line).not.toHaveTextContent("Never");
  });

  // Issue #4543 (silent-failure-hunter review finding): the reconcile worker
  // stamps a skip/failure reason onto `last_error` even while `status` stays
  // "connected" — e.g. the 15-minute sweep racing a pull_payments toggle-off.
  // Before this test (and the render it pins down) that stamp was DB-only:
  // the connected-state card read `lastReconcileAt` but never `lastError`.
  it("renders last_error on the connected-state card (not just the reauth banner)", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") {
        return jsonResponse({
          ...connected,
          lastError: "Payment pull: run skipped — disabled for this connection",
        });
      }
      return jsonResponse({}, 404);
    });

    render(<AccountingConnectionPanel provider="quickbooks" />);

    expect(
      await screen.findByTestId("quickbooks-reconcile-last-error"),
    ).toHaveTextContent("disabled for this connection");
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

    render(<AccountingConnectionPanel provider="quickbooks" />);
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

    render(<AccountingConnectionPanel provider="quickbooks" />);
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

  it("issue #4543 — shows the switched-off reason (not a generic failure) on a 409 payment_sync_disabled reconcile response", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url === "/accounting/quickbooks/reconcile" &&
          init?.method === "POST"
        ) {
          return jsonResponse(
            { error: "Payment sync is disabled for this connection", code: "payment_sync_disabled" },
            409,
          );
        }
        if (url === "/accounting/quickbooks") return jsonResponse(connected);
        return jsonResponse({}, 404);
      },
    );

    render(<AccountingConnectionPanel provider="quickbooks" />);
    fireEvent.click(await screen.findByTestId("quickbooks-reconcile-now"));

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith({
        type: "error",
        // Names BOTH switches: the reconcile pass runs when EITHER is on
        // (Phase D2 widened the gate), so telling the operator to turn on
        // "Payment sync" alone described a rule that no longer exists.
        message: "Payment sync is turned off for this connection — turn on Payment sync or Payment push to sync now.",
      }),
    );
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "warning" }),
    );
  });

  it("hides the pull-payments switch and the push-mode row without invoices:write", async () => {
    canWriteInvoices = false;
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === "/accounting/quickbooks" ? jsonResponse(connected) : jsonResponse({}, 404),
    );

    render(<AccountingConnectionPanel provider="quickbooks" />);

    // The panel still renders — this is a control-level gate, not a page gate.
    expect(await screen.findByTestId("quickbooks-environment")).toBeTruthy();
    expect(screen.queryByTestId("quickbooks-pullpayments")).toBeNull();
    expect(screen.queryByTestId("quickbooks-pushmode")).toBeNull();
    expect(screen.queryByTestId("quickbooks-pushmode-manual")).toBeNull();
    // The route 403s without invoices:write (finding: "Sync now" was gated
    // server-side but not hidden client-side like the two switches above).
    expect(screen.queryByTestId("quickbooks-reconcile-now")).toBeNull();
  });

  it("shows both controls again when invoices:write is granted", async () => {
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === "/accounting/quickbooks" ? jsonResponse(connected) : jsonResponse({}, 404),
    );

    render(<AccountingConnectionPanel provider="quickbooks" />);

    expect(await screen.findByTestId("quickbooks-pullpayments")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-pushmode")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-reconcile-now")).toBeTruthy();
  });

  it("renders none of the pull-back controls for an org-scoped user", async () => {
    scope = "organization";

    render(<AccountingConnectionPanel provider="quickbooks" />);

    expect(await screen.findByTestId("quickbooks-org-scope")).toBeTruthy();
    expect(screen.queryByTestId("quickbooks-pullpayments")).toBeNull();
    expect(screen.queryByTestId("quickbooks-last-reconcile")).toBeNull();
    expect(screen.queryByTestId("quickbooks-reconcile-now")).toBeNull();
    expect(fetchWithAuth).not.toHaveBeenCalled();
  });
});

describe("AccountingConnectionPanel — payment push (Phase D2)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope = "partner";
    canWriteInvoices = true;
    window.history.replaceState({}, "", "/integrations");
  });

  it("renders the push-payments switch from status and PATCHes { pushPayments: false } when turned off", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url === "/accounting/quickbooks/settings" &&
          init?.method === "PATCH"
        ) {
          return jsonResponse({ ...connected, pushPayments: false });
        }
        if (url === "/accounting/quickbooks")
          return jsonResponse({ ...connected, pushPayments: true });
        return jsonResponse({}, 404);
      },
    );

    render(<AccountingConnectionPanel provider="quickbooks" />);

    const toggle = await screen.findByTestId("quickbooks-pushpayments");
    expect(toggle.getAttribute("aria-checked")).toBe("true");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(fetchWithAuth).toHaveBeenCalledWith(
        "/accounting/quickbooks/settings",
        expect.objectContaining({
          method: "PATCH",
          body: JSON.stringify({ pushPayments: false }),
        }),
      ),
    );
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
    await waitFor(() =>
      expect(
        screen.getByTestId("quickbooks-pushpayments").getAttribute("aria-checked"),
      ).toBe("false"),
    );
  });

  it("reverts the switch and toasts on a failed PATCH — it never renders optimistically", async () => {
    fetchWithAuth.mockImplementation(
      async (url: string, init?: RequestInit) => {
        if (
          url === "/accounting/quickbooks/settings" &&
          init?.method === "PATCH"
        ) {
          return jsonResponse({ error: "nope" }, 500);
        }
        if (url === "/accounting/quickbooks")
          return jsonResponse({ ...connected, pushPayments: true });
        return jsonResponse({}, 404);
      },
    );

    render(<AccountingConnectionPanel provider="quickbooks" />);
    const toggle = await screen.findByTestId("quickbooks-pushpayments");
    fireEvent.click(toggle);

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      ),
    );
    // The switch is driven by the SERVER-confirmed value, so a rejected PATCH
    // leaves it reading the setting QuickBooks actually still has.
    expect(
      screen.getByTestId("quickbooks-pushpayments").getAttribute("aria-checked"),
    ).toBe("true");
    expect(showToast).not.toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("hides the push-payments toggle without invoices:write", async () => {
    canWriteInvoices = false;
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === "/accounting/quickbooks"
        ? jsonResponse({ ...connected, pushPayments: true })
        : jsonResponse({}, 404),
    );

    render(<AccountingConnectionPanel provider="quickbooks" />);

    await screen.findByTestId("quickbooks-environment");
    expect(screen.queryByTestId("quickbooks-pushpayments")).toBeNull();
  });
});


describe("owed QuickBooks operations", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope = "partner";
    window.history.replaceState({}, "", "/integrations");
  });

  it("shows pending deleted payments with error, age, count and invoice link", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/quickbooks") return jsonResponse(connected);
      if (url === "/accounting/quickbooks/owed-operations") return jsonResponse({ count: 2, data: [
        { id: "owed-1", pendingOp: "delete", lastError: "QuickBooks refused deletion", pendingSince: "2026-09-01T00:00:00Z", ageSeconds: 172800, invoiceId: "invoice-1", invoiceNumber: "INV-101" },
        { id: "owed-2", pendingOp: "push", lastError: null, pendingSince: "2026-09-02T00:00:00Z", ageSeconds: 60, invoiceId: null, invoiceNumber: null },
      ] });
      return jsonResponse({}, 404);
    });
    render(<AccountingConnectionPanel provider="quickbooks" />);
    const panel = await screen.findByTestId("quickbooks-owed-operations");
    await waitFor(() => expect(panel.textContent).toContain("QuickBooks refused deletion"));
    expect(panel.textContent).toContain("Pending operations: 2");
    expect(panel.textContent).toContain("Age: 2,880 min");
    expect(panel.textContent).toContain("Delete payment");
    expect(panel.textContent).toContain("Push payment");
    expect(panel.textContent).toContain("Invoice unavailable");
    expect(screen.getByTestId("quickbooks-owed-invoice-owed-1").getAttribute("href")).toBe("/billing/invoices/invoice-1");
    expect(screen.queryByTestId("quickbooks-owed-invoice-owed-2")).toBeNull();
  });

  it("shows an explicit empty state", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => jsonResponse(
      url === "/accounting/quickbooks" ? disconnected : { count: 0, data: [] },
    ));
    render(<AccountingConnectionPanel provider="quickbooks" />);
    await waitFor(() => expect(screen.getByTestId("quickbooks-owed-operations").textContent).toContain("No owed operations"));
  });

  it("shows a load failure instead of reporting no debt", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => url === "/accounting/quickbooks"
      ? jsonResponse(connected) : jsonResponse({}, 500));
    render(<AccountingConnectionPanel provider="quickbooks" />);
    expect(await screen.findByTestId("quickbooks-owed-error")).toBeTruthy();
    expect(screen.getByTestId("quickbooks-owed-operations").textContent).not.toContain("No owed operations");
  });

  it("redirects when the owed operations read is unauthorized", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => url === "/accounting/quickbooks"
      ? jsonResponse(disconnected) : jsonResponse({}, 401));
    render(<AccountingConnectionPanel provider="quickbooks" />);
    await waitFor(() => expect(navigateTo).toHaveBeenCalledWith("/login?next=/integrations"));
  });

  // Xero W01: every moved i18n key's English value carries `{{provider}}`
  // rather than a hardcoded "QuickBooks" — this proves the interpolation
  // actually fires for a SECOND provider, not just the one every other test
  // in this file happens to render.
  it("interpolates the connected provider's name and never leaks a raw {{provider}} token", async () => {
    fetchWithAuth.mockImplementation(async (url: string) => {
      if (url === "/accounting/xero") return jsonResponse(connected);
      return jsonResponse({ count: 0, data: [] });
    });

    const { container } = render(<AccountingConnectionPanel provider="xero" />);

    await screen.findByTestId("xero-status-connected");
    await screen.findByTestId("xero-owed-operations");
    expect(container.textContent).toContain("Xero");
    expect(container.textContent).not.toContain("{{provider}}");
  });

  // R10: the heading must render the full product name for QuickBooks
  // ("QuickBooks Online", not "QuickBooks") and the plain brand name for a
  // provider with no separate product name (Xero) — getByRole pins this to
  // exactly the <h1>, not any other on-page mention of the brand.
  it("renders the QuickBooks heading as exactly \"QuickBooks Online\"", async () => {
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === "/accounting/quickbooks" ? jsonResponse(disconnected) : jsonResponse({ count: 0, data: [] }));

    render(<AccountingConnectionPanel provider="quickbooks" />);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("QuickBooks Online");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("QuickBooks Online");
  });

  it("renders the Xero heading as exactly \"Xero\"", async () => {
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === "/accounting/xero" ? jsonResponse(disconnected) : jsonResponse({ count: 0, data: [] }));

    render(<AccountingConnectionPanel provider="xero" />);

    expect(await screen.findByRole("heading", { level: 1 })).toHaveTextContent("Xero");
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Xero");
  });

  it("renders the QuickBooks connect description with the full product name", async () => {
    fetchWithAuth.mockImplementation(async (url: string) =>
      url === "/accounting/quickbooks" ? jsonResponse(disconnected) : jsonResponse({ count: 0, data: [] }));

    render(<AccountingConnectionPanel provider="quickbooks" />);

    expect(
      await screen.findByText(
        "Connect your QuickBooks Online company to sync customers, invoices, and payments. Breeze stays your system of record.",
      ),
    ).toBeTruthy();
  });
});

// ─── Xero W02: capability gating, tenant picker, branded connect/disconnect,
//     specific OAuth-return errors ───────────────────────────────────────────
function mockStatus(path: string, status: unknown) {
  fetchWithAuth.mockImplementation(async (url: string) => {
    if (url === path) return jsonResponse(status);
    if (url === `${path}/owed-operations`) return jsonResponse({ count: 0, data: [] });
    return jsonResponse({}, 404);
  });
}
function mockJson(path: string, body: unknown, status = 200) {
  const prev = fetchWithAuth.getMockImplementation();
  fetchWithAuth.mockImplementation(async (url: string, init?: RequestInit) => {
    if (url === path) return jsonResponse(body, status);
    return prev ? prev(url, init) : jsonResponse({}, 404);
  });
}
const fetchWithAuthMock = fetchWithAuth;
const showToastMock = showToast;

describe("Xero W02 panel behaviour", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    scope = "partner";
    canWriteInvoices = true;
    window.history.replaceState({}, "", "/integrations");
  });

  const xeroStatus = (over = {}) => ({
    status: "connected", environment: "production", pushMode: "auto", connectedAt: null, lastError: null,
    pullPayments: true, pushPayments: true, lastReconcileAt: null,
    capabilities: { connect: true, mapping: false, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false },
    features: { tenantSelection: true, settingsOptions: false }, ...over,
  });

  it("hides every control whose capability is false (Xero W02: connect only)", async () => {
    mockStatus("/accounting/xero", xeroStatus());
    render(<AccountingConnectionPanel provider="xero" />);
    await screen.findByTestId("xero-disconnect");
    for (const id of [
      "xero-pushmode", "xero-pullpayments", "xero-pushpayments", "xero-reconcile-now", "xero-owed-operations",
      "xero-mapping-workbench", "xero-import-panel",
    ]) {
      expect(screen.queryByTestId(id)).toBeNull();
    }
  });

  it("QuickBooks without a capabilities field (older API) still shows every control", async () => {
    mockStatus("/accounting/quickbooks", connected);
    render(<AccountingConnectionPanel provider="quickbooks" />);
    for (const id of [
      "quickbooks-pushmode", "quickbooks-pullpayments", "quickbooks-pushpayments", "quickbooks-reconcile-now", "quickbooks-owed-operations",
      "quickbooks-mapping-workbench", "quickbooks-import-panel",
    ]) {
      expect(await screen.findByTestId(id)).toBeTruthy();
    }
  });

  it("pending_tenant renders the organisation picker instead of the connect card", async () => {
    mockStatus("/accounting/xero", xeroStatus({ status: "pending_tenant" }));
    mockJson("/accounting/xero/tenants", { data: [{ tenantId: "t-A", name: "Alpha" }], expiresAt: null });
    render(<AccountingConnectionPanel provider="xero" />);
    expect(await screen.findByTestId("xero-tenant-picker")).toBeTruthy();
    expect(screen.queryByTestId("xero-connect")).toBeNull();
  });

  it("shows a pending-tenant status pill", async () => {
    mockStatus("/accounting/xero", xeroStatus({ status: "pending_tenant" }));
    mockJson("/accounting/xero/tenants", { data: [{ tenantId: "t-A", name: "Alpha" }], expiresAt: null });
    render(<AccountingConnectionPanel provider="xero" />);
    expect(await screen.findByTestId("xero-status-pending")).toBeTruthy();
  });

  it("survives loading → loaded without a hook-order error (new state declared before the early returns)", async () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    let resolveStatus!: (r: Response) => void;
    fetchWithAuthMock.mockImplementation((url: string) => url === "/accounting/xero"
      ? new Promise<Response>((r) => { resolveStatus = r; })
      : Promise.resolve(jsonResponse({})));
    render(<AccountingConnectionPanel provider="xero" />);
    expect(screen.getByTestId("xero-loading")).toBeTruthy();
    resolveStatus(jsonResponse(xeroStatus()));
    fireEvent.click(await screen.findByTestId("xero-disconnect"));
    expect(await screen.findByTestId("xero-disconnect-confirm")).toBeTruthy();
    expect(errors.mock.calls.flat().join(" ")).not.toMatch(/Rendered more hooks|change in the order of Hooks/);
    errors.mockRestore();
  });

  it("Xero disconnect asks for confirmation; QuickBooks does not", async () => {
    mockStatus("/accounting/xero", xeroStatus());
    render(<AccountingConnectionPanel provider="xero" />);
    fireEvent.click(await screen.findByTestId("xero-disconnect"));
    expect(await screen.findByTestId("xero-disconnect-confirm")).toBeTruthy();
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith("/accounting/xero/disconnect", expect.anything());
  });

  it("confirming the Xero disconnect dialog calls the disconnect endpoint and onConnectionChanged", async () => {
    const onConnectionChanged = vi.fn();
    fetchWithAuthMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (url === "/accounting/xero/disconnect" && init?.method === "POST") return jsonResponse({});
      if (url === "/accounting/xero") return jsonResponse(disconnected);
      return jsonResponse({ count: 0, data: [] });
    });
    fetchWithAuthMock.mockImplementationOnce(async () => jsonResponse(xeroStatus()));
    render(<AccountingConnectionPanel provider="xero" onConnectionChanged={onConnectionChanged} />);
    fireEvent.click(await screen.findByTestId("xero-disconnect"));
    fireEvent.click(await screen.findByTestId("xero-disconnect-confirm"));
    await waitFor(() => expect(fetchWithAuthMock).toHaveBeenCalledWith(
      "/accounting/xero/disconnect", expect.objectContaining({ method: "POST" }),
    ));
    await waitFor(() => expect(onConnectionChanged).toHaveBeenCalled());
  });

  it.each([
    ["tenant_held", "This Xero organisation is connected to another Breeze account."],
    ["consent_denied", "You cancelled the Xero sign-in. Nothing was connected."],
    ["auth_event_missing", "Xero didn't confirm which organisations you authorised. Please connect again."],
  ])("OAuth return error=%s shows its specific message", async (code, message) => {
    window.history.replaceState({}, "", `/integrations?accounting=xero&error=${code}#xero`);
    mockStatus("/accounting/xero", xeroStatus({ status: "disconnected" }));
    render(<AccountingConnectionPanel provider="xero" />);
    await waitFor(() => expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error", message })));
  });

  // Reconnect copy is gated on features.tenantSelection, never on the
  // provider id — shown for Xero (feature true), absent for QuickBooks
  // (feature false/missing), even though both are reauth_required.
  it("shows the 'reconnect keeps organisation' note for Xero reauth_required with tenantSelection", async () => {
    mockStatus("/accounting/xero", xeroStatus({ status: "reauth_required" }));
    render(<AccountingConnectionPanel provider="xero" />);
    expect(await screen.findByTestId("xero-reconnect-keeps-org")).toBeTruthy();
  });

  it("does not show the 'reconnect keeps organisation' note for QuickBooks reauth_required", async () => {
    mockStatus("/accounting/quickbooks", {
      status: "reauth_required", environment: "production", pushMode: "auto",
      connectedAt: null, lastError: null,
    });
    render(<AccountingConnectionPanel provider="quickbooks" />);
    await screen.findByTestId("quickbooks-connect");
    expect(screen.queryByTestId("quickbooks-reconnect-keeps-org")).toBeNull();
  });

  it("skips the owed-operations fetch when the connection cannot push payments", async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === "/accounting/xero") return jsonResponse(xeroStatus());
      if (url === "/accounting/xero/owed-operations") return jsonResponse({ count: 3, data: [] });
      return jsonResponse({}, 404);
    });
    render(<AccountingConnectionPanel provider="xero" />);
    await screen.findByTestId("xero-disconnect");
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith("/accounting/xero/owed-operations");
  });

  // The settings step is gated on the FEATURE, never the provider id.
  it("renders the settings step for Xero when features.settingsOptions is true", async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === "/accounting/xero") return jsonResponse(xeroStatus({ features: { tenantSelection: true, settingsOptions: true } }));
      if (url === "/accounting/xero/settings/options") {
        return jsonResponse({ data: { organisation: { name: "Acme", isDemoCompany: false }, incomeAccounts: [], taxRates: [], bankAccounts: [] } });
      }
      return jsonResponse({}, 404);
    });
    render(<AccountingConnectionPanel provider="xero" />);
    expect(await screen.findByTestId("xero-settings-step")).toBeTruthy();
  });

  it("QuickBooks with no features field never renders or fetches the settings step", async () => {
    mockStatus("/accounting/quickbooks", connected);
    render(<AccountingConnectionPanel provider="quickbooks" />);
    await screen.findByTestId("quickbooks-pushmode");
    expect(screen.queryByTestId("quickbooks-settings-step")).toBeNull();
    expect(fetchWithAuthMock).not.toHaveBeenCalledWith("/accounting/quickbooks/settings/options");
  });

  // Xero W03b: the settings step owns the income account when
  // features.settingsOptions is true — the workbench must not show its own picker.
  it("renders the workbench without xero-income-account-select when the settings step owns the income account", async () => {
    fetchWithAuthMock.mockImplementation(async (url: string) => {
      if (url === "/accounting/xero") {
        return jsonResponse(xeroStatus({
          features: { tenantSelection: true, settingsOptions: true },
          capabilities: { connect: true, mapping: true, customerImport: false, invoicePush: false, paymentPull: false, paymentPush: false },
        }));
      }
      if (url === "/accounting/xero/settings/options") {
        return jsonResponse({ data: { organisation: { name: "Acme", isDemoCompany: false }, incomeAccounts: [], taxRates: [], bankAccounts: [] } });
      }
      if (url === "/accounting/xero/owed-operations") return jsonResponse({ count: 0, data: [] });
      return jsonResponse({}, 404);
    });
    render(<AccountingConnectionPanel provider="xero" />);
    await screen.findByTestId("xero-mapping-workbench");
    fireEvent.click(screen.getByTestId("xero-mapping-tab-items"));
    expect(screen.queryByTestId("xero-income-account-select")).toBeNull();
  });

  it("QuickBooks (no features) still shows its own income-account picker in the workbench", async () => {
    mockStatus("/accounting/quickbooks", connected);
    render(<AccountingConnectionPanel provider="quickbooks" />);
    await screen.findByTestId("quickbooks-mapping-workbench");
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    expect(screen.getByTestId("quickbooks-income-account-select")).toBeInTheDocument();
  });
});
