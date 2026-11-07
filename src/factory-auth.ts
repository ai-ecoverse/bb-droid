import { execFile } from "node:child_process";
import { createDecipheriv } from "node:crypto";
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { z } from "zod";

const run = promisify(execFile);
const credentialsSchema = z.object({
  access_token: z.string().min(1),
  active_organization_id: z.string().nullable().optional(),
  whoami: z.object({ isOnPrem: z.boolean().optional() }).passthrough().nullable().optional(),
});
const claimsSchema = z.object({ exp: z.number().optional(), email: z.string().optional() });
export class FactoryAuthError extends Error {
  constructor(readonly status: "unauthenticated" | "expired" | "error", message: string) { super(message); }
}
export interface FactoryCredential {
  token: string;
  email: string | null;
  organizationId: string | null;
}

export function decryptFactoryLogin(ciphertext: string, encodedKey: string): string {
  const parts = ciphertext.trim().split(":");
  const key = Buffer.from(encodedKey.trim(), "base64");
  if (parts.length !== 3 || key.length !== 32) throw new Error("Invalid Factory credential format.");
  const [iv, tag, data] = parts.map((part) => Buffer.from(part, "base64"));
  if (iv.length !== 16 || tag.length !== 16) throw new Error("Invalid Factory credential format.");
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(data), decipher.final()]).toString("utf8");
}

async function optionalFile(path: string): Promise<string | null> {
  try { return await readFile(path, "utf8"); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw new FactoryAuthError("error", "Factory login could not be read on this machine.");
  }
}

export async function readSecureKey(account: string, platform: NodeJS.Platform, signal?: AbortSignal): Promise<string> {
  try {
    if (platform === "darwin") {
      return (await run("/usr/bin/security", ["find-generic-password", "-s", "Factory CLI", "-a", account, "-w"],
        { timeout: 10_000, maxBuffer: 4096, signal })).stdout.trim();
    }
    if (platform === "linux") {
      return (await run("/usr/bin/secret-tool", ["lookup", "service", "Factory CLI", "account", account],
        { timeout: 10_000, maxBuffer: 4096, signal })).stdout.trim();
    }
  } catch { /* Do not propagate child output or raw credential-store errors. */ }
  throw new FactoryAuthError("error", "Factory's credential store is unavailable. Unlock it, or use the Factory API key plugin setting. Linux keyrings require secret-tool.");
}

export async function readFactoryCredential(options: {
  apiKey?: string;
  factoryDir?: string;
  platform?: NodeJS.Platform;
  disableKeyring?: boolean;
  signal?: AbortSignal;
  secureKey?: typeof readSecureKey;
} = {}): Promise<FactoryCredential> {
  const dir = options.factoryDir ?? join(homedir(), ".factory");
  // Hosted billing only. Never send a customer-deployment token to the hosted
  // Factory endpoint, even when its JWT happens to have a familiar shape.
  const deployment = await optionalFile(join(dir, "auth-deployment.json"));
  if (deployment !== null) {
    try {
      const parsed = z.object({ deployment: z.object({ kind: z.literal("factory") }) }).safeParse(JSON.parse(deployment));
      if (!parsed.success) throw new Error();
    } catch { throw new FactoryAuthError("error", "Usage collection supports Factory-hosted accounts only."); }
  }
  const apiKey = options.apiKey?.trim();
  if (apiKey) return { token: apiKey, email: null, organizationId: null };

  const platform = options.platform ?? process.platform;
  const secureKey = options.secureKey ?? readSecureKey;
  const candidates = options.disableKeyring ? [] : platform === "darwin"
    ? [["auth.v2.loginkeychain", "auth-encryption-key-security-cli"], ["auth.v2.keyring", "auth-encryption-key"]]
    : [["auth.v2.keyring", "auth-encryption-key"]];
  candidates.push(["auth.v2.file", ""]);
  for (const [file, account] of candidates) {
    const ciphertext = await optionalFile(join(dir, file));
    if (ciphertext === null) continue;
    try {
      const key = account
        ? await secureKey(account, platform, options.signal)
        : await optionalFile(join(dir, "auth.v2.key"));
      if (key === null) throw new Error();
      const credentials = credentialsSchema.parse(JSON.parse(decryptFactoryLogin(ciphertext, key)));
      if (credentials.whoami?.isOnPrem) throw new FactoryAuthError("error", "Usage collection supports Factory-hosted accounts only.");
      let email: string | null = null;
      try {
        const claims = claimsSchema.parse(JSON.parse(Buffer.from(credentials.access_token.split(".")[1], "base64url").toString("utf8")));
        if (claims.exp !== undefined && claims.exp * 1000 <= Date.now()) {
          throw new FactoryAuthError("expired", "Factory login expired. Open Droid to refresh it.");
        }
        email = claims.email ?? null;
      } catch (error) {
        if (error instanceof FactoryAuthError) throw error;
        // Opaque access tokens are validated by Factory rather than guessed.
      }
      return { token: credentials.access_token, email, organizationId: credentials.active_organization_id ?? null };
    } catch (error) {
      // The first login file that exists is the selected login. A failure must
      // not silently switch to an older account's leftover file.
      if (error instanceof FactoryAuthError) throw error;
      throw new FactoryAuthError("error", "Factory login could not be decrypted. Open Droid to repair the login.");
    }
  }
  throw new FactoryAuthError("unauthenticated", "Sign in with Droid or configure a Factory API key.");
}
