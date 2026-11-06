# Inherited names and bounded batch recovery implementation plan

> For agentic workers: execute each task with test-driven-development and verification-before-completion; use independent workers only for disjoint files and perform a final fresh review.

**Goal:** Implement the user's three naming cases, prevent naming-related data/settings loss, and reduce needless permanent single-item fallback.

**Architecture:** A pure naming plan feeds planner/UI/runner; the client edits metadata only from a validated snapshot. Transfer recovery is bounded and retains explicit API limits. No request interval reduction or unsafe write retry.

**Tech stack:** Existing native JavaScript ES modules, HTML/CSS, Node test runner, Playwright API-shim integration.

**Spec:** `docs/superpowers/specs/2026-11-06-inherited-names-and-batch-recovery-design.md`.

## Global constraints and review focus

- Source duplicate memberships and unavailable items must remain in their intended sources.
- Names follow source-list order; fewer targets must not rename any source; extra targets use the preview base.
- Renaming must preserve privacy, intro and cover; source name changes since preview invalidate inheritance.
- Long/colliding names, partial rename failure and unknown write results must not be reported as complete or automatically replayed.
- Recovered batches must preserve exact order, cap1 behavior, cooldown stops and uncertain-write no replay; partial target corruption cannot trigger unbounded probing or sweep foreign content.

## Tasks

1. **Naming plan** (`extension/lib/naming.js`, `planner.js`, `tests/naming.test.mjs`): reproduce missing inheritance through `buildPlan`; implement three count cases and collision/length planning; keep custom default compatible. Verify through exact worked-name examples.
2. **Rename execution** (`client.js`, `runner.js`, memory client + naming integration tests): validate required metadata, preserve editable settings, revalidate title changes, perform only approved name changes, report partial outcomes without retries. Verify zero-write cancellation/preflight failure and ambiguous rename handling.
3. **Batch recovery** (independent worker owns `transfer.js`, `tests/performance-recovery.test.mjs`): record failing transient anomaly request counts, implement bounded recovery after verified checkpoints and only justified prefix repair. Verify arbitrary backends, explicit cap1, risk/timeout and mixed duplicates/unavailable records.
4. **UI and delivery** (`manager.*`, browser tests, documentation): add naming selector and mapping preview/confirmation, run full unit/matrix/browser checks, compare request benchmark, conduct fresh standards/spec review, then version, package, checksum and sync the existing GitHub branch.

## Verification ledger

- Baseline audit: transfer 31/31, source cache 8/8, reliability 7/7 including 2000 combinations. No newly reproduced baseline duplicate or timeout-replay defect; inheritance must add its own metadata/name checks.
- Performance baseline: healthy 6000-item single-source workload 62 moves; isolated partial success 6007, isolated order anomaly 6010. Actual single-only backend 6003; exact ordering forbids pretending it supports batches.
- Naming verified: 16 tests plus real-page mock integration across all count cases, more than four final targets, cancellation, metadata privacy/intro/cover preservation and conflicting/incomplete metadata, source name races, partial/ambiguous renames, long names and collisions.
- Recovery verified: 23 tests; transient target partial/order 117/193 moves, staging anomaly 1116 (formerly7000); persistent partial6012, realcap1 unchanged6003. Correct suffix973 retained while only27 wrong-prefix records rebuilt. Independent review found the staging cap conflation and larger first-rejection assumption; both have regression coverage and are fixed.
- Final checks: full147 tests including2000 combinations; complete existing browser suite plus final naming browser rerun; normal four benchmarks unchanged; fault benchmark compares baseline14af79c to current using identical data. Fresh Standards and Spec reviews have no outstanding findings.
- User-authorized delivery: version1.4.0, runtime-only ZIP with SHA-256 and source pushed together to existing GitHub work branch after remote-head check. No live account writes or website/store deployment.
