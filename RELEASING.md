# Releasing Evakage

All automation is prepared but dormant. Workflow YAML lives in
`.github/workflows-disabled/`; Dependabot lives in `.github/dependabot.disabled.yml`.
GitHub will discover them only after they are moved to the active paths below.
Existing hosted images are unaffected by this local preparation.

## Release model

| Branch | Purpose |
| --- | --- |
| `main` | Integration code; successful app CI publishes `latest` and a full-SHA image. |
| `prod` | Reviewed production code; promotion preserves Conventional Commit history. |
| `release-state` | Orphan branch containing only version manifest, changelog and `release.json`. |

Feature PRs into `main` use squash merges and Conventional Commit titles.
Promotion PRs from `main` into `prod` use merge commits. Release metadata PRs
into `release-state` also use merge commits. Neither `prod` nor `release-state`
is merged back into `main`.

Release Please calculates the next stable version, starting at `v1.0.0`.
`scripts/release-state.cts` records the production commit being approved and
tags that exact commit when the metadata PR merges. It uses Release Please's
`simple` strategy, retaining only its changelog update; version metadata stays
off the code branches. `package.json` remains the development package version,
not the authoritative stable version. Containers carry the release version and
commit in OCI labels. Release tooling requires Node 24+.

The bridge and release workflow policies were adapted from
[3to1go](https://github.com/thesteau/3to1go/tree/ced2c19368182079d347acce757893795afb812a)
under its MIT license.

## Prepared workflows

| File | Purpose |
| --- | --- |
| `ci.yml` | Source checks, release tests, browser suites, container smoke and Trivy scan; reusable for stable releases. |
| `ci-repository.yml` | actionlint and hadolint. |
| `codeql.yml` | Existing CodeQL security gate and SARIF artifacts. |
| `image-latest.yml` | Publish tested `main` as `latest` and `sha-<full SHA>`; skip CI completions for superseded commits. |
| `pr-title.yml` | Validate Conventional Commit titles into `main`. |
| `pr-prod-source.yml` | Accept only same-repository `main` promotions into `prod`. |
| `release-promote.yml` | Keep one promotion PR open. |
| `release-please.yml` | Plan metadata PRs, publish approved tags/releases, dispatch image builds and metadata checks. |
| `release-state-check.yml` | Validate metadata without executing PR code; post the status on the metadata PR head. |
| `stable-docker-images.yml` | Validate published stable tags on `prod`, rerun app/container checks, publish immutable amd64/arm64 images. |

`GITHUB_TOKEN` events do not start downstream workflows automatically, so the
release workflow explicitly dispatches metadata validation and stable images.
Privileged metadata workflows check out trusted `prod` code, never PR code.
Existing stable image tags are skipped on retry. A stable release never updates
`latest`; that tag belongs to `main`.

## Enable when ready

1. Move every `.yml` file from `.github/workflows-disabled/` into `.github/workflows/`
   in one commit. Their reusable workflow references intentionally point to the
   final active paths. Do not leave duplicate copies.
2. Rename `.github/dependabot.disabled.yml` to `.github/dependabot.yml` if dependency
   update PRs should also start. Its npm, Actions and Docker updates are grouped.
3. Ensure that commit is on the default `main` branch, then create `prod` from
   `main` or promote the activation commit into an existing `prod` branch.
4. Configure GitHub settings and rules below. Allow Actions to create PRs.
5. Run **Release: Plan and publish** on `prod` with `plan`. This bootstraps the
   orphan `release-state` branch. At least one releasable Conventional Commit
   must be present to generate the first release PR.
6. Protect `release-state`, review the recorded SHA/version/notes, then merge the
   release PR only when ready for the public release.
7. After publishing, set GHCR package visibility and access as intended. Use
   a published `vX.Y.Z` image tag in the deployment Compose file to pin a stable
   release. The provided Compose file uses the literal `latest` tag.

Activating the workflows starts push/PR/scheduled automation. No GitHub branch,
ruleset, release, package permission or Mintlify hosting change is made by the
local preparation itself.

## GitHub settings and branch rules

Allow squash merges and merge commits. Default squash commit messages to the
PR title. Keep automatic head-branch deletion off because promotion PRs use
`main` as their head. Enable **Allow GitHub Actions to create and approve pull requests**.

| Target | Recommended rules |
| --- | --- |
| `main` | Require reviewed PRs, resolved conversations, squash merges; require `Check source and unit tests`, `Check browser behavior`, `Validate container`, `Lint workflows and Dockerfile`, and `Validate Conventional Commit PR title`. |
| `prod` | Require reviewed PRs and merge commits; require the app/repository checks and `Validate production PR source`. Do not require linear history or an up-to-date branch: `prod` is never merged back into `main`. |
| `release-state` | Require reviewed PRs, merge commits, an up-to-date branch and the `Validate release metadata` commit status. |
| `v*` tags | Restrict creation, updates and deletion while permitting the release workflow to create tags; enable immutable GitHub releases where available. |

Leave `release-please--branches--release-state` unprotected: Release Please updates
its own proposal branch. Keep required check names and workflow dispatch file
names in sync if renamed. Add CodeQL's security gate to branch requirements
according to the repository's code-scanning availability; set
`CODE_SCANNING_ENABLED=true` to enable Security-tab uploads once configured.

## Retry and recovery

- Missing tag or GitHub Release: run **Release: Plan and publish** on `prod` with `publish`.
- Missing container: run **Image: Stable release** on `prod` with the existing published tag.
- Never move or reuse a version tag. A conflicting tag causes publication to fail.
- If `release-state` is lost, disable release planning before recovery. Restore the
  last approved metadata commit from its merged PR, including any approved release
  that was not published yet. Restore the branch rules, then retry `publish` or `plan`.

The metadata branch contains exactly `.release-please-manifest.json`, `CHANGELOG.md`
and `release.json`. The latter records version, tag, production SHA, previous tag/SHA
and reviewed notes. If `prod` is reset, retained stable tags identify commits
already shipped; rebased or squashed copies with new SHAs may count again.
Review the proposed version and notes before approving.

Run `npm run check` before committing automation changes. Release tests use mocked
GitHub APIs and temporary local repositories; they do not create real releases.
