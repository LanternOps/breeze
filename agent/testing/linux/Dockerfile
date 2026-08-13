# NU Agent — Linux test endpoint.
#
# A real systemd host in a container, so `nu-agent service install` exercises the
# same code path a customer's Linux box does: unit file written to
# /etc/systemd/system, `systemctl daemon-reload`, `systemctl enable`, the
# `breeze` system group, /var/run/breeze, and the watchdog bootstrap.
#
# A plain (non-systemd) container would let the agent RUN but would silently skip
# all of that, which is precisely the part worth testing.
FROM ubuntu:24.04

ARG TARGETARCH

ENV DEBIAN_FRONTEND=noninteractive \
    container=docker

# systemd + dbus are the point of this image. The rest is what the agent shells
# out to at install and collection time:
#   passwd    -> groupadd/getent (creates the `breeze` IPC group)
#   procps    -> ps, for the process collector
#   iproute2  -> ip, for the network collector
#   sudo      -> remote script execution drops privileges the way an SSH session does
RUN apt-get update && apt-get install -y --no-install-recommends \
        systemd systemd-sysv dbus \
        ca-certificates curl \
        passwd procps iproute2 sudo \
        less vim-tiny \
    && rm -rf /var/lib/apt/lists/*

# Mask the units that cannot work in a container and would otherwise sit in
# `systemctl --failed` forever — which matters, because a clean --failed list is
# how you tell the agent's own unit apart from container noise.
#
# Mask, don't delete: an earlier version of this file rm -rf'd
# multi-user.target.wants/* wholesale and took dbus with it.
RUN systemctl mask \
        systemd-udevd.service systemd-udev-trigger.service \
        systemd-udevd-control.socket systemd-udevd-kernel.socket \
        systemd-firstboot.service systemd-hwdb-update.service \
        console-getty.service getty@.service \
        systemd-journald-audit.socket \
    && systemctl set-default multi-user.target

COPY stage/nu-agent-linux-${TARGETARCH}    /usr/local/bin/nu-agent
COPY stage/nu-watchdog-linux-${TARGETARCH} /usr/local/bin/nu-watchdog
RUN chmod 0755 /usr/local/bin/nu-agent /usr/local/bin/nu-watchdog

COPY enroll.sh /usr/local/bin/nu-enroll
RUN chmod 0755 /usr/local/bin/nu-enroll

# Deliberately NO `VOLUME /sys/fs/cgroup`. Declaring it mounts an empty
# anonymous volume over the real cgroup2 filesystem Docker provides; systemd
# then sees no unified hierarchy, falls back to mounting cgroup v1, gets
# EPERM, and exits PID 1 with "Failed to mount API filesystems." Let Docker's
# own cgroup2 mount show through.

# systemd shuts down on SIGRTMIN+3, not SIGTERM. Without this `docker stop`
# waits the full timeout and then SIGKILLs, so the agent never runs its
# graceful teardown — which is one of the things worth testing.
STOPSIGNAL SIGRTMIN+3

ENTRYPOINT [ "/sbin/init" ]
