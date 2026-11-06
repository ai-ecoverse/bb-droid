import { describe, expect, it, vi } from "vitest";
import { FactoryAuthError } from "./factory-auth.js";
import { collectFactoryUsage, normalizeFactoryLimits } from "./factory-usage.js";
import { usageMeasurementSchema } from "./usage-contract.js";

const window = { usedPercent: 43, windowEnd: "2026-11-12T15:26:11.096Z" };
const body = { limits: {
  standard: { fiveHour: { ...window, usedPercent: 98 }, weekly: window, monthly: { ...window, usedPercent: 25 } },
  core: { fiveHour: { usedPercent: 0, windowEnd: null }, weekly: { usedPercent: 0, windowEnd: null }, monthly: { usedPercent: 0, windowEnd: null } },
} };
const credential = { token: "sensitive-token", email: "user@example.com", organizationId: "org-a" };
const readCredential = async () => credential;
function api(response: Response = Response.json(body)) {
  return vi.fn<typeof fetch>().mockResolvedValueOnce(response).mockResolvedValue(Response.json({ userId: "user-a", orgId: "org-a" }));
}

describe("Factory account quota", () => {
  it("maps Standard and Core 5h, weekly, monthly limits, including inactive windows", () => {
    const windows = normalizeFactoryLimits(body);
    expect(windows).toHaveLength(6);
    expect(windows.map((w) => w.id)).toEqual(["standard:fiveHour", "standard:weekly", "standard:monthly", "core:fiveHour", "core:weekly", "core:monthly"]);
    expect(windows[2]).toMatchObject({ kind: "custom", label: "Monthly · Standard", usedPercent: 25 });
    expect(windows[3]).toMatchObject({ resetsAt: null, usedPercent: 0, model: "core" });
  });
  it("preserves overage and tolerates absent optional pools and windows", () => {
    expect(normalizeFactoryLimits({ limits: { standard: { weekly: { ...window, usedPercent: 120 } } } })).toHaveLength(1);
    expect(normalizeFactoryLimits({ limits: { standard: { weekly: { ...window, usedPercent: 120 } } } })[0].usedPercent).toBe(120);
  });
  it("fetches only hosted endpoints, forwards organization scope, and returns no credential material", async () => {
    const fetch = api();
    const value = usageMeasurementSchema.parse(await collectFactoryUsage({ readCredential, fetch }));
    expect(value).toMatchObject({ accountKey: "factory:organization:org-a:user:user-a", usage: { status: "ok", accountEmail: "user@example.com", plan: null } });
    expect(fetch).toHaveBeenNthCalledWith(1, "https://api.factory.ai/api/billing/limits", expect.objectContaining({ redirect: "error", headers: { Authorization: "Bearer sensitive-token", Accept: "application/json", "x-factory-org-id": "org-a" } }));
    expect(JSON.stringify(value)).not.toContain(credential.token);
  });
  it.each([401, 403, 429, 500])("handles HTTP %s without using response bodies as messages", async (status) => {
    const fetch = api(new Response("secret-error-body", { status }));
    const value = await collectFactoryUsage({ readCredential, fetch });
    expect(value.usage.status).toBe(status === 401 ? "expired" : "error");
    expect(JSON.stringify(value)).not.toContain("secret-error-body");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it.each(["unauthenticated", "expired", "error"] as const)("does not contact Factory when auth is %s", async (status) => {
    const fetch = api();
    const readCredential = async () => { throw new FactoryAuthError(status, "Known safe message"); };
    expect((await collectFactoryUsage({ readCredential, fetch })).usage.status).toBe(status);
    expect(fetch).not.toHaveBeenCalled();
  });
  it.each([{}, { limits: {} }, { limits: { standard: { weekly: { usedPercent: -1, windowEnd: null } } } }, { limits: { standard: { weekly: { ...window, windowEnd: "invalid" } } } }])("rejects unsupported or malformed billing responses", async (value) => {
    expect((await collectFactoryUsage({ readCredential, fetch: api(Response.json(value)) })).usage.status).toBe("error");
  });
  it("keeps quota when identity cannot be resolved, and never substitutes email as the identity", async () => {
    const fetch = api(); fetch.mockReset().mockResolvedValueOnce(Response.json(body)).mockResolvedValueOnce(new Response("denied", { status: 403 }));
    expect(await collectFactoryUsage({ readCredential, fetch })).toMatchObject({ accountKey: null, usage: { status: "ok" } });
  });
  it("sanitizes network exceptions", async () => {
    const fetch = api(); fetch.mockReset().mockRejectedValue(new Error(credential.token));
    const value = await collectFactoryUsage({ readCredential, fetch });
    expect(value.usage.status).toBe("error");
    expect(JSON.stringify(value)).not.toContain(credential.token);
  });
  it("propagates caller cancellation to the fetch signal", async () => {
    const controller = new AbortController(); controller.abort();
    const fetch = vi.fn<typeof globalThis.fetch>(async (_url, init) => { expect(init?.signal?.aborted).toBe(true); throw new Error("aborted"); });
    await collectFactoryUsage({ readCredential, fetch, signal: controller.signal });
  });
});
