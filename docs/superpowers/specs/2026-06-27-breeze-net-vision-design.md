# breeze-net — North-Star Vision

**Status:** Vision / concept doc (not an implementation spec)
**Date:** 2026-06-27
**Author:** Todd Hebebrand (with Claude)

> This is a north-star document. It captures the concept, the unifying pattern,
> the trust and privacy model, and a phased roadmap. It deliberately does **not**
> specify schemas, endpoints, or migrations — each buildable wedge gets its own
> focused spec spun out of this vision later.

---

## 1. The Idea in One Sentence

**breeze-net** is a community-driven, opt-in intelligence network where every
MSP's normal RMM work quietly contributes verdicts — and every MSP draws back a
shared brain that no single shop could ever build alone.

---

## 2. The Core Insight — Collapsing Duplicated Judgment

The most expensive thing in IT and security services is a *human deciding the
same thing everyone else is already deciding.*

Across the whole industry, thousands of analysts and admins independently
re-decide the same verdicts about the same artifacts:

- Is **KB5034441** safe to deploy, or does it break something?
- Is **FooApp 1.2.3** a bad version?
- Is **Event ID 7034 from Service Control Manager** benign noise, or a real problem?
- Is **this domain** malware, or fine?
- Is **this file hash** a trusted build of a new release, or a threat?

Every security company pays salaried people to look at these signals and decide
"benign or problem." That work is *massively duplicated* — and almost none of it
is shared. breeze-net collapses that duplication into one shared corpus.

The key move that makes it viable: **zero-effort contribution.** Nobody sits
down to "contribute." The triage and decisions they already make in the course
of normal work *are* the contribution. You opt in once; your day-to-day RMM
activity feeds the network as a byproduct.

---

## 3. The Unifying Pattern — `(canonical artifact) + (community judgment)`

Every data type in breeze-net reduces to the same shape:

- A **canonical artifact** — a globally-identifiable thing that is *the same on
  every machine on earth* (a KB number, a software name+version, an event log
  signature, a file hash, a domain).
- A **community judgment** — the verdict humans (and ML) attach to that artifact.

Aggregate one judgment across thousands of MSPs and the network knows things no
individual shop can: "this event ID is noise 98% of the time," "this version is
known-broken with X," "this domain went bad three hours ago."

This pattern is the spine of the entire network. Security is the flagship use
case, but ops use cases ride the exact same rails.

---

## 4. The Flagship — Community SOC / Triage Flywheel

The single most expensive line item in security services is a **human analyst
triaging signals**: EDR alerts, DNS lookups, file activity, abnormal event logs.
breeze-net turns that into a self-reinforcing loop:

1. **ML surfaces** an anomaly to the MSP locally — an abnormal event, a weird DNS
   lookup, odd file activity. (Breeze already has the reporters and the base ML.)
2. **The human flags it** — benign / problem. One click, inside work they're
   already doing.
3. **The verdict + canonical signature** flows into the global pool — *never the
   instance* (see §6).
4. **The global signal feeds back** — next time *anyone* sees that signature, the
   community verdict pre-classifies it and raises or lowers the local ML's
   confidence.
5. **At critical mass the network auto-triages the known** — so humans only touch
   the genuinely novel. "Barely any work."

The result is the holy grail of MDR/SOC economics: every MSP's analyst is quietly
working for every other MSP, and the noise floor drops for everyone as the corpus
grows.

**Prior art, and why it doesn't cover this:** VirusTotal (hashes), abuse.ch,
AlienVault OTX, community Sigma rules — all partial analogs, all siloed feeds. None
are *fused into the RMM where the triage is already happening.* That fusion — the
verdict captured at the exact moment the human makes it, with no extra tool, no
export, no separate portal — is the moat.

---

## 5. The Artifact Catalog

Security-first, ops second. All ride the same `(artifact) + (judgment)` rails.

| Artifact (canonical identity)        | Community judgment                          | Domain    |
|--------------------------------------|---------------------------------------------|-----------|
| Event log signature (`Event 7034 / SCM`) | benign / problem                        | Security  |
| File / process hash                  | safe / malware / PUP / trusted new release  | Security  |
| DNS / domain / URL                   | block / allow / malware                     | Security  |
| Abnormal file activity signature     | benign / problem                            | Security  |
| Software + version (`FooApp 1.2.3`)  | bad version / safe / known-broken-with-X    | Ops       |
| Patch / KB (`KB5034441`)             | safe to deploy / wait / breaks Y            | Ops       |
| Installer package (hash + name)      | trusted build / silent-install args         | Ops       |

The catalog is open-ended — alert thresholds, drivers to avoid, hardware that
dies early, config baselines, and other "things every tech decides" can join the
same network over time. The pattern, not the list, is the product.

---

## 6. The Privacy Principle (inviolable law)

> **Share the signature and the verdict. Never the instance.**

The **canonical identity** of an artifact and its **community judgment** cross the
line into the shared pool. The **instance** — hostnames, file paths, usernames,
raw log bodies, IPs, anything tenant-identifying — *never* does.

`Event ID 7034 / Service Control Manager → benign` crosses. The machine it fired
on, the service name in the message body, the customer it belongs to — does not.

This is stated as an **inviolable law, not a tunable dial.** Trust is the entire
game; a clear, absolute principle earns adoption in a way a privacy slider never
could. Instance-stripping happens before anything leaves the tenant boundary, and
the law generalizes cleanly to every artifact type in the catalog.

---

## 7. The Trust & Moderation Model

No single leg is trusted alone. Three layers compound:

1. **AI moderation (first gate).** Every contributed verdict passes an AI check
   for obvious junk, poisoning, malformed signatures, and PII that should never
   have left (defense-in-depth behind §6).
2. **Aggregate consensus weighting.** One MSP saying "bad" is a weak signal; 500
   *independent* MSPs converging on "bad" is a strong one. Score is a function of
   volume *and* independence, not a raw vote count.
3. **Contributor reputation.** Established, trusted MSPs carry more weight.
   Reputation blunts Sybil and poisoning attacks — flooding the network with fake
   shops to swing a verdict costs reputation you don't have.

Not pure voting. Not pure AI. Both, plus reputation — so the network is hard to
game and degrades gracefully when any one layer is fooled.

---

## 8. Additive, Never Authoritative (the load-bearing principle)

**The MSP always owns their own signature lists and verdicts.** That local list is
their source of truth, fully under their control. breeze-net only contributes a
**score** that nudges the local decision — it never makes the decision.

This single principle does a lot of work:

- **Solves cold-start.** The product is fully useful on day one with *zero*
  network data, because local-first lists stand on their own. The net is purely
  additive — it makes an already-working product smarter as the corpus grows.
- **Solves liability.** The net never decides for you, so "breeze-net said it was
  safe and it wasn't" can't happen — it advised, you decided. The human (or the
  MSP's own policy) stays in the loop by construction.
- **Unlocks automation safely.** Only at critical mass, and only **opt-in**, can
  an MSP let high-confidence community verdicts auto-triage the known stuff. The
  default is always advisory.

---

## 9. Reciprocity & Sustainability

**Give-as-you-get.** Opting in and contributing is the price of admission to
consume the shared intelligence. Because contribution is passive (a byproduct of
normal triage), the "cost" is near-zero — but it prevents free-riding and keeps
the flywheel fed.

**Subscription-funded.** A subscription sustains the central DB and the
infrastructure that aggregates, moderates, and serves the network. The community
supplies the judgments; the subscription pays for the shared brain that holds and
scores them.

---

## 10. Roadmap & First Wedge

Phased, with each phase proving more of the rails:

- **Phase 0 — Vision (this doc).** Lock the concept, pattern, and principles.
- **Phase 1 — Prove the rails on one artifact type, end-to-end.** Pick a single
  artifact + judgment, build the full loop: local capture → instance-stripping →
  contribution → aggregate scoring → score fed back into the local UI. Prove
  zero-effort contribution and additive scoring work in practice.
- **Phase 2 — Expand the catalog.** Add artifact types along the same rails once
  the loop is proven.
- **Phase 3 — Critical-mass features.** Opt-in auto-triage, richer reputation,
  subscription productization.

**Candidate first wedges** (decision deferred to the Phase 1 spec):

- **Event-log signature labeling** — closest to the original spark, clear
  benign/problem judgment, immediately useful for noise reduction.
- **Software-hash reputation for new releases** — clean canonical identity (the
  hash), high security value.
- **Patch/KB safe-to-deploy** — strong ops value, easy to reason about, low PII
  surface.

The wedge pick is intentionally left open; it becomes its own focused spec.

---

## 11. Risks & Open Questions

- **Data poisoning.** Mitigated by the three-layer trust model (§7), but
  adversaries adapt — reputation and anomaly-detection-on-contributions need
  ongoing investment.
- **Liability.** Largely defused by "additive, never authoritative" (§8), but the
  legal framing of a shared advisory network still needs review.
- **Competitive / anti-trust optics.** Pooling data across many MSPs (some of whom
  compete) needs clear, clean framing and terms.
- **Regulatory / PII edges.** §6 is the defense, but jurisdictions differ; the
  instance-stripping boundary must be auditable and provably enforced.
- **Cold-start.** Believed low-risk thanks to local-first design (§8), but the
  Phase 1 wedge should still be chosen partly for how fast it can reach useful
  aggregate signal.
- **Critical mass for automation.** What thresholds (volume, independence,
  reputation) gate the opt-in auto-triage unlock? Deferred, but flagged.

---

## Appendix — Naming

Working name: **breeze-net.** The "net" is doing double duty — a *network* of MSPs
and a *safety net* of shared judgment. Final naming TBD.
