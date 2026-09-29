import type { TermSheet } from "./terms.js";

/**
 * The closing checklist: the conditions and deliverables of the stock
 * purchase agreement (or SAFE), the firm's own compliance steps, and the
 * funding controls. Items depend on the security, the deal's flags and the
 * fund's LPs.
 *
 * Sources: the NVCA model SPA's conditions to closing and document set
 * (charter, IRA, voting agreement, ROFR and co-sale, management rights
 * letter); SEC Rule 503 (Form D within 15 days of the first sale, filed by
 * the company); ERISA's VCOC exemption (management rights letters);
 * Treasury's Outbound Investment Security Program (a notification within
 * 30 days of a notifiable transaction); OFAC sanctions screening; and the
 * FBI's guidance on business email compromise (confirm wire instructions
 * by calling a known number; two people approve).
 */

export type ClosingCategory = "documents" | "approvals" | "compliance" | "funding" | "after";

export const CATEGORY_LABELS: Record<ClosingCategory, string> = {
  documents: "Documents", approvals: "Approvals and filings", compliance: "Compliance and screening", funding: "Funding", after: "After closing",
};

export interface ClosingTemplateItem {
  key: string;
  category: ClosingCategory;
  title: string;
  required: boolean;
}

export function closingTemplate(t: Pick<TermSheet, "security" | "managementRightsLetter" | "board" | "oispRepresentation" | "tranched"> & { mfn?: boolean }, o: {
  sensitiveTech?: boolean;
  erisaLps?: boolean;
  hasProRataSideLetter?: boolean;
}): ClosingTemplateItem[] {
  const priced = t.security === "preferred";
  const note = t.security === "note";
  const items: ClosingTemplateItem[] = [
    { key: "term_sheet_signed", category: "documents", title: "Term sheet signed", required: priced },
    { key: "counsel_engaged", category: "documents", title: "Investor counsel engaged (or waived for small checks)", required: false },
    { key: "confirmatory_diligence", category: "documents", title: "Confirmatory legal diligence complete", required: priced },
  ];
  if (priced) {
    items.push(
      { key: "spa", category: "documents", title: "Stock purchase agreement, with disclosure schedule reviewed", required: true },
      { key: "charter", category: "documents", title: "Amended and restated certificate of incorporation", required: true },
      { key: "ira", category: "documents", title: "Investors' rights agreement", required: true },
      { key: "voting_agreement", category: "documents", title: "Voting agreement", required: true },
      { key: "rofr_cosale", category: "documents", title: "Right of first refusal and co-sale agreement", required: true },
      { key: "compliance_certificate", category: "documents", title: "Officer's compliance certificate", required: false },
      { key: "legal_opinion", category: "documents", title: "Company counsel's legal opinion", required: false },
      { key: "board_consent", category: "approvals", title: "Board consent approving the financing", required: true },
      { key: "stockholder_consent", category: "approvals", title: "Stockholder consent approving the new charter", required: true },
      { key: "charter_filed", category: "approvals", title: "Charter filed with the Delaware Secretary of State (or the company's state)", required: true },
      { key: "cap_table_certified", category: "documents", title: "Capitalization table certified by the company, matching the pro forma", required: true },
    );
  } else {
    items.push(
      { key: "safe_or_note", category: "documents", title: note ? "Convertible note purchase agreement and note" : "SAFE", required: true },
      { key: "board_consent", category: "approvals", title: "Board consent approving the issuance", required: true },
    );
    if (o.hasProRataSideLetter !== false) items.push({ key: "pro_rata_letter", category: "documents", title: "Pro rata side letter", required: false });
  }
  if (t.managementRightsLetter || o.erisaLps) {
    items.push({ key: "management_rights_letter", category: "documents", title: "Management rights letter (keeps the fund's VCOC status for ERISA investors)", required: Boolean(o.erisaLps) });
  }
  if (t.board?.ours === "seat") items.push({ key: "board_onboarding", category: "after", title: "Board seat: indemnification agreement and D&O insurance confirmed", required: false });
  if (t.tranched) items.push({ key: "tranche_milestones", category: "funding", title: "Tranche milestones and later closing dates recorded", required: true });
  items.push(
    { key: "sanctions", category: "compliance", title: "Sanctions screening: company, founders and co-investors against OFAC lists", required: true },
    { key: "kyc", category: "compliance", title: "Know-your-customer: company's legal name, state, EIN and beneficial owners on file", required: true },
    { key: "conflicts", category: "compliance", title: "Conflicts of interest cleared (partners' personal holdings, other funds)", required: true },
  );
  if (o.sensitiveTech || t.oispRepresentation) {
    items.push(
      { key: "oisp", category: "compliance", title: "Outbound investment (OISP) determination: not covered, notifiable, or prohibited", required: true },
      { key: "export_cfius", category: "compliance", title: "Export controls and CFIUS reviewed for foreign investors and controlled technology", required: false },
    );
  }
  items.push(
    { key: "wire_instructions", category: "funding", title: "Wire instructions received through a secure channel", required: true },
    { key: "wire_callback", category: "funding", title: "Wire instructions confirmed by phone, at a number not taken from the instructions", required: true },
    { key: "wire_approvals", category: "funding", title: "Wire approved by two people", required: true },
    { key: "funds_sent", category: "funding", title: "Wire sent from the bank, with its reference recorded", required: true },
    { key: "funds_received", category: "funding", title: "Company confirms receipt of funds", required: true },
    { key: "closing_set", category: "after", title: "Fully signed closing set received and filed", required: true },
    { key: "shares_issued", category: "after", title: priced ? "Shares issued (certificate or Carta)" : "Countersigned instrument received", required: true },
    { key: "form_d", category: "after", title: "Company filed Form D with the SEC (due 15 days after the first sale)", required: false },
    { key: "qsbs", category: "after", title: "QSBS: company's representation and gross-assets statement on file", required: false },
    { key: "crm_updated", category: "after", title: "CRM and fund administrator updated", required: false },
  );
  if (o.sensitiveTech || t.oispRepresentation) items.push({ key: "oisp_notice", category: "after", title: "If notifiable: OISP notice filed with Treasury within 30 days", required: false });
  return items;
}

/** Everything required is complete, and the money has arrived. */
export function readyToClose(items: { key: string; required: boolean; status: string }[]): { ready: boolean; open: string[] } {
  const done = new Set(["done", "signed", "filed", "received", "waived", "na"]);
  const open = items.filter((i) => i.required && !done.has(i.status) && !["funds_received", "shares_issued", "closing_set"].includes(i.key)).map((i) => i.key);
  return { ready: open.length === 0, open };
}
