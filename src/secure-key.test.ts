import { beforeEach, describe, expect, it, vi } from "vitest";

const execFileAsync = vi.hoisted(() => vi.fn());
vi.mock("node:child_process", async () => {
  const { promisify } = await import("node:util");
  const execFile = Object.assign(vi.fn(), { [promisify.custom]: execFileAsync });
  return { execFile };
});

import { FactoryAuthError, readSecureKey } from "./factory-auth.js";

beforeEach(() => { execFileAsync.mockReset(); });

describe("readSecureKey", () => {
  it("asks the absolute macOS security command for the account", async () => {
    execFileAsync.mockResolvedValue({ stdout: "key\n", stderr: "" });
    expect(await readSecureKey("auth-encryption-key", "darwin")).toBe("key");
    expect(execFileAsync).toHaveBeenCalledWith("/usr/bin/security",
      ["find-generic-password", "-s", "Factory CLI", "-a", "auth-encryption-key", "-w"],
      expect.objectContaining({ timeout: 10_000, maxBuffer: 4096 }));
  });
  it("asks the absolute secret-tool command, never one resolved from PATH", async () => {
    execFileAsync.mockResolvedValue({ stdout: "key\n", stderr: "" });
    expect(await readSecureKey("auth-encryption-key", "linux")).toBe("key");
    expect(execFileAsync).toHaveBeenCalledWith("/usr/bin/secret-tool",
      ["lookup", "service", "Factory CLI", "account", "auth-encryption-key"],
      expect.objectContaining({ timeout: 10_000, maxBuffer: 4096 }));
  });
  it.each(["darwin", "linux"] as const)("replaces child output and raw errors with a fixed message on %s", async (platform) => {
    execFileAsync.mockRejectedValue(Object.assign(new Error("stderr: leaked-secret"), { stdout: "leaked-secret", stderr: "leaked-secret" }));
    const error = await readSecureKey("auth-encryption-key", platform).catch((caught) => caught);
    expect(error).toBeInstanceOf(FactoryAuthError);
    expect(error).toMatchObject({ status: "error" });
    expect(error.message).toContain("credential store is unavailable");
    expect(JSON.stringify([error.message, error.status])).not.toContain("leaked-secret");
  });
  it("has no credential store on other platforms", async () => {
    await expect(readSecureKey("auth-encryption-key", "win32")).rejects.toMatchObject({ status: "error" });
    expect(execFileAsync).not.toHaveBeenCalled();
  });
});
