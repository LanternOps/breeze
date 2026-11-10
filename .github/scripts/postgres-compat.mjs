// Scheduled Postgres compatibility run (#11416 W1, #11417): the two pieces of
// .github/workflows/postgres-compat.yml that are logic rather than YAML.
//
//   node .github/scripts/postgres-compat.mjs plan
//     EVENT_NAME, SCHEDULE (github.event.schedule), INPUT_VERSIONS (dispatch)
//     → `versions=["18"]` on $GITHUB_OUTPUT, from postgres-versions.json.
//
//   node .github/scripts/postgres-compat.mjs notify
//     GH_REPO, RUN_ID, RUN_URL, VERSIONS, PLAN_RESULT (+ GH_TOKEN)
//     → one rolling issue per major, labelled postgres-compat: opened or
//       commented on while that major is red, closed by its next green run.
//
// The notifier borrows ci.yml main-red-alert's discipline: reads retry,
// writes get exactly one attempt (a retried create whose response was lost
// opens a duplicate), and a failed read is never mistaken for "no issue is
// open". Unlike main-red-alert it is not inside a gate-judged workflow, so a
// failed read or write exits 1: the scheduled run goes red for it as well.
// A major is green only when EVERY job it should have run succeeded: a job
// that never reported (renamed, never expanded, skipped) is a failure, so a
// broken nightly can neither go quiet nor close a real issue.
// Tested by .github/scripts/postgres-compat.test.mjs. Built-ins only.
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

export const LABEL = 'postgres-compat';
export const WORKFLOW_ISSUE_TITLE = 'Postgres compatibility workflow failing';
export const issueTitle = (major) => `Postgres ${major} compatibility run failing`;

const VERSIONS_URL = new URL('./postgres-versions.json', import.meta.url);
// A job timeout reports as `cancelled`, so it is a failure here too.
const FAILED = new Set(['failure', 'timed_out', 'cancelled', 'startup_failure']);
const SHARDS = 16;

/** Every job one major runs in postgres-compat.yml, by its expanded name
 *  (the contract test derives the same list from the workflow's templates). */
export function expectedJobNames(major) {
  return [
    `Migrations (Postgres ${major})`,
    `Migrations, non-superuser (Postgres ${major})`,
    ...Array.from({ length: SHARDS }, (_, i) => `Integration (Postgres ${major}, shard ${i + 1}/${SHARDS})`),
  ];
}

const byMajor = (a, b) => Number(a) - Number(b);

export function planVersions({ eventName, schedule = '', input = '', config }) {
  const scheduled = Object.keys(config.scheduled).sort(byMajor);
  switch (eventName) {
    case 'schedule': {
      const hit = scheduled.filter((m) => config.scheduled[m].cron === schedule.trim());
      if (hit.length === 0) throw new Error(`no scheduled major for cron ${JSON.stringify(schedule)} in postgres-versions.json`);
      return hit;
    }
    case 'workflow_dispatch': {
      const wanted = [...new Set(input.split(',').map((s) => s.trim()).filter(Boolean))];
      if (wanted.length === 0) throw new Error('no versions requested');
      for (const m of wanted) {
        if (!scheduled.includes(m)) throw new Error(`${m} is not a scheduled major (postgres-versions.json has ${scheduled.join(', ')})`);
      }
      return wanted.sort(byMajor);
    }
    case 'pull_request':
      return scheduled;
    default:
      throw new Error(`unsupported event ${JSON.stringify(eventName)}`);
  }
}

export function summarizeRun(jobs, versions) {
  const conclusionOf = new Map(jobs.map((j) => [j.name, j.conclusion]));
  return versions.map((version) => {
    const failed = [];
    const missing = []; // absent, skipped, neutral or still running
    for (const name of expectedJobNames(version)) {
      const c = conclusionOf.get(name);
      if (FAILED.has(c)) failed.push(name);
      else if (c !== 'success') missing.push(name);
    }
    const state = failed.length || missing.length ? 'failing' : 'green';
    return { version, state, failed, missing };
  });
}

const jobList = (names) => names.map((n) => `- ${n}`).join('\n');

export function planIssueActions({ summary, planFailed = false, openIssues, runUrl }) {
  const openNumber = (title) => openIssues.find((i) => i.title === title)?.number;
  const actions = [];
  const failing = (title, what, failedJobs, missingJobs = []) => {
    const n = openNumber(title);
    const jobs = (failedJobs.length ? `\n\nFailed jobs:\n${jobList(failedJobs)}` : '')
      + (missingJobs.length ? `\n\nJobs that did not report a result:\n${jobList(missingJobs)}` : '');
    if (n) {
      actions.push({ kind: 'comment', number: n, body: `Still failing (${what}): ${runUrl}${jobs}` });
    } else {
      actions.push({
        kind: 'create',
        title,
        body: `Scheduled run failed (${what}): ${runUrl}${jobs}\n\n`
          + 'Managed by `.github/workflows/postgres-compat.yml`: commented on while this stays red, closed by the next green scheduled run. '
          + 'How to triage a red: docs/agents/testing.md, "Postgres compatibility".',
      });
    }
  };
  if (planFailed) {
    failing(WORKFLOW_ISSUE_TITLE, 'the plan job did not succeed, so no major was tested', []);
  } else {
    const n = openNumber(WORKFLOW_ISSUE_TITLE);
    if (n) actions.push({ kind: 'close', number: n, body: `The plan job succeeded again: ${runUrl}` });
  }
  for (const s of summary) {
    if (s.state === 'failing') failing(issueTitle(s.version), `Postgres ${s.version}`, s.failed, s.missing);
    if (s.state === 'green') {
      const n = openNumber(issueTitle(s.version));
      if (n) actions.push({ kind: 'close', number: n, body: `Postgres ${s.version} is green again: ${runUrl}` });
    }
  }
  return actions;
}

function defaultGh(args) {
  return execFileSync('gh', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
}

const defaultSleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const defaultOut = {
  log: (m) => console.log(m),
  error: (m) => console.log(m), // ::error:: annotations are read from stdout
  summary: (md) => {
    if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${md}\n`);
  },
};

export async function notify({ env = process.env, runGh = defaultGh, sleep = defaultSleep, out = defaultOut } = {}) {
  const repo = env.GH_REPO;
  const runUrl = env.RUN_URL;
  const versions = JSON.parse(env.VERSIONS || '[]');
  const planFailed = env.PLAN_RESULT !== 'success';

  // gh's own complaint (stderr) is the useful part; execFileSync's message
  // is mostly the command line.
  const cause = (err) => String(err?.stderr || err?.message || err).trim().split('\n')[0].slice(0, 300);
  let lastReadError = '';

  // Reads only. Progress goes to `out`, never into the returned value.
  const readRetry = async (what, args) => {
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        return runGh(args);
      } catch (err) {
        lastReadError = cause(err);
        out.log(`gh read failed (${what}, attempt ${attempt}/3): ${lastReadError}`);
        if (attempt < 3) await sleep(attempt * 5000);
      }
    }
    return null;
  };

  let summary = [];
  if (versions.length > 0) {
    // filter=latest: each job's most recent attempt, so a "re-run failed
    // jobs" attempt is judged together with the successes it carried over.
    const raw = await readRetry('run jobs', [
      'api', '--paginate',
      `repos/${repo}/actions/runs/${env.RUN_ID}/jobs?filter=latest&per_page=100`,
      '--jq', '.jobs[] | [.name, (.conclusion // "")] | @tsv',
    ]);
    if (raw === null) {
      out.error(`::error::Could not read this run's jobs after 3 attempts (${lastReadError}); postgres-compat issues are unchanged. Re-run this job to reconcile.`);
      return 1;
    }
    const jobs = raw.split('\n').filter(Boolean).map((line) => {
      const [name, conclusion] = line.split('\t');
      return { name, conclusion: conclusion || null };
    });
    summary = summarizeRun(jobs, versions);
    for (const s of summary) {
      out.log(`Postgres ${s.version}: ${s.state} (${s.failed.length} failed, ${s.missing.length} without a result, of ${expectedJobNames(s.version).length} jobs)`);
    }
  }

  const listed = await readRetry('open issues', [
    'issue', 'list', '--repo', repo, '--label', LABEL, '--state', 'open', '--json', 'number,title', '--limit', '100',
  ]);
  if (listed === null) {
    // Treating this as "none open" would open a duplicate issue every red night.
    out.error(`::error::Could not read open postgres-compat issues after 3 attempts (${lastReadError}); nothing was filed or closed. Re-run this job to reconcile.`);
    return 1;
  }
  const actions = planIssueActions({ summary, planFailed, openIssues: JSON.parse(listed || '[]'), runUrl });

  let labelReady = false;
  let writeFailed = false;
  for (const a of actions) {
    try {
      if (a.kind === 'create') {
        if (!labelReady) {
          labelReady = true;
          try {
            runGh(['label', 'create', LABEL, '--repo', repo, '--color', 'B60205', '--description', 'Scheduled Postgres 17/18 compatibility run failed']);
          } catch (err) {
            // "already exists" is the common case; anything else will surface
            // as the create below failing on the missing label.
            if (!/already exists/i.test(cause(err))) out.log(`label create: ${cause(err)}`);
          }
        }
        runGh(['issue', 'create', '--repo', repo, '--label', LABEL, '--title', a.title, '--body', a.body]);
        out.log(`opened: ${a.title}`);
      } else if (a.kind === 'comment') {
        runGh(['issue', 'comment', String(a.number), '--repo', repo, '--body', a.body]);
        out.log(`commented on #${a.number}`);
      } else {
        runGh(['issue', 'close', String(a.number), '--repo', repo, '--comment', a.body]);
        out.log(`closed #${a.number}`);
      }
    } catch (err) {
      writeFailed = true;
      const verb = { create: 'open', comment: 'comment on', close: 'close' }[a.kind];
      const target = a.title ?? `#${a.number}`;
      out.error(`::error::Failed to ${verb} ${target} (${cause(err)}); not retried. Re-run this job to reconcile.`);
      out.summary(`### postgres-compat notifier: failed to ${verb} ${target}\nRun: ${runUrl}`);
    }
  }
  return writeFailed ? 1 : 0;
}

function planCli() {
  const config = JSON.parse(readFileSync(VERSIONS_URL, 'utf8'));
  const versions = planVersions({
    eventName: process.env.EVENT_NAME,
    schedule: process.env.SCHEDULE,
    input: process.env.INPUT_VERSIONS,
    config,
  });
  console.log(`Postgres majors for this run: ${versions.join(', ')}`);
  if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `versions=${JSON.stringify(versions)}\n`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const cmd = process.argv[2];
  try {
    if (cmd === 'plan') planCli();
    else if (cmd === 'notify') process.exitCode = await notify();
    else throw new Error('usage: postgres-compat.mjs plan|notify');
  } catch (err) {
    console.log(`::error::postgres-compat ${cmd ?? ''}: ${err.message}`);
    process.exitCode = 1;
  }
}
