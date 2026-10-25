# Zammad 7.2.x fixtures (synthesized)

**Zammad 7.2.x: shapes from 7.2.2, validated later against a live 7.2.0.**

**These responses were synthesized, not captured.** No live Zammad was available
when the module was written (#8313 W5). Every file is shaped after the Zammad
7.2.2 API as the research notes and the 7.2.2 source they cite describe it
(spec `docs/superpowers/specs/api-platform/2026-10-19-ticket-import-modules-design.md`
§3, Z1–Z20): the columns of the base migration, the `attributes_with_association_names`
form of `by_ticket`, attachment `size` as a string, the API's rewrite of
`cid:` images to `/api/v1/ticket_attachment/{ticket}/{article}/{store id}?view=inline`,
the merge marker, the `parent` link of a merged ticket, the 404/403 answers.

A read-only shape check against the first live instance (7.2.0) added what
the notes did not have, with generic stand-ins for anything instance-specific:
`GET /version`; a custom state of type `pending action` with no next state
("Paused"); inline images as ordinary attachments with `Content-Disposition:
inline` and a `Content-ID` (a mail attachment may carry no Content-Disposition
at all); the article keys `ai_stored_result_ids` and `ai_stored_results`;
custom attributes as `cf_*` keys on tickets, users and organizations. The full
validation against that instance comes later.

All people, organizations, addresses and texts are invented; every domain is an
`example.*` name. When a disposable 7.2.x instance becomes available, record
the same cases from it and replace these files (spec §6.8).

Two sets, one invented instance:

- `base/`: the source at the bulk pass. One file per endpoint response.
- `delta/`: an overlay of the files that changed before the delta pass. A file
  absent from `delta/` is the same as in `base/`.

`fakeZammad.fixtures.ts` (next to this directory) serves them: in process for
unit tests, and as a node `http` server on 127.0.0.1 for the end-to-end test.

## Files

| File | Endpoint |
|---|---|
| `version.json` | `GET /api/v1/version`. Its policy is `default_permit!('admin')`: the recommended `ticket.agent` token gets 403 (tests set it to null for that) |
| `users-me.json` | `GET /api/v1/users/me?expand=true` (the token user, `breeze-import`) |
| `roles.json` | `GET /api/v1/roles?expand=true` (with `permissions` names) |
| `users.json` | `GET /api/v1/users?page=N&per_page=1000` (inactive users and user 1 included) |
| `organizations.json` | `GET /api/v1/organizations?page=N&per_page=1000` |
| `groups.json` | `GET /api/v1/groups?page=N&per_page=1000` (inactive groups included) |
| `ticket_states.json` | `GET /api/v1/ticket_states?expand=true` (`state_type` by name, `next_state_id`) |
| `ticket_priorities.json` | `GET /api/v1/ticket_priorities` |
| `object_manager_attributes.403.json` | `GET /api/v1/object_manager_attributes`: 403, the token has no `admin.object` |
| `tickets.json` | `GET /api/v1/tickets?page=N&per_page=100`, `id ASC`; also each `GET /api/v1/tickets/:id` |
| (derived) | `GET /api/v1/tickets/:id?expand=true`: the ticket plus `article_ids`, every article of `by_ticket/<id>.json` (System ones included) |
| `by_ticket/<id>.json` | `GET /api/v1/ticket_articles/by_ticket/:id`; also each `GET /api/v1/ticket_articles/:id` |
| `tags.json` | `GET /api/v1/tags?object=Ticket&o_id=:id`, by ticket id |
| `links/<id>.json` | `GET /api/v1/links?link_object=Ticket&link_object_value=:id` (merged tickets) |
| `files.json` | `GET /api/v1/ticket_attachment/:ticket/:article/:id`, the original bytes (base64) |
| `hidden.json` | ticket ids that answer 403 (a deactivated group); any other unknown id answers 404 |

## Cases (spec §6.8)

| Ticket | Case |
|---|---|
| 101 | a plain mail ticket: customer mail, agent reply with `To`/`Cc`, internal note; owner matched; requester one contact; tags |
| 102 | an HTML mail: an inline image by API URL, an external tracking pixel, an unmatched `cid:`, the `message.html` copy (`content-alternative`), a PDF; a pasted inline image in the reply, and an inline-stored image the body does not show; closed twice (`close_at`, `last_close_at`); owner deactivated in Zammad; `time_unit` "45.0"; a boolean custom attribute |
| 103 | an agent phone ticket: `pending reminder`, owner gone (no Breeze user), a System trigger note, an SMS; a customer whose email two Breeze contacts share; type `Incident` |
| 104 | `pending close` (state type `pending action`, next state `closed`); a custom priority `4 critical`; a web ticket; a custom attribute set |
| 105 → 106 | a merged pair: 105 holds only the merge marker; its articles, older than 106 itself, now live on 106 |
| 107 → 108 → 109 | a chain: both links resolve to the final survivor 109 |
| 110 | no organization |
| 111 | a customer without email; an oversized (20 MiB declared) and an empty file; a `body_rendering_error` |
| 112 | a legacy `removed` state |
| 113 | a plain ticket (merged into 106 in the delta) |
| 114 | System-heavy: `article_count` (non-System only) is 3, the total 6; the module decides from the total, and tests lower the 500 threshold to see it read article by article |
| 115 | a closed ticket (hidden in the delta) |
| 116 | an organization the mapping leaves out |
| 117 | a custom `pending action` state with no next state ("Paused") |
| 118 → 119 | 118 is older than 119 (merged into it in the delta) |

The delta: 101 gains an article and one of its articles turns internal; an
article of 102 is edited; 104 closes; 112 is deleted (404); 113 is merged into
106; 115 is hidden (403); the older 118 is merged into the newer 119, which
then holds articles older than itself.
