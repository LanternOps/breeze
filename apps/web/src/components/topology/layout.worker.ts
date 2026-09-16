import { computeTopologyLayout, packTopologyLayout } from './layoutAdapter';
import type { LayoutRequest } from './layoutTypes';
const worker = self as unknown as { onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null; postMessage: (result: unknown) => void };
worker.onmessage = async ({ data }) => {
  try { worker.postMessage(await computeTopologyLayout(data)); }
  catch { worker.postMessage(packTopologyLayout(data, undefined, true)); }
};
