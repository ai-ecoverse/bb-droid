import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { PROFILE } from "./agent-entry.js";
import { unavailableUsage } from "./factory-usage.js";
import { usageFetchMethod, usageHostContract, usageListMethod, usageMeasurementSchema, usageSourceContract, type UsageMeasurement } from "./usage-contract.js";

export function registerUsageSource(bb: BbPluginApi, getApiKey: () => Promise<string | undefined>): () => void {
  const worker = bb.hosts.experimental_client({ contract: usageHostContract });
  const cache = new Map<string, UsageMeasurement>();
  const pending = new Map<string, { refresh: boolean; promise: Promise<UsageMeasurement> }>();
  let generation = 0;
  const lifetime = new AbortController();
  bb.onDispose(() => { lifetime.abort(); cache.clear(); pending.clear(); });

  async function load(hostId: string, refresh: boolean, signal: AbortSignal): Promise<UsageMeasurement> {
    const startedIn = generation;
    const host = (await bb.sdk.hosts.list()).find((candidate) => candidate.id === hostId && candidate.type !== "ephemeral");
    if (!host) throw new Error("Factory usage resource no longer exists.");
    const providers = await bb.sdk.providers.list({ hostId });
    if (!providers.some((provider) => provider.id === PROFILE.providerId)) throw new Error("Factory usage resource no longer exists.");
    const previous = cache.get(hostId);
    if (host.status === "disconnected") return { ...unavailableUsage("error", "Machine is disconnected."), observedAt: previous?.observedAt ?? null };
    if (!refresh && previous?.usage.status === "ok" && previous.observedAt !== null && Date.now() - previous.observedAt < 60_000) return previous;
    let value: UsageMeasurement;
    try {
      const apiKey = await getApiKey();
      value = usageMeasurementSchema.parse(await worker.call("collectUsage", apiKey ? { apiKey } : {}, { hostId, signal: AbortSignal.any([lifetime.signal, signal]) }));
    } catch { value = unavailableUsage("error", "Factory usage could not be collected from this machine."); }
    value = { ...value, observedAt: value.observedAt ?? previous?.observedAt ?? null };
    if (!lifetime.signal.aborted && startedIn === generation) cache.set(hostId, value);
    return value;
  }
  async function collect(hostId: string, refresh: boolean, signal: AbortSignal): Promise<UsageMeasurement> {
    const running = pending.get(hostId);
    if (running) {
      if (!refresh || running.refresh) return running.promise;
      await running.promise.catch(() => undefined);
      return collect(hostId, refresh, signal);
    }
    const promise = load(hostId, refresh, signal).finally(() => {
      if (pending.get(hostId)?.promise === promise) pending.delete(hostId);
    });
    pending.set(hostId, { refresh, promise });
    return promise;
  }
  bb.rpc.register(usageSourceContract, {
    async [usageListMethod]() {
      const hosts = (await bb.sdk.hosts.list()).filter((host) => host.type !== "ephemeral");
      // acp-droid has no bridge-owned usage implementation. This plugin owns
      // its source and must not set providerUsage on the ACP launch profile.
      const resources = (await Promise.all(hosts.map(async (host) => {
        const providers = await bb.sdk.providers.list({ hostId: host.id });
        if (!providers.some((provider) => provider.id === PROFILE.providerId)) return [];
        return [{ id: host.id, accountKey: null, providerId: PROFILE.providerId, label: PROFILE.displayName,
          scope: { kind: "host" as const, hostId: host.id, hostName: host.name } }];
      }))).flat();
      const ids = new Set(resources.map((resource) => resource.id));
      for (const id of cache.keys()) if (!ids.has(id)) cache.delete(id);
      return { resources };
    },
    [usageFetchMethod]: ({ resourceId, refresh }, context) => collect(resourceId, refresh, context.experimental_signal),
  }, {
    experimental_discoverable: true,
    experimental_description: "Factory Droid account quota, read on the selected machine using its CLI login or the configured API key.",
  });
  return () => { generation += 1; cache.clear(); pending.clear(); };
}
