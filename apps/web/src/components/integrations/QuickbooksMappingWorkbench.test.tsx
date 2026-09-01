import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import QuickbooksMappingWorkbench from "./QuickbooksMappingWorkbench";

const fetchWithAuthMock = vi.fn();
vi.mock("../../stores/auth", () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));

// runAction surfaces success/error toasts via showToast from ../shared/Toast.
const showToastMock = vi.fn();
vi.mock("../shared/Toast", () => ({
  showToast: (...a: unknown[]) => showToastMock(...a),
}));

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

function pendingResponse() {
  let resolve!: (value: Response) => void;
  const promise = new Promise<Response>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

const ORG_ID = "11111111-1111-1111-1111-111111111111";
const ITEM_ID = "22222222-2222-2222-2222-222222222222";

const ambiguousOrgProposal = {
  breezeEntityType: "org",
  breezeEntityId: ORG_ID,
  breezeDisplayName: "Acme Corp",
  remoteEntityType: "Customer",
  proposedRemoteId: null,
  proposedRemoteName: null,
  confidence: "ambiguous",
  linkStatus: "suggested",
  syncStatus: "pending",
  lastError: null,
};

const suggestedOrgProposal = {
  ...ambiguousOrgProposal,
  proposedRemoteId: "qb-12",
  proposedRemoteName: "Acme Corp (QBO)",
  confidence: "exact_email",
};

const itemProposal = {
  breezeEntityType: "catalog_item",
  breezeEntityId: ITEM_ID,
  breezeDisplayName: "Monthly Support",
  remoteEntityType: "Item",
  proposedRemoteId: null,
  proposedRemoteName: null,
  confidence: "none",
  linkStatus: "suggested",
  syncStatus: "pending",
  lastError: null,
};

beforeEach(() => {
  vi.clearAllMocks();
  window.location.hash = "";
});

describe("QuickbooksMappingWorkbench", () => {
  it("loads customer proposals and marks ambiguous rows for manual selection", async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({ data: [ambiguousOrgProposal] }),
    );
    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));

    expect(
      await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(`quickbooks-mapping-confidence-${ORG_ID}`),
    ).toHaveTextContent(/ambiguous/i);
    expect(fetchWithAuthMock.mock.calls[0]![0]).toContain("entityType=org");
  });

  it("confirms a proposal through runAction and reloads the list", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [suggestedOrgProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            breezeEntityType: "org",
            breezeEntityId: ORG_ID,
            remoteEntityType: "Customer",
            remoteEntityId: "qb-12",
            linkStatus: "confirmed",
            syncStatus: "pending",
            lastSyncedAt: null,
            lastError: null,
          },
        }),
      );

    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);

    fireEvent.change(screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`), {
      target: { value: "qb-12" },
    });
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success" }),
      ),
    );
    const putCall = fetchWithAuthMock.mock.calls[1]!;
    expect(putCall[0]).toContain("/accounting/quickbooks/mappings");
    expect((putCall[1] as RequestInit).method).toBe("PUT");
    expect(JSON.parse((putCall[1] as RequestInit).body as string)).toMatchObject({
      breezeEntityType: "org",
      breezeEntityId: ORG_ID,
      decision: "confirmed",
      remoteEntityId: "qb-12",
    });
  });

  it("does not flip the row status before the confirm request resolves (no optimistic UI)", async () => {
    const pending = pendingResponse();
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [suggestedOrgProposal] }))
      .mockReturnValueOnce(pending.promise);

    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);

    fireEvent.change(screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`), {
      target: { value: "qb-12" },
    });
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));

    // Still "pending" — the PUT hasn't resolved yet.
    expect(
      screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`),
    ).toHaveTextContent(/pending/i);

    pending.resolve(
      await jsonResponse({
        data: {
          breezeEntityType: "org",
          breezeEntityId: ORG_ID,
          remoteEntityType: "Customer",
          remoteEntityId: "qb-12",
          linkStatus: "confirmed",
          syncStatus: "synced",
          lastSyncedAt: "2026-08-31T00:00:00Z",
          lastError: null,
        },
      }),
    );

    await waitFor(() =>
      expect(
        screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`),
      ).toHaveTextContent(/synced/i),
    );
  });

  it("unlinks a mapping through runAction", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [suggestedOrgProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            breezeEntityType: "org",
            breezeEntityId: ORG_ID,
            remoteEntityType: "Customer",
            remoteEntityId: null,
            linkStatus: "unlinked",
            syncStatus: "pending",
            lastSyncedAt: null,
            lastError: null,
          },
        }),
      );

    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-unlink-${ORG_ID}`));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success" }),
      ),
    );
    const putCall = fetchWithAuthMock.mock.calls[1]!;
    expect(JSON.parse((putCall[1] as RequestInit).body as string)).toMatchObject(
      { decision: "unlinked" },
    );
  });

  it("disables item creation until an income account is saved", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // income accounts (bundled with items load)
      .mockResolvedValueOnce(jsonResponse({ data: [itemProposal] }));

    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`);

    expect(screen.getByTestId(`quickbooks-mapping-create-${ITEM_ID}`)).toBeDisabled();
    expect(
      screen.getByTestId(`quickbooks-mapping-sync-${ITEM_ID}`),
    ).toBeDisabled();
    expect(
      screen.getByTestId("quickbooks-income-account-required"),
    ).toBeInTheDocument();
  });

  it("creates a new remote item through runAction once an income account is set", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "acct-1", displayName: "Sales", accountType: "Income", accountSubType: "SalesOfProductIncome" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [itemProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            breezeEntityType: "catalog_item",
            breezeEntityId: ITEM_ID,
            remoteEntityType: "Item",
            remoteEntityId: null,
            linkStatus: "create_new",
            syncStatus: "pending",
            lastSyncedAt: null,
            lastError: null,
          },
        }),
      );

    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef="acct-1"
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`);

    expect(
      screen.queryByTestId("quickbooks-income-account-required"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId(`quickbooks-mapping-create-${ITEM_ID}`)).not.toBeDisabled();

    fireEvent.click(screen.getByTestId(`quickbooks-mapping-create-${ITEM_ID}`));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success" }),
      ),
    );
    const putCall = fetchWithAuthMock.mock.calls[2]!;
    expect(JSON.parse((putCall[1] as RequestInit).body as string)).toMatchObject(
      { decision: "create_new", breezeEntityType: "catalog_item" },
    );
  });

  it("saves the income account selection and enables item actions", async () => {
    const onSettingsChanged = vi.fn();
    fetchWithAuthMock
      .mockResolvedValueOnce(
        jsonResponse({
          data: [{ id: "acct-1", displayName: "Sales", accountType: "Income", accountSubType: "SalesOfProductIncome" }],
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: [itemProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({
          status: "connected",
          environment: "sandbox",
          pushMode: "auto",
          defaultIncomeAccountRef: "acct-1",
          defaultTaxCodeRef: null,
          lastError: null,
        }),
      );

    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
        onSettingsChanged={onSettingsChanged}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`);
    expect(screen.getByTestId("quickbooks-income-account-required")).toBeInTheDocument();

    fireEvent.change(screen.getByTestId("quickbooks-income-account-select"), {
      target: { value: "acct-1" },
    });
    fireEvent.click(screen.getByTestId("quickbooks-income-account-save"));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success" }),
      ),
    );
    expect(onSettingsChanged).toHaveBeenCalledWith(
      expect.objectContaining({ defaultIncomeAccountRef: "acct-1" }),
    );
    expect(
      screen.queryByTestId("quickbooks-income-account-required"),
    ).not.toBeInTheDocument();
    expect(screen.getByTestId(`quickbooks-mapping-create-${ITEM_ID}`)).not.toBeDisabled();

    const patchCall = fetchWithAuthMock.mock.calls[2]!;
    expect(patchCall[0]).toBe("/accounting/quickbooks/settings");
    expect((patchCall[1] as RequestInit).method).toBe("PATCH");
    expect(JSON.parse((patchCall[1] as RequestInit).body as string)).toEqual({
      defaultIncomeAccountRef: "acct-1",
    });
  });

  it("surfaces sync errors on the affected row", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [suggestedOrgProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({ error: "QuickBooks mapping is stale" }, 409),
      );

    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-sync-${ORG_ID}`));

    expect(
      await screen.findByTestId(`quickbooks-mapping-error-${ORG_ID}`),
    ).toHaveTextContent(/stale/i);
  });

  it("switches between customer and item tabs via window.location.hash", () => {
    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    expect(window.location.hash).toBe("#quickbooks-items");
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-customers"));
    expect(window.location.hash).toBe("#quickbooks-customers");
  });

  it("initializes the active tab from window.location.hash on mount", () => {
    window.location.hash = "#quickbooks-items";
    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    expect(
      screen.getByTestId("quickbooks-mapping-tab-items"),
    ).toHaveAttribute("aria-selected", "true");
  });

  it("calls onUnauthorized and does not double-toast on a 401", async () => {
    const onUnauthorized = vi.fn();
    fetchWithAuthMock.mockResolvedValueOnce(
      new Response(JSON.stringify({}), {
        status: 401,
        headers: { "Content-Type": "application/json" },
      }),
    );

    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={onUnauthorized}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));

    await waitFor(() => expect(onUnauthorized).toHaveBeenCalled());
    expect(showToastMock).not.toHaveBeenCalled();
  });

  it("shows an empty state when there are no proposals", async () => {
    fetchWithAuthMock.mockResolvedValueOnce(jsonResponse({ data: [] }));
    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    expect(
      await screen.findByTestId("quickbooks-mapping-empty"),
    ).toBeInTheDocument();
  });

  it("shows a read-only loading state while the request is in flight", async () => {
    const pending = pendingResponse();
    fetchWithAuthMock.mockReturnValueOnce(pending.promise);

    render(
      <QuickbooksMappingWorkbench
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    expect(screen.getByTestId("quickbooks-mapping-load")).toBeDisabled();

    pending.resolve(await jsonResponse({ data: [] }));
    await waitFor(() =>
      expect(screen.getByTestId("quickbooks-mapping-load")).not.toBeDisabled(),
    );
  });
});
