# W06 completion checklist — Hardware & RAID monitoring (#6854)

- [x] Lab resources restored: only this run's resources were removed. On Windows, the
  two lab VHDX files, the `BreezeW06Pool` pool and the `BreezeW06Mirror` virtual disk.
  On Linux, the whole disposable QEMU VM (md0, loop devices, udev rule, lab agent),
  plus the per-worktree stack and its lab policy (tmpfs Postgres, dropped with
  `pnpm wt-stack down`). Other sessions' stacks were not touched.
- [ ] **Windows lab VM production agent NOT fully restored.** The production agent
  binary and `agent.yaml` from the 2026-09-21 backup are back in place, and the lab
  agent's config is kept aside privately on the VM. The agent reports *"Waiting for
  enrollment"*. The production auth token lived in `secrets.yaml`, and the 09-21 backup
  never captured that file. Later lab enrollments overwrote it before this run started.
  Before W06, the VM was already enrolled to an earlier, dead local lab stack, not to
  EU production. To return it to production, re-enroll it against EU with a production
  enrollment key. That is an operator action this wave did not take.
- [x] The Linux lab agent was destroyed with its VM. No lab agent points at production.
- [x] Agent release request recorded (`w06-release-request.md`). This lab completion does
  not claim a fleet release or promotion.
- [x] Vendor coverage separates fixture-only, real-capture and live-lab proof. All nine
  vendor and BMC sources, plus zfs, are fixture-only.
- [x] Screenshots and structured evidence were reviewed for credentials and internal
  infrastructure before publication. `review_evidence` was run on every JSON file, and
  every PNG was inspected by eye.

## Evidence

- [w06-environment.json](w06-environment.json): tested commit, six merged prerequisite PRs, lab devices
- [w06-policy.json](w06-policy.json): four built-ins attached to a partner-owned policy, device-only assignments
- [w06-windows-baseline.json](w06-windows-baseline.json) / [png](w06-windows-baseline.png)
- [w06-windows-degraded.json](w06-windows-degraded.json) / [png](w06-windows-degraded.png)
- [w06-windows-recovered.json](w06-windows-recovered.json) / [png](w06-windows-recovered.png): PARTIAL, see #6895
- [w06-policy-toggle.json](w06-policy-toggle.json) / [w06-policy-disabled.png](w06-policy-disabled.png)
- [w06-linux-baseline.json](w06-linux-baseline.json) / [png](w06-linux-baseline.png)
- [w06-linux-degraded.json](w06-linux-degraded.json) / [png](w06-linux-degraded.png)
- [w06-linux-rebuilding.json](w06-linux-rebuilding.json) / [png](w06-linux-rebuilding.png)
- [w06-linux-recovered.json](w06-linux-recovered.json) / [png](w06-linux-recovered.png)
- [w06-zfs.json](w06-zfs.json): skipped (optional)
- Vendor provenance (all fixture-only): [storcli](w06-storcli.json), [perccli](w06-perccli.json), [megacli](w06-megacli.json), [ssacli](w06-ssacli.json), [arcconf](w06-arcconf.json), [omreport](w06-omreport.json), [ipmi](w06-ipmi.json), [racadm](w06-racadm.json), [hponcfg](w06-hponcfg.json)
- [w06-release-validation.json](w06-release-validation.json), [w06-release-request.md](w06-release-request.md)

## Issues filed

- #6895: Storage Spaces missing member gets a new key, so its `physical_disk_failed` alert stays open for 7 days after recovery (bug)
- #6896: smartctl reports 0 GiB for disks with no `user_capacity` (bug, low)
