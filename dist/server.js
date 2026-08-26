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
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
var PROFILE = {
  id: "droid",
  providerId: "acp-droid",
  displayName: "Factory Droid",
  binary: "droid",
  args: ["exec", "--output-format", "acp"],
  modelCli: {
    selectFlag: "--model",
    primaryModels: ["claude-opus-4-8", "claude-sonnet-4-6", "gemini-2.5-pro", "gpt-4.1"]
  },
  installHint: "Install and authenticate Factory Droid, then run `bb plugin reload droid`."
};
var moduleDir = dirname(fileURLToPath(import.meta.url));
var pluginRoot = basename(moduleDir) === "dist" ? dirname(moduleDir) : moduleDir;
var logoSource = join(pluginRoot, "assets", "logo.svg");
function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
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
  const temporary = `${path}.droid.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}
`, { encoding: "utf8", mode: 384 });
    chmodSync(temporary, 384);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}
function installLogo(dataDir) {
  const destination = join(dataDir, "logos", `${PROFILE.id}.svg`);
  mkdirSync(dirname(destination), { recursive: true });
  const changed = !existsSync(destination) || !readFileSync(destination).equals(readFileSync(logoSource));
  if (changed) copyFileSync(logoSource, destination);
  return { path: destination, changed };
}
function factoryAuthPath() {
  return join(homedir(), ".factory", "auth.v2.file");
}
function hasFactoryLoginFile() {
  return existsSync(factoryAuthPath());
}
function envHasApiKey(env) {
  return isObject(env) && typeof env.FACTORY_API_KEY === "string" && env.FACTORY_API_KEY.length > 0;
}
function readDotenv(path) {
  if (!existsSync(path)) return {};
  const env = {};
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if (value.startsWith('"') && value.endsWith('"') || value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1);
    }
    env[key] = value;
  }
  return env;
}
function pluginEnvPath(dataDir) {
  return join(dataDir, "plugins", PROFILE.id, ".env");
}
function resolveFactoryApiKey(dataDir, existing, setting) {
  if (typeof setting === "string" && setting.length > 0) return setting;
  const fromFile = readDotenv(pluginEnvPath(dataDir)).FACTORY_API_KEY;
  if (typeof fromFile === "string" && fromFile.length > 0) return fromFile;
  if (envHasApiKey(process.env)) return process.env.FACTORY_API_KEY;
  if (envHasApiKey(existing?.env)) return (existing?.env).FACTORY_API_KEY;
  return void 0;
}
function managedEnv(dataDir, existing, setting) {
  const env = isObject(existing?.env) ? { ...existing.env } : {};
  const key = resolveFactoryApiKey(dataDir, existing, setting);
  if (key) env.FACTORY_API_KEY = key;
  else delete env.FACTORY_API_KEY;
  return env;
}
function provision(dataDir, factoryApiKey) {
  const configPath = join(dataDir, "config.json");
  const config = readConfig(configPath);
  const agents = Array.isArray(config.customAcpAgents) ? [...config.customAcpAgents] : [];
  const index = agents.findIndex((agent) => agent?.id === PROFILE.id);
  const current = index >= 0 ? agents[index] : void 0;
  const binary = findBinary(current);
  if (binary === null) throw new Error(`${PROFILE.binary} was not found. ${PROFILE.installHint}`);
  const managed = {
    ...current,
    id: PROFILE.id,
    displayName: PROFILE.displayName,
    command: binary,
    args: [...PROFILE.args],
    env: managedEnv(dataDir, current, factoryApiKey),
    logo: `logos/${PROFILE.id}.svg`,
    modelCli: {
      selectFlag: PROFILE.modelCli.selectFlag,
      primaryModels: [...PROFILE.modelCli.primaryModels]
    }
  };
  const before = JSON.stringify(agents);
  if (index >= 0) agents[index] = managed;
  else agents.push(managed);
  const configChanged = JSON.stringify(agents) !== before;
  const logo = installLogo(dataDir);
  if (configChanged) {
    config.customAcpAgents = agents;
    writeAtomic(configPath, config);
  }
  return { changed: configChanged || logo.changed, binary };
}
function unregister(dataDir) {
  const configPath = join(dataDir, "config.json");
  const config = readConfig(configPath);
  if (!Array.isArray(config.customAcpAgents)) return false;
  const agents = config.customAcpAgents.filter((agent) => agent?.id !== PROFILE.id);
  if (agents.length === config.customAcpAgents.length) return false;
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
  async function reloadConfig() {
    await bb.sdk.system.reloadConfig();
  }
  async function repair() {
    const { factoryApiKey } = await settings.get();
    const result = provision(await dataDir(), factoryApiKey);
    if (result.changed) await reloadConfig();
    return result;
  }
  settings.onChange(() => {
    void repair().catch((error) => {
      bb.log.error(`Failed to apply Factory API key: ${String(error)}`);
    });
  });
  bb.background.service("provision", {
    async start() {
      try {
        const result = await repair();
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
          const result = await repair();
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
          const changed = unregister(await dataDir());
          if (changed) await reloadConfig();
          return { exitCode: 0, stdout: `${PROFILE.providerId}: ${changed ? "unregistered" : "not configured"}
` };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}
` };
        }
      }
      if (command === "status") {
        const root = await dataDir();
        const config = readConfig(join(root, "config.json"));
        const agents = Array.isArray(config.customAcpAgents) ? config.customAcpAgents : [];
        const entry = agents.find((agent) => agent?.id === PROFILE.id);
        const binary = findBinary(entry);
        const loginFile = hasFactoryLoginFile();
        const apiKey = Boolean(resolveFactoryApiKey(root, entry));
        let registered = false;
        try {
          registered = (await bb.sdk.providers.list()).some((provider) => provider.id === PROFILE.providerId);
        } catch {
        }
        const ready = Boolean(binary && entry && registered && (apiKey || loginFile));
        return {
          exitCode: ready ? 0 : 1,
          stdout: [
            `CLI: ${binary ?? "NOT FOUND"}`,
            `config entry: ${entry ? "present" : "missing"}`,
            `bb provider ${PROFILE.providerId}: ${registered ? "registered" : "NOT registered"}`,
            `Factory login file: ${loginFile ? factoryAuthPath() : "MISSING"}`,
            `FACTORY_API_KEY: ${apiKey ? "set" : "not set"}`,
            ...ready ? apiKey ? [] : [
              'Interactive droid login is present. Long-lived ACP processes can still drop that token; recycle with `bb thread stop <id>` then `bb thread tell --mode auto <id> "continue"`.'
            ] : [
              "Factory is not authenticated for ACP. Run `droid` to log in, or set FACTORY_API_KEY (plugin setting, ~/.bb/plugins/droid/.env, or the bb process environment) and `bb droid repair`."
            ]
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
