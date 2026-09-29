import { describe, it, expect, beforeAll } from "vitest";
import { scopedDb } from "../lib/db.js";
import { testFirm, testRoot } from "./helpers.js";

// Boot the database in a hook (30s limit), not inside the first test (5s).
beforeAll(() => testRoot());
import {
  createEntity, insertEvidence, insertClaim, currentClaims, findByIdentifier, companyProfile, detectContradictions,
} from "../ledger/repository.js";
import {
  acceptInvitations, addMembership, consumeLoginToken, createFirm, createLoginToken, createSession, endSession, firmsOf,
  invite, readSession, removeMember, saveOAuthState, switchFirm, takeOAuthState, team, upsertUser,
} from "../ledger/platform.js";
import { queue, pending } from "../modules/outbox/index.js";

async function twoFirms() {
  const { root, db: a, firm: fa } = await testFirm("Alpha Ventures");
  const fb = await createFirm(root, { name: "Beta Capital" });
  return { root, a, b: scopedDb(root, fb.id), fa, fb };
}

async function seedCompany(db: Awaited<ReturnType<typeof twoFirms>>["a"], headcount: number, scope: "vendor" | "confidential") {
  const e = await createEntity(db, { type: "company", name: "Girderline", source: "test", identifiers: [{ kind: "domain", value: "girderline.example" }] });
  const { evidence } = await insertEvidence(db, { kind: "note", source: "test", content: `headcount ${headcount}`, accessScope: scope });
  await insertClaim(db, { subjectId: e.id, predicate: "team.headcount", value: headcount, evidenceId: evidence.id, sourceType: "third_party", extractedBy: "t" });
  return e;
}

describe("firm isolation", () => {
  it("lets two firms track the same company without seeing each other's data", async () => {
    const { a, b } = await twoFirms();
    const ea = await seedCompany(a, 20, "vendor");
    const eb = await seedCompany(b, 35, "confidential"); // same domain and same evidence text source in both firms
    expect(ea.id).not.toBe(eb.id);
    expect((await findByIdentifier(a, "domain", "girderline.example"))?.id).toBe(ea.id);
    expect((await findByIdentifier(b, "domain", "girderline.example"))?.id).toBe(eb.id);
    expect((await currentClaims(a, ea.id)).map((c) => c.value)).toEqual([20]);
    // Firm B asking for firm A's entity by id sees nothing.
    expect(await currentClaims(b, ea.id)).toEqual([]);
    await expect(companyProfile(b, ea.id)).rejects.toThrow(/No entity/);
    expect((await a.query<{ n: number }>("select count(*)::int as n from claims")).rows[0]!.n).toBe(1);
    expect((await a.query<{ n: number }>("select count(*)::int as n from audit_log")).rows[0]!.n).toBeGreaterThan(0);
    const auditA = await a.query<{ target: string }>("select target from audit_log");
    expect(auditA.rows.map((r) => r.target)).not.toContain(eb.id);
  });

  it("refuses writes into another firm, even with an explicit firm_id", async () => {
    const { a, fb } = await twoFirms();
    await expect(a.query("insert into entities(type, name, firm_id) values ('company', 'Sneaky', $1)", [fb.id])).rejects.toThrow(/row-level security/);
  });

  it("can't attach claims to another firm's entity or evidence", async () => {
    const { a, b } = await twoFirms();
    const ea = await seedCompany(a, 20, "vendor");
    const { evidence } = await insertEvidence(b, { kind: "note", source: "test", content: "x" });
    await expect(insertClaim(b, { subjectId: ea.id, predicate: "team.headcount", value: 1, evidenceId: evidence.id, sourceType: "third_party", extractedBy: "t" })).rejects.toThrow(/No entity/);
    await detectContradictions(a, ea.id);
  });

  it("keeps each firm's outbox to itself", async () => {
    const { a, b } = await twoFirms();
    await queue(a, "gmail_draft", { to: ["x@y.example"], subject: "s", body: "b" }, { summary: "A's draft", proposedBy: "agent:x" });
    expect(await pending(a)).toHaveLength(1);
    expect(await pending(b)).toHaveLength(0);
  });

  it("rejects a malformed firm id before touching the database", () => {
    expect(() => scopedDb({} as never, "1 or 1=1")).toThrow(/Not a firm id/);
  });
});

describe("platform: people, sessions and tokens", () => {
  it("signs a person in to the firms they belong to, and switches between them", async () => {
    const { root, fa, fb } = await twoFirms();
    const u = await upsertUser(root, { email: "Partner@Alpha.example", name: "Pat" });
    expect(u.email).toBe("partner@alpha.example");
    await addMembership(root, fa.id, u.id, "partner");
    const token = await createSession(root, u.id, fa.id);
    expect((await readSession(root, token))?.firm).toMatchObject({ id: fa.id, role: "partner" });
    await expect(switchFirm(root, token, fb.id)).rejects.toThrow(/not a member/);
    await addMembership(root, fb.id, u.id, "analyst");
    await switchFirm(root, token, fb.id);
    expect((await readSession(root, token))?.firm).toMatchObject({ id: fb.id, role: "analyst" });
    expect((await firmsOf(root, u.id)).map((f) => f.name)).toEqual(["Alpha Ventures", "Beta Capital"]);
    await endSession(root, token);
    expect(await readSession(root, token)).toBeNull();
    expect(await readSession(root, "made-up")).toBeNull();
  });

  it("turns invitations into memberships at first sign-in", async () => {
    const { root, fa } = await twoFirms();
    const admin = await upsertUser(root, { email: "admin@alpha.example" });
    await addMembership(root, fa.id, admin.id, "admin");
    await invite(root, fa.id, "Analyst@Alpha.example", "analyst", admin.id);
    expect((await team(root, fa.id)).invited.map((i) => i.email)).toEqual(["analyst@alpha.example"]);
    const newcomer = await upsertUser(root, { email: "analyst@alpha.example" });
    expect(await acceptInvitations(root, newcomer)).toBe(1);
    expect((await team(root, fa.id)).members.map((m) => m.role).sort()).toEqual(["admin", "analyst"]);
    await expect(removeMember(root, fa.id, admin.id)).rejects.toThrow(/at least one admin/);
    await expect(invite(root, fa.id, "not an email", "analyst", admin.id)).rejects.toThrow();
  });

  it("uses sign-in links and OAuth states once", async () => {
    const { root } = await twoFirms();
    const t = await createLoginToken(root, "Someone@Firm.example");
    expect(await consumeLoginToken(root, t)).toBe("someone@firm.example");
    expect(await consumeLoginToken(root, t)).toBeNull();
    const stored = await root.query<{ token_hash: string }>("select token_hash from login_tokens");
    expect(stored.rows[0]!.token_hash).not.toBe(t); // only the hash is kept
    const s = await saveOAuthState(root, { provider: "google", purpose: "signin", codeVerifier: "v" });
    expect((await takeOAuthState(root, s))?.codeVerifier).toBe("v");
    expect(await takeOAuthState(root, s)).toBeNull();
  });

  it("gives firms unique, readable slugs", async () => {
    const { root } = await twoFirms();
    const x = await createFirm(root, { name: "Alpha Ventures" });
    expect(x.slug).toBe("alpha-ventures-2");
  });
});
