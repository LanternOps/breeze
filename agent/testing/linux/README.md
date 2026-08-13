# Linux test endpoint (Docker)

A throwaway Linux machine that enrolls into the RMM like a real endpoint, so agent
changes can be verified without touching a machine that matters.

It runs **systemd as PID 1**, which is the point: `nu-agent service install` writes a
unit, reloads systemd, enables the service, creates the `breeze` group and
`/var/run/breeze`, and bootstraps the watchdog. A plain container would let the agent
*run* while silently skipping all of that.

## Use

```bash
./build.sh                                    # build binaries + image
cp .env.example .env                          # add your enrollment key + secret
docker compose up -d
docker compose exec linux-endpoint nu-enroll
```

Then in the console the device shows up as `nu-linux-test-01`.

Second endpoint, when you want to prove multi-device behaviour:

```bash
docker compose --profile two up -d
```

Poke at it:

```bash
docker compose exec linux-endpoint journalctl -u nu-agent -f
docker compose exec linux-endpoint systemctl status nu-agent
docker compose exec linux-endpoint nu-agent status
```

Tear down completely — the container is disposable, so this is the whole cleanup:

```bash
docker compose down -v
```

The device row stays in the RMM after teardown; delete it from the console if you
don't want it in the device list.

## What `.env` needs

| Var | Where it comes from |
|---|---|
| `NU_ENROLLMENT_KEY` | Console → Settings → Enrollment Keys → create, copy the plaintext key. It is shown **once**; only a hash is stored. |
| `NU_ENROLLMENT_SECRET` | The server's `AGENT_ENROLLMENT_SECRET`. Global, not per-key. |
| `NU_SERVER` | `https://rmm.nodesunlimited.com` |

`.env` is gitignored. So is `stage/`.

## There is no Linux installer in the console

`GET /enrollment-keys/:id/installer/:platform` accepts **only** `windows` and `macos`.
Linux endpoints have to be enrolled by hand with `nu-agent enroll`, which is what
`enroll.sh` does. If Linux ever needs to be a supported customer platform, that
endpoint is where the work starts.

## Two things that will waste an afternoon if you change them

**Do not add `VOLUME /sys/fs/cgroup` to the Dockerfile.** It mounts an empty anonymous
volume over the real cgroup2 filesystem Docker provides. systemd then sees no unified
hierarchy, falls back to mounting cgroup v1, gets EPERM, and exits as PID 1 with
`Failed to mount API filesystems` — with no container logs at all, because it dies
before journald starts.

**Do not force `cgroup: host` in compose.** systemd needs its own cgroup2 root to
write into. Handed the host hierarchy, it does not own the tree it is trying to
manage. The default (private) namespace is correct.

## Architecture

`build.sh` matches the Docker host architecture by default — arm64 on Apple Silicon,
running natively. Pass `amd64` to build and run the Intel binary under emulation,
which is slower but exercises the same binary Intel customers get.
