# Hardware & RAID monitoring — agent release request

Feature #6854. The W06 evidence directory (this folder) records the tested commit, the
six prerequisite PRs, Windows and Linux fault/recovery observations, alert IDs,
screenshots and vendor capture provenance. This file is a request for the release
owner; W06 does not cut a tag, publish, deploy or promote anything.

- [ ] Select the next release tag using the release workflow and verify it contains
  W01, W02a, W02b, W03, W04 and W05 (PRs #6882, #6879, #6880, #6887, #6893, #6894).
  W02a, W02b and W05 ship agent code, so this feature needs an **agent release**, not
  just a server deploy.
- [ ] Version bump location: the release tag. `.github/workflows/release.yml` strips
  its leading `v` and passes the result to `agent/scripts/build-edition.sh`. Do not
  change the Makefile or `main.go` v0.5.0 development fallback.
- [ ] Build signed, edition-correct release artifacts through the established release
  process. The dev-push binaries used in the lab are lab evidence only.
- [ ] Follow `docs/superpowers/specs/agent/2026-06-23-controlled-agent-fleet-rollout.md`.
  Confirm `AGENT_AUTO_PROMOTE=false` in both configuration and the running API
  environment before registration; registration must not change the current fleet target.
- [ ] Verify the release agent on a Windows and a Linux canary: two accepted hardware
  polls, source durations, no unexpected collector failures, native agent health.
- [ ] Record operator approval and the rollout target before promotion. Platform-admin
  `POST /api/v1/agent-versions/promote` accepts `{version, component?}`; omitting
  `component` selects every component. Resolve the current edition/slot-aware operator
  procedure before promotion; W06 does not promote a fleet.
- [ ] Monitor agent CPU, source command durations, failed/backing_off rates and alert
  volume during the first week. Collector contention or a hanging CLI is a reason to
  pause the rollout and use the Hardware Monitoring policy toggle on affected canaries.
- [ ] Keep the prior promoted target and the rollback procedure in the release
  operator's private runbook.
- [ ] Populate the in-app What's New entry during the release
  (`apps/web/src/lib/whatsNew.ts`) using the selected tag/date. Publish marketing notes
  only from the merged PRs and tag range via update-breeze-release-notes.
- [ ] Keep fixture-only vendor rows explicitly marked until real captures exist
  (storcli, perccli, megacli, ssacli, arcconf, omreport, ipmi, racadm, hponcfg and zfs
  are all fixture-only after W06). A real capture is not a failure-injection claim.
  SMART prediction, chassis sensors, out-of-band BMC monitoring and remediation are
  outside this release.
- [ ] Review the defects W06 filed against #6854 (listed in the W06 PR body) and decide
  whether any must land before the tag.

Proposed customer copy: “See RAID array and disk problems in the Hardware tab, with
separate alerts for each affected component. Attach the built-in hardware monitors to
your configuration policies to receive alerts, and use the hardware collection controls
to set polling intervals or pause collection. Requires an updated agent and any
applicable vendor tools already installed.”
