import { config } from "dotenv";
import { join } from "node:path";
import { runDevelopment } from "./dev-supervisor.js";

config({ path: join(process.cwd(), ".env"), override: false });

try {
  const result = await runDevelopment();
  console.log(result.reason);
  process.exitCode = result.exitCode;
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
}
