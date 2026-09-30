/**
 * Line icons for the navigation, drawn on a 24px grid with a 1.6px stroke
 * in the manner of SF Symbols. Decorative: the link text names the page.
 */
const paths: Record<string, string> = {
  sourcing: "M10.5 17a6.5 6.5 0 1 0 0-13 6.5 6.5 0 0 0 0 13ZM20 20l-4.8-4.8",
  diligence: "M8 3.5h6.5L19 8v11.5a1 1 0 0 1-1 1H8a1 1 0 0 1-1-1v-15a1 1 0 0 1 1-1ZM14 3.5V8h5M10 14l2 2 4-4.5",
  execution: "M4 20h16M6.5 16.5 16 7l2 2-9.5 9.5H6.5v-2ZM14 9l2 2",
  portfolio: "M4 4.5h6.5V11H4zM13.5 4.5H20V11h-6.5zM4 14h6.5v6.5H4zM13.5 14H20v6.5h-6.5z",
  "lp-reporting": "M4 20V10M9.5 20V4M15 20v-7M20.5 20V8",
  fundraising: "M8.5 11a3.5 3.5 0 1 0 0-7 3.5 3.5 0 0 0 0 7ZM2.5 20a6 6 0 0 1 12 0M16 4.2a3.5 3.5 0 0 1 0 6.6M17.5 14.3A6 6 0 0 1 21.5 20",
  companies: "M4 20.5V6l7-2.5v17M11 8.5l9 3v9M7.5 9h.01M7.5 12.5h.01M7.5 16h.01M14.5 14h.01M14.5 17h.01M2.5 20.5h19",
  meetings: "M4.5 6.5h15a1 1 0 0 1 1 1v12a1 1 0 0 1-1 1h-15a1 1 0 0 1-1-1v-12a1 1 0 0 1 1-1ZM3.5 10.5h17M8 4v4M16 4v4",
  approvals: "M4 13.5 4 19a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-5.5M4 13.5 6.5 5h11l2.5 8.5M4 13.5h4.5l1 2h5l1-2H20",
  compliance: "M12 3.5 19 6v5.5c0 4.3-2.9 7.6-7 9-4.1-1.4-7-4.7-7-9V6l7-2.5ZM9 12l2 2 4-4.5",
  connections: "M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1",
  settings: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6ZM19.4 13.5l1.4 1.1-1.8 3.1-1.7-.6a7 7 0 0 1-1.9 1.1L15 20.5h-3.6l-.4-1.8a7 7 0 0 1-1.9-1.1l-1.7.6-1.8-3.1 1.4-1.1a7 7 0 0 1 0-2.2l-1.4-1.1 1.8-3.1 1.7.6a7 7 0 0 1 1.9-1.1l.4-1.8H15l.4 1.8a7 7 0 0 1 1.9 1.1l1.7-.6 1.8 3.1-1.4 1.1a7 7 0 0 1 0 2.2Z",
  module: "M12 3.5 20 8v8l-8 4.5L4 16V8l8-4.5ZM4 8l8 4.5L20 8M12 12.5v8",
};

export function Icon({ name }: { name: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
      <path d={paths[name] ?? paths.module} />
    </svg>
  );
}
