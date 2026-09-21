# coturn TLS placeholder

This directory is intentionally empty. It is the default bind-mount source for
`/etc/coturn/tls` in the bundled `coturn` service, so that Docker never creates
a phantom directory on the host when `TURN_TLS_DIR` is unset.

To enable TURN over TLS (`turns:` on 5349), point `TURN_TLS_DIR` at a directory
containing `cert.pem` and `privkey.pem` that are **readable by uid 65534
(`nobody`)** — coturn drops privileges and cannot read Caddy's `0600 root`
files directly. Copy them to a staging directory at mode `0640` with a group
`nobody` can read, and restart (or `SIGHUP`) coturn whenever they are renewed:
coturn reads the certificate once at startup and never reloads it.

See `docs/deploy/turn-server/` for the full recipe.
