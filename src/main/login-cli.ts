import path from "path";
import dotenv from "dotenv";
import { Cursor } from "@cursor/sdk";
import { projectRoot } from "./tools/allowlist";

dotenv.config({ path: path.join(projectRoot(), ".env") });

async function main() {
  console.log("Opening Cursor login in browser…");
  await Cursor.auth.login();
  console.log("Login complete. JARVIS can use stored SDK credentials.");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
