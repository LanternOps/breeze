// Pure helpers for the Deep telemetry card (UniFi Wi-Fi spec §10 / §14.5).
import type { RadioOverview, RadioStatistics } from "./unifiTypes";

export interface RadioRow {
  frequencyGHz: number;
  channel: number | null;
  channelWidthMHz: number | null;
  wlanStandard: string | null;
  // null = unknown / not joinable. Zero is a measured value and is preserved.
  txRetriesPct: number | null;
}

/**
 * Join radio overview with radio statistics by frequency, ONLY when the
 * frequency is unique on both sides. Never joins by position. Unpaired
 * overview radios keep txRetriesPct null; unpaired statistics are returned
 * as retries-only rows (no channel/width/standard).
 */
export function joinRadios(
  overview: RadioOverview[] | null | undefined,
  statistics: RadioStatistics[] | null | undefined,
): RadioRow[] {
  const ov = overview ?? [];
  const st = statistics ?? [];
  const count = (arr: Array<{ frequencyGHz: number }>, f: number) =>
    arr.filter((r) => r.frequencyGHz === f).length;
  const rows: RadioRow[] = [];
  for (const o of ov) {
    const joinable =
      count(ov, o.frequencyGHz) === 1 && count(st, o.frequencyGHz) === 1;
    const match = joinable
      ? st.find((s) => s.frequencyGHz === o.frequencyGHz)
      : undefined;
    rows.push({
      frequencyGHz: o.frequencyGHz,
      channel: o.channel ?? null,
      channelWidthMHz: o.channelWidthMHz ?? null,
      wlanStandard: o.wlanStandard ?? null,
      txRetriesPct: match?.txRetriesPct ?? null,
    });
  }
  for (const s of st) {
    const joined =
      count(ov, s.frequencyGHz) === 1 && count(st, s.frequencyGHz) === 1;
    if (joined) continue;
    rows.push({
      frequencyGHz: s.frequencyGHz,
      channel: null,
      channelWidthMHz: null,
      wlanStandard: null,
      txRetriesPct: s.txRetriesPct ?? null,
    });
  }
  return rows;
}
