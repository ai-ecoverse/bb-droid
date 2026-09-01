# bb-droid

Release procedure for this plugin. Tag a new version; never move a tag; do not open a marketplace PR for a patch.

## Identity

| Field | Value |
|---|---|
| GitHub | https://github.com/ai-ecoverse/bb-droid |
| `package.json` `name` | `bb-plugin-droid` (not published to npm) |
| bb plugin id | `droid` |
| Provider id | `acp-droid` |
| CLI | `bb droid` (`status`, `repair`, `unregister`) |
| Marketplace entry | get-bb/marketplace `entries/droid.json` |
| Source | `https://github.com/ai-ecoverse/bb-droid.git` |
| Range | `^0.3.0` |
| Listing owner | `author.github`: `trieloff` |

`acp-droid` is registered through the builtin ACP plugin's `customAgents` setting, not `bb.providers.register`. Current shipped version: `0.3.0` / tag `v0.3.0`.

## Tag, do not PR

The marketplace listing uses a git semver `range`. BB resolves that range over this repo's `vX.Y.Z` tags, records the tag **and** the commit it selected, and refuses a tag that later points elsewhere.

Marketplace README (get-bb/marketplace): approval covers the listing; with a `range` source you release updates by tagging this repository. Changing the entry itself (source location, name, or branding) needs a new reviewed pull request. The account in `author.github` gates later entry changes.

Never move, delete, or re-cut a tag. Ship a new version.

`dist/` is committed and is what a marketplace git install runs. Path installs load TypeScript directly, so a healthy local checkout does not prove the tag is good.

## The range: `^0.3.0`

Caret on `0.x` pins the minor. Confirmed with node-semver 7.8.5 `satisfies` / `maxSatisfying`:

| Version | `^0.3.0` |
|---|---|
| `0.3.0` | yes |
| `0.3.1` | yes |
| `0.3.2` | yes |
| `0.4.0` | **no** |
| `1.0.0` | no |

- **Patch (`0.3.x`)**: bump, rebuild `dist/`, tag `v0.3.x`. No marketplace PR.
- **Minor (`0.4.0`) or listing edits**: tag **and** a reviewed marketplace PR. Listing fields today: `id`, `displayName`, `description`, `icon`, `tags`, `author`, `source.git.url`, `source.git.range`. The icon is vendored in the marketplace as `icons/droid-0f671277.svg`.

`npm run check` in the marketplace repo only asserts that some `vX.Y.Z` tag exists at the source URL. It does not evaluate the range, so `^0.3.0` still passes after you tag `v0.4.0`.

## Pre-release checklist

Set `package.json` `version` to the version you will tag (`v0.3.1` ↔ `0.3.1`). Then from the repo root:

```sh
npm run typecheck
npm test
bb plugin build .
git diff --exit-code -- dist/
node -e 'const p=require("./package.json"); const m=require("./dist/server.meta.json"); if (p.version!==m.pluginVersion || m.pluginId!=="droid") process.exit(1)'
```

(`npm run build` is `bb plugin build .`.)

All five must pass. A dirty `git diff` means committed `dist/` does not match sources — commit the rebuild (it also stamps `pluginVersion` in `dist/*.meta.json`). A failed node check means you bumped `package.json` and did not rebuild; managed git installs reject that mismatch.

## Local verification

Install from this checkout if it is not already a path install:

```sh
bb plugin install . --yes
```

Then:

```sh
bb plugin list
bb droid status
bb provider list
bb provider models acp-droid
bb plugin logs droid -n 50
```

Pass when:

- `bb plugin list` shows `droid@<version>  running`
- `bb droid status` shows a CLI path and `bb provider acp-droid: registered`
- `bb provider list` includes `acp-droid` / Factory Droid
- `bb provider models acp-droid` prints a model table
- Recent logs are `registered acp-droid with …` or `acp-droid is already configured`

`bb droid` with no args is `status`. Do not run `bb droid unregister` as part of a release. Boot-time `Could not read provider-acp customAgents` warnings are the settings-race retry; they must be followed by a successful register.

## Cut the release

1. Commit the version bump and rebuilt `dist/`.
2. `git push origin main` — GitHub must already have the commit.
3. Create the GitHub release with the Homebrew `gh`, not PATH `gh`:

```sh
/opt/homebrew/bin/gh release create v0.3.1 --repo ai-ecoverse/bb-droid --title v0.3.1 --notes "…" --target "$(git rev-parse HEAD)"
```

PATH `gh` is `~/.local/bin/gh`, the as-a-bot wrapper. Under an AI tool it intercepts write operations. `/opt/homebrew/bin/gh` is the real GitHub CLI (2.97.0), authenticated as `trieloff`.

If the tag does not exist, `gh release create` mints a lightweight tag on `--target`. That is how `v0.3.0` was cut (`target_commitish: main`). Earlier `v0.1.0`–`v0.2.1` are annotated tags without GitHub releases; the marketplace resolves **tags**, not GitHub Releases.

Do not `git tag -f`. Do not delete and recreate a tag. Do not force-push a tag. A bad release is a new version.

## After the release

```sh
git ls-remote --tags https://github.com/ai-ecoverse/bb-droid.git 'refs/tags/v*'
```

The new `refs/tags/vX.Y.Z` line must be the release commit. Lightweight tags have no `^{}` peel line; that is expected.

In a get-bb/marketplace checkout (not this repo):

```sh
npm run check
```

That is `node scripts/build.mjs --liveness` (`git ls-remote --tags` for `v*`, plus schema and icon checks). It writes `dist/marketplace.json`.

## Worked examples

### Patch: 0.3.0 → 0.3.1 (tag only)

1. Set `package.json` `version` to `0.3.1`.
2. Run the pre-release checklist. Commit `package.json`, lockfile if it changed, and rebuilt `dist/`.
3. Local verification.
4. `git push origin main`.
5. `/opt/homebrew/bin/gh release create v0.3.1 --repo ai-ecoverse/bb-droid --title v0.3.1 --notes "…" --target "$(git rev-parse HEAD)"`.
6. Confirm `v0.3.1` on `git ls-remote --tags`.
7. Stop. `^0.3.0` already matches `0.3.1`.

### Minor: 0.3.x → 0.4.0 (tag + marketplace PR)

1. Same as the patch path, but version `0.4.0` and tag `v0.4.0`.
2. Tagging does not ship this to marketplace users: `^0.3.0` does not match `0.4.0`.
3. From a get-bb/marketplace fork, set `entries/droid.json` `source.git.range` to `^0.4.0`. The PR must come from GitHub account `trieloff`. Changes to `displayName`, `description`, `tags`, `icon`, `author`, or `source.git.url` belong in that PR too.
4. After `v0.4.0` is visible on `ls-remote`, run `npm run check` in the marketplace checkout.
5. Open the PR against `get-bb/marketplace:main`.
