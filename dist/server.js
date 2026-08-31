import { createRequire as __createRequire } from "node:module";
import { dirname as __pathDirname } from "node:path";
import { fileURLToPath as __fileURLToPath } from "node:url";
const require = __createRequire(import.meta.url);
var __filename = __fileURLToPath(import.meta.url);
var __dirname = __pathDirname(__filename);

// server.ts
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

// src/agent-entry.ts
var ACP_PLUGIN_ID = "provider-acp";
var PROFILE = {
  id: "droid",
  providerId: "acp-droid",
  displayName: "Factory Droid",
  binary: "droid",
  args: ["exec", "--output-format", "acp"],
  // Directories Droid actually reads (https://docs.factory.ai/cli/configuration/skills).
  // User roots resolve from the home directory; project roots from the workspace.
  // Compatibility roots are the `.agents` / `.agent` conventions Droid scans in
  // addition to `.factory/skills`. `--help` has no skill subcommand.
  nativeSkillRoots: {
    user: [".factory/skills", ".agents/skills", ".agent/skills"],
    project: [".factory/skills", ".agents/skills", ".agent/skills"]
  },
  // bb's permission modes as Droid exec launch flags. These are exec options,
  // so insertAfterArgs: 1 places them after `exec` rather than before it.
  // "full" is Droid's own skip-all-checks switch. "accept-edits" maps to
  // `--auto low` (file creation/modification, no system changes). bb's default
  // "auto" mode adds nothing, so every request comes through ACP as before.
  permissionCli: {
    full: ["--skip-permissions-unsafe"],
    workspaceWrite: ["--auto", "low"],
    insertAfterArgs: 1
  },
  installHint: "Install and authenticate Factory Droid, then run `bb plugin reload droid`."
};
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function isOwnAgent(agent) {
  return agent?.id === PROFILE.id;
}
function findOwnAgent(agents) {
  return agents.find(isOwnAgent);
}
function parseCustomAgents(value) {
  if (value === void 0 || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new Error(`${ACP_PLUGIN_ID} customAgents must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const parsed = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(`${ACP_PLUGIN_ID} customAgents must be a JSON array; refusing to overwrite it`);
  }
  return parsed;
}
function stringifyCustomAgents(agents) {
  return `${JSON.stringify(agents, null, 2)}
`;
}
function managedEnv(existing, factoryApiKey) {
  const env = isObject(existing?.env) ? { ...existing.env } : {};
  if (typeof factoryApiKey === "string") {
    if (factoryApiKey.length > 0) env.FACTORY_API_KEY = factoryApiKey;
    else delete env.FACTORY_API_KEY;
  }
  return Object.keys(env).length > 0 ? env : void 0;
}
function managedAgent(binary, existing, factoryApiKey) {
  const env = managedEnv(existing, factoryApiKey);
  const agent = {
    // Keys the user added themselves (cwd, dialect, modelCli, ...) survive a
    // reload; the fields below are ours and are rewritten every time.
    ...existing ?? {},
    id: PROFILE.id,
    displayName: PROFILE.displayName,
    command: binary,
    args: [...PROFILE.args],
    nativeSkillRoots: {
      user: [...PROFILE.nativeSkillRoots.user],
      project: [...PROFILE.nativeSkillRoots.project]
    },
    permissionCli: {
      full: [...PROFILE.permissionCli.full],
      workspaceWrite: [...PROFILE.permissionCli.workspaceWrite],
      insertAfterArgs: PROFILE.permissionCli.insertAfterArgs
    }
  };
  delete agent.logo;
  if (env) agent.env = env;
  else delete agent.env;
  if (!isObject(agent.modelCli) || !Array.isArray(agent.modelCli.listArgs)) {
    delete agent.modelCli;
  }
  return agent;
}
function upsertAgent(agents, next) {
  const index = agents.findIndex(isOwnAgent);
  const copy = [...agents];
  if (index >= 0) copy[index] = next;
  else copy.push(next);
  return { agents: copy, changed: JSON.stringify(copy) !== JSON.stringify(agents) };
}
function removeAgent(agents) {
  const next = agents.filter((agent) => !isOwnAgent(agent));
  return { agents: next, changed: next.length !== agents.length };
}

// server.ts
var SETTINGS_READY_ATTEMPTS = 10;
var SETTINGS_READY_DELAY_MS = 500;
function isExecutable(path) {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
function findBinary(existing) {
  if (typeof existing?.command === "string" && existing.command.includes(delimiter) && isExecutable(existing.command)) {
    return existing.command;
  }
  const names = process.platform === "win32" ? [`${PROFILE.binary}.exe`, `${PROFILE.binary}.cmd`, PROFILE.binary] : [PROFILE.binary];
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin"
  ].filter(Boolean);
  for (const directory of new Set(directories)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}
function readConfig(configPath) {
  if (!existsSync(configPath)) return {};
  const parsed = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isObject(parsed)) {
    throw new Error(`${configPath} must contain a JSON object; refusing to overwrite it`);
  }
  return parsed;
}
function writeAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${PROFILE.id}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: "utf8", mode: 384 });
    chmodSync(temporary, 384);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function factoryAuthPath() {
  return join(homedir(), ".factory", "auth.v2.file");
}
function envApiKey(env) {
  if (!isObject(env) || typeof env.FACTORY_API_KEY !== "string" || env.FACTORY_API_KEY.length === 0) {
    return void 0;
  }
  return env.FACTORY_API_KEY;
}
function readLegacyAgents(dataDir) {
  const config = readConfig(join(dataDir, "config.json"));
  return Array.isArray(config.customAcpAgents) ? [...config.customAcpAgents] : [];
}
function writeLegacyAgents(dataDir, agents) {
  const configPath = join(dataDir, "config.json");
  const config = readConfig(configPath);
  const current = Array.isArray(config.customAcpAgents) ? config.customAcpAgents : [];
  if (JSON.stringify(current) === JSON.stringify(agents)) return false;
  if (agents.length === 0) delete config.customAcpAgents;
  else config.customAcpAgents = agents;
  writeAtomic(configPath, config);
  return true;
}
function plugin(bb) {
  const settings = bb.settings.define({
    factoryApiKey: {
      type: "string",
      label: "Factory API key",
      secret: true
    }
  });
  async function dataDir() {
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) return config.dataDir;
    } catch (error) {
      bb.log.warn(`Could not resolve bb data directory through the SDK: ${String(error)}`);
    }
    return process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
  }
  async function readSettingAgents() {
    let values;
    try {
      const result = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
      values = result.values;
    } catch (error) {
      bb.log.warn(`Could not read ${ACP_PLUGIN_ID} customAgents: ${String(error)}`);
      return null;
    }
    return parseCustomAgents(values.customAgents);
  }
  async function readSettingAgentsWhenReady() {
    for (let attempt = 0; attempt < SETTINGS_READY_ATTEMPTS; attempt += 1) {
      const agents = await readSettingAgents();
      if (agents !== null) return agents;
      await new Promise((resolve) => setTimeout(resolve, SETTINGS_READY_DELAY_MS));
    }
    return readSettingAgents();
  }
  async function writeSettingAgents(agents) {
    const serialized = agents.length === 0 ? "" : stringifyCustomAgents(agents);
    await bb.sdk.plugins.updateSettings({
      pluginId: ACP_PLUGIN_ID,
      values: { customAgents: serialized }
    });
    return true;
  }
  async function provision(waitForSettings = false) {
    const { factoryApiKey } = await settings.get();
    const root = await dataDir();
    const settingAgents = waitForSettings ? await readSettingAgentsWhenReady() : await readSettingAgents();
    const legacyAgents = readLegacyAgents(root);
    const existing = (settingAgents === null ? void 0 : findOwnAgent(settingAgents)) ?? findOwnAgent(legacyAgents);
    const binary = findBinary(existing);
    if (binary === null) throw new Error(`${PROFILE.binary} was not found. ${PROFILE.installHint}`);
    const managed = managedAgent(binary, existing, factoryApiKey);
    let changed = false;
    if (settingAgents !== null) {
      const next = upsertAgent(settingAgents, managed);
      if (next.changed) {
        await writeSettingAgents(next.agents);
        changed = true;
      }
    } else {
      const next = upsertAgent(legacyAgents, managed);
      if (next.changed && writeLegacyAgents(root, next.agents)) {
        await bb.sdk.system.reloadConfig();
        changed = true;
      }
      return { changed, binary };
    }
    const stripped = removeAgent(legacyAgents);
    if (stripped.changed && writeLegacyAgents(root, stripped.agents)) {
      await bb.sdk.system.reloadConfig();
      changed = true;
    }
    return { changed, binary };
  }
  async function unregister() {
    const root = await dataDir();
    let changed = false;
    const settingAgents = await readSettingAgents();
    if (settingAgents !== null) {
      const next = removeAgent(settingAgents);
      if (next.changed) {
        await writeSettingAgents(next.agents);
        changed = true;
      }
    }
    const stripped = removeAgent(readLegacyAgents(root));
    if (stripped.changed && writeLegacyAgents(root, stripped.agents)) {
      await bb.sdk.system.reloadConfig();
      changed = true;
    }
    return changed;
  }
  settings.onChange(() => {
    void provision().catch((error) => {
      bb.log.error(`Failed to apply Factory API key: ${String(error)}`);
    });
  });
  bb.background.service("provision", {
    async start() {
      try {
        const result = await provision(true);
        bb.log.info(
          result.changed ? `registered ${PROFILE.providerId} with ${result.binary}` : `${PROFILE.providerId} is already configured`
        );
      } catch (error) {
        const message = String(error);
        bb.log.error(message);
        bb.status.needsConfiguration(message);
      }
    }
  });
  bb.cli.register({
    name: PROFILE.id,
    summary: `Manage the ${PROFILE.displayName} ACP provider.`,
    commands: [
      { name: "status", summary: "Check the CLI and bb provider registration", usage: `${PROFILE.id} status` },
      { name: "repair", summary: "Rewrite and reload the managed ACP configuration", usage: `${PROFILE.id} repair` },
      { name: "unregister", summary: "Remove this plugin's managed ACP configuration", usage: `${PROFILE.id} unregister` }
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      if (command === "repair") {
        try {
          const result = await provision();
          return { exitCode: 0, stdout: `${PROFILE.providerId}: ${result.changed ? "repaired" : "already up to date"}
CLI: ${result.binary}
` };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}
` };
        }
      }
      if (command === "unregister") {
        try {
          const changed = await unregister();
          return { exitCode: 0, stdout: `${PROFILE.providerId}: ${changed ? "unregistered" : "not configured"}
` };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}
` };
        }
      }
      if (command === "status") {
        const root = await dataDir();
        let settingAgents = null;
        try {
          settingAgents = await readSettingAgents();
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}
` };
        }
        const legacyAgents = readLegacyAgents(root);
        const entry = (settingAgents === null ? void 0 : findOwnAgent(settingAgents)) ?? findOwnAgent(legacyAgents);
        const binary = findBinary(entry);
        const loginFile = existsSync(factoryAuthPath());
        const { factoryApiKey } = await settings.get();
        const apiKey = Boolean(factoryApiKey) || Boolean(envApiKey(entry?.env)) || Boolean(envApiKey(process.env));
        let registered = false;
        try {
          registered = (await bb.sdk.providers.list()).some((provider) => provider.id === PROFILE.providerId);
        } catch {
        }
        const setting = settingAgents?.some(isOwnAgent) ? "present" : "missing";
        const legacy = legacyAgents.some(isOwnAgent) ? "present" : "absent";
        const ready = Boolean(binary && entry && registered && (apiKey || loginFile));
        const hint = !ready ? "Factory is not authenticated for ACP. Run `droid` to log in, or set the Factory API key plugin setting and `bb droid repair`." : apiKey ? null : 'Interactive droid login is present. If a thread fails with "Internal error: Agent error" or "No active ACP session", run `bb thread stop <id>` then `bb thread tell --mode auto <id> continue`.';
        return {
          exitCode: ready ? 0 : 1,
          stdout: [
            `CLI: ${binary ?? "NOT FOUND"}`,
            `ACP customAgents entry: ${setting}`,
            `legacy config.json entry: ${legacy}`,
            `bb provider ${PROFILE.providerId}: ${registered ? "registered" : "NOT registered"}`,
            `Factory login file: ${loginFile ? factoryAuthPath() : "MISSING"}`,
            `FACTORY_API_KEY: ${apiKey ? "set" : "not set"}`,
            ...hint ? [hint] : []
          ].join("\n") + "\n"
        };
      }
      return { exitCode: 2, stderr: `Unknown subcommand "${command}". Use "bb ${PROFILE.id} status".
` };
    }
  });
}
export {
  plugin as default
};
//# sourceMappingURL=server.js.map
