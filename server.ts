import type { BbPluginApi } from "@get-bb/plugin-sdk";
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
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const PROFILE = {
  id: "droid",
  providerId: "acp-droid",
  displayName: "Factory Droid",
  binary: "droid",
  args: ["exec","--output-format","acp"],
  modelCli: {
    selectFlag: "--model",
    primaryModels: ["claude-opus-4-8","claude-sonnet-4-6","gemini-2.5-pro","gpt-4.1"],
  },
  installHint: "Install and authenticate Factory Droid, then run `bb plugin reload droid`.",
} as const;

type JsonObject = Record<string, unknown>;
type CustomAgent = JsonObject & { id?: unknown; command?: unknown; env?: unknown };

const moduleDir = dirname(fileURLToPath(import.meta.url));
const pluginRoot = basename(moduleDir) === "dist" ? dirname(moduleDir) : moduleDir;
const logoSource = join(pluginRoot, "assets", "logo.svg");

function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isExecutable(path: string): boolean {
  try {
    accessSync(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function findBinary(existing?: CustomAgent): string | null {
  if (typeof existing?.command === "string" && existing.command.includes(delimiter) && isExecutable(existing.command)) {
    return existing.command;
  }
  const names = process.platform === "win32"
    ? [`${PROFILE.binary}.exe`, `${PROFILE.binary}.cmd`, PROFILE.binary]
    : [PROFILE.binary];
  const directories = [
    ...(process.env.PATH ?? "").split(delimiter),
    join(homedir(), ".local", "bin"),
    join(homedir(), ".npm-global", "bin"),
    "/opt/homebrew/bin",
    "/usr/local/bin",
  ].filter(Boolean);
  for (const directory of new Set(directories)) {
    for (const name of names) {
      const candidate = join(directory, name);
      if (isExecutable(candidate)) return candidate;
    }
  }
  return null;
}

function readConfig(configPath: string): JsonObject {
  if (!existsSync(configPath)) return {};
  const parsed: unknown = JSON.parse(readFileSync(configPath, "utf8"));
  if (!isObject(parsed)) {
    throw new Error(`${configPath} must contain a JSON object; refusing to overwrite it`);
  }
  return parsed;
}

function writeAtomic(path: string, value: JsonObject): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.droid.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
    chmodSync(temporary, 0o600);
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function installLogo(dataDir: string): { path: string; changed: boolean } {
  const destination = join(dataDir, "logos", `${PROFILE.id}.svg`);
  mkdirSync(dirname(destination), { recursive: true });
  const changed = !existsSync(destination)
    || !readFileSync(destination).equals(readFileSync(logoSource));
  if (changed) copyFileSync(logoSource, destination);
  return { path: destination, changed };
}

function factoryAuthPath(): string {
  return join(homedir(), ".factory", "auth.v2.file");
}

function envApiKey(env: unknown): string | undefined {
  if (!isObject(env) || typeof env.FACTORY_API_KEY !== "string" || env.FACTORY_API_KEY.length === 0) {
    return undefined;
  }
  return env.FACTORY_API_KEY;
}

function managedEnv(existing?: CustomAgent, setting?: string): JsonObject {
  const env = isObject(existing?.env) ? { ...existing.env } : {};
  if (typeof setting === "string") {
    if (setting.length > 0) env.FACTORY_API_KEY = setting;
    else delete env.FACTORY_API_KEY;
  }
  return env;
}

function provision(dataDir: string, factoryApiKey?: string): { changed: boolean; binary: string } {
  const configPath = join(dataDir, "config.json");
  const config = readConfig(configPath);
  const agents = Array.isArray(config.customAcpAgents)
    ? [...config.customAcpAgents] as CustomAgent[]
    : [];
  const index = agents.findIndex((agent) => agent?.id === PROFILE.id);
  const current = index >= 0 ? agents[index] : undefined;
  const binary = findBinary(current);
  if (binary === null) throw new Error(`${PROFILE.binary} was not found. ${PROFILE.installHint}`);

  const managed: CustomAgent = {
    ...current,
    id: PROFILE.id,
    displayName: PROFILE.displayName,
    command: binary,
    args: [...PROFILE.args],
    env: managedEnv(current, factoryApiKey),
    logo: `logos/${PROFILE.id}.svg`,
    modelCli: {
      selectFlag: PROFILE.modelCli.selectFlag,
      primaryModels: [...PROFILE.modelCli.primaryModels],
    },
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

function unregister(dataDir: string): boolean {
  const configPath = join(dataDir, "config.json");
  const config = readConfig(configPath);
  if (!Array.isArray(config.customAcpAgents)) return false;
  const agents = (config.customAcpAgents as CustomAgent[]).filter((agent) => agent?.id !== PROFILE.id);
  if (agents.length === config.customAcpAgents.length) return false;
  if (agents.length === 0) delete config.customAcpAgents;
  else config.customAcpAgents = agents;
  writeAtomic(configPath, config);
  return true;
}

export default function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    factoryApiKey: {
      type: "string",
      label: "Factory API key",
      secret: true,
    },
  });

  async function dataDir(): Promise<string> {
    try {
      const config = await bb.sdk.system.config();
      if (config.dataDir.length > 0) return config.dataDir;
    } catch (error) {
      bb.log.warn(`Could not resolve bb data directory through the SDK: ${String(error)}`);
    }
    return process.env.BB_DATA_DIR ?? join(homedir(), ".bb");
  }

  async function reloadConfig(): Promise<void> {
    await bb.sdk.system.reloadConfig();
  }

  async function repair(): Promise<{ changed: boolean; binary: string }> {
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
          result.changed
            ? `registered ${PROFILE.providerId} with ${result.binary}`
            : `${PROFILE.providerId} is already configured`,
        );
      } catch (error) {
        const message = String(error);
        bb.log.error(message);
        bb.status.needsConfiguration(message);
      }
    },
  });

  bb.cli.register({
    name: PROFILE.id,
    summary: `Manage the ${PROFILE.displayName} ACP provider.`,
    commands: [
      { name: "status", summary: "Check the CLI and bb provider registration", usage: `${PROFILE.id} status` },
      { name: "repair", summary: "Rewrite and reload the managed ACP configuration", usage: `${PROFILE.id} repair` },
      { name: "unregister", summary: "Remove this plugin's managed ACP configuration", usage: `${PROFILE.id} unregister` },
    ],
    async run(argv) {
      const command = argv[0] ?? "status";
      if (command === "repair") {
        try {
          const result = await repair();
          return { exitCode: 0, stdout: `${PROFILE.providerId}: ${result.changed ? "repaired" : "already up to date"}\nCLI: ${result.binary}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}\n` };
        }
      }
      if (command === "unregister") {
        try {
          const changed = unregister(await dataDir());
          if (changed) await reloadConfig();
          return { exitCode: 0, stdout: `${PROFILE.providerId}: ${changed ? "unregistered" : "not configured"}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}\n` };
        }
      }
      if (command === "status") {
        const root = await dataDir();
        const config = readConfig(join(root, "config.json"));
        const agents = Array.isArray(config.customAcpAgents) ? config.customAcpAgents as CustomAgent[] : [];
        const entry = agents.find((agent) => agent?.id === PROFILE.id);
        const binary = findBinary(entry);
        const loginFile = existsSync(factoryAuthPath());
        const { factoryApiKey } = await settings.get();
        const apiKey = Boolean(factoryApiKey) || Boolean(envApiKey(entry?.env)) || Boolean(envApiKey(process.env));
        let registered = false;
        try {
          registered = (await bb.sdk.providers.list()).some((provider) => provider.id === PROFILE.providerId);
        } catch {}
        const ready = Boolean(binary && entry && registered && (apiKey || loginFile));
        const hint = !ready
          ? "Factory is not authenticated for ACP. Run `droid` to log in, or set the Factory API key plugin setting and `bb droid repair`."
          : apiKey
            ? null
            : "Interactive droid login is present. If a thread fails with \"Internal error: Agent error\" or \"No active ACP session\", run `bb thread stop <id>` then `bb thread tell --mode auto <id> continue`.";
        return {
          exitCode: ready ? 0 : 1,
          stdout: [
            `CLI: ${binary ?? "NOT FOUND"}`,
            `config entry: ${entry ? "present" : "missing"}`,
            `bb provider ${PROFILE.providerId}: ${registered ? "registered" : "NOT registered"}`,
            `Factory login file: ${loginFile ? factoryAuthPath() : "MISSING"}`,
            `FACTORY_API_KEY: ${apiKey ? "set" : "not set"}`,
            ...(hint ? [hint] : []),
          ].join("\n") + "\n",
        };
      }
      return { exitCode: 2, stderr: `Unknown subcommand "${command}". Use "bb ${PROFILE.id} status".\n` };
    },
  });
}
