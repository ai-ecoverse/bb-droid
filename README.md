# bb-droid

Adds Factory Droid to [bb](https://getbb.app) as an ACP coding-agent provider.

After installation, **Factory Droid** appears in bb as provider **`acp-droid`**.

## Prerequisites

- bb 0.39 or newer with its built-in ACP providers plugin enabled.
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
bb plugin install .
```

The plugin locates the CLI, writes or repairs its managed `customAcpAgents`
entry without disturbing other agents, installs the approved monochrome icon,
and reloads bb's configuration. It uses `droid exec --output-format acp` over stdio.

ACP uses the interactive `droid` login when it is valid. Long-lived ACP
children can still drop that token. For a durable credential, set a
[Factory API key](https://app.factory.ai/settings/api-keys) in Extensions →
Plugins → Factory Droid, then `bb droid repair`.

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
for installations made before this repository became a bb plugin.

## How it works

bb's built-in ACP provider supplies the ACP-to-bb runtime. This plugin manages
the provider-specific launch profile and branding in bb's data-directory
configuration. Authentication and model availability remain owned by the
vendor CLI and the user's account.

The package ID is `droid`; the provider ID is `acp-droid`.

## Development

```bash
npm run typecheck
npm run build
```

The plugin requires bb 0.39+ and plugin SDK 0.4.8+.
