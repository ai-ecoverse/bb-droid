import type { BbPluginApi } from "@get-bb/plugin-sdk";
import {
  accessSync,
  chmodSync,
  constants,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { delimiter, dirname, join } from "node:path";

const PROFILE = {
  id: "droid",
  providerId: "acp-droid",
  displayName: "Factory Droid",
  binary: "droid",
  args: ["exec", "--output-format", "acp"],
  installHint: "Install and authenticate Factory Droid, then run `bb plugin reload droid`.",
} as const;

const ACP_PLUGIN_ID = "provider-acp";

type JsonObject = Record<string, unknown>;
type CustomAgent = JsonObject & { id?: unknown; command?: unknown; env?: unknown };

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

function factoryAuthPath(): string {
  return join(homedir(), ".factory", "auth.v2.file");
}

function envApiKey(env: unknown): string | undefined {
  if (!isObject(env) || typeof env.FACTORY_API_KEY !== "string" || env.FACTORY_API_KEY.length === 0) {
    return undefined;
  }
  return env.FACTORY_API_KEY;
}

function managedEnv(existing?: CustomAgent, setting?: string): JsonObject | undefined {
  const env = isObject(existing?.env) ? { ...existing.env } : {};
  if (typeof setting === "string") {
    if (setting.length > 0) env.FACTORY_API_KEY = setting;
    else delete env.FACTORY_API_KEY;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

function parseCustomAgents(value: unknown): CustomAgent[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error('ACP customAgents setting is not valid JSON; refusing to overwrite it');
  }
  if (!Array.isArray(parsed)) {
    throw new Error("ACP customAgents setting must be a JSON array; refusing to overwrite it");
  }
  return parsed as CustomAgent[];
}

function legacyAgents(dataDir: string): CustomAgent[] {
  const agents = readConfig(join(dataDir, "config.json")).customAcpAgents;
  return Array.isArray(agents) ? agents as CustomAgent[] : [];
}

function managedAgent(existing: CustomAgent | undefined, binary: string, factoryApiKey?: string): CustomAgent {
  const env = managedEnv(existing, factoryApiKey);
  const agent: CustomAgent = {
    ...existing,
    id: PROFILE.id,
    displayName: PROFILE.displayName,
    command: binary,
    args: [...PROFILE.args],
  };
  delete agent.logo;
  if (env) agent.env = env;
  else delete agent.env;
  // bb 0.40 requires modelCli.listArgs when modelCli is present. Droid has no
  // list-models command; ACP session discovery supplies the catalog instead.
  if (!isObject(agent.modelCli) || !Array.isArray(agent.modelCli.listArgs)) {
    delete agent.modelCli;
  }
  return agent;
}

function stringifyAgents(agents: CustomAgent[]): string {
  return `${JSON.stringify(agents, null, 2)}\n`;
}

function removeLegacyEntry(dataDir: string): boolean {
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

  async function readAcpAgents(): Promise<CustomAgent[]> {
    const result = await bb.sdk.plugins.getSettings({ pluginId: ACP_PLUGIN_ID });
    return parseCustomAgents(result.values.customAgents);
  }

  async function writeAcpAgents(agents: CustomAgent[]): Promise<void> {
    await bb.sdk.plugins.updateSettings({
      pluginId: ACP_PLUGIN_ID,
      values: { customAgents: stringifyAgents(agents) },
    });
  }

  async function repair(): Promise<{ changed: boolean; binary: string }> {
    const { factoryApiKey } = await settings.get();
    const root = await dataDir();
    const configured = await readAcpAgents();
    const current = configured.find((agent) => agent?.id === PROFILE.id)
      ?? legacyAgents(root).find((agent) => agent?.id === PROFILE.id);
    const binary = findBinary(current);
    if (binary === null) throw new Error(`${PROFILE.binary} was not found. ${PROFILE.installHint}`);

    const managed = managedAgent(current, binary, factoryApiKey);
    const next = configured.filter((agent) => agent?.id !== PROFILE.id);
    next.push(managed);
    const agentsChanged = stringifyAgents(configured) !== stringifyAgents(next);
    const legacyChanged = removeLegacyEntry(root);
    if (agentsChanged) await writeAcpAgents(next);
    else if (legacyChanged) await bb.sdk.plugins.reload({ pluginId: ACP_PLUGIN_ID });
    return { changed: agentsChanged || legacyChanged, binary };
  }

  async function unregister(): Promise<boolean> {
    const configured = await readAcpAgents();
    const next = configured.filter((agent) => agent?.id !== PROFILE.id);
    const agentsChanged = next.length !== configured.length;
    const legacyChanged = removeLegacyEntry(await dataDir());
    if (agentsChanged) await writeAcpAgents(next);
    else if (legacyChanged) await bb.sdk.plugins.reload({ pluginId: ACP_PLUGIN_ID });
    return agentsChanged || legacyChanged;
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
          const changed = await unregister();
          return { exitCode: 0, stdout: `${PROFILE.providerId}: ${changed ? "unregistered" : "not configured"}\n` };
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}\n` };
        }
      }
      if (command === "status") {
        let configured: CustomAgent[] = [];
        try {
          configured = await readAcpAgents();
        } catch (error) {
          return { exitCode: 1, stderr: `${String(error)}\n` };
        }
        const entry = configured.find((agent) => agent?.id === PROFILE.id);
        const legacy = legacyAgents(await dataDir()).find((agent) => agent?.id === PROFILE.id);
        const binary = findBinary(entry ?? legacy);
        const loginFile = existsSync(factoryAuthPath());
        const { factoryApiKey } = await settings.get();
        const apiKey = Boolean(factoryApiKey) || Boolean(envApiKey(entry?.env)) || Boolean(envApiKey(legacy?.env)) || Boolean(envApiKey(process.env));
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
            `ACP customAgents entry: ${entry ? "present" : "missing"}`,
            `legacy config.json entry: ${legacy ? "present (run bb droid repair)" : "absent"}`,
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
