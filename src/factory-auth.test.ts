import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, randomBytes } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decryptFactoryLogin, FactoryAuthError, readFactoryCredential } from "./factory-auth.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
async function fixture(file = "auth.v2.file", expired = false) {
  const dir = await mkdtemp(join(tmpdir(), "droid-auth-test-")); directories.push(dir);
  const key = randomBytes(32), iv = randomBytes(16);
  const token = `header.${Buffer.from(JSON.stringify({ email: "user@example.com", exp: expired ? 1 : Date.now() / 1000 + 3600 })).toString("base64url")}.signature`;
  const credentials = { access_token: token, refresh_token: "never-expose-this", active_organization_id: "org-a" };
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const data = Buffer.concat([cipher.update(JSON.stringify(credentials), "utf8"), cipher.final()]);
  const ciphertext = [iv, cipher.getAuthTag(), data].map((part) => part.toString("base64")).join(":");
  await writeFile(join(dir, file), ciphertext);
  if (file === "auth.v2.file") await writeFile(join(dir, "auth.v2.key"), key.toString("base64"));
  return { dir, token, key: key.toString("base64"), ciphertext, credentials };
}

describe("Factory credential storage", () => {
  it("decrypts Factory's AES-256-GCM keyfile format without returning refresh tokens", async () => {
    const f = await fixture();
    expect(JSON.parse(decryptFactoryLogin(f.ciphertext, f.key))).toEqual(f.credentials);
    expect(await readFactoryCredential({ factoryDir: f.dir, platform: "win32" })).toEqual({ token: f.token, email: "user@example.com", organizationId: "org-a" });
  });
  it.each(["auth.v2.loginkeychain", "auth.v2.keyring"])("reads the correct macOS Keychain account for %s", async (file) => {
    const f = await fixture(file);
    const secureKey = vi.fn(async () => f.key);
    await readFactoryCredential({ factoryDir: f.dir, platform: "darwin", secureKey });
    expect(secureKey).toHaveBeenCalledWith(file.endsWith("loginkeychain") ? "auth-encryption-key-security-cli" : "auth-encryption-key", "darwin", undefined);
  });
  it("uses the Linux keyring through the secure-key reader", async () => {
    const f = await fixture("auth.v2.keyring");
    const secureKey = vi.fn(async () => f.key);
    await readFactoryCredential({ factoryDir: f.dir, platform: "linux", secureKey });
    expect(secureKey).toHaveBeenCalledWith("auth-encryption-key", "linux", undefined);
  });
  it("prefers the configured API key without opening the keychain", async () => {
    const f = await fixture("auth.v2.loginkeychain");
    const secureKey = vi.fn();
    expect(await readFactoryCredential({ factoryDir: f.dir, apiKey: " fk-test ", secureKey })).toEqual({ token: "fk-test", email: null, organizationId: null });
    expect(secureKey).not.toHaveBeenCalled();
  });
  it("reports expired saved tokens without refreshing or writing the credential store", async () => {
    const f = await fixture("auth.v2.file", true);
    await expect(readFactoryCredential({ factoryDir: f.dir })).rejects.toMatchObject({ status: "expired" });
  });
  it("reports missing login, and does not mistake the encryption key for credentials", async () => {
    const f = await fixture(); await rm(join(f.dir, "auth.v2.file"));
    await expect(readFactoryCredential({ factoryDir: f.dir })).rejects.toMatchObject({ status: "unauthenticated" });
  });
  it("rejects ciphertext tampering and missing encryption keys", async () => {
    const f = await fixture();
    expect(() => decryptFactoryLogin(f.ciphertext, randomBytes(32).toString("base64"))).toThrow();
    await rm(join(f.dir, "auth.v2.key"));
    await expect(readFactoryCredential({ factoryDir: f.dir })).rejects.toMatchObject({ status: "error" });
  });
  it("honors disabled keyring and falls back to the encrypted keyfile", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "auth.v2.loginkeychain"), "unreadable");
    const secureKey = vi.fn();
    expect((await readFactoryCredential({ factoryDir: f.dir, platform: "darwin", disableKeyring: true, secureKey })).token).toBe(f.token);
    expect(secureKey).not.toHaveBeenCalled();
  });
  it("sanitizes credential-store exceptions", async () => {
    const f = await fixture("auth.v2.loginkeychain");
    const secureKey = async () => { throw new Error("sensitive-child-output"); };
    await expect(readFactoryCredential({ factoryDir: f.dir, platform: "darwin", secureKey })).rejects.toThrow("could not be decrypted");
  });
  it("does not fall back to an older keyfile login when the selected keychain login cannot be read", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "auth.v2.loginkeychain"), "selected-login");
    const secureKey = async () => { throw new FactoryAuthError("error", "Factory's credential store is unavailable."); };
    await expect(readFactoryCredential({ factoryDir: f.dir, platform: "darwin", secureKey })).rejects.toMatchObject({ status: "error", message: "Factory's credential store is unavailable." });
  });
  it("does not fall back to an older keyfile login when the selected keychain login cannot be decrypted", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "auth.v2.keyring"), "selected-login");
    const secureKey = async () => randomBytes(32).toString("base64");
    await expect(readFactoryCredential({ factoryDir: f.dir, platform: "linux", secureKey })).rejects.toThrow("could not be decrypted");
  });
  it("refuses customer-deployment credentials before reading a token or keychain", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "auth-deployment.json"), JSON.stringify({ deployment: { kind: "prem" } }));
    await expect(readFactoryCredential({ factoryDir: f.dir, apiKey: "fk-test" })).rejects.toThrow("Factory-hosted accounts only");
  });
  it("refuses malformed encrypted formats", () => {
    expect(() => decryptFactoryLogin("one:two", "bad")).toThrow();
    expect(new FactoryAuthError("expired", "Expired").status).toBe("expired");
  });
});
