# bb-droid

Register [Factory Droid](https://docs.factory.ai/cli/getting-started/overview) as a **bb custom ACP provider**.

bb speaks [Agent Client Protocol](https://agentclientprotocol.com) via `bb-acp-bridge`. Known agents (opencode, grok, hermes, …) auto-detect when on PATH. Droid is **not** in that list, so this repo ships a `customAcpAgents` entry for `~/.bb/config.json`.

After install, Droid appears as provider **`acp-droid`**.

## Prerequisites

1. **bb** desktop app running (host daemon co-located with the CLI).
2. **Droid** on PATH (`curl -fsSL https://app.factory.ai/cli | sh` or your usual install).
3. **Authenticated** with Factory (interactive login or `FACTORY_API_KEY`).

Verify:

```bash
which droid
droid --version
```

## Install into bb

```bash
./scripts/install.sh
```

Merges `config/custom-acp-agent.json` into `~/.bb/config.json` (by id `droid`), copies the logo, and reloads config when possible. Safe alongside other custom agents (e.g. `bb-auggie`).

```bash
bb provider list
bb provider models acp-droid
```

Spawn:

```bash
bb thread spawn --project <project-id> \
  --provider acp-droid --model acp-default \
  --permission-mode full \
  --prompt "Say hello"
```

## Uninstall

```bash
./scripts/uninstall.sh
```

## Launch profile

| Field | Value |
|--------|--------|
| Provider id | `acp-droid` |
| Display name | Factory Droid |
| Command | absolute path to `droid` (resolved at install) |
| Args | `["exec", "--output-format", "acp"]` |
| Models | usually `acp-default` (no scrapeable model list CLI) |

### PATH gotcha

bb’s host daemon often runs with a **minimal PATH**. If config uses bare `droid` and the binary lives in `~/.local/bin`, the agent can fail at `thread.start` with:

```text
ACP agent "droid" exited (code 0, signal null)
```

`scripts/install.sh` resolves `command -v droid` to an absolute path for this reason.

Factory documents this shape for JetBrains/Zed ACP clients:

```json
{
  "command": "droid",
  "args": ["exec", "--output-format", "acp"]
}
```

Source of truth: [`config/custom-acp-agent.json`](config/custom-acp-agent.json).

### Notes

- **Model list:** Droid has no scrapeable model-list CLI for bb’s bridge, so the picker usually shows **`acp-default`**. Pass `--model acp-default` when spawning until you set project defaults.
- **Auth:** Factory login on the host, or set `FACTORY_API_KEY` in the agent `env` block (see Factory JetBrains/Zed docs).
- **Permissions:** bb ACP modes are `accept-edits` and `full`.

### Capabilities (bb ACP defaults)

- Permission modes: `accept-edits`, `full`
- No native fork / archive / rename
- Agent owns tools

## Manual config

Append to `~/.bb/config.json` `customAcpAgents` (or merge with existing entries):

```json
{
  "id": "droid",
  "displayName": "Factory Droid",
  "command": "droid",
  "args": ["exec", "--output-format", "acp"]
}
```

Then refresh:

```bash
node /Applications/bb.app/Contents/Resources/app.asar.unpacked/node_modules/bb-app/dist/bb-app.js config refresh
```

## Related

- Sibling: [`bb-auggie`](../bb-auggie) — Augment CLI via `auggie --acp`
- Factory IDE integrations: https://docs.factory.ai/ide-integrations
- `bb guide providers`
