import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveConfig } from "../src/lib/config.js";

describe("resolveConfig base URL", () => {
  const saved = { api: process.env.UW_API_URL, base: process.env.UW_BASE_URL };
  beforeEach(() => {
    process.env.UW_CONFIG_DIR = mkdtempSync(join(tmpdir(), "uw-cli-env-"));
    delete process.env.UW_API_URL;
    delete process.env.UW_BASE_URL;
  });
  afterEach(() => {
    if (saved.api === undefined) delete process.env.UW_API_URL; else process.env.UW_API_URL = saved.api;
    if (saved.base === undefined) delete process.env.UW_BASE_URL; else process.env.UW_BASE_URL = saved.base;
  });

  it("defaults to production", () => {
    expect(resolveConfig().baseUrl).toBe("https://app.uptimewarden.online");
  });
  it("reads UW_API_URL", () => {
    process.env.UW_API_URL = "https://a.example";
    expect(resolveConfig().baseUrl).toBe("https://a.example");
  });
  it("reads UW_BASE_URL as an alias", () => {
    process.env.UW_BASE_URL = "https://b.example";
    expect(resolveConfig().baseUrl).toBe("https://b.example");
  });
  it("UW_API_URL wins over the alias", () => {
    process.env.UW_API_URL = "https://a.example";
    process.env.UW_BASE_URL = "https://b.example";
    expect(resolveConfig().baseUrl).toBe("https://a.example");
  });
});
