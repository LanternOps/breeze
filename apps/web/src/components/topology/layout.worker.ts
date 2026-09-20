import ELK from 'elkjs/lib/elk-api';
import { computeTopologyLayout, packTopologyLayout } from './layoutAdapter';
import type { LayoutRequest } from './layoutTypes';
// elk.bundled's synchronous fake worker assumes a document global. Inside a
// real worker use ELK's supported Worker transport, with its GWT engine bundled
// as a second same-origin module worker. No DOM shim, CDN, or Node transport.
const engine = new ELK({ workerFactory: () => new Worker(new URL('./elkEngine.worker.ts', import.meta.url), { type: 'module' }) });
const worker = self as unknown as { onmessage: ((event: MessageEvent<LayoutRequest>) => void) | null; postMessage: (result: unknown) => void };
worker.onmessage = async ({ data }) => {
  try { worker.postMessage(await computeTopologyLayout(data, engine)); }
  catch { worker.postMessage(packTopologyLayout(data, undefined, true)); }
};
