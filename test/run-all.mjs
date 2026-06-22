// =============================================================
// Onboarding test runner — runs EVERY *.test.ts under src/
// =============================================================
//
// The onboarding tests are plain tsx scripts that use a custom
// assert + `process.exit(1)` / `process.exitCode = 1` convention
// (not node:test). This runner discovers all of them, executes
// each with `node --import tsx <file>`, and aggregates exit codes
// so a single `npm test` covers the whole suite and exits non-zero
// if ANY file fails. No skips, no hard-coded file list.

import { globSync } from "node:fs";
import { spawnSync } from "node:child_process";
import process from "node:process";

const files = globSync("src/**/*.test.ts").sort();

if (files.length === 0) {
  console.error("No test files found under src/**/*.test.ts");
  process.exit(1);
}

let passed = 0;
const failed = [];

for (const file of files) {
  const res = spawnSync(process.execPath, ["--import", "tsx", file], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  });
  if (res.status === 0) {
    passed++;
    console.log(`PASS  ${file}`);
  } else {
    failed.push(file);
    console.log(`FAIL  ${file} (exit ${res.status})`);
    // Surface the tail of the failing file's output for diagnosis.
    const tail = (s) => (s ? s.split("\n").slice(-20).join("\n") : "");
    if (res.stdout) process.stdout.write(tail(res.stdout) + "\n");
    if (res.stderr) process.stderr.write(tail(res.stderr) + "\n");
  }
}

console.log("=".repeat(52));
console.log(
  `ONBOARDING TESTS: ${passed}/${files.length} passed, ${failed.length} failed`,
);
if (failed.length > 0) {
  console.log("FAILED:\n" + failed.map((f) => "  " + f).join("\n"));
  process.exit(1);
}
process.exit(0);
