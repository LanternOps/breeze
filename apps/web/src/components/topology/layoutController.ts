import { packTopologyLayout } from './layoutAdapter';
import { sameLayoutFence, type LayoutRequest, type LayoutResult } from './layoutTypes';
export type LayoutWorker = Pick<Worker, 'postMessage' | 'terminate' | 'onmessage' | 'onerror'>;
export class TopologyLayoutController {
  private worker?: LayoutWorker;
  private request?: LayoutRequest;
  private timer?: ReturnType<typeof setTimeout>;
  private finish?: (result: LayoutResult | null) => void;
  constructor(private createWorker: () => LayoutWorker = () => new Worker(new URL('./layout.worker.ts', import.meta.url), { type: 'module' })) {}
  accept(result: LayoutResult) { return !!this.request && sameLayoutFence(this.request, result); }
  cancel() {
    clearTimeout(this.timer); this.worker?.terminate(); this.worker = undefined;
    this.request = undefined; this.finish?.(null); this.finish = undefined;
  }
  run(request: LayoutRequest): Promise<LayoutResult | null> {
    this.cancel(); this.request = request;
    return new Promise((resolve) => {
      this.finish = resolve;
      const complete = (result: LayoutResult) => {
        if (!this.accept(result)) return;
        this.finish = undefined; this.cancel(); resolve(result);
      };
      const fallback = () => complete(packTopologyLayout(request, undefined, true));
      try {
        this.worker = this.createWorker();
        this.worker.onmessage = (event: MessageEvent<LayoutResult>) => complete(event.data);
        this.worker.onerror = fallback;
        this.timer = setTimeout(fallback, 3000);
        this.worker.postMessage(request);
      } catch { fallback(); }
    });
  }
}
