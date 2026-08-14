/**
 * <workspace-device-index> — the Workspace tab on a device's detail page.
 *
 * Renders ONLY the five aggregate fields the device-summary endpoint exposes.
 * Never widen this to filenames, paths, or credential state — the server's
 * projection and the API client's projection both enforce the same boundary,
 * and this element is the third copy of that rule.
 */
import {
  parseDeviceDetailTabContextV1,
  dispatchExtensionHostEvent,
  type DeviceDetailTabContextV1,
} from '@breeze/extension-web-sdk';
import { createWorkspaceApi, WorkspaceApiError, type WorkspaceApi } from './api';
import { WorkspaceBaseElement } from './baseElement';

function formatTimestamp(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleString();
}

export class WorkspaceDeviceIndex extends WorkspaceBaseElement {
  #api: WorkspaceApi = createWorkspaceApi();
  #context: DeviceDetailTabContextV1 | null = null;

  set context(value: unknown) {
    let parsed: DeviceDetailTabContextV1;
    try {
      parsed = parseDeviceDetailTabContextV1(value);
    } catch {
      this.#context = null;
      // Malformed host context: render the failure, make NO network call.
      this.renderError('Workspace received an invalid host context.');
      return;
    }
    this.#context = parsed;
    this.track(this.#load());
  }

  get context(): DeviceDetailTabContextV1 | null {
    return this.#context;
  }

  async #load(): Promise<void> {
    if (!this.#context) return;
    this.renderStatus('Loading device index…');
    let summary;
    try {
      summary = await this.#api.getDeviceSummary(
        this.#context.organizationId,
        this.#context.deviceId,
        { signal: this.signal },
      );
    } catch (error) {
      if (error instanceof WorkspaceApiError && error.kind === 'aborted') return;
      if (error instanceof WorkspaceApiError && error.kind === 'not-found') {
        this.clearContent();
        this.root.append(this.el('p', {
          text: 'This device has no Workspace index yet.',
          className: 'muted',
          attrs: { role: 'status' },
        }));
        return;
      }
      const message = error instanceof WorkspaceApiError && error.kind === 'unauthorized'
        ? 'You are not authorized to view this device’s Workspace index.'
        : 'The Workspace index for this device could not be loaded.';
      this.renderError(message, () => this.track(this.#load()));
      return;
    }

    this.clearContent();
    const stats = this.el('ul', { className: 'stats' }, [
      this.el('li', { text: `${summary.indexedFiles} indexed files` }),
      this.el('li', { text: `${summary.visibleSources} visible sources` }),
      this.el('li', { text: `Last successful crawl: ${formatTimestamp(summary.lastSuccessfulCrawlAt)}` }),
      this.el('li', { text: `Last activity: ${formatTimestamp(summary.lastActivityAt)}` }),
    ]);
    const manage = this.el('button', { text: 'Manage sources', attrs: { type: 'button' } });
    manage.addEventListener('click', () => {
      // Navigation goes through the typed host event — never window.location.
      dispatchExtensionHostEvent(this, {
        version: 1,
        type: 'navigate',
        path: '/extensions/workspace/sources',
      });
    });
    this.root.append(this.el('h2', { text: 'Workspace index' }), stats, manage);
  }
}
