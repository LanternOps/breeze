# README Sponsors and Contributors Design

## Goal

Recognize the people and organizations supporting Breeze while keeping the README professional, current, and low-maintenance. GitHub Sponsors remains a voluntary way to support open-source development and is visually separate from Breeze's hosted commercial offering.

## Scope

This change will:

- Enable GitHub's native Sponsor button for the `LanternOps` organization.
- Add a concise sponsorship call-to-action and a public sponsor gallery to `README.md`.
- Add an automatically maintained contributor gallery to `README.md`.
- Add a repository-owned updater script and GitHub Actions workflow.

It will not change product pricing, hosted subscriptions, sponsor tiers, application UI, or access to product features.

## README Presentation

Add a `Support Breeze` section near the existing `Contributing` section. Its copy will explain that Breeze is free and open source and invite self-hosters and community members to support continued development through GitHub Sponsors.

The section will include a `Sponsors` gallery containing linked GitHub avatars for active public sponsors. Until the LanternOps Sponsors listing is approved and receives a public sponsor, the gallery will show a restrained invitation to become the first sponsor.

Add a `Contributors` subsection within `Contributing`, after `Ways to Contribute`. It will contain linked GitHub avatars for repository contributors. Automated accounts will not be displayed.

Both galleries will use HTML comments as stable replacement boundaries:

```html
<!-- sponsors:start -->
<!-- sponsors:end -->

<!-- contributors:start -->
<!-- contributors:end -->
```

Generated avatars will include useful alternative text, fixed dimensions, and links to the corresponding GitHub profile. Sponsor ordering will be alphabetical so the README does not imply sponsorship value or disclose tiers. Contributors will retain GitHub's contribution-count ordering.

The top-of-page navigation will not gain an additional sponsorship link. The native GitHub Sponsor button and the dedicated README section provide discoverability without making sponsorship part of the primary product pitch.

## Native GitHub Funding Link

Create `.github/FUNDING.yml` containing:

```yaml
github: LanternOps
```

GitHub will use this file to display its native Sponsor button once the LanternOps Sponsors listing is public.

## Automation

Create a dependency-free Node.js script under `.github/scripts/` that:

1. Queries GitHub's GraphQL API for active sponsorships received by `LanternOps`, requesting public sponsorships only.
2. Queries GitHub's REST API for all contributors to `LanternOps/breeze`, following pagination.
3. Removes bot accounts from the contributor result.
4. Validates and escapes all rendered profile data.
5. Generates both README gallery blocks in memory.
6. Replaces the marked regions only after every API request and validation step succeeds.
7. Writes `README.md` only when its contents have changed.

The script will use the workflow-provided GitHub token. It will not query private sponsorships, sponsorship amounts, tiers, or payment information.

Create a GitHub Actions workflow that:

- Runs on a daily schedule and through `workflow_dispatch`.
- Uses only `contents: write` permission.
- Does not run on pull requests or process untrusted repository content.
- Runs the repository-owned updater script.
- Commits and pushes only when the README changed.
- Uses the existing `github-actions[bot]` commit identity pattern already present in the repository.

The generated commit message will identify the update as documentation automation and skip redundant CI when supported.

## Failure Handling

API, authentication, pagination, validation, or marker errors will fail the workflow before `README.md` is written. The existing README will remain intact. Missing or duplicated marker pairs are treated as errors rather than causing broad text replacement.

If the default workflow token cannot read the public organization sponsorship connection after the Sponsors listing becomes active, the workflow will report a clear authentication error. A dedicated read-only secret can then be added as a follow-up; the initial design does not introduce a long-lived personal token unnecessarily.

An empty API result is valid. It renders the sponsor invitation or an empty contributor message rather than failing.

## Verification

Verification will cover:

- Script fixture tests for public sponsors, empty sponsors, contributors, bot filtering, pagination, escaping, and malformed/missing markers.
- A dry run against the current README using mocked GitHub API responses.
- YAML parsing for `.github/FUNDING.yml` and the workflow.
- A final diff check confirming only the intended README regions are changed.

Because the LanternOps Sponsors listing is currently under review, live sponsor population cannot be verified until GitHub makes the listing public. The empty-state output and API behavior will be verified now.

## Success Criteria

- The repository exposes GitHub's native Sponsor button when the listing becomes public.
- The README clearly distinguishes voluntary sponsorship from hosted Breeze subscriptions.
- Active public sponsors appear automatically; private sponsors and financial details never appear.
- New human contributors appear automatically and bots do not.
- Routine syncs require no maintainer action and do not create commits when nothing changed.
