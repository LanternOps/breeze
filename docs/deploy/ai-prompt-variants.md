# AI prompt variants — runbook

Prompt variants (AI model registry W11, #7609) append short guidance to a feature's system prompt for one **model family** (prompt profile): `claude-frontier`, `claude-standard`, `claude-small`. `generic` never has variants. They live in code: `apps/api/src/services/aiModels/promptVariants.ts`.

## Lifecycle

| State | Live traffic | How it moves |
|---|---|---|
| `staged` | none | offline eval (gate G1), then a PR → `candidate` |
| `candidate` | a sticky `canaryPercent` (1–25 %) of conversations, by session / agent-run id | after ≥ 7 days and ≥ 30 conversations per arm, a PR → `active` (and the old active → `retired`), or → `retired` |
| `active` | every other conversation of its surface + family | superseded by a newer active |
| `retired` | none | kept so old ledger rows keep a name |

At most one `active` and one `candidate` per surface + family. Variants only append; they never remove prompt text. `promptVariants.test.ts` enforces every rule.

## 1. Author

Add a `staged` entry with the next version for its surface + family, and a `hypothesis` naming what it should move in the quality view. Open a PR.

## 2. Evaluate offline (gate G1)

On the PR branch, run the golden eval twice on a model of the variant's family, once for the base prompt and once for the variant:

```bash
gh workflow run ai-tool-eval.yml --ref <branch> -f model=<model id> -f surface=chat
gh workflow run ai-tool-eval.yml --ref <branch> -f model=<model id> -f surface=chat -f prompt_variant=<variant id>
```

For an `ai_agents` variant, run the agent suite locally instead:

```bash
pnpm --filter @breeze/api ai:tool-eval -- --suite agent --model <id> [--prompt-variant <id>]
```

The workflow input only drives the chat suite.

**Pass:**
- variant accuracy ≥ base − 1 case;
- no new "answered without a tool" or "not exposed" rows;
- mean context tokens to first tool ≤ base + 5 %.

## 3. Canary

A PR sets `state: 'candidate'` and `canaryPercent` (start at 10). It ships with the next release.

## 4. Read the result (gate G5)

`/admin/ai-models` → **Prompt variants** compares the variant with its base prompt across all partners over the last 28 days. It needs a platform-admin login; see "No platform admin" below.

Compare the candidate with the row marked **Incumbent**: the active variant, or the base prompt when none is active. Once a variant is active, no conversation gets the base prompt, so base stops accumulating data.

**Promote** when:
- both arms have ≥ 30 conversations;
- the candidate's flag rate, refusal rate and "left for another model" are no worse than the incumbent's;
- its turns to resolve and cost per conversation are no worse than the incumbent's + 10 %.

Otherwise retire it.

## Turning variants off without a release

Set the model's **prompt profile** to **Generic** on `/admin/ai-models`. Generic has no variants, so new conversations on that model get the base prompt. Conversations already running keep their prompt until their live session is recreated. Set the profile back when the fix ships.

## No platform admin

Run this read-only query against the region's database (psql with the API's `DATABASE_URL`):

```sql
SELECT COALESCE(i.prompt_variant, i.surface || '/' || i.prompt_profile || '@base') AS variant,
       COUNT(DISTINCT i.session_id) AS sessions,
       COUNT(DISTINCT i.session_id) FILTER (
         WHERE s.flagged_at IS NOT NULL
           AND NOT starts_with(COALESCE(s.flag_reason, ''), 'Tool failed:')
           AND NOT starts_with(COALESCE(s.flag_reason, ''), 'Tool rejected before execution:')) AS flagged_by_people,
       COUNT(*) FILTER (WHERE i.stop_reason = 'refusal') AS refusals,
       COUNT(*) AS calls
  FROM ai_invocations i
  LEFT JOIN ai_sessions s ON s.id = i.session_id
 WHERE i.ledger_mode = 'authoritative'
   AND i.prompt_profile IS NOT NULL
   AND i.created_at >= now() - interval '28 days'
 GROUP BY 1
 ORDER BY 1;
```
