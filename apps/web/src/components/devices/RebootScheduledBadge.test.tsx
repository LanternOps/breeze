import "@/lib/i18n";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import RebootScheduledBadge from "./RebootScheduledBadge";

// #3207 W5 — console visibility for a scheduled end-user restart.

const NOW = new Date("2026-09-02T12:00:00.000Z");
const FUTURE = "2026-09-02T13:00:00.000Z";
const PAST = "2026-09-02T11:00:00.000Z";
const DEADLINE = "2026-09-02T16:00:00.000Z";

const scheduled = {
  rebootScheduledAt: FUTURE,
  rebootDeadline: DEADLINE,
  rebootSource: "patch_job",
  rebootDeferralsUsed: 0,
  rebootMaxDeferrals: 3,
};

function renderBadge(overrides: Record<string, unknown> = {}) {
  return render(
    <RebootScheduledBadge {...scheduled} {...overrides} now={NOW} />,
  );
}

describe("RebootScheduledBadge", () => {
  it("renders a scheduled-restart badge when the device reports one", () => {
    renderBadge();
    const badge = screen.getByTestId("device-reboot-scheduled");
    expect(badge).toBeInTheDocument();
    expect(badge).toHaveAttribute("data-reboot-state", "scheduled");
  });

  it("renders nothing when no restart is scheduled", () => {
    renderBadge({ rebootScheduledAt: null });
    expect(screen.queryByTestId("device-reboot-scheduled")).not.toBeInTheDocument();
  });

  it("renders nothing when the field is absent (older API response)", () => {
    renderBadge({ rebootScheduledAt: undefined });
    expect(screen.queryByTestId("device-reboot-scheduled")).not.toBeInTheDocument();
  });

  it("renders nothing for an unparseable timestamp rather than Invalid Date", () => {
    renderBadge({ rebootScheduledAt: "not-a-date" });
    expect(screen.queryByTestId("device-reboot-scheduled")).not.toBeInTheDocument();
  });

  it("shows the postponement count once the user has deferred", () => {
    renderBadge({ rebootDeferralsUsed: 2, rebootMaxDeferrals: 3 });
    const deferrals = screen.getByTestId("device-reboot-deferrals");
    expect(deferrals).toHaveTextContent("2");
    expect(deferrals).toHaveTextContent("3");
  });

  it("shows a zero-of-N count so a tech can see the budget before it is spent", () => {
    renderBadge({ rebootDeferralsUsed: 0, rebootMaxDeferrals: 3 });
    expect(screen.getByTestId("device-reboot-deferrals")).toHaveTextContent("0");
  });

  it("says the restart cannot be postponed when the budget is zero", () => {
    // maxDeferrals === 0 is a real statement about this restart, not missing
    // data — the policy did not grant a deferral budget.
    renderBadge({ rebootDeferralsUsed: 0, rebootMaxDeferrals: 0 });
    expect(screen.getByTestId("device-reboot-no-deferrals")).toBeInTheDocument();
    expect(screen.queryByTestId("device-reboot-deferrals")).not.toBeInTheDocument();
  });

  it("stays silent about deferrals when the agent never reported a budget", () => {
    // null is "this agent predates deferral reporting", which must NOT be
    // rendered as "cannot be postponed" — that would be a claim we cannot make.
    renderBadge({ rebootDeferralsUsed: null, rebootMaxDeferrals: null });
    expect(screen.getByTestId("device-reboot-scheduled")).toBeInTheDocument();
    expect(screen.queryByTestId("device-reboot-deferrals")).not.toBeInTheDocument();
    expect(screen.queryByTestId("device-reboot-no-deferrals")).not.toBeInTheDocument();
  });

  it("switches to a restarting state once the scheduled instant has passed", () => {
    renderBadge({ rebootScheduledAt: PAST });
    expect(screen.getByTestId("device-reboot-scheduled")).toHaveAttribute(
      "data-reboot-state",
      "restarting",
    );
  });

  it("names the source in the tooltip for every source the server sends", () => {
    for (const [source, expected] of [
      ["patch_job", "patch installation"],
      ["maintenance_window", "maintenance window"],
      ["manual", "technician"],
    ] as const) {
      const { unmount } = renderBadge({ rebootSource: source });
      expect(screen.getByTestId("device-reboot-scheduled").title).toContain(expected);
      unmount();
    }
  });

  it("falls back to a generic source label instead of rendering an unknown one raw", () => {
    // The source is echoed back by the agent, so an unrecognized value is
    // untrusted input. It must never reach the DOM verbatim.
    renderBadge({ rebootSource: "totally_new_source" });
    const badge = screen.getByTestId("device-reboot-scheduled");
    expect(badge.title).not.toContain("totally_new_source");
    expect(badge.title).toContain("Scheduled restart");
  });

  it("omits the deadline from the tooltip when the agent did not report one", () => {
    renderBadge({ rebootDeadline: null });
    expect(screen.getByTestId("device-reboot-scheduled").title).not.toContain(
      "Must restart by",
    );
  });

  it("includes the deadline in the tooltip when one exists", () => {
    renderBadge();
    expect(screen.getByTestId("device-reboot-scheduled").title).toContain(
      "Must restart by",
    );
  });
});
