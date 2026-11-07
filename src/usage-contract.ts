// BB's provider-usage.v1 wire contract. Keep this compatible with the usage
// panel; it is a discoverable cross-plugin RPC, not an ACP session update.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

const account = {
  accountEmail: z.string().nullable(),
  planLabel: z.string().nullable(),
  plan: z.object({ id: z.string().min(1), multiplier: z.number().int().positive().nullable() }).nullable(),
};
export const usageWindowSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["five-hour", "daily", "weekly", "custom"]),
  label: z.string().min(1),
  usedPercent: z.number().nonnegative(),
  resetsAt: z.string().nullable(),
  model: z.string().nullable(),
  cost: z.object({ usedUsdCents: z.number().nonnegative(), limitUsdCents: z.number().positive() }).nullable(),
});
export const usageMeasurementSchema = z.object({
  accountKey: z.string().min(1).nullable(),
  observedAt: z.number().int().nonnegative().nullable(),
  usage: z.discriminatedUnion("status", [
    z.object({ status: z.literal("ok"), ...account, windows: z.array(usageWindowSchema) }),
    z.object({ status: z.literal("not_installed"), ...account }),
    z.object({ status: z.literal("unauthenticated"), ...account }),
    z.object({ status: z.literal("expired"), ...account }),
    z.object({ status: z.literal("error"), ...account, message: z.string() }),
  ]),
});
export type UsageMeasurement = z.infer<typeof usageMeasurementSchema>;
export type UsageWindow = z.infer<typeof usageWindowSchema>;

export const usageListMethod = "provider-usage.v1.listResources";
export const usageFetchMethod = "provider-usage.v1.getResource";
export const usageSourceContract = defineRpcContract({
  [usageListMethod]: {
    input: z.object({}),
    output: z.object({ resources: z.array(z.object({
      id: z.string().min(1),
      accountKey: z.string().min(1).nullable(),
      providerId: z.string().min(1),
      label: z.string().min(1),
      scope: z.object({ kind: z.literal("host"), hostId: z.string().min(1), hostName: z.string().min(1) }),
    })) }),
    experimental_description: "Lists Factory Droid accounts by machine without reading credentials or contacting Factory.",
  },
  [usageFetchMethod]: {
    input: z.object({ resourceId: z.string().min(1), refresh: z.boolean() }),
    output: usageMeasurementSchema,
    experimental_description: "Reads Factory quota for one machine. refresh=false permits a cached measurement; true requests a fresh one.",
  },
});

// Private host RPC: secrets travel only from the plugin server to its worker.
// The public usage RPC never accepts or returns credentials.
export const usageHostContract = defineRpcContract({
  collectUsage: {
    input: z.object({ apiKey: z.string().optional() }),
    output: usageMeasurementSchema,
    experimental_retryable: true,
  },
});
