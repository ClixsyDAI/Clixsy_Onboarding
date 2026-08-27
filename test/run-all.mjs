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
//
// =============================================================
// THE COMPLETION CONTRACT, and why an exit code is not enough
// =============================================================
//
// EXIT 0 DOES NOT MEAN THE SUITE RAN. On 2026-08-27 the PIN route
// suite stopped silently in the middle: a test awaited a promise
// that never settles, and the deadline it was relying on came from
// withDeadline, which calls .unref() on its timer. An unref'd timer
// plus a never-settling promise leaves NOTHING keeping the event
// loop alive, so Node did the correct thing and exited — cleanly,
// with code 0. Two whole sections never ran and the runner said
// PASS.
//
// The suite's own ran-N denominator could not catch it either,
// because the denominator is the LAST assertion in the file: a
// process that leaves early takes the denominator with it. Any
// check that lives inside the process shares the process's fate.
//
// So the check has to be outside. A file opts in by printing, as
// its first output:
//
//     [[SUITE-CONTRACT]] sections=<N>
//
// and, once every section has run:
//
//     [[SUITE-END]] sections=<N>
//
// This runner then FAILS the file, whatever its exit code, if the
// end line is missing or the two counts disagree. Missing end line
// means the process left early. A lower count means a section was
// skipped while the process survived. Neither is visible from an
// exit status, and both used to read as PASS.
//
// Opt-in on purpose: files without a CONTRACT line are unaffected,
// so this cannot silently start failing suites that never made the
// promise.
//
// =============================================================
// THE COMPLETION CONTRACT, and why an exit code is not enough
// =============================================================
//
// EXIT 0 DOES NOT MEAN THE SUITE RAN. On 2026-08-27 the PIN route
// suite stopped silently in the middle: a test awaited a promise
// that never settles, and the deadline it was relying on came from
// withDeadline, which calls .unref() on its timer. An unref'd timer
// plus a never-settling promise leaves NOTHING keeping the event
// loop alive, so Node did the correct thing and exited — cleanly,
// with code 0. Two whole sections never ran and the runner said
// PASS.
//
// The suite's own ran-N denominator could not catch it either,
// because the denominator is the LAST assertion in the file: a
// process that leaves early takes the denominator with it. Any
// check that lives inside the process shares the process's fate.
//
// So the check has to be outside. A file opts in by printing, as
// its first output:
//
//     [[SUITE-CONTRACT]] sections=<N>
//
// and, once every section has run:
//
//     [[SUITE-END]] sections=<N>
//
// This runner then FAILS the file, whatever its exit code, if the
// end line is missing or the two counts disagree. Missing end line
// means the process left early. A lower count means a section was
// skipped while the process survived. Neither is visible from an
// exit status, and both used to read as PASS.
//
// Opt-in on purpose: files without a CONTRACT line are unaffected,
// so this cannot silently start failing suites that never made the
// promise.

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
  const out = `${res.stdout ?? ""}`;
  const contract = out.match(/\[\[SUITE-CONTRACT\]\]\s+sections=(\d+)/);
  const ended = out.match(/\[\[SUITE-END\]\]\s+sections=(\d+)/);
  let contractBreach = null;
  if (contract) {
    const want = Number(contract[1]);
    if (!ended) {
      contractBreach =
        `declared ${want} sections and never printed [[SUITE-END]]. The process ` +
        `left before finishing. An exit code of ${res.status} cannot show this.`;
    } else if (Number(ended[1]) !== want) {
      contractBreach =
        `declared ${want} sections but completed ${ended[1]}. A section was ` +
        `skipped while the process survived.`;
    }
  }

  if (res.status === 0 && !contractBreach) {
    passed++;
    console.log(`PASS  ${file}`);
  } else if (contractBreach) {
    failed.push(file);
    console.log(`FAIL  ${file} (INCOMPLETE, exit ${res.status})`);
    console.log(`      ${contractBreach}`);
    const tail = (t) => (t ? t.split("\n").slice(-12).join("\n") : "");
    if (res.stdout) process.stdout.write(tail(res.stdout) + "\n");
    if (res.stderr) process.stderr.write(tail(res.stderr) + "\n");
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
