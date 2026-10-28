# Profile picture draft flow

Profile picture selection uploads a private draft and **Save changes** publishes it with the rest of the profile.

## 🎯 Intent

The profile editor currently previews a selected file, then asks the user to click **Upload**, then **Save changes**. The upload endpoint immediately changes the saved avatar, while the profile form saves only the name. The new flow uploads on selection, previews the draft, and commits it only when the user saves.

## ✅ Goals and boundaries

- Use **Change picture** to pick or drop an image, then upload it automatically.
- Keep the existing picture visible in the header until profile save succeeds.
- Let the user undo a pending replacement or removal.
- Show upload and save failures beside the avatar or profile form.
- Keep the current avatar endpoints unchanged. The profile editor uses new draft endpoints so the documented API contract stays intact.
- Keep image validation, the 5 MB limit, and tenant isolation on the server.

## 🧭 Approaches

The selected design stores one pending draft per user in a dedicated table. The draft has a unique identifier and a `replace` or `remove` intent. Save supplies that identifier, so a stale tab cannot publish a newer draft it did not show.

Candidate 1 stored one row per upload and added revisions, tombstones, quotas, and extra retry paths. Those features add maintenance for a profile editor that needs one current draft. Candidate 3 stored pending image bytes on `users`; the repository has many full-row user queries, so a separate table avoids adding another large value to those reads.

## 🧱 Data flow

The browser tracks upload progress separately from the server draft. A successful upload returns its draft ID and preview path. A failed upload leaves the saved avatar unchanged and displays an error. `GET /users/me` returns the current draft summary so the editor can restore its preview after reload.

The draft table has one row per user, an identifier, an intent, optional image bytes and a media type, and an update time. The table uses user-ID row-level security (RLS), with forced RLS and the shape 6 coverage entry. The upload route keeps the 5 MB body limit and validates the image bytes. Draft preview is self-only and uses `Cache-Control: private, no-store`.

Save sends the draft ID with the profile fields. One database transaction checks that the ID still matches, updates the name and committed avatar, then removes the draft. A missing or stale ID returns a conflict without saving either field. Undo deletes only the matching draft. Removal creates a draft intent and follows the same Save path.

On replacement, the committed avatar URL includes `?v=<draftId>`. This changes the URL key used by `useAvatarBlobUrl`, so the header fetches the new bytes after save. The auth store updates only from the successful save response.

The draft expires after seven days and a daily cleanup job deletes expired rows. Existing immediate avatar endpoints remain available for compatibility; the profile editor no longer calls them.

## 🧪 Verification

Cover automatic upload, preview, undo, upload failure, draft replacement, stale-tab conflict, and the atomic profile save in API and web tests. Verify forced RLS and the row-level policies with the RLS contract test. Run the profile page in the browser and confirm that the header changes only after **Save changes**.

## ⚖️ Tradeoffs

The draft table and cleanup job add a migration and a user-scoped RLS policy. They keep staged bytes out of user queries and bound abandoned uploads. A single row per user avoids a general upload history. If another tab replaces the draft, the old tab must refresh and choose again.

The versioned avatar URL matches the cache refresh approach in related PR #10252. That PR remains separate and is currently open with changes requested.
