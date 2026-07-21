# README Sponsors and Contributors Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox syntax for tracking.

**Goal:** Add automatically refreshed public sponsor and human contributor galleries to the Breeze README, plus GitHub's native Sponsor button.

**Architecture:** A dependency-free Node.js module owns rendering, GitHub API pagination, validation, and atomic README replacement. A scheduled/manual GitHub Actions workflow supplies the repository token, runs the module, and commits only a changed README. Stable HTML comments isolate generated content from hand-written copy.

**Tech Stack:** Node.js 22 ESM, built-in fetch, node:test, GitHub GraphQL and REST APIs, GitHub Actions, Markdown/HTML.

## Global Constraints

- Display active public sponsors only; never query or render private sponsors, amounts, or tiers.
- Filter GitHub bot accounts from contributors.
- Use no runtime npm dependencies or third-party sponsor widgets/actions.
- Build both galleries in memory and leave README.md untouched on any failure.
- Run automation only on a daily schedule and manual dispatch with contents: write.
- Implement on a clean docs/readme-sponsors-contributors branch.

## File Map

- Create .github/FUNDING.yml for GitHub's Sponsor button.
- Create .github/scripts/update-community-readme.mjs for rendering, API access, and atomic updates.
- Create .github/scripts/update-community-readme.test.mjs for Node tests.
- Create .github/workflows/update-community-readme.yml for refreshes.
- Modify README.md with support copy and generated block markers.

---

### Task 1: Rendering and marker safety

**Files:**
- Create: .github/scripts/update-community-readme.mjs
- Create: .github/scripts/update-community-readme.test.mjs

**Interfaces:**
- Produces escapeHtml(value), isBot(account), renderGallery(accounts, emptyMarkdown), and replaceMarkedBlock(markdown, name, content).
- CommunityAccount fields are login, optional name, avatarUrl, url, and optional type.

- [ ] **Step 1: Write failing helper tests**

Use node:test and node:assert/strict. Assert HTML escaping, Bot type and [bot] suffix handling, fixed 64px accessible avatars, empty-state output, and rejection of missing, duplicate, or reversed markers.

    test('replaces exactly one marker pair', () => {
      const source = 'before\n<!-- sponsors:start -->\nold\n<!-- sponsors:end -->\nafter\n';
      assert.equal(
        replaceMarkedBlock(source, 'sponsors', 'new'),
        'before\n<!-- sponsors:start -->\nnew\n<!-- sponsors:end -->\nafter\n',
      );
      assert.throws(() => replaceMarkedBlock('missing', 'sponsors', 'new'), /exactly one/);
    });

- [ ] **Step 2: Verify the test fails**

Run: node --test .github/scripts/update-community-readme.test.mjs

Expected: ERR_MODULE_NOT_FOUND.

- [ ] **Step 3: Implement pure helpers**

escapeHtml must replace ampersand, angle brackets, both quote types. isBot must accept GitHub type Bot or a login ending [bot]. renderGallery must add s=128 to avatar URLs and render linked images with width, height, title, and alt attributes. replaceMarkedBlock must require exactly one ordered start/end pair and preserve everything outside it.

    export function replaceMarkedBlock(markdown, name, content) {
      const start = '<!-- ' + name + ':start -->';
      const end = '<!-- ' + name + ':end -->';
      if (markdown.split(start).length !== 2
          || markdown.split(end).length !== 2
          || markdown.indexOf(start) > markdown.indexOf(end)) {
        throw new Error('README must contain exactly one ordered ' + name + ' marker pair');
      }
      return markdown.slice(0, markdown.indexOf(start))
        + start + '\n' + content + '\n' + end
        + markdown.slice(markdown.indexOf(end) + end.length);
    }

- [ ] **Step 4: Run and commit**

Run: node --test .github/scripts/update-community-readme.test.mjs

Expected: helper tests PASS.

    git add .github/scripts/update-community-readme.mjs .github/scripts/update-community-readme.test.mjs
    git commit -m "test(docs): define community gallery rendering"

---

### Task 2: GitHub clients and atomic update

**Files:**
- Modify: .github/scripts/update-community-readme.mjs
- Modify: .github/scripts/update-community-readme.test.mjs

**Interfaces:**
- Produces fetchSponsors(fetchImpl, token), fetchContributors(fetchImpl, token), buildReadme(source, sponsors, contributors), and updateReadme(options).

- [ ] **Step 1: Add failing API tests**

Inject fetchImpl fixtures using Node's Response. Cover two-page sponsor results, includePrivate: false, activeOnly: true, null removal, case-insensitive de-duplication, alphabetical ordering, contributor pages of 100 plus a final short page, bot filtering, API failure without a write, malformed markers without a write, and a no-op second update.

- [ ] **Step 2: Verify missing exports fail**

Run: node --test .github/scripts/update-community-readme.test.mjs

Expected: FAIL for missing API/updater exports.

- [ ] **Step 3: Implement the sponsor client**

Use this GraphQL connection:

    organization(login: $login) {
      sponsorshipsAsMaintainer(
        first: 100,
        after: $cursor,
        activeOnly: true,
        includePrivate: false
      ) {
        pageInfo { hasNextPage endCursor }
        nodes {
          sponsorEntity {
            ... on User { login name avatarUrl url }
            ... on Organization { login name avatarUrl url }
          }
        }
      }
    }

Send Authorization: Bearer, Accept: application/vnd.github+json, and X-GitHub-Api-Version: 2022-11-28. Reject non-2xx responses, GraphQL errors, missing organizations, and malformed connections. Never request privacyLevel, amounts, or tiers.

- [ ] **Step 4: Implement contributors and atomic writes**

Request GET /repos/LanternOps/breeze/contributors?anon=0&per_page=100&page=N until a page has fewer than 100 entries. Map avatar_url and html_url, preserve API order, and filter bots.

Read the original README and fetch both lists before rendering. Replace sponsors then contributors in memory. When changed, write a process-specific temporary sibling and rename it over README.md; remove the temp file after errors. The CLI reads GITHUB_TOKEN, logs changed/unchanged, and exits nonzero on failure.

- [ ] **Step 5: Run and commit**

Run: node --test .github/scripts/update-community-readme.test.mjs

Expected: all helper, API, privacy, pagination, and atomic-write tests PASS.

    git add .github/scripts/update-community-readme.mjs .github/scripts/update-community-readme.test.mjs
    git commit -m "feat(docs): automate sponsor and contributor galleries"

---

### Task 3: Funding, README, and workflow

**Files:**
- Create: .github/FUNDING.yml
- Create: .github/workflows/update-community-readme.yml
- Modify: README.md
- Modify: .github/scripts/update-community-readme.test.mjs

- [ ] **Step 1: Add a failing repository contract test**

Assert funding equals github: LanternOps plus a newline; each README block has exactly one start/end marker; and the workflow contains schedule, workflow_dispatch, contents: write, and the updater command but no pull_request trigger.

- [ ] **Step 2: Add funding and README content**

FUNDING.yml:

    github: LanternOps

Before Contributing, add Support Breeze copy explaining that Breeze is free/open source and linking to https://github.com/sponsors/LanternOps. Add a Sponsors subsection with these markers and empty state:

    <!-- sponsors:start -->
    _No public sponsors yet. [Become the first sponsor →](https://github.com/sponsors/LanternOps)_
    <!-- sponsors:end -->

After Ways to Contribute, add a Contributors subsection thanking contributors and these markers:

    <!-- contributors:start -->
    _No contributors are available yet._
    <!-- contributors:end -->

- [ ] **Step 3: Add the workflow**

Schedule at 17 5 * * * and allow workflow_dispatch. Grant only contents: write. Use actions/checkout@v7 and actions/setup-node@v6 with Node 22. Pass GITHUB_TOKEN from \${{ github.token }}. Run the repository script. If README differs, commit only README as github-actions[bot] with message docs: refresh sponsors and contributors [skip ci], then push HEAD:main.

- [ ] **Step 4: Populate and verify**

    GITHUB_TOKEN="$(gh auth token)" node .github/scripts/update-community-readme.mjs
    node --test .github/scripts/update-community-readme.test.mjs
    actionlint .github/workflows/update-community-readme.yml
    ruby -e 'require "yaml"; YAML.load_file(ARGV.fetch(0), aliases: true)' .github/FUNDING.yml
    git diff --check

Expected: sponsor empty state remains during GitHub review; contributors populate; tests and validators pass.

- [ ] **Step 5: Commit**

    git add .github/FUNDING.yml .github/workflows/update-community-readme.yml .github/scripts/update-community-readme.test.mjs README.md
    git commit -m "docs: recognize Breeze sponsors and contributors"

---

### Task 4: Final verification and PR

- [ ] **Step 1: Run final checks**

    node --test .github/scripts/update-community-readme.test.mjs
    actionlint .github/workflows/update-community-readme.yml
    git diff --check
    git status --short
    git diff --stat origin/main...HEAD

Expected: checks pass and no device-change-history or .githooks files appear.

- [ ] **Step 2: Push and open the PR**

    git push -u origin docs/readme-sponsors-contributors
    gh pr create --base main --head docs/readme-sponsors-contributors --title "docs: recognize Breeze sponsors and contributors" --body-file /tmp/breeze-community-pr.md

The PR body must summarize funding, automatic public recognition, privacy, workflow triggers, tests, and the expected sponsor empty state while GitHub reviews the listing.
