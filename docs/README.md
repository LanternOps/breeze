# Breeze documentation

Repository documentation, organized by topic. (This is the internal/self-hoster
doc tree; the **published product docs** live separately in `apps/docs/` →
docs.breezermm.com.)

## Map

| Folder | Holds |
|---|---|
| `guides/` | Human-facing guides: admin, user, developer, agent installation, architecture overview |
| `operations/` | Running & recovering a deployment: production deploy, disaster recovery, monitoring, secret rotation, TLS, backup/restore, log aggregation, Cloudflare, version upgrades |
| `deploy/` | Deployment reference configs & specifics (Cloudflare Access trust, TLS, upgrades) |
| `runbooks/` | Step-by-step operational runbooks for specific incidents/procedures |
| `signing/` | Artifact & installer code-signing operations (macOS/Linux, Windows) |
| `security/` | Security policy & practices: `SECURITY.md`, security practices whitepaper, compliance, known advisories |
| `security-reports/` | Point-in-time security review reports (tracked by date) |
| `threat-models/` | System & OAuth/MCP threat models |
| `registers/` | Trust / validation / recovery registers (compliance evidence) |
| `notes/` | Working notes: SOC control notes & templates, CSP scan artifacts, misc engineering notes |
| `testing/` | Test plans, UI QA checklists, feature/e2e coverage logs |
| `integrations/` | Integration references (partner API, integrations overview) |
| `extensions/` | Runtime extension platform docs (SDK compatibility) |
| `release-notes/` | Per-feature release-note fragments |
| `research/` | Market / competitive research matrices |
| `remote-desktop-performance/` | Remote desktop encoder-pipeline performance findings |
| `assets/` | Images & media referenced by docs (e.g. demo GIFs) |
| `superpowers/` | Implementation **plans** & design **specs**, sorted into domain subfolders. See [`superpowers/plans/README.md`](superpowers/plans/README.md). `superpowers/plans/open/` is the contributor work queue. |

## Conventions

- **Guides & ops docs** use `UPPER_SNAKE_CASE.md`; plans/specs use `YYYY-MM-DD-slug.md`.
- Files are referenced by path from `README.md`, code comments, tests, and other
  docs — when moving one, rewrite the references (grep the repo for its path).
- New contributor work starts as a plan in `superpowers/plans/open/`; see the
  [Coding with Claude Code](https://docs.breezermm.com/contributing/coding-with-claude-code/) guide.
