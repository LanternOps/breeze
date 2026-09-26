import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../../stores/auth", () => ({ fetchWithAuth: vi.fn() }));
const showToast = vi.fn();
vi.mock("../shared/Toast", () => ({ showToast: (a: unknown) => showToast(a) }));

import RemediateConfirmDialog, {
  TYPED_CONFIRM_THRESHOLD,
} from "./RemediateConfirmDialog";
import { fetchWithAuth } from "../../stores/auth";

const fetchMock = vi.mocked(fetchWithAuth);
const json = (payload: unknown, ok = true, status = ok ? 200 : 400): Response =>
  ({
    ok,
    status,
    json: async () => payload,
    text: async () => JSON.stringify(payload),
    headers: new Headers({ "content-type": "application/json" }),
  }) as unknown as Response;

const POLICY = { id: "pol-1", name: "Standard apps", mode: "allowlist" as const };
const id = (n: number) => `dev-${n}`;

function preview(deviceCount: number, overrides: Record<string, unknown> = {}) {
  const deviceIds = Array.from({ length: deviceCount }, (_, i) => id(i + 1));
  return {
    policy: POLICY,
    deviceIds,
    deviceCount,
    uninstallCount: deviceCount * 2,
    software: deviceCount ? [{ name: "Zoom", deviceCount }] : [],
    softwareDistinctCount: deviceCount ? 1 : 0,
    sampleDevices: deviceIds.slice(0, 10).map((d) => ({
      deviceId: d,
      hostname: `host-${d}`,
      uninstalls: [{ name: "Zoom", version: "5.1" }],
    })),
    totalTargetDevices: deviceCount,
    capped: false,
    maxDevices: 500,
    ...overrides,
  };
}

function renderDialog(onClose = vi.fn(), onQueued = vi.fn()) {
  render(
    <RemediateConfirmDialog
      open
      policy={POLICY}
      onClose={onClose}
      onQueued={onQueued}
    />,
  );
  return { onClose, onQueued };
}

const confirmButton = () => screen.getByTestId("confirm-software-remediate");
const remediateCalls = () =>
  fetchMock.mock.calls.filter(
    ([url, init]) =>
      url === `/software-policies/${POLICY.id}/remediate` &&
      (init as RequestInit | undefined)?.method === "POST",
  );

describe("RemediateConfirmDialog (#3616)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("loads the server preview and states the blast radius before anything is queued", async () => {
    fetchMock.mockResolvedValueOnce(json(preview(3)));
    renderDialog();

    const body = await screen.findByTestId("software-remediate-preview");
    expect(fetchMock).toHaveBeenCalledWith(
      `/software-policies/${POLICY.id}/remediate/preview`,
    );
    expect(body.textContent).toContain("3");
    expect(body.textContent).toContain("Standard apps");
    expect(body.textContent).toContain("Zoom");
    expect(body.textContent).toContain("host-dev-1");
    expect(remediateCalls()).toHaveLength(0);
  });

  it("confirms with exactly the previewed device ids, never an empty body", async () => {
    fetchMock.mockResolvedValueOnce(json(preview(2)));
    const { onQueued, onClose } = renderDialog();
    await screen.findByTestId("software-remediate-preview");

    fetchMock.mockResolvedValueOnce(json({ queued: 2, deviceIds: [id(1), id(2)] }));
    fireEvent.click(confirmButton());

    await waitFor(() => expect(remediateCalls()).toHaveLength(1));
    const init = remediateCalls()[0]![1] as RequestInit;
    expect(JSON.parse(String(init.body))).toEqual({ deviceIds: [id(1), id(2)] });
    await waitFor(() => expect(onQueued).toHaveBeenCalled());
    expect(onClose).toHaveBeenCalled();
    expect(showToast).toHaveBeenCalledWith(
      expect.objectContaining({ type: "success" }),
    );
  });

  it(`requires typing the device count at or above ${TYPED_CONFIRM_THRESHOLD} devices`, async () => {
    const count = TYPED_CONFIRM_THRESHOLD;
    fetchMock.mockResolvedValueOnce(json(preview(count)));
    renderDialog();
    await screen.findByTestId("software-remediate-preview");

    fireEvent.click(confirmButton());
    expect(remediateCalls()).toHaveLength(0);

    const input = screen.getByTestId("software-remediate-count");
    fireEvent.change(input, { target: { value: String(count - 1) } });
    fireEvent.click(confirmButton());
    expect(remediateCalls()).toHaveLength(0);

    fetchMock.mockResolvedValueOnce(json({ queued: count }));
    fireEvent.change(input, { target: { value: String(count) } });
    fireEvent.click(confirmButton());
    await waitFor(() => expect(remediateCalls()).toHaveLength(1));
  });

  it("disables confirm when the preview finds nothing to uninstall", async () => {
    fetchMock.mockResolvedValueOnce(json(preview(0)));
    renderDialog();
    await screen.findByTestId("software-remediate-empty");

    fireEvent.click(confirmButton());
    expect(remediateCalls()).toHaveLength(0);
  });

  it("disables confirm and says nothing was queued when the preview fails", async () => {
    fetchMock.mockResolvedValueOnce(json({ error: "boom" }, false, 500));
    renderDialog();
    await screen.findByTestId("software-remediate-preview-error");

    fireEvent.click(confirmButton());
    expect(remediateCalls()).toHaveLength(0);
  });

  it("warns when the qualifying set exceeds one run's cap", async () => {
    fetchMock.mockResolvedValueOnce(
      json(preview(2, { totalTargetDevices: 812, capped: true })),
    );
    renderDialog();
    const warning = await screen.findByTestId("software-remediate-capped");
    expect(warning.textContent).toContain("812");
    expect(warning.textContent).toContain("500");
  });

  it("keeps the dialog open and surfaces the error when the remediate call fails", async () => {
    fetchMock.mockResolvedValueOnce(json(preview(1)));
    const { onClose, onQueued } = renderDialog();
    await screen.findByTestId("software-remediate-preview");

    fetchMock.mockResolvedValueOnce(
      json({ error: "MFA required", code: "MFA_REQUIRED" }, false, 403),
    );
    fireEvent.click(confirmButton());

    await waitFor(() =>
      expect(showToast).toHaveBeenCalledWith(
        expect.objectContaining({ type: "error" }),
      ),
    );
    expect(onQueued).not.toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
  });
});
