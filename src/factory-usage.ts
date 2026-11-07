import { z } from "zod";
import { FactoryAuthError, readFactoryCredential } from "./factory-auth.js";
import type { UsageMeasurement, UsageWindow } from "./usage-contract.js";

const quotaWindow = z.object({
  usedPercent: z.number().nonnegative(),
  windowEnd: z.string().datetime({ offset: true }).nullable(),
});
const pool = z.object({ fiveHour: quotaWindow.optional(), weekly: quotaWindow.optional(), monthly: quotaWindow.optional() });
const limitsSchema = z.object({
  limits: z.object({ standard: pool.optional(), core: pool.optional() }),
});
const identitySchema = z.object({ userId: z.string().min(1), orgId: z.string().min(1) });

export function normalizeFactoryLimits(value: unknown): UsageWindow[] {
  const limits = limitsSchema.parse(value).limits;
  const windows: UsageWindow[] = [];
  for (const model of ["standard", "core"] as const) {
    for (const [name, kind, label] of [
      ["fiveHour", "five-hour", "5h"], ["weekly", "weekly", "7d"], ["monthly", "custom", "Monthly"],
    ] as const) {
      const window = limits[model]?.[name];
      if (!window) continue;
      windows.push({
        id: `${model}:${name}`, kind, label: `${label} · ${model === "standard" ? "Standard" : "Core"}`,
        usedPercent: window.usedPercent, resetsAt: window.windowEnd, model, cost: null,
      });
    }
  }
  if (windows.length === 0) throw new Error("No quota windows.");
  return windows;
}

export function unavailableUsage(status: "unauthenticated" | "expired" | "error", message = "Factory usage could not be collected."): UsageMeasurement {
  const account = { accountEmail: null, planLabel: null, plan: null };
  return { accountKey: null, observedAt: null, usage: status === "error" ? { status, ...account, message } : { status, ...account } };
}

export async function collectFactoryUsage(options: {
  apiKey?: string;
  signal?: AbortSignal;
  readCredential?: typeof readFactoryCredential;
  fetch?: typeof fetch;
} = {}): Promise<UsageMeasurement> {
  try {
    const credential = await (options.readCredential ?? readFactoryCredential)({
      apiKey: options.apiKey ?? process.env.FACTORY_API_KEY,
      disableKeyring: process.env.FACTORY_DISABLE_KEYRING === "1",
      signal: options.signal,
    });
    const headers: Record<string, string> = { Authorization: `Bearer ${credential.token}`, Accept: "application/json" };
    if (credential.organizationId) headers["x-factory-org-id"] = credential.organizationId;
    const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)]) : AbortSignal.timeout(15_000);
    const request = (path: string) => (options.fetch ?? fetch)(`https://api.factory.ai${path}`, { headers, signal, redirect: "error" });
    const response = await request("/api/billing/limits");
    if (response.status === 401) return unavailableUsage("expired");
    if (response.status === 403) return unavailableUsage("error", "Factory denied access to billing limits for this account or API key.");
    if (!response.ok) return unavailableUsage("error", `Factory billing limits request failed (HTTP ${response.status}).`);
    const windows = normalizeFactoryLimits(await response.json());
    // Use provider-issued user AND organization IDs for quota identity, never
    // email or a bearer token. Failure to resolve identity must not hide quota.
    let accountKey: string | null = null;
    try {
      const identityResponse = await request("/api/cli/whoami");
      if (identityResponse.ok) {
        const identity = identitySchema.safeParse(await identityResponse.json());
        if (identity.success) accountKey = `factory:organization:${identity.data.orgId}:user:${identity.data.userId}`;
      }
    } catch { /* Unknown accounts stay separate in BB's usage panel. */ }
    return {
      accountKey, observedAt: Date.now(),
      usage: { status: "ok", accountEmail: credential.email, planLabel: null, plan: null, windows },
    };
  } catch (error) {
    if (error instanceof FactoryAuthError) return unavailableUsage(error.status, error.message);
    // Fetch errors and parse failures can contain credentials or response bodies.
    return unavailableUsage("error", "Factory usage could not be read. Check the connection and open Droid to verify your login. This billing format may be unsupported.");
  }
}
