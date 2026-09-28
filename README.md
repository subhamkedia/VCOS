# VC OS

An AI-native operating system for a venture fund. Every fact about a company
is stored once as a **claim**, with its source, date, confidence and the exact
characters it came from. Sourcing scores, diligence flags, IC memos and LP
letters are all queries over that ledger.

This is **Phase 0: the foundation.** The ledger, the entity resolver, the
cited-claim extractor, the first connectors and the eval harness that gates
Phase 1.

## Try it in two minutes

```bash
pnpm install
pnpm demo        # offline walk-through on fictional data, no keys needed
pnpm test        # 46 tests on in-process Postgres
```

The demo ingests a company from Harmonic, an SEC Form D, a press article and
a founder call. It resolves all four to one entity and prints every claim
with its source. It flags that the founder says 34 people while Harmonic said
21 twelve days earlier. Add `ANTHROPIC_API_KEY` to `.env` and the demo uses
live Claude for extraction instead of scripted replies.

## Use it on real companies

```bash
cp .env.example .env            # add the keys you have
pnpm db:migrate                 # local PGlite in .data/, or Postgres via DATABASE_URL

pnpm ingest harmonic acme.com --dry-run          # check the mapping first
pnpm ingest harmonic acme.com
pnpm ingest formd "Acme Robotics" --from 2025-01-01
pnpm ingest web https://acme.com/about --company "Acme Robotics" --domain acme.com
pnpm ingest transcript ~/Downloads/acme-call.vtt --company "Acme Robotics" --domain acme.com --date 2026-10-02
pnpm ingest granola <meeting-id> --company "Acme Robotics"

pnpm show acme.com              # everything the ledger knows, with sources and open contradictions
pnpm resolve                    # merge proposals waiting for you
pnpm resolve accept <id>
```

For production, `docker compose up -d` and set
`DATABASE_URL=postgres://vcos:vcos@localhost:5432/vcos`.

## What's here

| Path | What it does |
| --- | --- |
| `db/migrations/0001_ledger.sql` | Entities, identifiers, aliases, relations, evidence, claims, contradictions, merge proposals, decisions, audit log. Evidence and claims are append-only, enforced by triggers. |
| `ledger/predicates.ts` | The controlled vocabulary: 40 predicates with kind, unit, cardinality, tolerance and comparison window. Includes the pilot ladder (conversation → unpaid trial → paid pilot → production contract → expansion). |
| `ledger/repository.ts` | The only code that writes to the ledger. Validates every claim, checks cited spans against the evidence, inherits access scope. |
| `ledger/contradictions.ts` | Finds claims that can't both be true. A self-reported number far from an independent source is high severity. |
| `agents/resolver/` | Entity resolution: hard identifiers first, then Fellegi-Sunter scoring on name, domain, founders and city. Ambiguous cases become merge proposals; Claude can suggest a pick, a human accepts. |
| `agents/extractor/` | Claim extraction with the Claude Citations API. Every claim carries the exact quote and character offsets. Lines without a valid citation are rejected. |
| `connectors/` | Harmonic, SEC EDGAR Form D, web pages, transcripts (files or Granola MCP). All flow through one `ingest()` pipeline. |
| `evals/resolver/` | Resolver eval and the Phase 0 gate. |
| `evals/extraction/` | Extraction eval: precision, recall, citation validity, pass^k. |
| `CLAUDE.md` | Rules for Claude Code in this repo. Read it before changing anything. |

## The Phase 0 gate

```bash
pnpm eval:resolver --set evals/resolver/real --gate 0.95
```

Pass requires ≥95% accuracy on ≥200 hand-labeled real names from your own
pipeline, with zero false merges. The bundled synthetic set scores 100%, but
it was written alongside the resolver, so treat it as a smoke test.
`evals/resolver/README.md` explains how to build the real set in an
afternoon.

## Known limits in Phase 0

- The Harmonic field mapping follows their documented response but hasn't
  been run against a live key. Run `--dry-run` once before trusting it.
- Granola tool names come from Granola's docs. `pnpm ingest granola-tools`
  lists the live ones; pass `--tool` if they differ.
- Resolver weights are hand-set. Re-estimate them from labeled pairs once
  you have a few thousand, or move batch dedupe to Splink (same model).
- Web pages rendered by JavaScript come back nearly empty. A headless-browser
  fetcher is a Phase 1 task.
- No UI yet. Phase 1 adds the diligence board.
