import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.dirname(fileURLToPath(import.meta.url));
const cliEntry = path.join(root, "dist", "cli", "mock-panel.js");
const forwarded = ["serve", ...process.argv.slice(2)];

const child = spawn(process.execPath, [cliEntry, ...forwarded], {
  stdio: "inherit",
  env: process.env
});

child.on("exit", (code, signal) => {
  process.exit(code ?? (signal ? 1 : 0));
});
