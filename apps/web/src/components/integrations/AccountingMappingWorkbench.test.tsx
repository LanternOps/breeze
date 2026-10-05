import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import AccountingMappingWorkbench from "./AccountingMappingWorkbench";

// SEC-2026-09-05-057: every mutating control here is gated on
// `accounting:manage`. This suite covers the workbench's own behaviour, so it
// holds the grant throughout; the gate itself is covered by
// AccountingMappingWorkbench.accountingPermissions.test.tsx.
vi.mock("../../lib/permissions", () => ({
  usePermissions: () => ({ permissions: [], can: () => true }),
}));

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

// An item row already decided as "create new" but not yet successfully
// synced (no remoteEntityId yet) — this is the shape the API's
// income_account_required guard actually applies to (isCreate && no default
// income account).
const itemProposalCreateNew = {
  ...itemProposal,
  linkStatus: "create_new",
};

// An item row already confirmed against a real QuickBooks item — syncing
// this is an UPDATE, which never needs an income account.
const itemProposalConfirmed = {
  ...itemProposal,
  proposedRemoteId: "qb-item-9",
  proposedRemoteName: "Support Plan (QBO)",
  linkStatus: "confirmed",
};

beforeEach(() => {
  vi.clearAllMocks();
  // clearAllMocks drops recorded calls but KEEPS queued `mockResolvedValueOnce`
  // implementations, so a test that leaves one unconsumed (any test asserting an
  // early abort) would silently serve it to the next test. Reset the queue.
  fetchWithAuthMock.mockReset();
  window.location.hash = "";
});

describe("AccountingMappingWorkbench", () => {
  it("loads customer proposals and marks ambiguous rows for manual selection", async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({ data: [ambiguousOrgProposal] }),
    );
    render(
      <AccountingMappingWorkbench provider="quickbooks"
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

  it("confirms a proposal pre-filled with the suggested candidate, updating the row in place from the PUT response", async () => {
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
      )
      // The confirm auto-syncs (see the auto-sync suite below).
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            breezeEntityType: "org",
            breezeEntityId: ORG_ID,
            remoteEntityType: "Customer",
            remoteEntityId: "qb-12",
            linkStatus: "confirmed",
            syncStatus: "synced",
            lastSyncedAt: "2026-09-06T00:00:00Z",
            lastError: null,
          },
        }),
      );

    render(
      <AccountingMappingWorkbench provider="quickbooks"
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);

    // The select is already showing the proposal's suggested candidate
    // ("qb-12") without the operator touching it — Confirm must work from
    // that pre-filled value, not require a redundant re-selection.
    expect(screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`)).toHaveValue("qb-12");
    expect(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`)).not.toBeDisabled();
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
    // Updated in place from the PUT/sync responses — no second list GET was
    // issued (the only follow-up call is the auto-sync POST).
    expect(fetchWithAuthMock).toHaveBeenCalledTimes(3);
    expect(String(fetchWithAuthMock.mock.calls[2]![0])).toBe(
      "/accounting/quickbooks/mappings/sync",
    );
    await waitFor(() =>
      expect(
        screen.getByTestId(`quickbooks-mapping-linkstatus-${ORG_ID}`),
      ).toHaveTextContent(/confirmed/i),
    );
  });

  it("does not flip the row status before the confirm request resolves (no optimistic UI)", async () => {
    const pending = pendingResponse();
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [suggestedOrgProposal] }))
      .mockReturnValueOnce(pending.promise)
      // The confirm auto-syncs once the PUT resolves.
      .mockResolvedValueOnce(
        jsonResponse({
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

    render(
      <AccountingMappingWorkbench provider="quickbooks"
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);

    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));

    // Still "Not synced" — the PUT hasn't resolved yet.
    expect(
      screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`),
    ).toHaveTextContent("Not synced");

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
      ).toHaveTextContent("In QuickBooks"),
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
      <AccountingMappingWorkbench provider="quickbooks"
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
      // A "create new" row (no remoteEntityId yet) is exactly what the API's
      // income_account_required guard applies to (isCreate && no default
      // income account) — see syncMappedEntity in accountingMappingService.ts.
      .mockResolvedValueOnce(jsonResponse({ data: [itemProposalCreateNew] }));

    render(
      <AccountingMappingWorkbench provider="quickbooks"
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

  it("does not gate sync for an already-confirmed item row even without a saved income account", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // income accounts (bundled with items load)
      .mockResolvedValueOnce(jsonResponse({ data: [itemProposalConfirmed] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            breezeEntityType: "catalog_item",
            breezeEntityId: ITEM_ID,
            remoteEntityType: "Item",
            remoteEntityId: "qb-item-9",
            linkStatus: "confirmed",
            syncStatus: "synced",
            lastSyncedAt: "2026-09-01T00:00:00Z",
            lastError: null,
          },
        }),
      );

    render(
      <AccountingMappingWorkbench provider="quickbooks"
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`);

    // The banner still shows (no income account saved), and create is still
    // gated — but this confirmed row's sync is an UPDATE, not a create, so it
    // must stay enabled.
    expect(
      screen.getByTestId("quickbooks-income-account-required"),
    ).toBeInTheDocument();
    expect(screen.getByTestId(`quickbooks-mapping-create-${ITEM_ID}`)).toBeDisabled();
    expect(screen.getByTestId(`quickbooks-mapping-sync-${ITEM_ID}`)).not.toBeDisabled();

    fireEvent.click(screen.getByTestId(`quickbooks-mapping-sync-${ITEM_ID}`));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success" }),
      ),
    );
    const postCall = fetchWithAuthMock.mock.calls[2]!;
    expect(postCall[0]).toBe("/accounting/quickbooks/mappings/sync");
    expect((postCall[1] as RequestInit).method).toBe("POST");
    await waitFor(() =>
      expect(
        screen.getByTestId(`quickbooks-mapping-status-${ITEM_ID}`),
      ).toHaveTextContent("In QuickBooks"),
    );
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
      )
      // An income account IS saved, so the decision auto-syncs.
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            breezeEntityType: "catalog_item",
            breezeEntityId: ITEM_ID,
            remoteEntityType: "Item",
            remoteEntityId: "qb-item-101",
            linkStatus: "create_new",
            syncStatus: "synced",
            lastSyncedAt: "2026-09-06T00:00:00Z",
            lastError: null,
          },
        }),
      );

    render(
      <AccountingMappingWorkbench provider="quickbooks"
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
      <AccountingMappingWorkbench provider="quickbooks"
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
      <AccountingMappingWorkbench provider="quickbooks"
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
      <AccountingMappingWorkbench provider="quickbooks"
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
      <AccountingMappingWorkbench provider="quickbooks"
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
      <AccountingMappingWorkbench provider="quickbooks"
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
      <AccountingMappingWorkbench provider="quickbooks"
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
      <AccountingMappingWorkbench provider="quickbooks"
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

  it("still renders the item mapping list when the income-account fetch fails", async () => {
    // The income-account list is a convenience for the selector; the mapping
    // list is the screen's whole purpose. A single shared try/catch let a
    // QuickBooks Account-query failure abort the load before the mappings
    // request was ever issued, so the operator saw an empty workbench and one
    // toast about income accounts.
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ error: "QuickBooks returned an error" }, 502))
      .mockResolvedValueOnce(jsonResponse({ data: [itemProposal] }));

    render(
      <AccountingMappingWorkbench provider="quickbooks"
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef="79"
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));

    expect(
      await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`),
    ).toBeInTheDocument();
    // The failure is still reported — it is not swallowed, just isolated.
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error" }),
    );
    expect(fetchWithAuthMock.mock.calls[1]![0]).toContain("entityType=catalog_item");
  });

  it("labels a confirmed row as linked rather than a suggested match", async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({
        data: [{
          ...suggestedOrgProposal,
          confidence: "existing_link",
          linkStatus: "confirmed",
        }],
      }),
    );
    render(
      <AccountingMappingWorkbench provider="quickbooks"
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
      />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);

    expect(
      screen.getByTestId(`quickbooks-mapping-confidence-${ORG_ID}`),
    ).not.toHaveTextContent(/suggested/i);
    expect(
      screen.getByTestId(`quickbooks-mapping-confidence-${ORG_ID}`),
    ).toHaveTextContent(/linked/i);
  });
});

describe("AccountingMappingWorkbench remote candidate search", () => {
  function wire(candidates: unknown[], proposals: unknown[] = [ambiguousOrgProposal]) {
    fetchWithAuthMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/accounting/quickbooks/remote-candidates"))
        return jsonResponse({ data: candidates });
      if (u.includes("/accounting/quickbooks/mappings"))
        return jsonResponse({ data: proposals });
      if (u.includes("/accounting/quickbooks/income-accounts"))
        return jsonResponse({ data: [] });
      return jsonResponse({}, 404);
    });
  }

  it("debounces the search into ONE GET carrying entityType and the query", async () => {
    wire([{ id: "qb-77", displayName: "Acme Corporation", email: "ap@acme.test", currencyCode: "USD" }]);
    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);

    const box = screen.getByTestId(`quickbooks-mapping-search-${ORG_ID}`);
    fireEvent.change(box, { target: { value: "acm" } });
    fireEvent.change(box, { target: { value: "acme" } });

    await waitFor(() => {
      const calls = fetchWithAuthMock.mock.calls.filter((c) =>
        String(c[0]).includes("/accounting/quickbooks/remote-candidates"));
      expect(calls).toHaveLength(1);
      expect(String(calls[0][0])).toContain("entityType=org");
      expect(String(calls[0][0])).toContain("q=acme");
    });

    // The fetched candidate becomes a selectable option (no manual ID typing).
    await waitFor(() =>
      expect(screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`)).toHaveTextContent(
        "Acme Corporation",
      ));
    expect(
      screen.queryByTestId(`quickbooks-mapping-remote-manual-${ORG_ID}`),
    ).toBeNull();
  });

  it("searches items with entityType=catalog_item on the Items tab", async () => {
    wire([{ id: "qb-item-3", displayName: "Support Plan", sku: "SUP-1" }], [itemProposal]);
    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef="acct-1" />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`);

    fireEvent.change(screen.getByTestId(`quickbooks-mapping-search-${ITEM_ID}`), {
      target: { value: "support" },
    });

    await waitFor(() => {
      const call = fetchWithAuthMock.mock.calls.find((c) =>
        String(c[0]).includes("/accounting/quickbooks/remote-candidates"));
      expect(call).toBeTruthy();
      expect(String(call![0])).toContain("entityType=catalog_item");
    });
  });

  it("confirming a searched candidate PUTs the decision with that remote id", async () => {
    const confirmed = {
      breezeEntityType: "org",
      breezeEntityId: ORG_ID,
      remoteEntityType: "Customer",
      remoteEntityId: "qb-77",
      linkStatus: "confirmed",
      syncStatus: "pending",
      lastSyncedAt: null,
      lastError: null,
    };
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/accounting/quickbooks/remote-candidates"))
        return jsonResponse({ data: [{ id: "qb-77", displayName: "Acme Corporation" }] });
      if (u.includes("/accounting/quickbooks/mappings") && init?.method === "PUT")
        return jsonResponse({ data: confirmed });
      if (u.includes("/accounting/quickbooks/mappings"))
        return jsonResponse({ data: [ambiguousOrgProposal] });
      return jsonResponse({}, 404);
    });

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);

    fireEvent.change(screen.getByTestId(`quickbooks-mapping-search-${ORG_ID}`), {
      target: { value: "acme" },
    });
    const select = screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`);
    await waitFor(() => expect(select).toHaveTextContent("Acme Corporation"));
    fireEvent.change(select, { target: { value: "qb-77" } });

    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));

    await waitFor(() => {
      const call = fetchWithAuthMock.mock.calls.find(
        (c) => String(c[0]).includes("/accounting/quickbooks/mappings") &&
          (c[1] as RequestInit | undefined)?.method === "PUT");
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({
        breezeEntityType: "org",
        breezeEntityId: ORG_ID,
        decision: "confirmed",
        remoteEntityId: "qb-77",
      });
    });
  });

  it("renders synced_with_tax_variance with its own label, never as Pending", async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({
        data: [{ ...ambiguousOrgProposal, syncStatus: "synced_with_tax_variance" }],
      }),
    );
    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));

    const status = await screen.findByTestId(`quickbooks-mapping-status-${ORG_ID}`);
    expect(status).toHaveTextContent("Synced with tax difference");
    expect(status).not.toHaveTextContent("Not synced");
  });
});

describe("AccountingMappingWorkbench auto-sync after a decision", () => {
  const confirmedPending = {
    breezeEntityType: "org",
    breezeEntityId: ORG_ID,
    remoteEntityType: "Customer",
    remoteEntityId: "qb-12",
    linkStatus: "confirmed",
    syncStatus: "pending",
    lastSyncedAt: null,
    lastError: null,
  };
  const confirmedSynced = {
    ...confirmedPending,
    syncStatus: "synced",
    lastSyncedAt: "2026-09-06T00:00:00Z",
  };

  function syncCalls() {
    return fetchWithAuthMock.mock.calls.filter((c) =>
      String(c[0]).includes("/accounting/quickbooks/mappings/sync"),
    );
  }

  it("pushes the row to QuickBooks immediately after Confirm match, without a second click", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [suggestedOrgProposal] }))
      .mockResolvedValueOnce(jsonResponse({ data: confirmedPending }))
      .mockResolvedValueOnce(jsonResponse({ data: confirmedSynced }));

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));

    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    const syncCall = syncCalls()[0]!;
    expect((syncCall[1] as RequestInit).method).toBe("POST");
    expect(JSON.parse((syncCall[1] as RequestInit).body as string)).toMatchObject({
      breezeEntityType: "org",
      breezeEntityId: ORG_ID,
    });
    await waitFor(() =>
      expect(screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`)).toHaveTextContent(
        "In QuickBooks",
      ),
    );
    // One click, one outcome: the PUT is a step on the way to the push, so
    // only the sync's own toast is shown.
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("pushes the row to QuickBooks immediately after Create new", async () => {
    const createdSynced = {
      breezeEntityType: "catalog_item",
      breezeEntityId: ITEM_ID,
      remoteEntityType: "Item",
      remoteEntityId: "qb-item-77",
      linkStatus: "create_new",
      syncStatus: "synced",
      lastSyncedAt: "2026-09-06T00:00:00Z",
      lastError: null,
    };
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // income accounts
      .mockResolvedValueOnce(jsonResponse({ data: [itemProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { ...createdSynced, remoteEntityId: null, syncStatus: "pending" } }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: createdSynced }));

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef="acct-1" />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-create-${ITEM_ID}`));

    await waitFor(() => expect(syncCalls()).toHaveLength(1));
    await waitFor(() =>
      expect(screen.getByTestId(`quickbooks-mapping-status-${ITEM_ID}`)).toHaveTextContent(
        "In QuickBooks",
      ),
    );
  });

  it("labels the picker with the org name (not the QBO Id) after Create new", async () => {
    const created = {
      breezeEntityType: "org",
      breezeEntityId: ORG_ID,
      remoteEntityType: "Customer",
      remoteEntityId: "231",
      linkStatus: "confirmed",
      syncStatus: "synced",
      lastSyncedAt: "2026-09-06T00:00:00Z",
      lastError: null,
    };
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [ambiguousOrgProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { ...created, remoteEntityId: null, linkStatus: "create_new", syncStatus: "pending" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: created }));

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-create-${ORG_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`)).toHaveTextContent(
        "In QuickBooks",
      ),
    );
    const select = screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`) as HTMLSelectElement;
    expect(select.value).toBe("231");
    expect(select.selectedOptions[0]!.textContent).toBe("Acme Corp");
  });

  it("labels the picker with the item name (not the QBO Id) after Create new on the Items tab", async () => {
    const created = {
      breezeEntityType: "catalog_item",
      breezeEntityId: ITEM_ID,
      remoteEntityType: "Item",
      remoteEntityId: "345",
      linkStatus: "confirmed",
      syncStatus: "synced",
      lastSyncedAt: "2026-09-06T00:00:00Z",
      lastError: null,
    };
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // income accounts
      .mockResolvedValueOnce(jsonResponse({ data: [itemProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { ...created, remoteEntityId: null, linkStatus: "create_new", syncStatus: "pending" },
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: created }));

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef="acct-1" />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-create-${ITEM_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`quickbooks-mapping-status-${ITEM_ID}`)).toHaveTextContent(
        "In QuickBooks",
      ),
    );
    const select = screen.getByTestId(`quickbooks-mapping-remote-${ITEM_ID}`) as HTMLSelectElement;
    expect(select.value).toBe("345");
    expect(select.selectedOptions[0]!.textContent).toBe("Monthly Support");
  });

  it("does NOT relabel with the Breeze name when a create_new row is later re-linked to a different existing customer", async () => {
    // A row that already went through "Create new" (proposedRemoteId set from
    // that create) is then manually re-pointed at a DIFFERENT, pre-existing
    // QBO record via search + confirm. The id changes, but this is not a
    // fresh create — the picker must not borrow the Breeze org name for a
    // record it did not name.
    const createdRow = {
      ...ambiguousOrgProposal,
      linkStatus: "create_new",
      proposedRemoteId: "231",
      proposedRemoteName: "Acme Corp",
      confidence: "existing_link",
    };
    const relinked = {
      breezeEntityType: "org",
      breezeEntityId: ORG_ID,
      remoteEntityType: "Customer",
      remoteEntityId: "qb-77",
      linkStatus: "confirmed",
      syncStatus: "pending",
      lastSyncedAt: null,
      lastError: null,
    };
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/accounting/quickbooks/remote-candidates"))
        return jsonResponse({ data: [{ id: "qb-77", displayName: "Acme Corporation" }] });
      if (u.includes("/accounting/quickbooks/mappings") && init?.method === "PUT")
        return jsonResponse({ data: relinked });
      if (u.includes("/accounting/quickbooks/mappings"))
        return jsonResponse({ data: [createdRow] });
      return jsonResponse({}, 404);
    });

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);

    fireEvent.change(screen.getByTestId(`quickbooks-mapping-search-${ORG_ID}`), {
      target: { value: "acme" },
    });
    const select = screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`) as HTMLSelectElement;
    await waitFor(() => expect(select).toHaveTextContent("Acme Corporation"));
    fireEvent.change(select, { target: { value: "qb-77" } });

    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));

    await waitFor(() => expect(select.value).toBe("qb-77"));
    // Must show the searched candidate's own name ("Acme Corporation") or, at
    // worst, fall back to the raw id — NEVER the Breeze org's own display
    // name ("Acme Corp"), which belongs to the row, not this remote record.
    expect(select.selectedOptions[0]!.textContent).not.toBe("Acme Corp");
  });

  it("does NOT push to QuickBooks after an Unlink decision", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [suggestedOrgProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: { ...confirmedPending, remoteEntityId: null, linkStatus: "unlinked" },
        }),
      );

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-unlink-${ORG_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`quickbooks-mapping-linkstatus-${ORG_ID}`)).toHaveTextContent(
        /unlink/i,
      ),
    );
    expect(syncCalls()).toHaveLength(0);
  });

  it("reports a failed auto-sync on the row without faking a persisted error status", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [suggestedOrgProposal] }))
      .mockResolvedValueOnce(jsonResponse({ data: confirmedPending }))
      .mockResolvedValueOnce(
        jsonResponse({ error: "QuickBooks rejected the customer name" }, 502),
      );

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));

    expect(await screen.findByTestId(`quickbooks-mapping-error-${ORG_ID}`)).toHaveTextContent(
      /rejected the customer name/i,
    );
    // The badge must NOT claim a persisted failure. The API only writes
    // syncStatus='error' after a provider call fails; a pre-flight refusal
    // (currency_mismatch, income_account_required, item_price_required,
    // mapping_not_ready) leaves the row `pending`, so a locally faked "Sync
    // failed" reverts to "Not synced" on the next refresh with nothing
    // explaining why. The reason lives in the row's error text instead.
    expect(screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`)).toHaveTextContent(
      "Not synced",
    );
    expect(screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`)).not.toHaveTextContent(
      "Sync failed",
    );
    expect(showToastMock).toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  it("shows 'Sync failed' only when the mapping itself carries syncStatus=error", async () => {
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [suggestedOrgProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({
          data: {
            ...confirmedPending,
            syncStatus: "error",
            lastError: "QuickBooks: Duplicate Name Exists Error",
          },
        }),
      );

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-sync-${ORG_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`)).toHaveTextContent(
        "Sync failed",
      ),
    );
    expect(screen.getByTestId(`quickbooks-mapping-error-${ORG_ID}`)).toHaveTextContent(
      /duplicate name/i,
    );
  });

  it("does NOT auto-sync a create_new item row while the income account is unset", async () => {
    // The Create new button is already gated, but the PUT response is what
    // decides the row's real link status — a decision that comes back as
    // create_new must obey the same gate the manual Sync now button does,
    // instead of firing a request the API is guaranteed to refuse.
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [] })) // income accounts
      .mockResolvedValueOnce(jsonResponse({ data: [itemProposalConfirmed] }))
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
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ITEM_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`quickbooks-mapping-linkstatus-${ITEM_ID}`)).toHaveTextContent(
        /create new/i,
      ),
    );
    expect(syncCalls()).toHaveLength(0);
    // The decision still saved, so the operator gets exactly one success
    // toast and no error about a sync that was never attempted.
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(showToastMock).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it("gives a never-decided suggested row no 'confirmed in Breeze' tooltip", async () => {
    // The hint explains a decision the operator made. A row they have not
    // touched is unsynced because nothing was decided, not because Breeze is
    // sitting on a confirmation.
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({ data: [suggestedOrgProposal] }),
    );
    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));

    const status = await screen.findByTestId(`quickbooks-mapping-status-${ORG_ID}`);
    expect(status).toHaveTextContent("Not synced");
    expect(status).not.toHaveAttribute("title");
  });

  it("labels an unsynced confirmed row 'Not synced' and explains it in a tooltip", async () => {
    fetchWithAuthMock.mockResolvedValueOnce(
      jsonResponse({ data: [{ ...suggestedOrgProposal, linkStatus: "confirmed" }] }),
    );
    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));

    const status = await screen.findByTestId(`quickbooks-mapping-status-${ORG_ID}`);
    expect(status).toHaveTextContent("Not synced");
    expect(status).toHaveAttribute(
      "title",
      "Confirmed in Breeze, not sent to QuickBooks yet",
    );
  });

  it("reflects the synced mapping in the suggested-match column and the combobox", async () => {
    // The row starts with NO suggestion at all ("No match" / "—"). After a sync
    // returns the linked remote id, the row must show the link without the
    // operator reloading the whole list.
    fetchWithAuthMock
      .mockResolvedValueOnce(jsonResponse({ data: [ambiguousOrgProposal] }))
      .mockResolvedValueOnce(
        jsonResponse({ data: { ...confirmedSynced, remoteEntityId: "qb-99", confidence: "existing_link", proposedRemoteName: "Created customer in QuickBooks" } }),
      );

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    expect(screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`)).toHaveValue("");
    expect(screen.getByTestId(`quickbooks-mapping-confidence-${ORG_ID}`)).toHaveTextContent(
      /ambiguous/i,
    );

    fireEvent.click(screen.getByTestId(`quickbooks-mapping-sync-${ORG_ID}`));

    await waitFor(() =>
      expect(screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`)).toHaveValue("qb-99"),
    );
    expect(screen.getByTestId(`quickbooks-mapping-confidence-${ORG_ID}`)).toHaveTextContent(
      /linked/i,
    );
    expect(screen.getByTestId(`quickbooks-mapping-remote-${ORG_ID}`)).toHaveTextContent(
      "Created customer in QuickBooks",
    );
  });
});

describe("AccountingMappingWorkbench provider wiring", () => {
  // Ruling R6 (Xero W01c): a throttled mapping sync answers 429
  // `{ code: 'rate_limited', error: '<provider> is rate limiting…' }`. The
  // server text is what tells the operator to wait, so it must reach both the
  // toast and the row error verbatim — never the generic failedToSyncEntity.
  it("surfaces a 429 rate_limited mapping sync with the server text, not the generic fallback", async () => {
    const serverText = "QuickBooks is rate limiting requests. Try again in a minute.";
    fetchWithAuthMock.mockImplementation((url: string) =>
      String(url).includes("/mappings/sync")
        ? jsonResponse({ error: serverText, code: "rate_limited" }, 429)
        : jsonResponse({ data: [{ ...suggestedOrgProposal, linkStatus: "confirmed" }] }),
    );

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    fireEvent.click(await screen.findByTestId(`quickbooks-mapping-sync-${ORG_ID}`));

    await waitFor(() =>
      expect(showToastMock).toHaveBeenCalledWith({ type: "error", message: serverText }),
    );
    expect(showToastMock).toHaveBeenCalledTimes(1);
    expect(await screen.findByTestId(`quickbooks-mapping-error-${ORG_ID}`)).toHaveTextContent(serverText);
  });

  it("scopes its API calls, test ids and hash tabs to the provider prop", async () => {
    fetchWithAuthMock.mockImplementation(() => jsonResponse({ data: [] }));
    render(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-tab-items"));
    expect(window.location.hash).toBe("#xero-items");
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await waitFor(() =>
      expect(fetchWithAuthMock).toHaveBeenCalledWith("/accounting/xero/mappings?entityType=catalog_item"),
    );
    expect(fetchWithAuthMock).toHaveBeenCalledWith("/accounting/xero/income-accounts");
  });
});

describe("Xero W03", () => {
  it("hides the income-account picker and does not fetch income accounts when the settings step owns it", async () => {
    fetchWithAuthMock.mockImplementation((url: string) =>
      String(url).includes("/mappings") ? jsonResponse({ data: [itemProposal] }) : jsonResponse({}, 404),
    );
    render(
      <AccountingMappingWorkbench
        provider="xero"
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
        incomeAccountHome="settings"
      />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await screen.findByTestId(`xero-mapping-row-${ITEM_ID}`);

    expect(screen.queryByTestId("xero-income-account-select")).toBeNull();
    expect(screen.getByTestId("xero-income-account-in-settings")).toHaveTextContent("settings step");
    expect(
      fetchWithAuthMock.mock.calls.some((c) => String(c[0]).includes("/accounting/xero/income-accounts")),
    ).toBe(false);
    expect(screen.getAllByTestId(/^xero-mapping-create-/)[0]).toBeDisabled();
  });

  it("re-enables Create new when the parent's income account arrives after mount", async () => {
    fetchWithAuthMock.mockImplementation((url: string) =>
      String(url).includes("/mappings") ? jsonResponse({ data: [itemProposal] }) : jsonResponse({}, 404),
    );
    const { rerender } = render(
      <AccountingMappingWorkbench
        provider="xero"
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef={null}
        incomeAccountHome="settings"
      />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await screen.findByTestId(`xero-mapping-row-${ITEM_ID}`);
    expect(screen.getAllByTestId(/^xero-mapping-create-/)[0]).toBeDisabled();

    rerender(
      <AccountingMappingWorkbench
        provider="xero"
        onUnauthorized={vi.fn()}
        defaultIncomeAccountRef="200"
        incomeAccountHome="settings"
      />,
    );

    expect(screen.getAllByTestId(/^xero-mapping-create-/)[0]).toBeEnabled();
    expect(screen.queryByTestId("xero-income-account-in-settings")).toBeNull();
  });

  it("keeps the QuickBooks income-account picker exactly as before (default home)", async () => {
    fetchWithAuthMock.mockImplementation((url: string) =>
      String(url).includes("/mappings") ? jsonResponse({ data: [itemProposal] }) : jsonResponse({ data: [] }),
    );
    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef="acct-1" />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ITEM_ID}`);

    expect(screen.getByTestId("quickbooks-income-account-select")).toBeInTheDocument();
  });

  it("labels archived candidates and lists them after live ones", async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/remote-candidates")) {
        return jsonResponse({
          data: [
            { id: "old", displayName: "Acme", archived: true },
            { id: "live", displayName: "Acme Ltd", archived: false },
          ],
        });
      }
      if (u.includes("/mappings")) return jsonResponse({ data: [ambiguousOrgProposal] });
      return jsonResponse({ data: [] });
    });
    render(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await screen.findByTestId(`xero-mapping-row-${ORG_ID}`);

    fireEvent.change(screen.getByTestId(`xero-mapping-search-${ORG_ID}`), { target: { value: "acme" } });

    const select = await screen.findByTestId(`xero-mapping-remote-${ORG_ID}`);
    await waitFor(() => expect(within(select).getAllByRole("option").length).toBeGreaterThan(1));
    const options = within(select).getAllByRole("option").map((o) => o.textContent);
    expect(options.indexOf("Acme Ltd")).toBeLessThan(options.findIndex((t) => t?.startsWith("Acme · Archived")));
    expect(screen.getByTestId("xero-candidate-archived-old")).toBeInTheDocument();
  });

  it("on duplicate_name, shows the hint, seeds the row search with the name and preselects the one exact match", async () => {
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/mappings/sync")) {
        return jsonResponse(
          {
            error: 'Xero already has a customer named "Acme" — link it instead.',
            code: "duplicate_name",
            details: { remoteName: "Acme" },
          },
          409,
        );
      }
      if (u.includes("/remote-candidates") && u.includes("q=Acme")) {
        return jsonResponse({
          data: [
            { id: "xc-7", displayName: "acme", archived: false },
            { id: "xc-8", displayName: "Acme Holdings", archived: false },
          ],
        });
      }
      if (u.includes("/mappings") && init?.method === "PUT") {
        return jsonResponse({
          data: {
            breezeEntityType: "org",
            breezeEntityId: ORG_ID,
            remoteEntityType: "Customer",
            remoteEntityId: "xc-7",
            linkStatus: "confirmed",
            syncStatus: "pending",
            lastSyncedAt: null,
            lastError: null,
          },
        });
      }
      if (u.includes("/mappings")) return jsonResponse({ data: [{ ...ambiguousOrgProposal, linkStatus: "create_new" }] });
      return jsonResponse({ data: [] });
    });
    render(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await screen.findByTestId(`xero-mapping-row-${ORG_ID}`);

    fireEvent.click(screen.getByTestId(`xero-mapping-sync-${ORG_ID}`));

    expect(await screen.findByTestId(`xero-mapping-duplicate-hint-${ORG_ID}`)).toBeInTheDocument();
    await waitFor(() =>
      expect(screen.getByTestId(`xero-mapping-search-${ORG_ID}`)).toHaveValue("Acme"),
    );

    const select = screen.getByTestId(`xero-mapping-remote-${ORG_ID}`);
    await waitFor(() => expect(select).toHaveValue("xc-7"));

    fireEvent.click(screen.getByTestId(`xero-mapping-confirm-${ORG_ID}`));

    await waitFor(() => {
      const call = fetchWithAuthMock.mock.calls.find(
        (c) => String(c[0]).includes("/accounting/xero/mappings") && (c[1] as RequestInit | undefined)?.method === "PUT",
      );
      expect(call).toBeTruthy();
      const body = JSON.parse((call![1] as RequestInit).body as string);
      expect(body).toMatchObject({ decision: "confirmed", remoteEntityId: "xc-7" });
    });
  });

  it("a duplicate_name WITHOUT details.remoteName shows the error but no hint and no seed", async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/mappings/sync")) {
        return jsonResponse(
          { error: 'A record with this name already exists — rename it and try again.', code: "duplicate_name" },
          409,
        );
      }
      if (u.includes("/mappings")) return jsonResponse({ data: [{ ...ambiguousOrgProposal, linkStatus: "confirmed", proposedRemoteId: "qb-1" }] });
      return jsonResponse({ data: [] });
    });
    render(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await screen.findByTestId(`xero-mapping-row-${ORG_ID}`);

    fireEvent.click(screen.getByTestId(`xero-mapping-sync-${ORG_ID}`));

    expect(await screen.findByTestId(`xero-mapping-error-${ORG_ID}`)).toBeInTheDocument();
    expect(screen.queryByTestId(`xero-mapping-duplicate-hint-${ORG_ID}`)).toBeNull();
    expect(screen.getByTestId(`xero-mapping-search-${ORG_ID}`)).toHaveValue("");
  });

  it("a seeded search runs exactly once — no request loop from the preselect (quorum 7)", async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/mappings/sync")) {
        return jsonResponse(
          { error: 'dup', code: "duplicate_name", details: { remoteName: "Acme" } },
          409,
        );
      }
      if (u.includes("/remote-candidates") && u.includes("q=Acme")) {
        return jsonResponse({ data: [{ id: "xc-7", displayName: "acme", archived: false }] });
      }
      if (u.includes("/mappings")) return jsonResponse({ data: [{ ...ambiguousOrgProposal, linkStatus: "create_new" }] });
      return jsonResponse({ data: [] });
    });
    const { rerender } = render(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await screen.findByTestId(`xero-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`xero-mapping-sync-${ORG_ID}`));
    await screen.findByTestId(`xero-mapping-duplicate-hint-${ORG_ID}`);
    await waitFor(() =>
      expect(screen.getByTestId(`xero-mapping-remote-${ORG_ID}`)).toHaveValue("xc-7"),
    );

    rerender(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    rerender(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );

    const calls = fetchWithAuthMock.mock.calls.filter(
      (c) => String(c[0]).includes("/remote-candidates") && String(c[0]).includes("q=Acme"),
    );
    expect(calls).toHaveLength(1);
  });

  it("an ordinary QuickBooks search does not refetch when the parent re-renders", async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/remote-candidates")) return jsonResponse({ data: [{ id: "qb-77", displayName: "Acme Corporation" }] });
      if (u.includes("/mappings")) return jsonResponse({ data: [ambiguousOrgProposal] });
      return jsonResponse({ data: [] });
    });
    const { rerender } = render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.change(screen.getByTestId(`quickbooks-mapping-search-${ORG_ID}`), { target: { value: "acme" } });
    await waitFor(() => {
      const calls = fetchWithAuthMock.mock.calls.filter((c) => String(c[0]).includes("/remote-candidates"));
      expect(calls).toHaveLength(1);
    });

    rerender(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );

    const calls = fetchWithAuthMock.mock.calls.filter((c) => String(c[0]).includes("/remote-candidates"));
    expect(calls).toHaveLength(1);
  });

  it("does not preselect when two candidates match the name exactly", async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/mappings/sync")) {
        return jsonResponse({ error: "dup", code: "duplicate_name", details: { remoteName: "Acme" } }, 409);
      }
      if (u.includes("/remote-candidates") && u.includes("q=Acme")) {
        return jsonResponse({
          data: [
            { id: "xc-7", displayName: "Acme", archived: false },
            { id: "xc-8", displayName: "acme", archived: false },
          ],
        });
      }
      if (u.includes("/mappings")) return jsonResponse({ data: [{ ...ambiguousOrgProposal, linkStatus: "create_new" }] });
      return jsonResponse({ data: [] });
    });
    render(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await screen.findByTestId(`xero-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`xero-mapping-sync-${ORG_ID}`));
    await screen.findByTestId(`xero-mapping-duplicate-hint-${ORG_ID}`);

    const select = screen.getByTestId(`xero-mapping-remote-${ORG_ID}`);
    await waitFor(() => {
      const calls = fetchWithAuthMock.mock.calls.filter(
        (c) => String(c[0]).includes("/remote-candidates") && String(c[0]).includes("q=Acme"),
      );
      expect(calls).toHaveLength(1);
    });
    expect(select).toHaveValue("");
  });

  it("seeds the search box with the normalised name and preselects the candidate whose displayed name matches once normalised", async () => {
    fetchWithAuthMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/mappings/sync")) {
        return jsonResponse(
          { error: "dup", code: "duplicate_name", details: { remoteName: "  Acme   <Ltd>  " } },
          409,
        );
      }
      if (u.includes("/remote-candidates") && u.includes("q=Acme%20Ltd")) {
        return jsonResponse({ data: [{ id: "xc-9", displayName: "acme ltd", archived: false }] });
      }
      if (u.includes("/mappings")) return jsonResponse({ data: [{ ...ambiguousOrgProposal, linkStatus: "create_new" }] });
      return jsonResponse({ data: [] });
    });
    render(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await screen.findByTestId(`xero-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`xero-mapping-sync-${ORG_ID}`));

    await screen.findByTestId(`xero-mapping-duplicate-hint-${ORG_ID}`);
    await waitFor(() =>
      expect(screen.getByTestId(`xero-mapping-search-${ORG_ID}`)).toHaveValue("Acme Ltd"),
    );
    await waitFor(() => expect(screen.getByTestId(`xero-mapping-remote-${ORG_ID}`)).toHaveValue("xc-9"));
  });

  it("never renders remoteName as HTML — it is text-only, even when it looks like a tag", async () => {
    const evil = '<img src=x onerror="alert(1)">Evil';
    fetchWithAuthMock.mockImplementation((url: string) => {
      const u = String(url);
      if (u.includes("/mappings/sync")) {
        return jsonResponse({ error: "dup", code: "duplicate_name", details: { remoteName: evil } }, 409);
      }
      if (u.includes("/remote-candidates")) return jsonResponse({ data: [] });
      if (u.includes("/mappings")) return jsonResponse({ data: [{ ...ambiguousOrgProposal, linkStatus: "create_new" }] });
      return jsonResponse({ data: [] });
    });
    const { container } = render(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("xero-mapping-load"));
    await screen.findByTestId(`xero-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`xero-mapping-sync-${ORG_ID}`));

    await screen.findByTestId(`xero-mapping-duplicate-hint-${ORG_ID}`);
    expect(container.querySelector("img")).toBeNull();
    await waitFor(() =>
      expect(screen.getByTestId(`xero-mapping-search-${ORG_ID}`)).toHaveValue(
        'img src=x onerror="alert(1)"Evil',
      ),
    );
  });

  it("the #xero-items hash opens the Items tab", async () => {
    window.location.hash = "#xero-items";
    fetchWithAuthMock.mockImplementation(() => jsonResponse({ data: [] }));
    render(
      <AccountingMappingWorkbench provider="xero" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    await waitFor(() =>
      expect(screen.getByTestId("xero-mapping-tab-items")).toHaveAttribute("aria-selected", "true"),
    );
  });
});

// #7386: the PUT already enqueues a worker sync, so the workbench's own
// follow-up POST /mappings/sync can lose the Redis lock (409 sync_in_progress)
// even though the create succeeds. That is "queued", not a failure.
describe("AccountingMappingWorkbench — decision racing the worker's sync (#7386)", () => {
  it("treats sync_in_progress after a decision as queued: no error, row settles to Synced without a reload", async () => {
    let listCalls = 0;
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/mappings/sync")) {
        return jsonResponse(
          { error: "QuickBooks mapping sync is already in progress", code: "sync_in_progress" },
          409,
        );
      }
      if (method === "PUT") {
        return jsonResponse({
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
        });
      }
      listCalls++;
      // 1st GET = initial load; later GETs = the settle poll (worker finished).
      return jsonResponse({
        data: [
          listCalls === 1
            ? suggestedOrgProposal
            : { ...suggestedOrgProposal, linkStatus: "confirmed", syncStatus: "synced" },
        ],
      });
    });

    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));

    await waitFor(
      () =>
        expect(screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`)).toHaveTextContent("In QuickBooks"),
      { timeout: 5000 },
    );
    expect(screen.queryByTestId(`quickbooks-mapping-error-${ORG_ID}`)).not.toBeInTheDocument();
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "error" }));
  });

  // Shared harness: PUT succeeds, the follow-up sync loses the lock, and every
  // GET after the initial load returns `settled` (the worker's view of the row).
  function mockRaceWithPoll(settled: Record<string, unknown>) {
    let listCalls = 0;
    const counter = { polls: 0 };
    fetchWithAuthMock.mockImplementation((url: string, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? "GET";
      if (u.includes("/mappings/sync")) {
        return jsonResponse({ error: "already in progress", code: "sync_in_progress" }, 409);
      }
      if (method === "PUT") {
        return jsonResponse({
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
        });
      }
      listCalls++;
      if (listCalls > 1) counter.polls++;
      return jsonResponse({ data: [listCalls === 1 ? suggestedOrgProposal : { ...suggestedOrgProposal, ...settled }] });
    });
    return counter;
  }

  async function loadAndConfirm() {
    render(
      <AccountingMappingWorkbench provider="quickbooks" onUnauthorized={vi.fn()} defaultIncomeAccountRef={null} />,
    );
    fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
    await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-confirm-${ORG_ID}`));
  }

  it("poll exhaustion: a row still pending after the window stays Not synced, toasts 'saved', and stops polling", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const counter = mockRaceWithPoll({ linkStatus: "confirmed", syncStatus: "pending" });
      await loadAndConfirm();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(16_000);
      });
      expect(counter.polls).toBe(15);
      expect(showToastMock).toHaveBeenCalledWith(
        expect.objectContaining({ type: "success", message: "Mapping saved." }),
      );
      expect(screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`)).toHaveTextContent("Not synced");
      expect(screen.queryByTestId(`quickbooks-mapping-error-${ORG_ID}`)).not.toBeInTheDocument();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5_000);
      });
      expect(counter.polls).toBe(15);
    } finally {
      vi.useRealTimers();
    }
  });

  it("worker error: the poll surfaces the worker's lastError on the row and does not toast success", async () => {
    mockRaceWithPoll({ linkStatus: "confirmed", syncStatus: "error", lastError: "QBO rejected the customer" });
    await loadAndConfirm();
    await waitFor(
      () =>
        expect(screen.getByTestId(`quickbooks-mapping-error-${ORG_ID}`)).toHaveTextContent(
          "QBO rejected the customer",
        ),
      { timeout: 5000 },
    );
    expect(screen.getByTestId(`quickbooks-mapping-status-${ORG_ID}`)).toHaveTextContent("Sync failed");
    expect(showToastMock).not.toHaveBeenCalledWith(expect.objectContaining({ type: "success" }));
  });

  it("supersede: leaving the tab mid-poll cancels the row's poll — no further polls, no stale toast", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const counter = mockRaceWithPoll({ linkStatus: "confirmed", syncStatus: "pending" });
      await loadAndConfirm();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(2_500);
      });
      expect(counter.polls).toBeGreaterThan(0);
      fireEvent.click(screen.getByTestId("quickbooks-mapping-tab-items"));
      const before = counter.polls;
      showToastMock.mockClear();
      await act(async () => {
        await vi.advanceTimersByTimeAsync(20_000);
      });
      expect(counter.polls).toBe(before);
      expect(showToastMock).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });
});
