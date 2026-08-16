/**
 * Tech-persona pane shell (spec §3, Task 22): reads the open message's email
 * identity, fetches its context (org/contacts/tickets), and renders
 * ContextCard + TicketList. State machine per item-generation bump:
 *
 *   mount / generation change
 *     -> readEmailIdentity()
 *     -> mode 'compose'     -> disabled explanatory state (no fetch)
 *     -> mode 'none'        -> empty state (no fetch)
 *     -> sharedMailbox      -> informational notice (no fetch; actions stay hidden — v1)
 *     -> else               -> fetchEmailContext({...identity, itemGeneration})
 *
 * A rapid item switch aborts the in-flight fetch (AbortController) AND — belt
 * and suspenders against a response that started before the abort landed —
 * discards any response whose echoed `itemGeneration` no longer matches the
 * store's current generation. Every fetch/mutation failure surfaces in a
 * dismissible `tech-banner`; nothing fails silently.
 */
import { useCallback, useEffect, useState } from 'react';
import type { TechPersonaSession } from '@breeze/office-addin-core';
import { readEmailIdentity, type EmailIdentity } from './emailIdentity';
import { createItemGenerationStore } from './itemGeneration';
import {
  fetchEmailContext,
  TechApiError,
  type EmailContextResponse,
  type ContactCandidate,
  type AddinTicketSummary,
  type MatchedTicket,
} from './api';
import { ContextCard } from './ContextCard';
import { TicketList } from './TicketList';
import { LinkEmailAction } from './LinkEmailAction';
import { CreateTicketForm } from './CreateTicketForm';
import { TimeWidget } from './TimeWidget';
import { getMailboxItemOrNull, readBodyText } from '../tools/mailbox';

export interface TechPaneProps {
  session: TechPersonaSession;
}

type PaneState =
  | { kind: 'loading' }
  | { kind: 'compose' }
  | { kind: 'none' }
  | { kind: 'shared-mailbox' }
  | {
      kind: 'ready';
      context: EmailContextResponse;
      org: { id: string; name: string } | null;
      headerCapable: boolean;
      identity: EmailIdentity;
      bodyText: string;
    }
  | { kind: 'error' };

// Module-level so the store survives re-renders but is fresh per pane mount
// in tests (each render() call gets a new TechPane instance).
function useItemGenerationStore() {
  const [store] = useState(() => createItemGenerationStore());
  return store;
}

export function TechPane({ session: _session }: TechPaneProps) {
  const store = useItemGenerationStore();
  const [state, setState] = useState<PaneState>({ kind: 'loading' });
  const [banner, setBanner] = useState<string | null>(null);
  // Manual org pick overrides the server-resolved org until the next context
  // load (a fresh item switch / re-fetch supersedes a stale manual choice).
  const [manualOrg, setManualOrg] = useState<{ id: string; name: string } | null>(null);
  const [contactOverride, setContactOverride] = useState<ContactCandidate | null>(null);
  const [selectedTicket, setSelectedTicket] = useState<AddinTicketSummary | MatchedTicket | null>(null);
  const [showCreateForm, setShowCreateForm] = useState(false);
  // Last AI draft's suggested duration (Task 24) — lifted out of
  // CreateTicketForm just for this one field so TimeWidget can prefill its
  // manual log form; the rest of the draft stays local to the form.
  const [suggestedDurationMinutes, setSuggestedDurationMinutes] = useState<number | undefined>(undefined);

  const load = useCallback(
    async (generation: number, signal: AbortSignal) => {
      setManualOrg(null);
      setContactOverride(null);
      setSelectedTicket(null);
      setShowCreateForm(false);
      setSuggestedDurationMinutes(undefined);
      let identity: EmailIdentity;
      try {
        identity = await readEmailIdentity();
      } catch (err) {
        if (signal.aborted) return;
        setBanner(err instanceof Error ? err.message : 'Failed to read the open message.');
        setState({ kind: 'error' });
        return;
      }
      if (signal.aborted || generation !== store.current()) return;

      if (identity.mode === 'compose') {
        setState({ kind: 'compose' });
        return;
      }
      if (identity.mode === 'none') {
        setState({ kind: 'none' });
        return;
      }
      if (identity.sharedMailbox) {
        setState({ kind: 'shared-mailbox' });
        return;
      }
      if (!identity.from) {
        // No usable sender to resolve against — treat like an empty item.
        setState({ kind: 'none' });
        return;
      }

      try {
        const context = await fetchEmailContext(
          {
            from: identity.from,
            sender: identity.sender,
            internetMessageId: identity.internetMessageId,
            references: identity.references,
            inReplyTo: identity.inReplyTo,
            subject: identity.subject,
            conversationId: identity.conversationId,
            itemGeneration: generation,
          },
          { signal },
        );
        // Belt-and-suspenders: the abort may not have landed before the
        // response resolved, and the echoed itemGeneration is the authority.
        if (signal.aborted || generation !== store.current() || context.itemGeneration !== store.current())
          return;

        // Body text for the create-ticket fallback prefill (subject/description)
        // and the link-email quote. Never blocks the pane on failure (an
        // offline/permission getAsync error) — the create form still works with
        // an empty fallback description, same "never block" contract as the
        // rest of this reader.
        const item = getMailboxItemOrNull();
        let bodyText = '';
        if (item) {
          try {
            bodyText = await readBodyText(item);
          } catch {
            bodyText = '';
          }
        }
        if (signal.aborted || generation !== store.current()) return;

        setState({
          kind: 'ready',
          context,
          org: context.org,
          headerCapable: identity.headerCapable,
          identity,
          bodyText,
        });
      } catch (err) {
        if (signal.aborted || generation !== store.current()) return;
        const message =
          err instanceof TechApiError
            ? `Failed to load context (${err.code}).`
            : 'Failed to load context.';
        setBanner(message);
        setState({ kind: 'error' });
      }
    },
    [store],
  );

  useEffect(() => {
    let activeController = new AbortController();
    void load(store.current(), activeController.signal);
    const unsubscribe = store.subscribe((generation) => {
      activeController.abort();
      activeController = new AbortController();
      void load(generation, activeController.signal);
    });
    return () => {
      activeController.abort();
      unsubscribe();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- store is stable for the pane's lifetime
  }, []);

  function dismissBanner(): void {
    setBanner(null);
  }

  return (
    <div className="flex h-screen flex-col gap-3 overflow-y-auto p-3">
      {banner && (
        <div
          data-testid="tech-banner"
          className="flex items-start justify-between gap-2 rounded-md border border-red-300 bg-red-50 p-2 text-xs text-red-700"
        >
          <span>{banner}</span>
          <button type="button" onClick={dismissBanner} className="font-semibold" aria-label="Dismiss">
            ×
          </button>
        </div>
      )}
      {renderBody()}
    </div>
  );

  function renderBody() {
    switch (state.kind) {
      case 'loading':
        return (
          <div data-testid="tech-loading-state" className="text-sm text-gray-400">
            Loading…
          </div>
        );
      case 'compose':
        return (
          <div data-testid="tech-compose-state" className="text-sm text-gray-500">
            Ticketing isn&apos;t available while composing — open a received message to see its context.
          </div>
        );
      case 'none':
        return (
          <div data-testid="tech-empty-state" className="text-sm text-gray-400">
            Select a message to see its ticket context.
          </div>
        );
      case 'shared-mailbox':
        return (
          <div data-testid="tech-shared-mailbox-notice" className="text-sm text-amber-700">
            Shared mailboxes aren&apos;t supported yet
          </div>
        );
      case 'error':
        return null; // the banner above already reports the failure
      case 'ready': {
        const effectiveOrg = manualOrg ?? state.org;
        return (
          <>
            <ContextCard
              org={effectiveOrg}
              orgSummary={effectiveOrg === state.org ? state.context.orgSummary : null}
              contacts={state.context.contacts}
              headerCapable={state.headerCapable}
              inboundPathConfigured={state.context.inboundPathConfigured}
              onOrgSelected={(org) => setManualOrg(org)}
              onContactSelected={(contact) => setContactOverride(contact)}
            />
            <TicketList
              threadMatchedTicket={state.context.threadMatchedTicket}
              openTickets={state.context.openTickets}
              recentTickets={state.context.recentTickets}
              onSelect={(ticket) => {
                setSelectedTicket(ticket);
                setShowCreateForm(false);
              }}
            />

            <button
              type="button"
              data-testid="create-ticket-button"
              onClick={() => {
                setShowCreateForm((v) => !v);
                setSelectedTicket(null);
              }}
              className="w-fit rounded-md border border-gray-300 px-2 py-1 text-sm hover:bg-gray-50"
            >
              {showCreateForm ? 'Cancel new ticket' : 'Create ticket from this email'}
            </button>

            {selectedTicket && (
              <LinkEmailAction
                ticket={selectedTicket}
                identity={state.identity}
                bodyText={state.bodyText}
                orgId={effectiveOrg?.id ?? null}
                onDone={() => {
                  setBanner(null);
                  setSelectedTicket(null);
                }}
                onBanner={setBanner}
              />
            )}

            {showCreateForm && (
              <CreateTicketForm
                context={state.context}
                identity={state.identity}
                bodyText={state.bodyText}
                orgOverride={manualOrg}
                onDone={() => {
                  setBanner(null);
                  setShowCreateForm(false);
                }}
                onBanner={setBanner}
                onCancel={() => setShowCreateForm(false)}
                onDraftSuggestedDuration={setSuggestedDurationMinutes}
              />
            )}

            <TimeWidget
              linkedTicket={selectedTicket}
              suggestedDurationMinutes={suggestedDurationMinutes}
              onBanner={setBanner}
            />

            {contactOverride && (
              <span data-testid="tech-contact-override" className="hidden">
                {contactOverride.id}
              </span>
            )}
          </>
        );
      }
    }
  }
}
