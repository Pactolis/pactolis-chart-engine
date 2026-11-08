## Summary

<!-- Briefly describe the change and its reason. -->

## Acceptance criteria → evidence

| Acceptance criterion | Test/check or CI artifact evidence (name and link) |
| --- | --- |
| <!-- One row per criterion; include each issue-closure criterion. Partial completion does not close an issue. --> | <!-- Test/check name, CI run/artifact link, or measurement/commit evidence --> |

## Validation commands and CI record

The following are the repository CI commands/checks; record the applicable command, GitHub Actions runner/job, result, and run/artifact link. Do not run these locally for this PR; verification is performed by authorized PR Actions on GitHub-hosted Ubuntu runners.

| CI command/check | Runner/job | Result | Actions run / artifact link |
| --- | --- | --- | --- |
| `npm run check` (Node 22, 24, 26) | GitHub-hosted Ubuntu / test matrix | Pending | <!-- link --> |
| `npm test` (Node 22, 24, 26) | GitHub-hosted Ubuntu / test matrix | Pending | <!-- link --> |
| `npm run check:exports`; `npm run check:default-import-graph`; `npm pack --dry-run` | GitHub-hosted Ubuntu / test matrix | Pending | <!-- link --> |
| `npm run check:browser`; `npm run test:browser -- --project=default` | GitHub-hosted Ubuntu / browser | Pending | <!-- link; playwright-results artifact on failure --> |
| `npm run test:browser -- --project=census --fully-parallel --workers=1 --shard=1/2` and `...--shard=2/2` | GitHub-hosted Ubuntu / census-shards | Pending | <!-- run and census-evidence artifacts --> |
| census aggregation check | GitHub-hosted Ubuntu / census | Pending | <!-- link --> |

## Scope

- [ ] Changes stay within the approved scope.
- [ ] Documentation/configuration changes follow repository conventions.

## Related issue

<!-- Link the issue, if applicable. -->