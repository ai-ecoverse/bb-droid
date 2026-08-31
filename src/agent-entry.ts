export type JsonObject = Record<string, unknown>;
export type CustomAgent = JsonObject & { id?: unknown; command?: unknown; env?: unknown };

export const ACP_PLUGIN_ID = "provider-acp";

export const PROFILE = {
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
    project: [".factory/skills", ".agents/skills", ".agent/skills"],
  },
  // bb's permission modes as Droid exec launch flags. These are exec options,
  // so insertAfterArgs: 1 places them after `exec` rather than before it.
  // "full" is Droid's own skip-all-checks switch. "accept-edits" maps to
  // `--auto low` (file creation/modification, no system changes). bb's default
  // "auto" mode adds nothing, so every request comes through ACP as before.
  permissionCli: {
    full: ["--skip-permissions-unsafe"],
    workspaceWrite: ["--auto", "low"],
    insertAfterArgs: 1,
  },
  installHint: "Install and authenticate Factory Droid, then run `bb plugin reload droid`.",
} as const;

export function isObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function isOwnAgent(agent: CustomAgent | undefined): boolean {
  return agent?.id === PROFILE.id;
}

export function findOwnAgent(agents: CustomAgent[]): CustomAgent | undefined {
  return agents.find(isOwnAgent);
}

export function parseCustomAgents(value: unknown): CustomAgent[] {
  if (value === undefined || value === null || value === "") return [];
  if (typeof value !== "string") {
    throw new Error(`${ACP_PLUGIN_ID} customAgents must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0) return [];
  const parsed: unknown = JSON.parse(trimmed);
  if (!Array.isArray(parsed)) {
    throw new Error(`${ACP_PLUGIN_ID} customAgents must be a JSON array; refusing to overwrite it`);
  }
  return parsed as CustomAgent[];
}

export function stringifyCustomAgents(agents: CustomAgent[]): string {
  return `${JSON.stringify(agents, null, 2)}\n`;
}

export function managedEnv(existing?: CustomAgent, factoryApiKey?: string): JsonObject | undefined {
  const env = isObject(existing?.env) ? { ...existing.env } : {};
  if (typeof factoryApiKey === "string") {
    if (factoryApiKey.length > 0) env.FACTORY_API_KEY = factoryApiKey;
    else delete env.FACTORY_API_KEY;
  }
  return Object.keys(env).length > 0 ? env : undefined;
}

export function managedAgent(binary: string, existing?: CustomAgent, factoryApiKey?: string): CustomAgent {
  const env = managedEnv(existing, factoryApiKey);
  const agent: CustomAgent = {
    // Keys the user added themselves (cwd, dialect, modelCli, ...) survive a
    // reload; the fields below are ours and are rewritten every time.
    ...(existing ?? {}),
    id: PROFILE.id,
    displayName: PROFILE.displayName,
    command: binary,
    args: [...PROFILE.args],
    nativeSkillRoots: {
      user: [...PROFILE.nativeSkillRoots.user],
      project: [...PROFILE.nativeSkillRoots.project],
    },
    permissionCli: {
      full: [...PROFILE.permissionCli.full],
      workspaceWrite: [...PROFILE.permissionCli.workspaceWrite],
      insertAfterArgs: PROFILE.permissionCli.insertAfterArgs,
    },
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

export function upsertAgent(agents: CustomAgent[], next: CustomAgent): { agents: CustomAgent[]; changed: boolean } {
  const index = agents.findIndex(isOwnAgent);
  const copy = [...agents];
  if (index >= 0) copy[index] = next;
  else copy.push(next);
  return { agents: copy, changed: JSON.stringify(copy) !== JSON.stringify(agents) };
}

export function removeAgent(agents: CustomAgent[]): { agents: CustomAgent[]; changed: boolean } {
  const next = agents.filter((agent) => !isOwnAgent(agent));
  return { agents: next, changed: next.length !== agents.length };
}
