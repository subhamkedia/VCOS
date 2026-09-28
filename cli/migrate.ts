import "dotenv/config";
import { connect, migrate } from "../lib/db.js";
import { run } from "./common.js";

run(async () => {
  const db = await connect();
  const applied = await migrate(db);
  console.log(applied.length ? `Applied: ${applied.join(", ")}` : "Database is up to date.");
  await db.close();
});
