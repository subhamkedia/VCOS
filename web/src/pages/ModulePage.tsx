import { Link } from "react-router-dom";
import type { ModuleInfo } from "../types";
import { PageHead } from "../ui";

/** A module that isn't built yet: what it will do, and what it will read. */
export default function ModulePage({ module: m }: { module: ModuleInfo }) {
  return (
    <div className="module-page section">
      <PageHead
        eyebrow={m.status === "next" ? "Module · being built next" : `Module · phase ${m.phase}`}
        title={m.name}
        lead={m.summary}
      />
      <div className="grid-2">
        <section className="panel panel-pad section">
          <h2>What it will do</h2>
          <ul className="does">{m.does.map((d) => <li key={d}>{d}</li>)}</ul>
        </section>
        <section className="panel panel-pad section">
          <h2>What it builds on</h2>
          <ul className="does">{m.reads.map((d) => <li key={d}>{d}</li>)}</ul>
          <p className="small muted" style={{ margin: 0 }}>
            Everything it uses is already being collected: your <Link to="/settings">firm profile</Link>, your{" "}
            <Link to="/connections">connected sources</Link> and the <Link to="/companies">company ledger</Link>.
          </p>
        </section>
      </div>
    </div>
  );
}
