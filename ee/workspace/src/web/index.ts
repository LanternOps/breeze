/**
 * Workspace web entry: registers both Custom Elements, idempotently.
 *
 * This module has no side effects beyond element definitions — no API calls,
 * no timers, no DOM mutation. The host may load the entry more than once
 * (see the testkit's web idempotency probe), so every definition is guarded
 * by customElements.get().
 */
import { WorkspaceDeviceIndex } from './deviceIndex';
import { WorkspaceSourcesPage } from './sourcesPage';

export function defineWorkspaceElements(): void {
  if (!customElements.get('workspace-sources-page')) {
    customElements.define('workspace-sources-page', WorkspaceSourcesPage);
  }
  if (!customElements.get('workspace-device-index')) {
    customElements.define('workspace-device-index', WorkspaceDeviceIndex);
  }
}

defineWorkspaceElements();

export { WorkspaceSourcesPage } from './sourcesPage';
export { WorkspaceDeviceIndex } from './deviceIndex';
