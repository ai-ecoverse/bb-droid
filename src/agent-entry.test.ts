import { describe, expect, it } from "vitest";
import {
  PROFILE,
  findOwnAgent,
  managedAgent,
  parseCustomAgents,
  removeAgent,
  stringifyCustomAgents,
  upsertAgent,
  type CustomAgent,
} from "./agent-entry.js";

const BINARY = "/Users/trieloff/.local/bin/droid";

function otherAgent(id: string): CustomAgent {
  return { id, displayName: id, command: id, args: ["--acp"], env: {} };
}

describe("managedAgent", () => {
  it("declares the fields the plugin owns", () => {
    const agent = managedAgent(BINARY);
    expect(agent).toMatchObject({
      id: PROFILE.id,
      displayName: PROFILE.displayName,
      command: BINARY,
      args: ["exec", "--output-format", "acp"],
      nativeSkillRoots: {
        user: [".factory/skills", ".agents/skills", ".agent/skills"],
        project: [".factory/skills", ".agents/skills", ".agent/skills"],
      },
      permissionCli: {
        full: ["--skip-permissions-unsafe"],
        workspaceWrite: ["--auto", "low"],
        insertAfterArgs: 1,
      },
    });
    expect(agent.env).toBeUndefined();
    expect(agent.supportsManualCompaction).toBeUndefined();
  });

  it("keeps keys the user added and env they set", () => {
    const existing: CustomAgent = {
      id: PROFILE.id,
      command: "droid",
      args: ["exec", "--output-format", "acp", "--banner"],
      env: { DROID_HOME: "/tmp/droid" },
      cwd: "/tmp/workspace",
      dialect: "cursor",
      modelCli: { listArgs: ["models"], selectFlag: "--model" },
    };
    const agent = managedAgent(BINARY, existing);
    expect(agent.cwd).toBe("/tmp/workspace");
    expect(agent.dialect).toBe("cursor");
    expect(agent.env).toEqual({ DROID_HOME: "/tmp/droid" });
    expect(agent.modelCli).toEqual({ listArgs: ["models"], selectFlag: "--model" });
    expect(agent.args).toEqual(["exec", "--output-format", "acp"]);
    expect(agent.command).toBe(BINARY);
  });

  it("injects FACTORY_API_KEY from the plugin setting without dropping other env", () => {
    const existing: CustomAgent = {
      id: PROFILE.id,
      env: { DROID_HOME: "/tmp/droid", FACTORY_API_KEY: "old" },
    };
    expect(managedAgent(BINARY, existing, "fk-new").env).toEqual({
      DROID_HOME: "/tmp/droid",
      FACTORY_API_KEY: "fk-new",
    });
    expect(managedAgent(BINARY, existing, "").env).toEqual({ DROID_HOME: "/tmp/droid" });
    expect(managedAgent(BINARY, existing).env).toEqual({
      DROID_HOME: "/tmp/droid",
      FACTORY_API_KEY: "old",
    });
  });

  it("ignores a non-object env rather than passing it through", () => {
    expect(managedAgent(BINARY, { id: PROFILE.id, env: "nope" }).env).toBeUndefined();
  });

  it("drops a logo and a modelCli that bb 0.40 would reject", () => {
    const existing: CustomAgent = {
      id: PROFILE.id,
      logo: "droid-logo.svg",
      modelCli: { selectFlag: "--model" },
    };
    const agent = managedAgent(BINARY, existing);
    expect(agent.logo).toBeUndefined();
    expect(agent.modelCli).toBeUndefined();
  });
});

describe("findOwnAgent", () => {
  it("finds this plugin's entry by id", () => {
    const ours = { ...managedAgent(BINARY), cwd: "/current" };
    expect(findOwnAgent([otherAgent("auggie"), ours])?.cwd).toBe("/current");
  });

  it("does not claim another plugin's factory-droid entry", () => {
    const theirs: CustomAgent = {
      id: "factory-droid",
      displayName: "Factory Droid",
      command: "droid",
      args: ["exec", "--output-format", "acp"],
    };
    expect(findOwnAgent([theirs])).toBeUndefined();
  });
});

describe("upsertAgent", () => {
  it("appends the entry and leaves other agents in place", () => {
    const agents = [otherAgent("auggie"), otherAgent("factory-droid")];
    const result = upsertAgent(agents, managedAgent(BINARY));
    expect(result.changed).toBe(true);
    expect(result.agents.map((agent) => agent.id)).toEqual(["auggie", "factory-droid", PROFILE.id]);
  });

  it("is idempotent once provisioned", () => {
    const first = upsertAgent([otherAgent("auggie")], managedAgent(BINARY));
    const second = upsertAgent(first.agents, managedAgent(BINARY));
    expect(second.changed).toBe(false);
    expect(second.agents).toEqual(first.agents);
  });

  it("reports a change when the resolved binary moved", () => {
    const provisioned = upsertAgent([], managedAgent("/usr/local/bin/droid")).agents;
    const result = upsertAgent(provisioned, managedAgent(BINARY));
    expect(result.changed).toBe(true);
    expect(result.agents).toHaveLength(1);
    expect(result.agents[0]?.command).toBe(BINARY);
  });

  it("replaces our entry in place without touching a similarly named one", () => {
    const theirs: CustomAgent = {
      id: "factory-droid",
      displayName: "Factory Droid",
      command: "droid",
    };
    const result = upsertAgent([theirs, otherAgent("auggie")], managedAgent(BINARY));
    expect(result.changed).toBe(true);
    expect(result.agents.map((agent) => agent.id)).toEqual(["factory-droid", "auggie", PROFILE.id]);
    expect(result.agents[0]).toEqual(theirs);
  });
});

describe("removeAgent", () => {
  it("removes our id and nothing else", () => {
    const theirs: CustomAgent = { id: "factory-droid", displayName: "Factory Droid" };
    const agents = [otherAgent("auggie"), managedAgent(BINARY), theirs];
    const result = removeAgent(agents);
    expect(result.changed).toBe(true);
    expect(result.agents).toEqual([otherAgent("auggie"), theirs]);
  });

  it("reports no change when nothing is registered", () => {
    expect(removeAgent([otherAgent("auggie")]).changed).toBe(false);
  });
});

describe("parseCustomAgents", () => {
  it("treats an unset or blank setting as no agents", () => {
    expect(parseCustomAgents(undefined)).toEqual([]);
    expect(parseCustomAgents(null)).toEqual([]);
    expect(parseCustomAgents("")).toEqual([]);
    expect(parseCustomAgents("   \n")).toEqual([]);
  });

  it("round-trips what stringifyCustomAgents writes", () => {
    const agents = [otherAgent("auggie"), managedAgent(BINARY)];
    expect(parseCustomAgents(stringifyCustomAgents(agents))).toEqual(agents);
  });

  it("refuses a setting it would otherwise clobber", () => {
    expect(() => parseCustomAgents('{"id":"droid"}')).toThrow(/JSON array/);
    expect(() => parseCustomAgents(["already parsed"])).toThrow(/must be a string/);
    expect(() => parseCustomAgents("[not json")).toThrow();
  });
});
