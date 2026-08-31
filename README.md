# bb-droid

Adds Factory Droid to [bb](https://getbb.app) as an ACP coding-agent provider.

After installation, **Factory Droid** appears in bb as provider **`acp-droid`**.

## Prerequisites

- bb 0.40 or newer with its built-in ACP providers plugin enabled.
- Install and authenticate the [Factory Droid CLI](https://docs.factory.ai/cli/getting-started/overview).

## Install

Until the marketplace entry is merged, install directly from GitHub:

```bash
bb plugin install https://github.com/ai-ecoverse/bb-droid
```

For local development:

```bash
npm install
npm run typecheck
npm run build
npm test
bb plugin install .
```

The plugin locates the CLI and upserts a managed entry in the ACP providers
plugin's `customAgents` setting without disturbing other agents. It uses
`droid exec --output-format acp` over stdio. A leftover `customAcpAgents`
entry in `config.json` is removed on repair, because bb 0.40 rejects that
shape unless `modelCli.listArgs` is present and 0.41 stops reading it.

ACP uses the interactive `droid` login when it is valid. Long-lived ACP
children can still drop that token. For a durable credential, set a
[Factory API key](https://app.factory.ai/settings/api-keys) in Extensions →
Plugins → Factory Droid, then `bb droid repair`.

## Skills

The managed entry declares the skill directories Droid reads
([Factory skills](https://docs.factory.ai/cli/configuration/skills)), so bb
lists them in the composer next to its own:

- project: `.factory/skills/`, `.agents/skills/`, `.agent/skills/`
- user: `~/.factory/skills/`, `~/.agents/skills/`, `~/.agent/skills/`

`.agents` and `.agent` are Droid's compatibility roots. Folder-specific
`.factory/skills` trees under a subproject are still Droid's to discover;
bb indexes the workspace-relative roots above.

## Permission modes

bb's thread permission mode becomes a Droid `exec` launch flag (inserted after
`exec`, because these options belong to that subcommand):

| bb mode      | Droid flag                   |
| ------------ | ---------------------------- |
| Auto         | none — every tool call comes through ACP for approval |
| Accept edits | `--auto low` — file creation and edits in non-system directories; system changes still ask |
| Full access  | `--skip-permissions-unsafe` |

Droid's ACP initialize response does not advertise manual compaction, so this
plugin does not set `supportsManualCompaction`. Use Droid's own `/compress`
inside a Droid session if you need it.

## Check or repair

```bash
bb droid status
bb droid repair
bb provider models acp-droid
```

If the CLI moves after an upgrade, `bb droid repair` records its new
absolute path and reloads bb.

## Troubleshooting

### `Internal error: Agent error` or `No active ACP session`

The first is Factory Droid with no access token. The second is bb sending
`turn/start` to a worker that no longer has a session.

Refresh login with `droid` if needed, then recycle the runtime so the next
message resumes (`session/load`) instead of a bare `turn/start`:

```bash
bb thread stop <thread-id>
bb thread tell --mode auto <thread-id> continue
```

Optional: set a [Factory API key](https://app.factory.ai/settings/api-keys) in
the plugin settings and run `bb droid repair`. `bb droid status` reports
whether the key is present without printing it.

## Uninstall

Remove the managed provider entry before removing the plugin:

```bash
bb droid unregister
bb plugin remove droid
```

The legacy `scripts/install.sh` and `scripts/uninstall.sh` remain available
for installations made before this repository became a bb plugin. Do not use
them for new installs: they write the `customAcpAgents` array that bb removes
in 0.41. Installing the plugin migrates such an entry to the setting and
deletes the legacy one.

## How it works

bb's built-in ACP provider supplies the ACP-to-bb runtime. This plugin manages
the provider-specific launch profile through that plugin's `customAgents`
setting. Authentication and model availability remain owned by the vendor CLI
and the user's account.

The package ID is `droid`; the provider ID is `acp-droid`. The compact icon
is a `currentColor` mask so it follows the bb theme.

A community plugin, `bentossell/bb-plugin-factory-droid`, wraps the same CLI
under plugin id `factory-droid` and provider id `acp-factory-droid`. Those
ids do not collide with this plugin, so this package keeps `droid` /
`acp-droid`.

## Development

```bash
npm run typecheck
npm run build
npm test
```

The plugin requires bb 0.40+ and plugin SDK 0.4.8+. Licensed under MIT.
