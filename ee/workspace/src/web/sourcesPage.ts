/**
 * <workspace-sources-page> — the Workspace sources administration page.
 *
 * The host assigns `context` (ExtensionPageContextV1); everything else is
 * fetched through the safe API client. All API data reaches the DOM as
 * textContent via `el()` — never markup. Mutations announce themselves to the
 * host through typed toast events.
 */
import {
  parseExtensionPageContextV1,
  dispatchExtensionHostEvent,
  type ExtensionPageContextV1,
} from '@breeze/extension-web-sdk';
import {
  createWorkspaceApi,
  WorkspaceApiError,
  type SourceInput,
  type SourceRow,
  type WorkspaceApi,
} from './api';
import { WorkspaceBaseElement } from './baseElement';

type FormMode =
  | { kind: 'closed' }
  | { kind: 'create' }
  | { kind: 'edit'; source: SourceRow };

function formatTimestamp(value: string | null): string {
  if (!value) return 'never';
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? 'never' : date.toLocaleString();
}

export class WorkspaceSourcesPage extends WorkspaceBaseElement {
  #api: WorkspaceApi = createWorkspaceApi();
  #context: ExtensionPageContextV1 | null = null;
  #sources: SourceRow[] = [];
  #form: FormMode = { kind: 'closed' };
  #confirmingDelete: string | null = null;
  #formKind = 'smb_share';
  /**
   * Live field values captured before a mid-edit re-render (the Kind switch
   * rebuilds the form). Without this, toggling Kind silently wiped every
   * typed value — including a credential, which then never reached
   * setCredential and the source saved credential-less under a success toast.
   */
  #draft: Record<string, string> | null = null;

  set context(value: unknown) {
    let parsed: ExtensionPageContextV1;
    try {
      parsed = parseExtensionPageContextV1(value);
    } catch {
      this.#context = null;
      // Malformed host context: render the failure, make NO network call.
      this.renderError('Workspace received an invalid host context.');
      return;
    }
    this.#context = parsed;
    this.track(this.#load());
  }

  get context(): ExtensionPageContextV1 | null {
    return this.#context;
  }

  async #load(): Promise<void> {
    if (!this.#context) return;
    this.renderStatus('Loading sources…');
    try {
      this.#sources = await this.#api.listSources(this.#context.organizationId, {
        signal: this.signal,
      });
    } catch (error) {
      if (error instanceof WorkspaceApiError && error.kind === 'aborted') return;
      const message = error instanceof WorkspaceApiError && error.kind === 'unauthorized'
        ? 'You are not authorized to manage Workspace sources.'
        : 'Workspace sources could not be loaded.';
      this.renderError(message, () => this.track(this.#load()));
      return;
    }
    this.#render();
  }

  #toast(tone: 'success' | 'error', message: string): void {
    dispatchExtensionHostEvent(this, { version: 1, type: 'toast', tone, message });
  }

  #render(): void {
    this.clearContent();
    const heading = this.el('h1', { text: 'Workspace Sources' });
    const addButton = this.el('button', { text: 'Add source', attrs: { type: 'button' } });
    addButton.addEventListener('click', () => {
      this.#form = this.#form.kind === 'create' ? { kind: 'closed' } : { kind: 'create' };
      this.#formKind = 'smb_share';
      this.#draft = null;
      this.#render();
    });
    this.root.append(heading, addButton);

    if (this.#form.kind !== 'closed') this.root.append(this.#renderForm());

    if (this.#sources.length === 0) {
      this.root.append(this.el('p', {
        text: 'No sources yet. Add one to start indexing.',
        className: 'muted',
        attrs: { role: 'status' },
      }));
      return;
    }
    this.root.append(this.#renderTable());
  }

  #renderTable(): HTMLTableElement {
    const head = this.el('tr', {}, [
      this.el('th', { text: 'Name' }),
      this.el('th', { text: 'Kind' }),
      this.el('th', { text: 'Path' }),
      this.el('th', { text: 'Status' }),
      this.el('th', { text: 'Last crawl' }),
      this.el('th', { text: 'Credential' }),
      this.el('th', { text: 'Actions' }),
    ]);
    const rows = this.#sources.map((source) => this.#renderRow(source));
    return this.el('table', {}, [this.el('thead', {}, [head]), this.el('tbody', {}, rows)]);
  }

  #renderRow(source: SourceRow): HTMLTableRowElement {
    const actions = this.el('div', { className: 'row-actions' });
    if (this.#confirmingDelete === source.id) {
      const confirm = this.el('button', {
        text: 'Confirm delete',
        className: 'danger',
        attrs: { type: 'button' },
      });
      confirm.addEventListener('click', () => this.track(this.#deleteSource(source)));
      const cancel = this.el('button', { text: 'Cancel', attrs: { type: 'button' } });
      cancel.addEventListener('click', () => {
        this.#confirmingDelete = null;
        this.#render();
      });
      actions.append(confirm, cancel);
    } else {
      const edit = this.el('button', { text: 'Edit', attrs: { type: 'button' } });
      edit.addEventListener('click', () => {
        this.#form = { kind: 'edit', source };
        this.#formKind = source.kind;
        this.#draft = null;
        this.#render();
      });
      const remove = this.el('button', {
        text: 'Delete',
        className: 'danger',
        attrs: { type: 'button' },
      });
      remove.addEventListener('click', () => {
        this.#confirmingDelete = source.id;
        this.#render();
      });
      actions.append(edit, remove);
    }

    const status = source.errorReason ? `${source.status} (error)` : source.status;
    return this.el('tr', {}, [
      this.el('td', { text: source.displayName }),
      this.el('td', { text: source.kind }),
      this.el('td', { text: source.rootPath }),
      this.el('td', { text: status }),
      this.el('td', { text: formatTimestamp(source.lastCompleteRunAt) }),
      this.el('td', { text: source.hasCredential ? 'set' : 'none' }),
      this.el('td', {}, [actions]),
    ]);
  }

  #renderForm(): HTMLFormElement {
    const editing = this.#form.kind === 'edit' ? this.#form.source : null;
    const form = this.el('form', { attrs: { 'aria-label': editing ? 'Edit source' : 'Create source' } });

    const input = (
      name: string,
      label: string,
      value: string,
      attrs: Record<string, string> = {},
    ): HTMLLabelElement => {
      const field = this.el('input', { attrs: { name, ...attrs } });
      field.value = value;
      return this.el('label', { text: label }, [field]);
    };

    const kindSelect = this.el('select', { attrs: { name: 'kind' } });
    for (const kind of ['smb_share', 'local_profile']) {
      const option = this.el('option', { text: kind, attrs: { value: kind } });
      if (kind === this.#formKind) option.setAttribute('selected', '');
      kindSelect.append(option);
    }
    kindSelect.addEventListener('change', () => {
      // Capture live values before the rebuild, or the switch discards
      // everything the user typed (see #draft). Merge, don't replace: a form
      // variant that omits some fields (local_folder has no SMB fields) must
      // not wipe the values captured for them on an earlier switch.
      this.#draft = { ...this.#draft, ...this.#captureDraft(form) };
      this.#formKind = kindSelect.value;
      this.#render();
    });

    const seed = (name: string, fallback: string): string => this.#draft?.[name] ?? fallback;

    form.append(
      this.el('h2', { text: editing ? `Edit ${editing.displayName}` : 'New source' }),
      input('displayName', 'Display name', seed('displayName', editing?.displayName ?? '')),
      this.el('label', { text: 'Kind' }, [kindSelect]),
      input('rootPath', 'Root path', seed('rootPath', editing?.rootPath ?? '')),
    );
    if (this.#formKind === 'smb_share') {
      // Type-specific SMB fields: the crawl device and the share credential.
      form.append(
        input('crawlDeviceId', 'Crawl device id', seed('crawlDeviceId', editing?.crawlDeviceId ?? '')),
        input('credentialUsername', 'Credential username', seed('credentialUsername', ''), { autocomplete: 'off' }),
        input('credentialPassword', 'Credential password', seed('credentialPassword', ''), {
          type: 'password',
          autocomplete: 'new-password',
        }),
        input('credentialDomain', 'Credential domain', seed('credentialDomain', ''), { autocomplete: 'off' }),
      );
    }
    form.append(
      input('crawlCadenceMinutes', 'Crawl cadence (minutes)', seed('crawlCadenceMinutes', String(editing?.crawlCadenceMinutes ?? 1440)), { type: 'number', min: '1' }),
      this.el('button', { text: editing ? 'Save changes' : 'Create source', attrs: { type: 'submit' } }),
    );

    form.addEventListener('submit', (event) => {
      event.preventDefault();
      this.track(this.#submitForm(form, editing));
    });
    return form;
  }

  #captureDraft(form: HTMLFormElement): Record<string, string> {
    const draft: Record<string, string> = {};
    for (const field of form.querySelectorAll<HTMLInputElement | HTMLSelectElement>('[name]')) {
      draft[field.getAttribute('name')!] = field.value;
    }
    return draft;
  }

  #readForm(form: HTMLFormElement): SourceInput & {
    credential: { username: string; password: string; domain: string };
  } {
    const value = (name: string): string =>
      (form.querySelector(`[name="${name}"]`) as HTMLInputElement | HTMLSelectElement | null)?.value ?? '';
    // The server schema is strict AND total: every field below is required,
    // so the page supplies the fixed defaults for what the form doesn't ask.
    return {
      kind: value('kind'),
      displayName: value('displayName'),
      rootPath: value('rootPath'),
      crawlDeviceId: value('crawlDeviceId') || null,
      crawlCadenceMinutes: Number(value('crawlCadenceMinutes')) || 1440,
      visibilityGroupIds: [],
      excludeGlobs: [],
      watch: true,
      status: 'active',
      credential: {
        username: value('credentialUsername'),
        password: value('credentialPassword'),
        domain: value('credentialDomain'),
      },
    };
  }

  #clearCredentialFields(form: HTMLFormElement): void {
    // Secrets never linger in the DOM after submit — success or failure.
    for (const name of ['credentialUsername', 'credentialPassword', 'credentialDomain']) {
      const field = form.querySelector(`[name="${name}"]`) as HTMLInputElement | null;
      if (field) field.value = '';
    }
  }

  async #submitForm(form: HTMLFormElement, editing: SourceRow | null): Promise<void> {
    if (!this.#context) return;
    const orgId = this.#context.organizationId;
    const { credential, ...fields } = this.#readForm(form);
    try {
      let saved: SourceRow;
      if (editing) {
        saved = await this.#api.updateSource(orgId, editing.id, fields, { signal: this.signal });
      } else {
        saved = await this.#api.createSource(orgId, fields, { signal: this.signal });
      }
      if (credential.username && credential.password) {
        await this.#api.setCredential(orgId, saved.id, {
          username: credential.username,
          password: credential.password,
          ...(credential.domain ? { domain: credential.domain } : {}),
        }, { signal: this.signal });
      }
      this.#clearCredentialFields(form);
      this.#draft = null;
      this.#form = { kind: 'closed' };
      this.#toast('success', editing ? 'Source updated.' : 'Source created.');
      await this.#load();
    } catch (error) {
      this.#clearCredentialFields(form);
      this.#draft = null;
      if (error instanceof WorkspaceApiError && error.kind === 'aborted') return;
      this.#toast('error', editing ? 'Source update failed.' : 'Source creation failed.');
    }
  }

  async #deleteSource(source: SourceRow): Promise<void> {
    if (!this.#context) return;
    try {
      await this.#api.deleteSource(this.#context.organizationId, source.id, { signal: this.signal });
      this.#confirmingDelete = null;
      this.#toast('success', 'Source deleted.');
      await this.#load();
    } catch (error) {
      if (error instanceof WorkspaceApiError && error.kind === 'aborted') return;
      this.#toast('error', 'Source deletion failed.');
    }
  }
}
