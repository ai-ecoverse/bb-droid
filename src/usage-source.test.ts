import { afterEach, expect, it, vi } from "vitest";
import { createFakePluginHost, makeHostResponse, experimental_scanPublicSdkOnly } from "@get-bb/plugin-sdk/testing";
import { registerUsageSource } from "./usage-source.js";
import { usageFetchMethod, usageListMethod, usageMeasurementSchema } from "./usage-contract.js";
import { unavailableUsage } from "./factory-usage.js";
import plugin from "../server.js";

afterEach(() => { vi.useRealTimers(); });
const measurement = () => usageMeasurementSchema.parse({ accountKey: "factory:org:user", observedAt: Date.now(), usage: {
  status: "ok", accountEmail: "user@example.com", planLabel: null, plan: null,
  windows: [{ id: "standard:weekly", kind: "weekly", label: "7d · Standard", usedPercent: 43, resetsAt: null, model: "standard", cost: null }],
} });

it("discovers machine-scoped resources without opening credentials; caches only the requested machine", async () => {
  let removed = false;
  const collect = vi.fn(async () => measurement());
  const { bb, harness } = createFakePluginHost({ pluginId: "droid", sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "online", name: "Laptop", status: "connected" }), makeHostResponse({ id: "offline", status: "disconnected" })] },
    providers: { list: async () => removed ? [] : [{ id: "acp-droid", displayName: "Factory Droid", pluginId: "provider-acp" }] },
  }, experimental_callHostRpc: collect });
  try {
    const clear = registerUsageSource(bb, async () => "fk-test");
    const read = (resourceId = "online", refresh = false) => harness.behavior.callRpc(usageFetchMethod, { resourceId, refresh });
    expect(await harness.behavior.callRpc(usageListMethod, {})).toMatchObject({ resources: [{ id: "online", scope: { hostId: "online" } }, { id: "offline" }] });
    expect(collect).not.toHaveBeenCalled();
    expect(await read()).toMatchObject({ usage: { status: "ok" } });
    expect(harness.experimental_hostRpcCalls[0]).toMatchObject({ hostId: "online", method: "collectUsage", input: { apiKey: "fk-test" } });
    await read(); expect(collect).toHaveBeenCalledTimes(1);
    await read("online", true); expect(collect).toHaveBeenCalledTimes(2);
    clear(); await read(); expect(collect).toHaveBeenCalledTimes(3);
    expect(await read("offline")).toMatchObject({ usage: { status: "error", message: "Machine is disconnected." } });
    expect(collect).toHaveBeenCalledTimes(3);
    removed = true;
    expect(await harness.behavior.callRpc(usageListMethod, {})).toEqual({ resources: [] });
    await expect(read()).rejects.toThrow("no longer exists");
    await expect(read("missing")).rejects.toThrow("no longer exists");
  } finally { await harness.lifecycle.dispose(); }
});

it("retries expired/error measurements, expires successful cache, and preserves the last success time", async () => {
  vi.useFakeTimers();
  const success = measurement();
  const collect = vi.fn().mockResolvedValueOnce(success).mockResolvedValue(unavailableUsage("expired"));
  const { bb, harness } = createFakePluginHost({ sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "host", status: "connected" })] },
    providers: { list: async () => [{ id: "acp-droid", displayName: "Droid", pluginId: "provider-acp" }] },
  }, experimental_callHostRpc: collect });
  try {
    registerUsageSource(bb, async () => undefined);
    const read = () => harness.behavior.callRpc(usageFetchMethod, { resourceId: "host", refresh: false });
    await read(); vi.advanceTimersByTime(60_001);
    expect(await read()).toMatchObject({ observedAt: success.observedAt, usage: { status: "expired" } });
    await read(); expect(collect).toHaveBeenCalledTimes(3);
  } finally { await harness.lifecycle.dispose(); }
});

it("coalesces concurrent refreshes and sanitizes worker failures", async () => {
  let resolve!: (value: ReturnType<typeof measurement>) => void;
  const collect = vi.fn(() => new Promise<ReturnType<typeof measurement>>((done) => { resolve = done; }));
  const { bb, harness } = createFakePluginHost({ sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "host", status: "connected" })] },
    providers: { list: async () => [{ id: "acp-droid", displayName: "Droid", pluginId: "provider-acp" }] },
  }, experimental_callHostRpc: collect });
  try {
    registerUsageSource(bb, async () => undefined);
    const read = () => harness.behavior.callRpc(usageFetchMethod, { resourceId: "host", refresh: true });
    const a = read(), b = read();
    await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    resolve(measurement()); await Promise.all([a, b]);
    collect.mockRejectedValueOnce(new Error("sensitive-host-error"));
    const value = await read(); expect(value).toMatchObject({ usage: { status: "error" } });
    expect(JSON.stringify(value)).not.toContain("sensitive-host-error");
  } finally { await harness.lifecycle.dispose(); }
});

it("uses only the public plugin SDK", () => {
  const scan = experimental_scanPublicSdkOnly(new URL("..", import.meta.url).pathname);
  expect(scan.violations).toEqual([]); expect(scan.privateDependencies).toEqual([]);
});

it("does not repopulate the cache with an old account when the API key changes during collection", async () => {
  let finishOld!: (value: ReturnType<typeof measurement>) => void;
  let key = "old-key";
  const collect = vi.fn().mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; })).mockImplementation(async () => measurement());
  const { bb, harness } = createFakePluginHost({ sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "host", status: "connected" })] },
    providers: { list: async () => [{ id: "acp-droid", displayName: "Droid", pluginId: "provider-acp" }] },
  }, experimental_callHostRpc: collect });
  try {
    const clear = registerUsageSource(bb, async () => key);
    const read = () => harness.behavior.callRpc(usageFetchMethod, { resourceId: "host", refresh: false });
    const oldRead = read(); await vi.waitFor(() => expect(collect).toHaveBeenCalledTimes(1));
    key = "new-key"; clear(); await read();
    finishOld({ ...measurement(), accountKey: "old-account" }); await oldRead;
    expect(await read()).toMatchObject({ accountKey: "factory:org:user" });
    expect(collect).toHaveBeenCalledTimes(2);
    expect(harness.experimental_hostRpcCalls[1].input).toEqual({ apiKey: "new-key" });
  } finally { await harness.lifecycle.dispose(); }
});

it("cancels the host request when the plugin is disposed", async () => {
  let signal: AbortSignal | undefined;
  const { bb, harness } = createFakePluginHost({ sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "host", status: "connected" })] },
    providers: { list: async () => [{ id: "acp-droid", displayName: "Droid", pluginId: "provider-acp" }] },
  }, experimental_callHostRpc: async (call) => { signal = call.signal; return measurement(); } });
  registerUsageSource(bb, async () => undefined);
  try {
    await harness.behavior.callRpc(usageFetchMethod, { resourceId: "host", refresh: false });
    expect(signal?.aborted).toBe(false);
  } finally { await harness.lifecycle.dispose(); }
  expect(signal?.aborted).toBe(true);
});

it.each([
  { setting: "setting-key", entry: "entry-key", expected: "setting-key" },
  { setting: undefined, entry: "entry-key", expected: "entry-key" },
  { setting: undefined, entry: undefined, expected: undefined },
])("uses the plugin/managed-entry credential precedence: $expected", async ({ setting, entry, expected }) => {
  const { bb, harness } = createFakePluginHost({ pluginId: "droid", settings: setting ? { factoryApiKey: setting } : {}, sdk: {
    hosts: { list: async () => [makeHostResponse({ id: "host", status: "connected" })] },
    providers: { list: async () => [{ id: "acp-droid", displayName: "Droid", pluginId: "provider-acp" }] },
    plugins: { getSettings: async () => ({ values: { customAgents: JSON.stringify([{ id: "droid", env: entry ? { FACTORY_API_KEY: entry } : {} }]) } }) },
  }, experimental_callHostRpc: async () => measurement() });
  try {
    plugin(bb);
    await harness.behavior.callRpc(usageFetchMethod, { resourceId: "host", refresh: false });
    expect(harness.experimental_hostRpcCalls[0].input).toEqual(expected ? { apiKey: expected } : {});
  } finally { await harness.lifecycle.dispose(); }
});
