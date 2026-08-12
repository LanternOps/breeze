import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { defineWorkspaceElements, WorkspaceFilingCard } from './index';
import type { ClientPanelContext, ClientPanelItem } from './filingCard';

function item(overrides: Partial<ClientPanelItem> = {}): ClientPanelItem {
  return {
    subject: 'PO #4021 — Alder Creek',
    sender: 'vendor@example.com',
    dateISO: '2026-07-19T12:00:00.000Z',
    internetMessageId: '<abc@mail>',
    itemId: 'AAMk-item-1',
    ...overrides,
  };
}

function context(overrides: Partial<ClientPanelContext> = {}): ClientPanelContext {
  return {
    host: 'outlook',
    item: item(),
    fetchJson: vi.fn(),
    ...overrides,
  };
}

function shadowText(element: HTMLElement): string {
  return element.shadowRoot?.textContent ?? '';
}

function shadowChildCount(element: HTMLElement): number {
  return element.shadowRoot
    ? [...element.shadowRoot.children].filter((c) => c.tagName !== 'STYLE').length
    : 0;
}

/** A promise the test controls the resolution/rejection of. */
function deferred<T>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function matchResponse(over: Record<string, unknown> = {}): unknown {
  return {
    match: {
      fileIndexId: 'file-1',
      tier: 1,
      filing: {
        fileIndexId: 'file-1',
        relPath: 'inbox/po-4021.eml',
        name: 'po-4021.eml',
        emailMeta: null,
        status: 'suggested',
        suggestedProjectKey: 'alder-creek',
        suggestedProjectLabel: 'Alder Creek',
        matchedEntityType: 'po',
        matchedEntityValue: 'PO 4021',
        confidence: 'high',
        rationale: 'matched PO #4021',
        decidedProjectKey: null,
        ...over,
      },
    },
  };
}

function projectsResponse(): unknown {
  return {
    projects: [
      { key: 'alder-creek', label: 'Alder Creek' },
      { key: 'birchwood', label: 'Birchwood' },
    ],
  };
}

async function mount(ctx: ClientPanelContext): Promise<WorkspaceFilingCard> {
  const element = document.createElement('workspace-filing-card') as WorkspaceFilingCard;
  document.body.append(element);
  element.context = ctx;
  await element.updateComplete;
  return element;
}

describe('workspace-filing-card', () => {
  beforeEach(() => {
    defineWorkspaceElements();
  });

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('renders nothing when item is null', async () => {
    const fetchJson = vi.fn();
    const el = await mount(context({ item: null, fetchJson }));
    expect(fetchJson).not.toHaveBeenCalled();
    expect(shadowChildCount(el)).toBe(0);
  });

  it('goes loading -> suggested, rendering the project label and confidence', async () => {
    const fetchJson = vi.fn(async (path: string) => {
      if (path.startsWith('/client/filing/match')) return matchResponse();
      if (path === '/client/content/projects') return projectsResponse();
      throw new Error(`unexpected path ${path}`);
    });
    const el = await mount(context({ fetchJson }));

    expect(fetchJson.mock.calls[0][0]).toContain('/client/filing/match?');
    expect(fetchJson.mock.calls[0][0]).toContain('subject=');
    expect(fetchJson.mock.calls[0][0]).toContain('internetMessageId=');

    const text = shadowText(el);
    expect(text).toContain('Filed to');
    expect(text).toContain('Alder Creek');
    expect(text).toContain('high');
    expect(el.shadowRoot?.querySelector('button')?.textContent).toBe('File');
  });

  it('File click posts assign and re-renders filed', async () => {
    const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/client/filing/match')) return matchResponse();
      if (path === '/client/content/projects') return projectsResponse();
      if (path === '/client/filing/file-1/assign') {
        expect(init?.method).toBe('POST');
        expect(JSON.parse(String(init?.body))).toEqual({ projectKey: 'alder-creek' });
        return {
          filing: {
            fileIndexId: 'file-1',
            relPath: 'inbox/po-4021.eml',
            name: 'po-4021.eml',
            emailMeta: null,
            status: 'confirmed',
            suggestedProjectKey: 'alder-creek',
            suggestedProjectLabel: 'Alder Creek',
            matchedEntityType: 'po',
            matchedEntityValue: 'PO 4021',
            confidence: 'high',
            rationale: 'matched PO #4021',
            decidedProjectKey: 'alder-creek',
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const el = await mount(context({ fetchJson }));

    const fileButton = [...(el.shadowRoot?.querySelectorAll('button') ?? [])]
      .find((b) => b.textContent === 'File') as HTMLButtonElement;
    fileButton.click();
    await el.updateComplete;

    expect(fetchJson).toHaveBeenCalledWith('/client/filing/file-1/assign', expect.objectContaining({
      method: 'POST',
    }));
    const text = shadowText(el);
    expect(text).toContain('Alder Creek');
    expect(el.shadowRoot?.querySelector('button')?.textContent).toBe('Change');
  });

  it('Reassign flow posts the chosen key', async () => {
    const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/client/filing/match')) return matchResponse();
      if (path === '/client/content/projects') return projectsResponse();
      if (path === '/client/filing/file-1/assign') {
        expect(JSON.parse(String(init?.body))).toEqual({ projectKey: 'birchwood' });
        return {
          filing: {
            fileIndexId: 'file-1',
            relPath: 'inbox/po-4021.eml',
            name: 'po-4021.eml',
            emailMeta: null,
            status: 'reassigned',
            suggestedProjectKey: 'alder-creek',
            suggestedProjectLabel: 'Alder Creek',
            matchedEntityType: 'po',
            matchedEntityValue: 'PO 4021',
            confidence: 'high',
            rationale: 'matched PO #4021',
            decidedProjectKey: 'birchwood',
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const el = await mount(context({ fetchJson }));

    const reassignButton = [...(el.shadowRoot?.querySelectorAll('button') ?? [])]
      .find((b) => b.textContent === 'Reassign') as HTMLButtonElement;
    reassignButton.click();
    await el.updateComplete;

    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    expect(select).toBeTruthy();
    expect([...select.options].map((o) => o.value)).toEqual(['alder-creek', 'birchwood']);
    select.value = 'birchwood';
    select.dispatchEvent(new Event('change'));

    const confirmButton = [...(el.shadowRoot?.querySelectorAll('button') ?? [])]
      .find((b) => b.textContent === 'Confirm') as HTMLButtonElement;
    confirmButton.click();
    await el.updateComplete;

    expect(fetchJson).toHaveBeenCalledWith('/client/filing/file-1/assign', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ projectKey: 'birchwood' }),
    }));
    const text = shadowText(el);
    expect(text).toContain('Birchwood');
    expect(el.shadowRoot?.querySelector('button')?.textContent).toBe('Change');
  });

  it('Reassign confirm posts the option actually shown in the picker, even when the seeded key is not in the project list', async () => {
    // suggestedProjectKey is not among the projects the /content/projects
    // fetch returns, so the <select> falls back to its first option
    // ('alder-creek') while any naively-seeded selection state would still
    // hold the stale, off-list key. Confirm must post what the user sees.
    const fetchJson = vi.fn(async (path: string, init?: RequestInit) => {
      if (path.startsWith('/client/filing/match')) {
        return matchResponse({ suggestedProjectKey: 'zeta-not-in-list', suggestedProjectLabel: 'Zeta' });
      }
      if (path === '/client/content/projects') return projectsResponse();
      if (path === '/client/filing/file-1/assign') {
        expect(JSON.parse(String(init?.body))).toEqual({ projectKey: 'alder-creek' });
        return {
          filing: {
            fileIndexId: 'file-1',
            relPath: 'inbox/po-4021.eml',
            name: 'po-4021.eml',
            emailMeta: null,
            status: 'reassigned',
            suggestedProjectKey: 'zeta-not-in-list',
            suggestedProjectLabel: 'Zeta',
            matchedEntityType: 'po',
            matchedEntityValue: 'PO 4021',
            confidence: 'high',
            rationale: 'matched PO #4021',
            decidedProjectKey: 'alder-creek',
          },
        };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const el = await mount(context({ fetchJson }));

    const reassignButton = [...(el.shadowRoot?.querySelectorAll('button') ?? [])]
      .find((b) => b.textContent === 'Reassign') as HTMLButtonElement;
    reassignButton.click();
    await el.updateComplete;

    const select = el.shadowRoot?.querySelector('select') as HTMLSelectElement;
    // Nothing matches the seeded key, so the browser defaults to option 0.
    expect(select.value).toBe('alder-creek');

    // The user never touches the <select> — just confirms what is displayed.
    const confirmButton = [...(el.shadowRoot?.querySelectorAll('button') ?? [])]
      .find((b) => b.textContent === 'Confirm') as HTMLButtonElement;
    confirmButton.click();
    await el.updateComplete;

    expect(fetchJson).toHaveBeenCalledWith('/client/filing/file-1/assign', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ projectKey: 'alder-creek' }),
    }));
  });

  it('renders nothing on no-match', async () => {
    const fetchJson = vi.fn(async () => ({ match: null }));
    const el = await mount(context({ fetchJson }));
    expect(shadowChildCount(el)).toBe(0);
  });

  it('shows an error state with a retry button on fetch rejection, and retry re-fetches', async () => {
    let calls = 0;
    const fetchJson = vi.fn(async (path: string) => {
      if (path.startsWith('/client/filing/match')) {
        calls += 1;
        if (calls === 1) throw new Error('network down');
        return matchResponse();
      }
      if (path === '/client/content/projects') return projectsResponse();
      throw new Error(`unexpected path ${path}`);
    });
    const el = await mount(context({ fetchJson }));

    expect(el.shadowRoot?.querySelector('[role="alert"]')).toBeTruthy();
    const retry = el.shadowRoot?.querySelector('button') as HTMLButtonElement;
    expect(retry.textContent).toBe('Retry');
    retry.click();
    await el.updateComplete;

    expect(shadowText(el)).toContain('Alder Creek');
  });

  it('a context re-assignment while a fetch is in flight does not let the stale response paint over the new card', async () => {
    const first = deferred<unknown>();
    const fetchJsonA = vi.fn((path: string) => {
      if (path.startsWith('/client/filing/match')) return first.promise;
      return Promise.resolve(projectsResponse());
    });
    const element = document.createElement('workspace-filing-card') as WorkspaceFilingCard;
    document.body.append(element);

    element.context = context({ item: item({ subject: 'first message' }), fetchJson: fetchJsonA });
    // Do not await — the fetch above is still pending.

    // Message B resolves to a DIFFERENT suggestion (not an empty/no-match
    // render) so that "still on screen after A resolves" is a real signal,
    // not indistinguishable from a broken element that painted nothing.
    const fetchJsonB = vi.fn(async (path: string) => {
      if (path.startsWith('/client/filing/match')) {
        return matchResponse({ suggestedProjectKey: 'birchwood', suggestedProjectLabel: 'Birchwood' });
      }
      return projectsResponse();
    });
    element.context = context({ item: item({ subject: 'second message' }), fetchJson: fetchJsonB });
    await element.updateComplete;
    expect(shadowText(element)).toContain('Birchwood');

    // Now let the first (stale) fetch resolve with a different suggestion.
    // It must NOT overwrite what message B already painted.
    first.resolve(matchResponse());
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(shadowText(element)).toContain('Birchwood');
    expect(shadowText(element)).not.toContain('Alder Creek');
  });

  it('does not paint after the element is disconnected, even if fetchJson ignores the abort signal', async () => {
    // A misbehaving (or fake, as here) fetchJson that never rejects on abort
    // must not be the only thing standing between a detached element and a
    // paint into its now-orphaned shadow root.
    const pending = deferred<unknown>();
    const fetchJson = vi.fn((path: string) => {
      if (path.startsWith('/client/filing/match')) return pending.promise;
      return Promise.resolve(projectsResponse());
    });
    const element = document.createElement('workspace-filing-card') as WorkspaceFilingCard;
    document.body.append(element);
    element.context = context({ fetchJson });
    expect(shadowText(element)).toContain('Loading');

    element.remove(); // disconnectedCallback fires and aborts the signal
    pending.resolve(matchResponse()); // ...but fetchJson above ignores that
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    expect(shadowText(element)).toContain('Loading');
    expect(shadowText(element)).not.toContain('Alder Creek');
  });

  it('loads and renders even when context is assigned before the element is connected to the DOM', async () => {
    // The host's assignment order relative to append is unspecified (Task 5's
    // ExtensionPanelHost does not exist yet). The element must not carry a
    // silent ordering requirement whose failure mode is a permanently blank
    // pane.
    const fetchJson = vi.fn(async (path: string) => {
      if (path.startsWith('/client/filing/match')) return matchResponse();
      if (path === '/client/content/projects') return projectsResponse();
      throw new Error(`unexpected path ${path}`);
    });
    const element = document.createElement('workspace-filing-card') as WorkspaceFilingCard;
    element.context = context({ fetchJson }); // assigned BEFORE append
    document.body.append(element);
    await element.updateComplete;

    expect(fetchJson).toHaveBeenCalled();
    expect(shadowText(element)).toContain('Alder Creek');
  });

  it('does not offer Reassign when the projects list failed to load', async () => {
    const fetchJson = vi.fn(async (path: string) => {
      if (path.startsWith('/client/filing/match')) return matchResponse();
      if (path === '/client/content/projects') throw new Error('projects down');
      throw new Error(`unexpected path ${path}`);
    });
    const el = await mount(context({ fetchJson }));

    const buttonLabels = [...(el.shadowRoot?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(buttonLabels).toContain('File');
    expect(buttonLabels).not.toContain('Reassign');
  });

  it('does not offer Change (reassign) on a decided filing when the projects list failed to load', async () => {
    const fetchJson = vi.fn(async (path: string) => {
      if (path.startsWith('/client/filing/match')) {
        return matchResponse({ status: 'confirmed', decidedProjectKey: 'alder-creek' });
      }
      if (path === '/client/content/projects') throw new Error('projects down');
      throw new Error(`unexpected path ${path}`);
    });
    const el = await mount(context({ fetchJson }));

    // Projects fetch failed, so the decided label falls back to the raw key
    // (per the existing degrade-gracefully behavior) — the point of this
    // test is the missing Reassign/Change entry point, not the label text.
    expect(shadowText(el)).toContain('alder-creek');
    const buttonLabels = [...(el.shadowRoot?.querySelectorAll('button') ?? [])].map((b) => b.textContent);
    expect(buttonLabels).not.toContain('Change');
  });

  it('URL-encodes fileIndexId when building the assign path', async () => {
    const rawId = 'file/needs encoding';
    const matchWithOddId = {
      match: {
        fileIndexId: rawId,
        tier: 1,
        filing: {
          fileIndexId: rawId,
          relPath: 'inbox/po-4021.eml',
          name: 'po-4021.eml',
          emailMeta: null,
          status: 'suggested',
          suggestedProjectKey: 'alder-creek',
          suggestedProjectLabel: 'Alder Creek',
          matchedEntityType: 'po',
          matchedEntityValue: 'PO 4021',
          confidence: 'high',
          rationale: 'matched PO #4021',
          decidedProjectKey: null,
        },
      },
    };
    const fetchJson = vi.fn(async (path: string) => {
      if (path.startsWith('/client/filing/match')) return matchWithOddId;
      if (path === '/client/content/projects') return projectsResponse();
      if (path.startsWith('/client/filing/')) {
        return { filing: { ...matchWithOddId.match.filing, status: 'confirmed', decidedProjectKey: 'alder-creek' } };
      }
      throw new Error(`unexpected path ${path}`);
    });
    const el = await mount(context({ fetchJson }));

    const fileButton = [...(el.shadowRoot?.querySelectorAll('button') ?? [])]
      .find((b) => b.textContent === 'File') as HTMLButtonElement;
    fileButton.click();
    await el.updateComplete;

    expect(fetchJson).toHaveBeenCalledWith(
      `/client/filing/${encodeURIComponent(rawId)}/assign`,
      expect.objectContaining({ method: 'POST' }),
    );
  });
});
