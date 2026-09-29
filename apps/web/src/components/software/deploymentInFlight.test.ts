import { describe, expect, it } from "vitest";
import {
  SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS,
  SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS,
} from "@breeze/shared";

import { describeInFlight } from "./deploymentInFlight";

const NOW = Date.parse("2026-09-28T12:00:00Z");
const minutesAgo = (m: number) => new Date(NOW - m * 60_000).toISOString();

const pending = {
  status: "pending",
  queuedOffline: false,
  sentAt: minutesAgo(10),
  agentStage: null as string | null,
  agentStageAt: null as string | null,
};

describe("describeInFlight (#3578)", () => {
  it("is null for a row that is not in flight", () => {
    expect(describeInFlight({ ...pending, status: "completed" }, NOW)).toBeNull();
    expect(describeInFlight({ ...pending, queuedOffline: true }, NOW)).toBeNull();
    // Never handed to an agent (scheduled / queued before dispatch).
    expect(describeInFlight({ ...pending, sentAt: null }, NOW)).toBeNull();
  });

  it("falls back to 'sent' timed from the send for agents that report no stage", () => {
    expect(describeInFlight(pending, NOW)).toEqual({
      stage: "sent",
      elapsedMinutes: 10,
      silent: false,
    });
  });

  it("times a reported stage from when the agent reported it", () => {
    expect(
      describeInFlight(
        { ...pending, sentAt: minutesAgo(20), agentStage: "installing", agentStageAt: minutesAgo(4) },
        NOW,
      ),
    ).toEqual({ stage: "installing", elapsedMinutes: 4, silent: false });
  });

  it("flags a download the agent has been quiet on past its download ceiling", () => {
    const ceilingMin = SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS / 60_000;
    const under = describeInFlight(
      { ...pending, agentStage: "downloading", agentStageAt: minutesAgo(ceilingMin - 1) },
      NOW,
    );
    const over = describeInFlight(
      { ...pending, agentStage: "downloading", agentStageAt: minutesAgo(ceilingMin + 1) },
      NOW,
    );
    expect(under?.silent).toBe(false);
    expect(over).toEqual({ stage: "downloading", elapsedMinutes: ceilingMin + 1, silent: true });
  });

  it("gives the installer its own, longer ceiling", () => {
    const installMin = SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS / 60_000;
    expect(
      describeInFlight({ ...pending, agentStage: "installing", agentStageAt: minutesAgo(installMin - 1) }, NOW)
        ?.silent,
    ).toBe(false);
    expect(
      describeInFlight({ ...pending, agentStage: "installing", agentStageAt: minutesAgo(installMin + 1) }, NOW)
        ?.silent,
    ).toBe(true);
  });

  it("allows an agent with no stage reporting the agent's whole budget before flagging", () => {
    const totalMin =
      (SOFTWARE_INSTALL_DOWNLOAD_TIMEOUT_MS + SOFTWARE_INSTALL_INSTALLER_TIMEOUT_MS) / 60_000;
    expect(describeInFlight({ ...pending, sentAt: minutesAgo(totalMin - 1) }, NOW)?.silent).toBe(false);
    expect(describeInFlight({ ...pending, sentAt: minutesAgo(totalMin + 1) }, NOW)?.silent).toBe(true);
  });

  it("treats a stage this UI does not know as generically running", () => {
    expect(
      describeInFlight({ ...pending, agentStage: "verifying", agentStageAt: minutesAgo(2) }, NOW),
    ).toEqual({ stage: "running", elapsedMinutes: 2, silent: false });
  });

  it("never reports negative elapsed time under client clock skew", () => {
    expect(describeInFlight({ ...pending, sentAt: new Date(NOW + 90_000).toISOString() }, NOW)?.elapsedMinutes).toBe(0);
  });
});
