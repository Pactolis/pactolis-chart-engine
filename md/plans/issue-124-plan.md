# CE #124 implementation plan (draft; implementation not started)

> Added only to open the draft PR; will be removed when implementation starts.

1. `playwright.config.ts`: move the Tam scenario to the `census-load` project (`grep` / `grepInvert`: `/#308 (L[2-9]|Tam)/`).
2. `census-load.yml`: also run on `push` to `integration/approved-prs` (schedule only runs the default branch, which is stale until release).
3. `ci.yml`: once Tam is gone, collapse `census-shards` into one census job (and drop the `census` aggregator), or move `chart-hidden-tab-recovery.spec.ts` (150 s real wait) into its own parallel job.
4. `chart-endurance.yml`: `cancel-in-progress: true` for pull_request events.
5. Update `tests/ciCensusWorkflow.test.mjs` with the workflow change.

Validation: PR critical path p50 over 5 runs before/after (target <= 5 min); `--project=census --list` excludes Tam, `--project=census-load --list` includes it; first integration push runs Census Load green.
