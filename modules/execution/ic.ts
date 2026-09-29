/**
 * Investment committee votes. Principle 5: judgment is data, so every
 * member's vote is recorded twice, before discussion (independent, not
 * shown to anyone until the chair opens discussion, so no one anchors on
 * the senior partner) and after it. The shift between the two is itself
 * worth reviewing later.
 *
 * Approval rules (set in the firm profile):
 * - majority: more yes than no among votes cast;
 * - supermajority: at least two thirds of votes cast are yes;
 * - unanimous: every member who isn't recused votes yes;
 * - champion: one member votes yes with full conviction (5 of 5) and no
 *   one votes no with full conviction. Malenko, Nanda, Rhodes-Kropf and
 *   Sundaresan (HBS working paper 21-131) find early-stage VCs use a
 *   champion rule to "catch outliers" that a majority would reject;
 * - managing_partner: the chair's vote decides.
 * A quorum is more than half the members not recused, voting.
 */

export type Vote = "yes" | "no" | "abstain" | "recused";
export type Rule = "unanimous" | "supermajority" | "majority" | "champion" | "managing_partner";

export const RULE_LABELS: Record<Rule, string> = {
  unanimous: "Unanimous", supermajority: "Supermajority (two thirds)", majority: "Simple majority",
  champion: "One champion with full conviction, no veto", managing_partner: "Managing partner decides",
};

export interface Ballot {
  member: string;
  vote: Vote;
  conviction?: number;
}

export interface Tally {
  outcome: "approved" | "declined" | "no_quorum";
  yes: number;
  no: number;
  abstain: number;
  recused: number;
  notVoted: string[];
  detail: string;
}

/** The outcome of a set of ballots under a rule. Pure. */
export function tally(rule: Rule, members: string[], ballots: Ballot[], chair?: string): Tally {
  const latest = new Map<string, Ballot>();
  for (const b of ballots) if (members.includes(b.member)) latest.set(b.member, b);
  const all = [...latest.values()];
  const count = (v: Vote) => all.filter((b) => b.vote === v).length;
  const yes = count("yes");
  const no = count("no");
  const abstain = count("abstain");
  const recused = count("recused");
  const eligible = members.length - recused;
  const voted = yes + no + abstain;
  const notVoted = members.filter((m) => !latest.has(m));
  const base = { yes, no, abstain, recused, notVoted };
  if (eligible <= 0) return { ...base, outcome: "no_quorum", detail: "Every member is recused." };
  if (voted * 2 <= eligible) return { ...base, outcome: "no_quorum", detail: `Only ${voted} of ${eligible} eligible members voted; a quorum is more than half.` };
  let approved: boolean;
  let why: string;
  switch (rule) {
    case "unanimous":
      approved = yes === eligible;
      why = approved ? "Every eligible member voted yes." : `Unanimity needs all ${eligible} eligible members to vote yes; ${yes} did.`;
      break;
    case "supermajority":
      approved = yes + no > 0 && yes * 3 >= (yes + no) * 2;
      why = `${yes} yes of ${yes + no} votes cast; two thirds needed.`;
      break;
    case "champion": {
      const champion = all.find((b) => b.vote === "yes" && (b.conviction ?? 0) >= 5);
      const veto = all.find((b) => b.vote === "no" && (b.conviction ?? 0) >= 5);
      approved = Boolean(champion) && !veto;
      why = veto ? `${veto.member.replace(/^human:/, "")} voted no with full conviction (a veto).` : champion ? `${champion.member.replace(/^human:/, "")} champions it with full conviction.` : "No member voted yes with full conviction.";
      break;
    }
    case "managing_partner": {
      const mp = chair ? latest.get(chair) : undefined;
      approved = mp?.vote === "yes";
      why = mp ? `The managing partner voted ${mp.vote}.` : "The managing partner hasn't voted.";
      if (!mp) return { ...base, outcome: "no_quorum", detail: why };
      break;
    }
    default:
      approved = yes > no;
      why = `${yes} yes, ${no} no.`;
  }
  return { ...base, outcome: approved ? "approved" : "declined", detail: why };
}

/** How votes moved between before and after discussion. Pure. */
export function shifts(pre: Ballot[], post: Ballot[]): { member: string; from: Vote; to: Vote; conviction: [number | undefined, number | undefined] }[] {
  const before = new Map(pre.map((b) => [b.member, b]));
  return post.flatMap((b) => {
    const a = before.get(b.member);
    if (!a || (a.vote === b.vote && a.conviction === b.conviction)) return [];
    return [{ member: b.member, from: a.vote, to: b.vote, conviction: [a.conviction, b.conviction] as [number | undefined, number | undefined] }];
  });
}
