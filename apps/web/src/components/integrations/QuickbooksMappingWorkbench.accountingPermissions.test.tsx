import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

/**
 * SEC-2026-09-05-057 (PR review finding): the mapping workbench drives three
 * manage-gated routes — Save income account (PATCH /accounting/:provider/settings),
 * Confirm / Create / Unlink (PUT /accounting/:provider/mappings) and Sync now
 * (POST /accounting/:provider/mappings/sync). Without `accounting:manage` a
 * read-only caller must see every one of those disabled; the read-only Load
 * button and the tab switches stay operable.
 */
const fetchWithAuthMock = vi.fn();
const state = vi.hoisted(() => ({ canManage: false }));

vi.mock("../../lib/permissions", () => ({
  usePermissions: () => ({
    permissions: [],
    can: (resource: string, action: string) =>
      resource === "accounting" && action === "manage" ? state.canManage : true,
  }),
}));
vi.mock("../../stores/auth", () => ({
  fetchWithAuth: (...a: unknown[]) => fetchWithAuthMock(...a),
}));
vi.mock("../shared/Toast", () => ({ showToast: vi.fn() }));

import QuickbooksMappingWorkbench from "./QuickbooksMappingWorkbench";

const ORG_ID = "11111111-1111-1111-1111-111111111111";

const suggestedOrgProposal = {
  breezeEntityType: "org",
  breezeEntityId: ORG_ID,
  breezeDisplayName: "Acme Corp",
  remoteEntityType: "Customer",
  proposedRemoteId: "qb-12",
  proposedRemoteName: "Acme Corp (QBO)",
  confidence: "exact_email",
  linkStatus: "confirmed",
  syncStatus: "pending",
  lastError: null,
};

function jsonResponse(body: unknown, status = 200) {
  return Promise.resolve(
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    }),
  );
}

async function renderLoaded() {
  fetchWithAuthMock.mockResolvedValueOnce(
    jsonResponse({ data: [suggestedOrgProposal] }),
  );
  render(
    <QuickbooksMappingWorkbench
      onUnauthorized={vi.fn()}
      defaultIncomeAccountRef="income-1"
    />,
  );
  fireEvent.click(screen.getByTestId("quickbooks-mapping-load"));
  await screen.findByTestId(`quickbooks-mapping-row-${ORG_ID}`);
}

const disabled = (testId: string) =>
  (screen.getByTestId(testId) as HTMLButtonElement).disabled;

beforeEach(() => {
  vi.clearAllMocks();
  fetchWithAuthMock.mockReset();
  state.canManage = false;
  window.location.hash = "";
});

describe("QuickbooksMappingWorkbench accounting:manage gate", () => {
  it("disables Confirm/Create/Unlink and Sync now without accounting:manage", async () => {
    await renderLoaded();

    expect(disabled(`quickbooks-mapping-confirm-${ORG_ID}`)).toBe(true);
    expect(disabled(`quickbooks-mapping-create-${ORG_ID}`)).toBe(true);
    expect(disabled(`quickbooks-mapping-unlink-${ORG_ID}`)).toBe(true);
    expect(disabled(`quickbooks-mapping-sync-${ORG_ID}`)).toBe(true);
  });

  it("keeps the read-only Load control operable without accounting:manage", async () => {
    await renderLoaded();
    expect(disabled("quickbooks-mapping-load")).toBe(false);
  });

  it("never issues a mutating request from a disabled control", async () => {
    await renderLoaded();
    const callsAfterLoad = fetchWithAuthMock.mock.calls.length;

    fireEvent.click(screen.getByTestId(`quickbooks-mapping-sync-${ORG_ID}`));
    fireEvent.click(screen.getByTestId(`quickbooks-mapping-unlink-${ORG_ID}`));

    expect(fetchWithAuthMock.mock.calls.length).toBe(callsAfterLoad);
  });

  // The income-account control only renders on the Items tab (it gates item
  // creation in QuickBooks), so it needs its own render.
  it.each([
    { canManage: false, expected: true },
    { canManage: true, expected: false },
  ])(
    "Save income account disabled=$expected when accounting:manage=$canManage",
    async ({ canManage, expected }) => {
      state.canManage = canManage;
      window.location.hash = "#quickbooks-items";
      // income-accounts fetch on mount, then the proposals load.
      fetchWithAuthMock
        .mockResolvedValueOnce(jsonResponse({ data: [{ id: "income-1", displayName: "Sales" }] }))
        .mockResolvedValueOnce(jsonResponse({ data: [] }));
      render(
        <QuickbooksMappingWorkbench
          onUnauthorized={vi.fn()}
          defaultIncomeAccountRef="income-1"
        />,
      );

      expect(disabled("quickbooks-income-account-save")).toBe(expected);
    },
  );

  it("restores the mutating controls once accounting:manage is granted", async () => {
    state.canManage = true;
    await renderLoaded();

    expect(disabled(`quickbooks-mapping-confirm-${ORG_ID}`)).toBe(false);
    expect(disabled(`quickbooks-mapping-unlink-${ORG_ID}`)).toBe(false);
  });
});
