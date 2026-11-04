import { describe, it, expect } from "vitest";
import { render, screen, within } from "@testing-library/react";
import TelemetryViewerCard from "./TelemetryViewerCard";
import { joinRadios } from "./telemetryRadios";
import type { TelemetryDevice } from "./unifiTypes";

const base: TelemetryDevice = {
  id: "d1",
  unifiDeviceId: "u1",
  name: "AP-1",
  mac: "aa:bb",
  uptimeSeconds: 90000,
  numClients: 3,
  isStale: false,
  poePorts: null,
};

function renderCard(
  device: Partial<TelemetryDevice>,
  over: { loading?: boolean; error?: string | null; empty?: boolean } = {},
) {
  return render(
    <TelemetryViewerCard
      telemetrySite="s1"
      sitesByOrg={[]}
      telemetryLoading={over.loading ?? false}
      telemetryError={over.error ?? null}
      telemetry={{ devices: over.empty ? [] : [{ ...base, ...device }], clients: [] }}
      onLoadTelemetry={() => {}}
    />,
  );
}

describe("joinRadios", () => {
  it("joins when frequency is unique on both sides", () => {
    const rows = joinRadios(
      [{ frequencyGHz: 5, channel: 36, channelWidthMHz: 80, wlanStandard: "ax" }],
      [{ frequencyGHz: 5, txRetriesPct: 0 }],
    );
    expect(rows).toEqual([
      { frequencyGHz: 5, channel: 36, channelWidthMHz: 80, wlanStandard: "ax", txRetriesPct: 0 },
    ]);
  });
  it("does not join duplicated frequencies; never by position", () => {
    const rows = joinRadios(
      [
        { frequencyGHz: 5, channel: 36, channelWidthMHz: 80, wlanStandard: "ax" },
        { frequencyGHz: 5, channel: 100, channelWidthMHz: 40, wlanStandard: "ax" },
      ],
      [{ frequencyGHz: 5, txRetriesPct: 7 }],
    );
    expect(rows).toHaveLength(3);
    expect(rows.slice(0, 2).every((r) => r.txRetriesPct === null)).toBe(true);
    expect(rows[2]).toMatchObject({ frequencyGHz: 5, txRetriesPct: 7, channel: null });
  });
  it("keeps unpaired overview radios without retries and unpaired stats alone", () => {
    const rows = joinRadios(
      [{ frequencyGHz: 2.4, channel: 1, channelWidthMHz: 20, wlanStandard: "n" }],
      [{ frequencyGHz: 6, txRetriesPct: 2 }],
    );
    expect(rows[0]).toMatchObject({ frequencyGHz: 2.4, txRetriesPct: null });
    expect(rows[1]).toMatchObject({ frequencyGHz: 6, txRetriesPct: 2, channel: null });
  });
  it("tolerates null/undefined inputs", () => {
    expect(joinRadios(null, undefined)).toEqual([]);
  });
});

describe("TelemetryViewerCard", () => {
  it("renders — for absent values and never invents 0", () => {
    renderCard({ uptimeSeconds: null });
    expect(screen.getByTestId("unifi-telemetry-online")).toHaveTextContent("—");
    expect(screen.getByTestId("unifi-telemetry-cpu")).toHaveTextContent("CPU: —");
    expect(screen.getByTestId("unifi-telemetry-mem")).toHaveTextContent("Memory: —");
    expect(screen.getByTestId("unifi-telemetry-wireless-clients")).toHaveTextContent(": —");
    expect(screen.getByTestId("unifi-telemetry-uptime")).toHaveTextContent(": —");
    expect(screen.queryByTestId("unifi-telemetry-stale-uplink")).toBeNull();
  });

  it("renders measured zeros as 0 and the exact 'wireless clients' label", () => {
    renderCard({
      online: true,
      wifiCapable: true,
      controllerState: "ONLINE",
      cpuPct: 0,
      memPct: 0,
      wirelessClientCount: 0,
      radioOverview: [{ frequencyGHz: 5, channel: 36, channelWidthMHz: 80, wlanStandard: "ax" }],
      radioStatistics: [{ frequencyGHz: 5, txRetriesPct: 0 }],
    });
    expect(screen.getByTestId("unifi-telemetry-online")).toHaveTextContent("Online");
    expect(screen.getByTestId("unifi-telemetry-wireless-clients")).toHaveTextContent(
      "wireless clients: 0",
    );
    expect(screen.getByTestId("unifi-telemetry-cpu")).toHaveTextContent("CPU: 0%");
    expect(screen.getByTestId("unifi-telemetry-mem")).toHaveTextContent("Memory: 0%");
    expect(screen.getByTestId("unifi-telemetry-radio-retries")).toHaveTextContent("0%");
    const radio = screen.getByTestId("unifi-telemetry-radio");
    expect(within(radio).getByText(/36/)).toBeTruthy();
  });

  it("shows last reported / stale + time for offline AP with positive uplink rate", () => {
    renderCard({
      online: false,
      uplinkRxRateBps: 5_000_000,
      uplinkTxRateBps: 0,
      wifiStatisticsObservedAt: new Date(Date.now() - 5 * 60_000).toISOString(),
    });
    expect(screen.getByTestId("unifi-telemetry-online")).toHaveTextContent("Offline");
    const stale = screen.getByTestId("unifi-telemetry-stale-uplink");
    expect(stale).toHaveTextContent("Last reported / stale");
    expect(stale.textContent).toMatch(/·\s*\S+/);
    expect(screen.getByTestId("unifi-telemetry-uplink")).toHaveTextContent("Uplink TX: 0 Mbps");
  });

  it("no stale label when offline with zero/absent uplink or when online", () => {
    renderCard({ online: false, uplinkRxRateBps: 0, uplinkTxRateBps: null });
    expect(screen.queryByTestId("unifi-telemetry-stale-uplink")).toBeNull();
  });

  const radioFixture = {
    radioOverview: [{ frequencyGHz: 5, channel: 36, channelWidthMHz: 80, wlanStandard: "ax" }],
    radioStatistics: [{ frequencyGHz: 5, txRetriesPct: 0 }],
  };

  it("hides the radio line for non wifi-capable devices (false/undefined)", () => {
    const a = renderCard({ wifiCapable: false, ...radioFixture });
    expect(screen.queryByTestId("unifi-telemetry-radios")).toBeNull();
    a.unmount();
    renderCard({ ...radioFixture });
    expect(screen.queryByTestId("unifi-telemetry-radios")).toBeNull();
  });

  it("shows the radio line for wifi-capable AP with radios", () => {
    renderCard({ wifiCapable: true, ...radioFixture });
    expect(screen.getByTestId("unifi-telemetry-radios")).toBeTruthy();
  });

  it("shows 'As of' + time when the row is stale and not the offline-uplink case", () => {
    renderCard({
      online: true,
      isStale: true,
      wifiStatisticsObservedAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    });
    const asOf = screen.getByTestId("unifi-telemetry-as-of");
    expect(asOf).toHaveTextContent(/^As of\s+\S+/);
    expect(screen.queryByTestId("unifi-telemetry-stale-uplink")).toBeNull();
  });

  it("offline + positive uplink keeps lastReportedStale and not the as-of label", () => {
    renderCard({
      online: false,
      isStale: true,
      uplinkRxRateBps: 1_000_000,
      wifiStatisticsObservedAt: new Date(Date.now() - 60_000).toISOString(),
    });
    expect(screen.getByTestId("unifi-telemetry-stale-uplink")).toHaveTextContent(
      "Last reported / stale",
    );
    expect(screen.queryByTestId("unifi-telemetry-as-of")).toBeNull();
  });

  it("shows neither label when not stale", () => {
    renderCard({
      online: true,
      isStale: false,
      wifiStatisticsObservedAt: new Date().toISOString(),
    });
    expect(screen.queryByTestId("unifi-telemetry-as-of")).toBeNull();
    expect(screen.queryByTestId("unifi-telemetry-stale-uplink")).toBeNull();
  });

  it("keeps loading / error / empty states", () => {
    const a = renderCard({}, { loading: true });
    expect(screen.getByTestId("unifi-telemetry-loading")).toBeTruthy();
    a.unmount();
    const b = renderCard({}, { error: "boom" });
    expect(screen.getByTestId("unifi-telemetry-error")).toHaveTextContent("boom");
    b.unmount();
    renderCard({}, { empty: true });
    expect(screen.getByTestId("unifi-telemetry-devices-empty")).toBeTruthy();
  });
});
