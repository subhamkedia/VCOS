import { describe, it, expect, beforeAll, beforeEach, afterEach } from "vitest";
import { randomBytes } from "node:crypto";
import { scopedDb, type Db } from "../lib/db.js";
import { config, requireKey, setting, withCredentials } from "../lib/config.js";
import { decrypt, encrypt, setSecretKeyForTests } from "../lib/secrets.js";
import { testFirm } from "./helpers.js";
import { createFirm } from "../ledger/platform.js";
import { catalog, connectWithKeys, connectWithOAuth, disconnect, enable, isReady, withFirmCredentials } from "../modules/connections/index.js";
import { accessToken, clearTokenCache, authorizeUrl, pkcePair } from "../connectors/oauth.js";

beforeAll(() => setSecretKeyForTests(randomBytes(32)));

let a: Db;
let b: Db;
let root: Db;
beforeEach(async () => {
  const t = await testFirm("Alpha Ventures");
  root = t.root;
  a = t.db;
  b = scopedDb(root, (await createFirm(root, { name: "Beta Capital" })).id);
  clearTokenCache();
  config.harmonicApiKey = "OPERATOR-ENV-KEY";
  config.googleClientId = "app-client";
  config.googleClientSecret = "app-secret";
});
afterEach(() => {
  config.harmonicApiKey = "";
});

describe("secrets", () => {
  it("round-trips, and tampering is detected", () => {
    const c = encrypt("sk-live-123");
    expect(c).not.toContain("sk-live-123");
    expect(decrypt(c)).toBe("sk-live-123");
    const parts = c.split(":");
    parts[3] = Buffer.from("forged").toString("base64");
    expect(() => decrypt(parts.join(":"))).toThrow();
  });
});

describe("credential scope", () => {
  it("never lends the operator's vendor keys to a firm", async () => {
    expect(setting("harmonicApiKey")).toBe("OPERATOR-ENV-KEY"); // the local CLI still uses .env
    await withCredentials({}, async () => {
      expect(setting("harmonicApiKey")).toBe("");
      expect(() => requireKey("harmonicApiKey")).toThrow(/Connect it under Connections/);
      expect(setting("googleClientId")).toBe("app-client"); // platform key
    });
  });
});

describe("connections", () => {
  it("stores API keys encrypted and never returns them", async () => {
    const r = await connectWithKeys(a, "harmonic", { harmonicApiKey: "hm-alpha-secret" }, "human:pat");
    expect(r.ok).toBe(true); // Harmonic has no test call
    const raw = await root.query<{ credentials: string }>("select credentials from connections");
    expect(raw.rows[0]!.credentials).not.toContain("hm-alpha-secret");
    const entry = (await catalog(a)).find((c) => c.id === "harmonic")!;
    expect(entry.status).toBe("connected");
    expect(JSON.stringify(await catalog(a))).not.toContain("hm-alpha-secret");
    await expect(connectWithKeys(a, "harmonic", {}, "human:pat")).rejects.toThrow(/required/);
  });

  it("gives each firm only its own keys", async () => {
    await connectWithKeys(a, "harmonic", { harmonicApiKey: "hm-alpha" }, "human:pat");
    expect(await withFirmCredentials(a, ["harmonic"], async () => setting("harmonicApiKey"))).toBe("hm-alpha");
    expect(await withFirmCredentials(b, ["harmonic"], async () => setting("harmonicApiKey"))).toBe("");
    expect(await isReady(a, "harmonic")).toBe(true);
    expect(await isReady(b, "harmonic")).toBe(false);
    expect((await catalog(b)).find((c) => c.id === "harmonic")?.status).toBe("not_configured");
  });

  it("forgets credentials on disconnect", async () => {
    await connectWithKeys(a, "harmonic", { harmonicApiKey: "hm-alpha" }, "human:pat");
    await disconnect(a, "harmonic", "human:pat");
    expect(await isReady(a, "harmonic")).toBe(false);
    expect((await root.query<{ credentials: string | null }>("select credentials from connections")).rows[0]!.credentials).toBeNull();
  });

  it("marks no-key sources as in use", async () => {
    expect((await catalog(a)).find((c) => c.id === "yc")?.status).toBe("available");
    await enable(a, "docsend", "human:pat");
    expect((await catalog(a)).find((c) => c.id === "docsend")?.status).toBe("connected");
    await expect(enable(a, "harmonic", "human:pat")).rejects.toThrow(/needs credentials/);
  });

  it("stores an OAuth refresh token and uses it for that firm's calls only", async () => {
    const calls: string[] = [];
    const fetchImpl = async (_url: string, init?: RequestInit) => {
      calls.push(new URLSearchParams(String(init?.body)).get("refresh_token") ?? "");
      return new Response(JSON.stringify({ access_token: `at-${calls.length}`, expires_in: 3600 }));
    };
    // Test calls fail (no network in tests) and are recorded as errors; the token is still saved.
    await connectWithOAuth(a, "gmail", "rt-alpha", "partner@alpha.example", "human:pat").catch(() => undefined);
    await connectWithOAuth(b, "gmail", "rt-beta", "gp@beta.example", "human:sam").catch(() => undefined);
    const ta = await withFirmCredentials(a, ["gmail"], () => accessToken("google", fetchImpl));
    const tb = await withFirmCredentials(b, ["gmail"], () => accessToken("google", fetchImpl));
    expect(calls).toEqual(["rt-alpha", "rt-beta"]);
    expect(ta).not.toBe(tb);
    await withFirmCredentials(a, ["gmail"], () => accessToken("google", fetchImpl));
    expect(calls).toHaveLength(2); // cached per refresh token
    expect((await catalog(a)).find((c) => c.id === "gmail")?.accountLabel).toBeTruthy();
  });

  it("saves a refresh token the provider rotated, for that firm only", async () => {
    await connectWithOAuth(a, "zoom", "zr-1", "pat@alpha.example", "human:pat").catch(() => undefined);
    await connectWithOAuth(b, "zoom", "zr-beta", "sam@beta.example", "human:sam").catch(() => undefined);
    Object.assign(config, { zoomClientId: "zid", zoomClientSecret: "zsec" });
    const rotating = async () => new Response(JSON.stringify({ access_token: "zat", expires_in: 3600, refresh_token: "zr-2" }));
    await withFirmCredentials(a, ["zoom"], () => accessToken("zoom", rotating));
    expect(await withFirmCredentials(a, ["zoom"], async () => setting("zoomRefreshToken"))).toBe("zr-2");
    expect(await withFirmCredentials(b, ["zoom"], async () => setting("zoomRefreshToken"))).toBe("zr-beta");
  });

  it("builds a PKCE consent URL that asks for offline access", () => {
    const { challenge } = pkcePair();
    const u = new URL(authorizeUrl("google", { scopes: ["openid", "email"], state: "s1", challenge, redirectUri: "https://app.example/cb", offline: true }));
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("access_type")).toBe("offline");
    expect(u.searchParams.get("client_id")).toBe("app-client");
  });
});
