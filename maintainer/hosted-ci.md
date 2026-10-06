# Authenticated hosted CI validation — 2026-10-04

Read GitHub Actions through its authenticated API using the existing Git
credential helper. No workflow was dispatched, code pushed or image published
as part of this validation.

The checked revision is `99bea4dffa9136c25a5d676cfb52b6085259cf6b`, matching local
HEAD. [Build and publish container run 37187650814](https://github.com/thesteau/aria-drop/actions/runs/37187650814)
completed successfully on 2026-10-04 at 08:05:32 UTC.

| Job | Confirmed successful steps |
| --- | --- |
| test | Lint, type checking, unit tests, dependency audit |
| browser | Chromium installation and end-to-end suite |
| container | Build scan candidate, container smoke, vulnerability scan, build/publish |

The separate [CodeQL run 37187650893](https://github.com/thesteau/aria-drop/actions/runs/37187650893)
also succeeded for that revision. This is automated evidence, not an independent
protocol/security review.

The hosted run predates local uncommitted changes, including the expanded
three-engine browser workflow, mandatory pairing and transfer-churn fixes. It
does not validate those changes. Their reported checks are local until a future
run against their committed revision succeeds.

The sanitized [API evidence](validation/hosted-ci-20261004.json) includes run/job
links and individual step conclusions. Credentials are not included.
