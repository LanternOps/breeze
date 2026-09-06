import "@/lib/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import UninstallStateBadge from "./UninstallStateBadge";
import type { Device } from "./DeviceList";

// #3987 item 7 — what happened to the agent-uninstall a Remove queued.

const NOW = new Date("2026-09-05T12:00:00.000Z");
const EXPIRES = "2026-09-08T12:00:00.000Z"; // exactly 3 days out

function renderBadge(
  uninstall: Device["uninstall"],
  overrides: { status?: string; compact?: boolean } = {},
) {
  return render(
    <UninstallStateBadge
      uninstall={uninstall}
      status={overrides.status ?? "decommissioned"}
      compact={overrides.compact}
      now={NOW}
    />,
  );
}

const base = {
  queuedAt: "2026-09-05T10:00:00.000Z",
  sentAt: null,
  completedAt: null,
  expiresAt: null,
};

describe("UninstallStateBadge", () => {
  it("reports a queued uninstall with its deadline", () => {
    renderBadge({ ...base, state: "pending", expiresAt: EXPIRES });

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveAttribute("data-state", "pending");
    expect(badge).toHaveTextContent("queued");
    // The deadline is what makes this actionable — "queued" alone does not
    // tell a tech whether to wait or to go touch the machine.
    expect(badge).toHaveTextContent("in 3 days");
  });

  it("falls back to deadline-free copy when the row carries no expiry", () => {
    renderBadge({ ...base, state: "pending", expiresAt: null });

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveAttribute("data-state", "pending");
    expect(badge).toHaveTextContent("queued");
    expect(badge).not.toHaveTextContent("in ");
  });

  it("falls back to deadline-free copy when the deadline has already passed", () => {
    // The reaper has not swept it yet, but "expires in -2 hours" is nonsense
    // and "expires now" would be a lie about a window that is already shut.
    renderBadge({ ...base, state: "pending", expiresAt: "2026-09-05T10:00:00.000Z" });

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveTextContent("queued");
    expect(badge).not.toHaveTextContent("in ");
  });

  it("says delivered — never uninstalled — for a dispatched command", () => {
    // `sent` means the agent's handler acked the command, NOT that the
    // teardown finished. Claiming "uninstalled" here would tell an operator
    // the endpoint is clean when it may not be (see #3995).
    renderBadge({ ...base, state: "sent", sentAt: "2026-09-05T11:00:00.000Z" });

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveAttribute("data-state", "sent");
    expect(badge).toHaveTextContent("delivered");
    expect(badge.textContent?.toLowerCase()).not.toContain("uninstalled");
  });

  it("claims teardown only for a completed command", () => {
    renderBadge({ ...base, state: "completed", completedAt: "2026-09-05T11:00:30.000Z" });

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveAttribute("data-state", "completed");
    expect(badge).toHaveTextContent("Agent uninstalled");
  });

  it("warns that an expired uninstall may still be installed", () => {
    renderBadge({ ...base, state: "expired" });

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveAttribute("data-state", "expired");
    expect(badge).toHaveTextContent("expired");
    expect(badge).toHaveTextContent("still be installed");
    // Tone carries the warning as much as the words do.
    expect(badge.className).toContain("warning");
  });

  it("renders the failed state", () => {
    renderBadge({ ...base, state: "failed" });

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveAttribute("data-state", "failed");
    expect(badge).toHaveTextContent("failed");
    expect(badge.className).toContain("warning");
  });

  it("renders the cancelled state", () => {
    renderBadge({ ...base, state: "cancelled" });

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveAttribute("data-state", "cancelled");
    expect(badge).toHaveTextContent("cancelled");
  });

  it("says the agent was left installed when the Remove queued nothing", () => {
    renderBadge(null);

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveAttribute("data-state", "none");
    expect(badge).toHaveTextContent("left installed");
  });

  it("renders nothing when the field is absent (a list row, not the detail payload)", () => {
    // `uninstall` only rides on GET /devices/:id. A list row has no such
    // field, and rendering "Agent was left installed" there would be an
    // outright false claim about every removed device on the page — hence
    // undefined and null must NOT collapse to the same branch.
    renderBadge(undefined);

    expect(screen.queryByTestId("uninstall-state")).not.toBeInTheDocument();
  });

  it("renders nothing for a device that is not removed", () => {
    renderBadge({ ...base, state: "pending", expiresAt: EXPIRES }, { status: "online" });

    expect(screen.queryByTestId("uninstall-state")).not.toBeInTheDocument();
  });

  it("drops the pill chrome in compact mode but keeps the state readable", () => {
    renderBadge({ ...base, state: "expired" }, { compact: true });

    const badge = screen.getByTestId("uninstall-state");
    expect(badge).toHaveAttribute("data-state", "expired");
    expect(badge).toHaveTextContent("still be installed");
    expect(badge.className).not.toContain("rounded-full");
  });

  it("ignores an unrecognised state rather than rendering a raw translation key", () => {
    // Defense in depth: the API closes this union already, but a stale client
    // against a newer server must not paint "uninstallState.somethingNew"
    // across the device header.
    renderBadge({ ...base, state: "something-new" } as Device["uninstall"]);

    expect(screen.queryByTestId("uninstall-state")).not.toBeInTheDocument();
  });
});
