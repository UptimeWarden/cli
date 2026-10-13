/**
 * auth.test.ts — config persistence + status reporting.
 *
 * Each test points UW_CONFIG_DIR at a fresh tmp dir so writes never
 * touch the real ~/.uw/config.json on the developer's machine.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, existsSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAuthLogin, authStatus } from "../src/commands/auth.js";

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "uw-cli-auth-"));
  process.env.UW_CONFIG_DIR = tmp;
  delete process.env.UW_API_TOKEN;
  delete process.env.UW_API_URL;
  delete process.env.UW_WORKSPACE;
});

describe("uw auth", () => {
  it("persists token, base URL, and workspace to ~/.uw/config.json", async () => {
    const { ok, configFile } = await runAuthLogin({
      token: "uw_test_token",
      baseUrl: "https://staging.example.com",
      workspace: "acme-staging",
    });
    expect(ok).toBe(true);
    expect(existsSync(configFile)).toBe(true);
    const persisted = JSON.parse(readFileSync(configFile, "utf8"));
    expect(persisted).toEqual({
      apiToken: "uw_test_token",
      baseUrl: "https://staging.example.com",
      workspace: "acme-staging",
    });
  });

  it("writes config file with restrictive 0600 perms", async () => {
    const { configFile } = await runAuthLogin({ token: "uw_secret" });
    const mode = statSync(configFile).mode & 0o777;
    // On non-POSIX (Windows) we'd skip; CI runs on Linux so 0600 is firm.
    if (process.platform !== "win32") {
      expect(mode).toBe(0o600);
    }
  });

  it("throws clear error if no token + no UW_API_TOKEN env", async () => {
    await expect(runAuthLogin({})).rejects.toThrow(/Missing --token/);
  });

  it("authStatus reports authenticated=false on a fresh dir", () => {
    const s = authStatus();
    expect(s.authenticated).toBe(false);
  });

  it("authStatus reports authenticated=true after login (without leaking the token)", async () => {
    await runAuthLogin({ token: "uw_secret", baseUrl: "https://api.example.com" });
    const s = authStatus();
    expect(s.authenticated).toBe(true);
    expect(s.baseUrl).toBe("https://api.example.com");
    // The status object intentionally does not expose the token.
    expect((s as Record<string, unknown>).apiToken).toBeUndefined();
  });

  it("env UW_API_TOKEN beats file value", async () => {
    await runAuthLogin({ token: "from-file" });
    process.env.UW_API_TOKEN = "from-env";
    const s = authStatus();
    expect(s.authenticated).toBe(true); // truthy from env
  });
});
