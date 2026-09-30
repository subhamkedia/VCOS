import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { EXECUTION_LABELS, EXIT_LABELS, OUTBOX_LABELS, PORTFOLIO_LABELS, vocabulary } from "../ledger/labels.js";

// Every value the database allows gets a label, so a person never sees an
// identifier like `escrow_release`. The allowed values are read from the
// migrations themselves: add one there and this fails until it has a label.

const sql = (file: string) => readFileSync(new URL(`../db/migrations/${file}`, import.meta.url), "utf8");
function allowed(file: string, anchor: RegExp): string[] {
  const text = sql(file);
  const at = text.search(anchor);
  if (at < 0) throw new Error(`${anchor} not found in ${file}`);
  const list = /in\s*\(([^)]*)\)/.exec(text.slice(at))![1]!;
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
}

describe("labels", () => {
  it.each([
    ["realization kinds", allowed("0012_exits.sql", /realizations_kind_check check/), EXIT_LABELS.realizationKinds],
    ["term sheet statuses", allowed("0007_execution.sql", /status\s+text not null default 'draft' check \(status in \('draft', 'proposed'/), EXECUTION_LABELS.termStatus],
    ["request statuses", allowed("0008_portfolio.sql", /check \(status in \('open', 'received'/), PORTFOLIO_LABELS.requestStatus],
    ["board meeting kinds", allowed("0008_portfolio.sql", /check \(kind in \('regular'/), PORTFOLIO_LABELS.boardKinds],
    ["value-creation kinds", allowed("0008_portfolio.sql", /check \(kind in \('hiring'/), PORTFOLIO_LABELS.helpKinds],
  ])("labels every %s", (_name, values, labels) => {
    expect(values.length).toBeGreaterThan(2);
    expect(values.filter((v) => !labels[v])).toEqual([]);
  });

  it("labels every approval channel and serves the module groups in the vocabulary", () => {
    for (const c of ["affinity_note", "gmail_draft", "outlook_draft", "docusign_draft"]) {
      expect(OUTBOX_LABELS.channels[c]).toBeTruthy();
      expect(OUTBOX_LABELS.approve[c]).toMatch(/^Approve/);
    }
    const v = vocabulary();
    expect(Object.keys(v)).toEqual(expect.arrayContaining(["portfolio", "execution", "meetings", "exits", "outbox"]));
  });
});
