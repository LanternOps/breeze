// A blur-to-save text draft that re-syncs from its server value without ever
// discarding an edit newer than that value.
//
// The billing editors (invoice notes/terms, quote title/terms/footer) all save
// on blur and then fire a quiet refetch that is NOT awaited. The field
// re-enables as soon as the PATCH resolves, so the user can keep typing while
// the refetch is still in flight. When it lands it carries the value we just
// PATCHed — the ECHO of our own save — and a naive "server changed → replace
// the draft and clear dirty" resync silently threw those newer keystrokes
// away, then made the next blur a no-op because dirty was already cleared
// (#4296).
//
// Rule applied here: when the server value changes,
//   - to one of OUR OWN saved values (an echo): the local draft is at least as
//     new as the server, so keep it (and its dirty flag). If nothing was typed
//     since and no later save is outstanding, adopt the server string so the
//     field shows exactly what was stored.
//   - to anything else: someone else changed it. Replace the draft and clear
//     dirty — the long-standing contract, pinned by the invoice editor's
//     "DOES replace the draft when the server value genuinely changes" test.
//
// Known limit: echoes are matched by VALUE. If another user writes, within one
// save round-trip, a string identical to one of our still-outstanding saves,
// it is taken as our echo. Telling those apart needs a server version
// (e.g. updatedAt) on the PATCH response, which these routes do not return;
// the editors had no concurrent-edit detection before this hook either.
//
// The re-sync is derived DURING RENDER, never from a passive effect (#3277 /
// #4807): a deferred effect can flush after a keystroke and overwrite it.
// Comparing the normalised STRING (callers pass `value ?? ''`) means a
// null → '' round-trip is not a change.
import { useCallback, useState } from 'react';

export interface ServerSyncedDraft {
  /** The text the field renders. */
  draft: string;
  /** True once the user has edited the draft since the last save/resync. */
  dirty: boolean;
  /** onChange handler: update the draft and mark it dirty. */
  edit: (value: string) => void;
  /**
   * Call after the save request SUCCEEDS, before triggering the refetch, with
   * the value exactly as the server will echo it back (post-normalisation, e.g.
   * trimmed, and `?? ''` for a null). Clears dirty and records the echo so the
   * refetch that carries it does not clobber newer typing.
   */
  markSaved: (savedServerValue: string) => void;
}

export function useServerSyncedDraft(serverValue: string): ServerSyncedDraft {
  const [draft, setDraft] = useState(serverValue);
  const [dirty, setDirty] = useState(false);
  // The server value last synced from, plus the saved values whose refetch has
  // not landed yet. One state object so markSaved can compare
  // against the CURRENT synced value inside a functional update and stay stable.
  const [sync, setSync] = useState<{ from: string; echoes: readonly string[] }>(
    () => ({ from: serverValue, echoes: [] }),
  );

  if (sync.from !== serverValue) {
    const idx = sync.echoes.indexOf(serverValue);
    if (idx >= 0) {
      // Consume ONLY the matched echo. Refetches are not guaranteed to land in
      // save order (the invoice workspace applies every response), so a newer
      // save's echo can arrive before an older one's; dropping the older entry
      // here would make its late arrival look like a foreign change and revert
      // the field to it.
      const outstanding = [...sync.echoes.slice(0, idx), ...sync.echoes.slice(idx + 1)];
      setSync({ from: serverValue, echoes: outstanding });
      if (!dirty && outstanding.length === 0) setDraft(serverValue);
    } else {
      setSync({ from: serverValue, echoes: [] });
      setDraft(serverValue);
      setDirty(false);
    }
  }

  const edit = useCallback((value: string) => {
    setDraft(value);
    setDirty(true);
  }, []);

  const markSaved = useCallback((savedServerValue: string) => {
    setDirty(false);
    // A save that leaves the server value unchanged produces no resync, so an
    // echo recorded for it would never be consumed — and could later mask a
    // genuine change back to that same string. Only record real changes.
    setSync((s) => (savedServerValue === s.from ? s : { ...s, echoes: [...s.echoes, savedServerValue] }));
  }, []);

  return { draft, dirty, edit, markSaved };
}
