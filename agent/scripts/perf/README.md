# Lab measurement harness

Measures a `breeze-agent` Windows build on one libvirt lab VM against a local `worktree-stack`, for the Go agent performance audit (`docs/superpowers/specs/2026-11-17-go-agent-performance-audit-design.md`).

- `run-lab.sh` runs on the host. It drives the VM through the QEMU guest agent, so the VM needs no SSH.
- `sample-process.ps1` runs in the VM. Every 10 seconds it writes one row of `ts,workingSetBytes,privateBytes,cpuSeconds,handles`.

## Usage

```bash
pnpm wt-stack up
cd agent && GOOS=windows GOARCH=amd64 go build -ldflags "-X main.version=perf" -o /tmp/breeze-agent.exe ./cmd/breeze-agent && cd ..

export BREEZE_STACK_URL=$(jq -r .baseUrl .breeze-stack.json)       # http://localhost:<caddy port>
export BREEZE_PG_CONTAINER=$(jq -r .pgContainer .breeze-stack.json)
export BREEZE_ADMIN_EMAIL=admin@breeze.local BREEZE_ADMIN_PASSWORD='BreezeAdmin123!'  # local-stack seed admin
export BREEZE_ENROLLMENT_SECRET=$(grep ^AGENT_ENROLLMENT_SECRET= .env | cut -d= -f2)  # when the stack sets one

agent/scripts/perf/run-lab.sh --vm Win11-26H2-01 --agent /tmp/breeze-agent.exe \
  --workload idle --runs 5 --out /tmp/perf/idle-before [--snapshot <name>] [--seconds <n>]
```

In fish, run the `export` lines as `set -x NAME value`.

Run it from the repo root. The enrollment runs only against the local stack, never production.

| Workload | Length | What runs |
|---|---|---|
| `idle` | 1800 s | The agent alone, on its default 60-second heartbeat |
| `scan` | 600 s | One `refresh_inventory` and one patch scan, queued as soon as the agent is enrolled |
| `desktop` | | Not automated. It needs a WebRTC viewer session. |
| `transfer` | | Not automated. No API command moves 500 MB to the agent, and file upload stops at 4 MB. |

`--seconds` overrides the length.

Each run writes `run-<n>/` under `--out`:

- `sample.csv`: the sampler rows
- `agent-runtime.json` and `goroutines.txt`: the newest heartbeat's `agentRuntime`
- `commands.txt`: the device's commands and their status
- `state-before.txt` and `state-after.txt`: hashes of `C:\ProgramData\Breeze`, when there is no snapshot
- `services-after.txt`: the installed services' status after the restart, when there is no snapshot

`binary-size.txt` holds the agent's size in bytes.

## What a run does

1. With `--snapshot`, it reverts the snapshot. The harness refuses to start while any other VM is running.
2. It starts the VM and waits for `guest-ping`.
3. Without `--snapshot`, it keeps the installed agent safe:
   - It stops the running `*breeze*` services, watchdog first.
   - It hashes `C:\ProgramData\Breeze` and mirrors it to `C:\ProgramData\Breeze.perf-backup`.
   - The test agent's `--config` only moves `agent.yaml`. Secrets, state, data and logs still land in `C:\ProgramData\Breeze`, so the backup is needed.
   - `PERF_LAB_DATA_DIR` replaces that path. It is test-only, for exercising the backup on a scratch tree.
4. It serves the agent and sampler on the libvirt bridge address, port 53317, and the VM downloads them to `C:\breeze-perf`. The harness then checks the SHA256.
5. It relays the same port to the stack with `socat`, enrolls the agent with a single-use key, and starts it detached.
6. It samples the test binary by path, queues the workload's commands, and pulls the CSV and the newest `agentRuntime`.
7. It stops the test agent, then mirrors the backup back and restarts the services. The run fails if the hashes differ.
8. It deletes `C:\breeze-perf` and shuts the VM down.

The exit trap repeats steps 7 and 8 and kills the file server and relay, so a failed run still restores the installed agent. If a backup is still present when a run starts, the run stops so the backup is never overwritten.

The VM cannot reach host services directly, so the harness uses the bridge-bound port, which the host firewall allows. It reads the bridge address from `virsh net-dumpxml default` at runtime.

## Measurement discipline

These rules are copied from the spec.

### Benchmarks

- New benchmarks use `b.Loop()` and live in `<source>_bench_test.go`, in the same order as the functions they measure.
- Run with `-benchmem -count=10` and compare with `benchstat`.
- Run benchmarks one at a time, never in parallel with other benchmarks or builds.
- Commit messages paste only the affected rows, with the `goos`/`goarch`/`cpu` line, and use the `perf(agent):` type.
- A row marked `~` (not significant) is not a win and is not pasted.

### Lab VMs

- Measure one VM at a time, with the other two shut off.
- With `--snapshot`, revert each VM to the same libvirt snapshot before every run.
- Without it (the default), each run backs up `C:\ProgramData\Breeze` and restores it afterwards, and fails if the hashes differ.
- Run at least 5 runs per arm, alternating before and after builds.
- Report the median and spread of each metric.

### Fleet

- Before wave 2 ships, record the p50 and p95 of `agentRuntime` `sysBytes`, `heapInuseBytes` and `goroutines` from stored heartbeats.
- Repeat the same query after each wave reaches the fleet.
