# Full Playbooks Page & Custom Playbook Builder — Roadmap

**Status**: Deferred (tracked as item 5 from BE-12 maintenance review)
**Priority**: Low — implement when customers need custom playbooks

## Scope

A dedicated `/playbooks` page in the web app that provides:

1. **Playbook List View** — browse all available playbooks (built-in + org-custom) with category filtering
2. **Playbook Detail View** — view step definitions, execution history, success rate stats
3. **Custom Playbook Builder** — form-based UI for creating org-specific playbooks
4. **Execution History Dashboard** — cross-device view of all playbook runs with drill-in

## Dependencies

- Playbook backend is fully implemented (schema, routes, AI tools, guardrails)
- Device-level "Playbook History" tab exists (added Feb 2026)
- Retention worker handles execution cleanup

## Approach

### Sidebar Placement

Add "Playbooks" under the existing "Automations" sidebar section. This groups it with scripts and automation rules, which are conceptually similar.

### Custom Playbook Builder

The builder should expose:
- Name, description, category selection
- Ordered step editor (drag-to-reorder) with type picker (diagnose/act/wait/verify/rollback)
- Per-step: tool selection (from AI tool registry), tool input template with `{{variable}}` support
- Verification condition editor for verify steps (metric, operator, value)
- Trigger conditions (alert types, device tags, auto-execute toggle)
- Required permissions picker
- Preview/test mode that dry-runs the playbook definition validation

### Analytics

Once there's enough execution data:
- Success rate per playbook (pie chart)
- Average execution duration per playbook
- Most-used playbooks ranking
- Failure reason breakdown

## Estimated Effort

- Playbook list + detail views: 1-2 days
- Custom playbook builder form: 2-3 days
- Execution history dashboard: 1 day
- Analytics panel: 1 day
- API additions (POST/PUT/DELETE for custom playbooks, analytics endpoint): 1 day

**Total: ~6-8 days**

## Notes

- The current design stores playbook definitions as JSONB steps, which is flexible but means the builder form needs to handle a freeform step schema. Consider a Zod schema for the builder form that mirrors `PlaybookStep[]`.
- The seed function already handles built-in vs org-scoped playbooks (`orgId: null` = built-in). Custom playbooks set `orgId` to the creating org and `isBuiltIn: false`.
- No CRUD endpoints for custom playbook definitions exist yet — only the AI tools and the GET/execute routes. POST/PUT/DELETE for definitions will need to be added.
