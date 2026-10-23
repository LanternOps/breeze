# Vercel custom images must be built for linux/amd64.
FROM node:24-bookworm-slim@sha256:55fb5f5a527ea2c5c4a95f963e48ef90aa38c7b346054fdc8ee9957a2b55d205 AS node
FROM python:3.13-slim-bookworm@sha256:ed86c82274b3c69b52fb5820f358f0bd7df0b603332063cb5c6e32bd220c3e6e

COPY --from=node /usr/local/bin/node /usr/local/bin/node
# apt-get upgrade picks up fixed Debian security-repo packages (e.g. libpcre2-8-0)
# published after this base image's digest was pinned; it never changes the
# digest itself, so the pin above still identifies the base layer.
RUN apt-get update \
    && apt-get upgrade -y --no-install-recommends \
    && apt-get install -y --no-install-recommends bash ca-certificates jq ripgrep sqlite3 poppler-utils fonts-dejavu-core \
    && rm -rf /var/lib/apt/lists/*
COPY requirements.lock /opt/breeze-runtime/requirements.lock
RUN python3 -m pip install --no-cache-dir --only-binary=:all: --require-hashes \
    -r /opt/breeze-runtime/requirements.lock \
    && python3 -m pip check
COPY smoke.py /opt/breeze-runtime/smoke.py
RUN python3 /opt/breeze-runtime/smoke.py \
    && node -e 'if (1+2 !== 3) process.exit(1)' \
    && jq --version && rg --version && sqlite3 --version \
    && useradd --create-home --uid 1000 breeze \
    && mkdir -p /work/in /work/out /work/tmp \
    && chown -R breeze:breeze /work
USER breeze
WORKDIR /work
