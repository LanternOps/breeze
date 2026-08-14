/**
 * <workspace-filing-card> — the Outlook add-in pane's filing card.
 *
 * Mounted by the generic client-panel host (Task 5's `ExtensionPanelHost`)
 * above the chat thread. The host assigns `context` as a PROPERTY, and
 * RE-ASSIGNS it whole every time the user switches the open message —
 * `context.item` is the only thing that changes across those assignments,
 * `context.fetchJson` is the host's authenticated client for this org's
 * `/client/*` surface (never construct a URL or touch a token here).
 *
 * Concurrency (load-bearing): a context re-assignment while a fetch from the
 * PREVIOUS assignment is still in flight must never let that stale response
 * paint over the new message's card. Every async cycle captures the
 * generation token current when it started and re-checks it before every
 * paint; a mismatch means a newer `context=` happened meanwhile and the
 * cycle silently stops. The base element's disconnect AbortSignal is passed
 * into every `fetchJson` call as a second guard (element removed from the
 * DOM entirely, not just re-targeted).
 */
import { WorkspaceBaseElement } from './baseElement';

// ---------------------------------------------------------------------------
// Task 5 contract — the property the host assigns.
// ---------------------------------------------------------------------------

export interface ClientPanelItem {
  subject: string;
  sender: string;
  dateISO: string;
  internetMessageId?: string;
  itemId?: string;
}

export interface ClientPanelContext {
  host: 'outlook';
  item: ClientPanelItem | null;
  /** Already authenticated by the host. Throws on non-OK responses. */
  fetchJson: (path: string, init?: RequestInit) => Promise<unknown>;
}

// ---------------------------------------------------------------------------
// Wire types — mirror src/routes/client.ts's ClientMatchResponse /
// ClientAssignResponse / ClientProjectsResponse as they arrive over JSON.
// Duplicated here (not imported) the same way dashboard.ts mirrors its
// service types: the web bundle never depends on server-side modules.
// ---------------------------------------------------------------------------

interface FilingRecord {
  fileIndexId: string;
  relPath: string;
  name: string;
  emailMeta: { from?: string; to?: string[]; subject?: string; date?: string } | null;
  status: 'suggested' | 'confirmed' | 'reassigned' | null;
  suggestedProjectKey: string | null;
  suggestedProjectLabel: string | null;
  matchedEntityType: string | null;
  matchedEntityValue: string | null;
  confidence: 'high' | 'low' | null;
  rationale: string | null;
  decidedProjectKey: string | null;
}

interface ClientMatchResponse {
  match: { fileIndexId: string; tier: 1 | 2 | 3; filing: FilingRecord | null } | null;
}

interface ClientAssignResponse {
  filing: FilingRecord;
}

interface ClientProjectsResponse {
  projects: Array<{ key: string; label: string }>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

/** Narrow an unknown `fetchJson` result to the match response shape. */
function expectMatchResponse(body: unknown): ClientMatchResponse {
  if (!isRecord(body) || !('match' in body)) throw new Error('malformed /client/filing/match response');
  return body as unknown as ClientMatchResponse;
}

function expectAssignResponse(body: unknown): ClientAssignResponse {
  if (!isRecord(body) || !isRecord(body.filing)) throw new Error('malformed assign response');
  return body as unknown as ClientAssignResponse;
}

function expectProjectsResponse(body: unknown): ClientProjectsResponse {
  if (!isRecord(body) || !Array.isArray(body.projects)) throw new Error('malformed projects response');
  return body as unknown as ClientProjectsResponse;
}

function matchQuery(item: ClientPanelItem): string {
  const params = new URLSearchParams();
  params.set('subject', item.subject);
  if (item.sender) params.set('sender', item.sender);
  if (item.dateISO) params.set('date', item.dateISO);
  if (item.internetMessageId) params.set('internetMessageId', item.internetMessageId);
  return `/client/filing/match?${params.toString()}`;
}

function isAbort(error: unknown): boolean {
  return error instanceof DOMException && error.name === 'AbortError';
}

export class WorkspaceFilingCard extends WorkspaceBaseElement {
  #context: ClientPanelContext | null = null;
  #generation = 0;
  #match: ClientMatchResponse['match'] = null;
  #projects: Array<{ key: string; label: string }> = [];
  #reassigning = false;

  set context(value: ClientPanelContext) {
    this.#context = value;
    const gen = ++this.#generation;
    this.#match = null;
    this.#projects = [];
    this.#reassigning = false;

    if (!value.item) {
      // No message open: render nothing, make no network call.
      this.clearContent();
      this.track(Promise.resolve());
      return;
    }
    this.track(this.#load(value, value.item, gen));
  }

  get context(): ClientPanelContext | null {
    return this.#context;
  }

  // A generation match alone isn't enough: the host's `fetchJson` is not
  // guaranteed to honor the disconnect AbortSignal (its contract is
  // unverified — see the Task 8 report), so also refuse to paint into a
  // shadow root that is no longer attached to the document.
  //
  // Used for every POST-await check. Do NOT use it for the synchronous
  // entry into `#load` (see the comment there) — the host's assignment
  // order relative to append is unspecified, and gating on `isConnected`
  // before any await ever runs would silently drop the whole load cycle
  // for an element configured before it is mounted.
  #current(gen: number): boolean {
    return gen === this.#generation && this.isConnected;
  }

  async #load(ctx: ClientPanelContext, item: ClientPanelItem, gen: number): Promise<void> {
    // Entered synchronously from the `context` setter, before any await has
    // run — `gen` cannot be stale yet, so only the generation is checked
    // here (always true at this exact call site, kept for defensiveness).
    // `isConnected` is intentionally NOT checked yet: the host may assign
    // `context` before appending the element to the DOM (or race the two),
    // and by the time the fetch below resolves the append will typically
    // already have happened. Connectedness is enforced at every point after
    // an await via `#current`, which is where a stale paint would actually
    // occur.
    if (gen !== this.#generation) return;
    this.clearContent();
    this.root.append(this.el('p', {
      text: 'Loading filing suggestion…',
      className: 'muted skeleton',
      attrs: { role: 'status' },
    }));

    let match: ClientMatchResponse['match'];
    try {
      const body = await ctx.fetchJson(matchQuery(item), { signal: this.signal });
      if (!this.#current(gen)) return;
      match = expectMatchResponse(body).match;
    } catch (error) {
      if (isAbort(error) || !this.#current(gen)) return;
      this.#renderErrorState(ctx, item, gen);
      return;
    }

    // No identified file, or a matched file the caller may see but not file
    // (already filed under a project path, tombstoned): nothing actionable
    // to show. Rendering nothing is neutral, not a claim that no match was
    // found server-side — the server contract still returned the match.
    if (!match || !match.filing) {
      if (!this.#current(gen)) return;
      this.#match = null;
      this.clearContent();
      return;
    }

    let projects: Array<{ key: string; label: string }> = [];
    try {
      const body = await ctx.fetchJson('/client/content/projects', { signal: this.signal });
      if (!this.#current(gen)) return;
      projects = expectProjectsResponse(body).projects;
    } catch (error) {
      if (isAbort(error) || !this.#current(gen)) return;
      // The reassign picker degrades (falls back to raw keys) rather than
      // the whole card failing over a non-essential fetch.
    }

    if (!this.#current(gen)) return;
    this.#match = match;
    this.#projects = projects;
    this.#reassigning = false;
    this.#paint(ctx, gen);
  }

  #renderErrorState(ctx: ClientPanelContext, item: ClientPanelItem, gen: number): void {
    this.renderError('The filing suggestion could not be loaded.', () => {
      this.track(this.#load(ctx, item, gen));
    });
  }

  #projectLabel(key: string | null): string | null {
    if (!key) return null;
    return this.#projects.find((p) => p.key === key)?.label ?? key;
  }

  #paint(ctx: ClientPanelContext, gen: number): void {
    if (!this.#current(gen)) return;
    this.clearContent();
    const filing = this.#match?.filing;
    if (!filing) return;

    const card = this.el('div', { className: 'ws-filing' });
    card.append(this.el('span', { className: 'ws-filing-label', text: 'Filed to' }));

    if (filing.status === 'confirmed' || filing.status === 'reassigned') {
      const decidedLabel = this.#projectLabel(filing.decidedProjectKey)
        ?? filing.suggestedProjectLabel
        ?? filing.decidedProjectKey
        ?? 'Filed';
      card.append(this.el('span', { className: 'ws-filing-project', text: decidedLabel }));
      if (this.#reassigning && this.#projects.length > 0) {
        card.append(this.#reassignForm(ctx, gen, filing));
      } else if (this.#projects.length > 0) {
        // No project list (the /client/content/projects fetch failed) means
        // the reassign picker would render with zero options and no way to
        // confirm — offering "Change" in that state is a dead end, so it is
        // withheld rather than shown broken.
        const change = this.el('button', { text: 'Change', attrs: { type: 'button' } });
        change.addEventListener('click', () => {
          this.#reassigning = true;
          this.#paint(ctx, gen);
        });
        card.append(change);
      }
    } else {
      // 'suggested' (classify-on-demand always sets a status, so this is the
      // only remaining branch once filing !== null).
      const label = filing.suggestedProjectLabel ?? filing.suggestedProjectKey ?? 'Unknown project';
      card.append(this.el('span', { className: 'ws-filing-project', text: label }));
      if (filing.confidence) {
        card.append(this.el('span', {
          className: `ws-filing-badge ws-filing-badge-${filing.confidence}`,
          text: filing.confidence,
        }));
      }
      if (this.#reassigning && this.#projects.length > 0) {
        card.append(this.#reassignForm(ctx, gen, filing));
      } else {
        const fileButton = this.el('button', { text: 'File', attrs: { type: 'button' } });
        fileButton.addEventListener('click', () => {
          if (!filing.suggestedProjectKey) return;
          this.track(this.#assign(ctx, gen, filing.suggestedProjectKey));
        });
        card.append(fileButton);
        // See the 'confirmed'/'reassigned' branch above: withhold Reassign
        // (rather than opening a picker with zero options) when the
        // projects list failed to load.
        if (this.#projects.length > 0) {
          const reassignButton = this.el('button', { text: 'Reassign', attrs: { type: 'button' } });
          reassignButton.addEventListener('click', () => {
            this.#reassigning = true;
            this.#paint(ctx, gen);
          });
          card.append(reassignButton);
        }
      }
    }

    this.root.append(card);
  }

  #reassignForm(ctx: ClientPanelContext, gen: number, filing: FilingRecord): HTMLElement {
    const select = this.el('select', { attrs: { 'aria-label': 'Project' } });
    const seeded = filing.decidedProjectKey ?? filing.suggestedProjectKey ?? this.#projects[0]?.key ?? '';
    for (const project of this.#projects) {
      const option = this.el('option', { text: project.label, attrs: { value: project.key } });
      if (project.key === seeded) option.setAttribute('selected', '');
      select.append(option);
    }
    // No listener-tracked selection state: if `seeded` isn't among
    // `this.#projects` (suggestion outside the returned set, or the
    // projects fetch failed), the browser silently falls back to option 0
    // and `select.value` reflects that. Confirm must post exactly what the
    // picker displays, so it reads `select.value` directly rather than a
    // variable that could drift from what's on screen.
    const confirm = this.el('button', { text: 'Confirm', attrs: { type: 'button' } });
    confirm.addEventListener('click', () => {
      if (!select.value) return;
      this.track(this.#assign(ctx, gen, select.value));
    });
    const cancel = this.el('button', { text: 'Cancel', attrs: { type: 'button' } });
    cancel.addEventListener('click', () => {
      this.#reassigning = false;
      this.#paint(ctx, gen);
    });

    return this.el('div', { className: 'ws-filing-reassign' }, [select, confirm, cancel]);
  }

  async #assign(ctx: ClientPanelContext, gen: number, projectKey: string): Promise<void> {
    if (!this.#current(gen) || !this.#match) return;
    const fileIndexId = this.#match.fileIndexId;
    try {
      const body = await ctx.fetchJson(`/client/filing/${encodeURIComponent(fileIndexId)}/assign`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ projectKey }),
        signal: this.signal,
      });
      if (!this.#current(gen)) return;
      const { filing } = expectAssignResponse(body);
      this.#match = { ...this.#match, filing };
      this.#reassigning = false;
      this.#paint(ctx, gen);
    } catch (error) {
      if (isAbort(error) || !this.#current(gen)) return;
      this.renderError('The filing change could not be saved.', () => {
        this.track(this.#assign(ctx, gen, projectKey));
      });
    }
  }
}
