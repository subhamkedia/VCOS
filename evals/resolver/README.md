# Resolver eval

The Phase 0 gate: **≥95% accuracy on ≥200 hand-labeled real cases, zero false merges.**

`synthetic/` is a 34-case demo built around known hard patterns (suffixes,
typos, rebrands, TLD changes, look-alike names). It proves the harness works.
It does not prove the resolver works, because the same person wrote both.

## The YC 2026 gate set

The gate set is built from Y Combinator's public directory: 200 companies
drawn across the 2026 batches (W26, X26, S26, and F26 once published), in
proportion to batch size, with a seeded hash so the draw is reproducible.

```
pnpm eval:resolver:build-yc                      # fetch, snapshot, build
pnpm eval:resolver --set evals/resolver/yc2026 --gate 0.95
pnpm eval:resolver:build-yc --from-snapshot      # rebuild offline from snapshot.json
```

Needs network access to yc-oss.github.io, www.ycombinator.com and
hn.algolia.com. `yc-gate.ts` explains how cases are made; `SUMMARY.md` in
the output lists counts by kind. In short: 80% of the companies are the
fund's known entities, 20% are held out and must come back NEW; known
companies are mentioned as a website record, a Form D legal name, a founder
intro or a one-letter typo, plus their real Launch HN titles and former
names; real YC companies from other years with look-alike names must come
back NEW. Labels come from YC's identity for each company, not from the
resolver. Spot-check a sample of cases before trusting the score.

## Build a set from your own pipeline

Make `evals/resolver/real/` with two files. Keep it out of git if it holds
anything confidential (`.gitignore` it).

**entities.jsonl** — companies you already know, one per line:

```json
{"key":"acme","name":"Acme Robotics","aliases":["Acme Bots"],"domain":"acmerobotics.com","founders":["Jane Doe"],"location":"Austin, TX"}
```

**cases.jsonl** — mentions as they actually arrived, labeled:

```json
{"name":"ACME Robotics Inc.","location":"Austin","expected":"acme","note":"from YC W26 page"}
{"name":"Acme","expected":"acme","acceptReview":true,"note":"name only in an email"}
{"name":"Acme Energy","domain":"acme-energy.com","expected":"NEW"}
```

- `expected`: the entity key, or `NEW` if it's a company not in entities.jsonl.
- `acceptReview`: sending it to a human is also a right answer.
- `mustReview`: only a human review is right; auto-merging is unsafe even if it guesses correctly.

Where to get 200 cases fast: export your CRM company list as entities; take
the last few months of accelerator cohort pages, Harmonic alerts and inbound
emails as cases; label each against the CRM. Aim for at least 40 `NEW`
cases and 20 look-alike names, since those are where false merges hide.

Run it:

```
pnpm eval:resolver --set evals/resolver/real --gate 0.95
```

When a case fails, fix the cause in `agents/resolver/resolve.ts` (a
normalization gap, a missing comparison), not the label. Tune `LEVELS` only
with a reason you can state.
