/**
 * audit-fault-injection.test.ts — FAULT INJECTION, not inspection.
 * ============================================================================
 *
 * Run:  npx tsx src/lib/supabase/audit-fault-injection.test.ts
 *       (also picked up by `npm test` via test/run-all.mjs)
 *
 * WHAT THIS PROVES
 * ----------------
 * THIS FILE'S CONTRACT IS NOW THE FIXED ONE. It used to pin the BROKEN
 * behaviour: `threw:false`, nothing new logged, caller still 200 everywhere.
 * That was deliberate (it was written before the fix, to establish the fact),
 * and every one of those assertions has been INVERTED here. The fault
 * injection itself is unchanged, which is the point: the same real PostgREST
 * refusal, driven through the same real call sites, must now produce a visible
 * consequence.
 *
 * The primitives under test are `recordAuditEvent` / `recordOpenEvent` (total,
 * loud) and `insertAuditEventOrThrow` (fails closed), all in
 * src/lib/supabase/server.ts. They replaced two silent primitives that did:
 *
 *     await supabase.from('<table>').insert({...});     // .error never read
 *
 * postgrest-js resolves BOTH fault classes into `{ error }` rather than
 * rejecting, which is why `.error` never being read was invisible, and why the
 * normaliser in server.ts is written against a RESOLVED-VALUE contract rather
 * than a rejection contract. Every line number below was read out of the
 * installed copy, node_modules/@supabase/postgrest-js/src/PostgrestBuilder.ts
 * @ v2.89.0:
 *
 *   :26   `protected shouldThrowOnError = false`  — the DEFAULT, in the
 *         class field list. Nothing in this app flips it.
 *   :77-80 `throwOnError()` is the ONLY setter; :78 is its
 *         `this.shouldThrowOnError = true` body line — a line that never
 *         executes here, not the default.
 *   :182  `error = JSON.parse(body)` — a non-2xx response body becomes a
 *         VALUE on the resolved result. No throw.
 *   :209  `if (error && this.shouldThrowOnError) {`  — the guard.
 *   :210  `throw new PostgrestError(error)` — the ONLY `throw` in the
 *         file, and it sits behind that false guard.
 *   :224  `if (!this.shouldThrowOnError) {`
 *   :225  `res = res.catch((fetchError) => {` — a TRANSPORT failure is
 *         caught and converted into a resolved value…
 *   :259  `status: 0,` — …carrying status 0 and a synthesised error.
 *
 * So an audit write in this app COULD vanish with no throw and no log, and did.
 * `.throwOnError()` is deliberately NOT the fix: with shouldThrowOnError true,
 * :224's catch is skipped, so a transport fault rejects with the raw undici
 * TypeError while an HTTP fault throws a PostgrestError — two shapes to
 * normalise instead of one, for no gain.
 *
 * This harness does not read that source and grep for a string. It stands up
 * a real PostgREST stub, makes the audit write REALLY fail, drives the real
 * call sites, and records exactly what an operator would see.
 *
 * THE SEVEN SITES AND THEIR RULED DISPOSITIONS
 * --------------------------------------------
 * Not every site should react the same way, so the harness asserts a per-site
 * contract rather than one blanket rule:
 *
 *   analyze route         FAIL CLOSED, HTTP 503. Those rows ARE the rate
 *                         limiter's state (counted in the same handler), so
 *                         silence fails the limit OPEN on the one route that
 *                         spends Anthropic tokens. Accepted consequence: the
 *                         analyze route errors while Supabase is degraded.
 *   submit route          DEGRADE at 200, loudly. The submission is already
 *                         committed and the already-submitted guard turns a
 *                         retry into a 400, so failing the caller would report
 *                         a failure that did not happen.
 *   sheet-export          DEGRADE, loudly.
 *   save-step, session x2,
 *   dashboard-bridge      LOG AND CONTINUE at 200.
 *
 * FOUR FAULT SHAPES, AND THE TWO THAT WERE ADDED LATER
 * ----------------------------------------------------
 * The site x mode matrix runs every site against 'unreachable' (socket
 * destroyed), 'rls_denied' (a real 403 + SQLSTATE 42501), and two shapes the
 * first revision of the fix could not see:
 *
 *   'stall'         the write is ACCEPTED and never answered. Nothing in this
 *                   app bounded a Supabase write, and undici's own header/body
 *                   timeout is 300s — past any Vercel function lifetime — so
 *                   the primitives were TOTAL but not TERMINATING: the await
 *                   never settled, normaliseAuditFault never ran, and NO line
 *                   was ever logged. Declared fault kind 'timeout' was
 *                   unreachable in production. Each site now asserts both that
 *                   it TERMINATES and that it LOGS.
 *   'gateway_html'  a 502 whose body is HTML rather than a PostgREST error
 *                   document. It classified as 'postgrest' with a null
 *                   pg_code and put the whole page in `message`.
 *
 * THE HARNESS'S OWN OUTPUT SURVIVES A HANG OR A CRASH (section 5a2)
 * -----------------------------------------------------------------
 * `out()` writes through the real `console.log`, which writes through
 * `process.stdout.write` — the exact function `patchStream` REPLACES while a
 * capture is open, and deliberately does not call through. So the 300s bail
 * and the top-level crash handler, which both printed that way, printed
 * NOTHING whenever the hang or crash happened inside a driver, which is where
 * hangs and crashes happen. A non-zero exit with an empty transcript is the
 * least useful pair of facts a harness can produce, and it is the same defect
 * class as the code under test: the report vanishes exactly when it is needed.
 * Both paths now go through `emergencyOut`, which writes to fd 2 through the
 * ORIGINAL `fs.writeSync` captured before this file patched anything, so it
 * sits underneath both the stream patch and the fd patch.
 *
 * TEN THINGS THE MATRIX ALONE CANNOT SEE
 * (11c, 11d, 11e, 11n, 11n-ii, 11n-iii, 11o, 11p, 11q, 11r)
 * ---------------------------------------------------------------------------
 *   11n-ii THE DEGRADED PATH'S OWN CATCH HANDLER, and the harness gap that
 *       hid it. 11n drives all three emitters with `fault.status = BigInt(1)`,
 *       which breaks only the FULL-record path — every field READ on the
 *       degraded path still succeeds. So `safeField`'s CATCH was never entered
 *       by any assertion, and it was itself unguarded: it built
 *       `<unreadable: ${err instanceof Error ? err.name : 'throw'}>`, which
 *       walks a hostile prototype chain AND reads a hostile property, throws a
 *       second time, and leaves the shared floor emitting ZERO LINES. Each
 *       emitter is now driven with a field whose GETTER THROWS a Proxy that is
 *       hostile to both, and must still emit exactly one tagged line.
 *   11n-iii A `message` THAT IS NOT A STRING. `boundFaultMessage` called
 *       `.slice` on the strength of a TypeScript annotation over a value that
 *       is JSON.parse'd out of a REMOTE RESPONSE BODY. Because the normaliser
 *       is evaluated in ARGUMENT POSITION —
 *       `logSupabaseFailure(tag, ctx, normaliseAuditFault(...))` — the
 *       TypeError escaped one frame BELOW the logger, so nothing was emitted
 *       at all and the floors above could not help. Four normalisers x five
 *       message shapes (array, object, number, null, undefined), plus the
 *       same defect in `code`, which is declared `string | null` and used to
 *       receive whatever the remote sent.
 *   11r THE OTHER THREE ROUTES' UNBOUNDED UPSTREAM AWAITS. 11h proved the
 *       bound for the ANALYZE route only, so the claim "bounds every await
 *       upstream of a failure-reporting write" was false for save-step,
 *       session and submit — which carry five of the seven sites, four of them
 *       in `after()` callbacks that a stall above the registration point stops
 *       being registered at all. Both dispositions are driven: fail-closed on
 *       the session lookups, and a DEGRADE case that asserts the after() task
 *       is still registered and both of its writes still land.
 *   11n THE REPORTING LAYER'S OWN SILENT FAILURE. Of the three emitters,
 *       `logSupabaseFailure` — the one six of the seven reporting sites go
 *       through — had a bare `catch {}` where the other two had a degraded
 *       fallback, so a record JSON.stringify refused produced ZERO lines from
 *       it. Each emitter is now driven with an unserialisable record (a
 *       BigInt `status`) and must still produce exactly one tagged line.
 *   11o THE TOTALITY CLAIM, AGAINST A HOSTILE PROTOTYPE CHAIN.
 *       `normaliseThrownFault` guarded every property read but not its
 *       `instanceof` checks, which walk the prototype chain — so a Proxy with
 *       a throwing `getPrototypeOf` trap made the reporter the second failure.
 *   11p THE TERMINAL CATCH ON THE ANALYZE ROUTE. Once the fail-closed audit
 *       write SUCCEEDS a rate-limit slot is spent, and every later failure
 *       fell into an untagged, session-less, multi-line console.error and an
 *       opaque 500. Driven with a healthy audit table and a refused
 *       onboarding_site_intelligence, so the slot really is spent.
 *   11q AM-BYPASS AT reusable_scan_lookup. That stage 503'd a bypass caller
 *       under the LIMITER's machine code, which is the one thing the bypass
 *       ruling forbids. Driven both ways, like every other bypass rule here.
 *
 *   11c INDEPENDENCE. Each site filters the stub's traffic to its OWN table,
 *       so no site could see that the session route's two tracking writes,
 *       once folded into one after() callback, had been SEQUENCED — making a
 *       first write that never settles silently cancel the second. Both
 *       directions and the both-stalling case are asserted there.
 *   11d THE MESSAGE BOUND, measured against the HTML body that motivated it.
 *   11e AM-BYPASS SCOPING, driven BOTH ways with a signature minted by the
 *       app's own signer, so "an AM is not 503'd by a limiter that does not
 *       apply to them" is a measurement rather than a claim.
 *
 * TWO ENTRY POINTS, PROBED DIRECTLY (section 11)
 * ----------------------------------------------
 * A discriminated-result-only design would have been the original bug moved
 * one frame up: TypeScript has no `must_use`, so `await fn()` discarding a
 * result compiles silently. So there are two entry points with two contracts,
 * and section 11 pins both against a genuinely dead host AND against the ONE
 * genuine rejection path in this code (createServiceRoleClient throwing
 * 'Missing Supabase environment variables' at server.ts:11, which must come
 * back as fault kind 'client_init', not as a raw Error escaping from a
 * different frame than every other failure).
 *
 * HERMETIC
 * --------
 *   - Stub PostgREST on 127.0.0.1:<ephemeral>, `node:http`, port 0.
 *   - NEXT_PUBLIC_SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY point at it.
 *   - Guards at FOUR layers, because a "no network" claim is only as good as
 *     the narrowest transport it forgot:
 *       * globalThis.fetch  (undici — supabase-js).
 *       * http.request / https.request / http.get / https.get (node-fetch,
 *         which gaxios / google-auth-library falls back to in its
 *         _defaultAdapter, and which the fetch guard would NOT see).
 *       * net.connect / net.createConnection / tls.connect — the raw socket
 *         layer. A previous revision guarded only the two above, and a
 *         hand-rolled `net.connect(443, '1.1.1.1')` reached the internet
 *         while the harness still reported "0 non-loopback attempts".
 *       * net.Socket.prototype.connect, http2.connect, dgram.createSocket
 *         (its .send / .connect) — added for D9. Everything above patches a
 *         MODULE OBJECT, so a dependency that destructured its reference
 *         before this file ran keeps the unpatched function. The PROTOTYPE
 *         is what net.connect, net.createConnection, tls.connect, every
 *         http(s) Agent and a hand-rolled `new net.Socket()` all funnel
 *         through, so patching it closes that hole; http2 and dgram were
 *         simply transports nobody had enumerated.
 *     All of them record AND reject any non-loopback destination, and the
 *     recorded lists are asserted empty.
 *   - RESIDUAL, D9, honestly (see "WHAT THIS DOES NOT CLOSE"): this is still
 *     JS-level interception in ONE thread. A native addon opening its own
 *     socket, a worker_thread or child process (this file spawns two of its
 *     own), and DNS resolution — which goes through cares_wrap in C++, not
 *     through node:dgram — are all outside these guards. A module that
 *     captured `net.Socket.prototype.connect` itself, rather than calling it
 *     through the prototype, would also escape.
 *   - No .env.local, no Supabase credentials, no network.
 *
 * THE RUNTIME IS PINNED, AND THE WHOLE MATRIX RUNS THREE TIMES
 * ------------------------------------------------------------
 * A harness that only ever runs as `NODE_ENV=development` cannot see a
 * one-line `if (process.env.NODE_ENV === 'production') return;` at the top
 * of recordAuditEvent — a mutation that destroys 100% of audit rows in
 * production. So the runtime is a DIMENSION of this harness, not an
 * accident of how it was launched. Three passes, each running the identical
 * site x mode matrix:
 *
 *   'prod'    (the parent) NODE_ENV=production, VERCEL_ENV=production,
 *             VERCEL=1, and every other VERCEL_/AWS_LAMBDA_ variable
 *             DELETED. The deliberately MINIMAL production pin, kept so a
 *             gate keyed on the ABSENCE of a system variable is catchable.
 *             Plain requests, no proxy headers.
 *
 *   'dev'     NODE_ENV=development, every VERCEL_/AWS_LAMBDA_ variable
 *             deleted. Plain requests.
 *
 *   'vercel'  A production-REPRESENTATIVE runtime: NODE_ENV=production plus
 *             the documented Vercel system environment — VERCEL_REGION,
 *             VERCEL_URL, VERCEL_BRANCH_URL, VERCEL_PROJECT_PRODUCTION_URL,
 *             VERCEL_DEPLOYMENT_ID, VERCEL_PROJECT_ID, VERCEL_TARGET_ENV,
 *             VERCEL_SKEW_PROTECTION_ENABLED, the VERCEL_GIT_* set,
 *             NEXT_RUNTIME, and the AWS_LAMBDA_ / LAMBDA_ / AWS_REGION
 *             substrate a Vercel Node function actually inherits — AND
 *             every Request built with a realistic edge header set
 *             (x-vercel-id, x-vercel-deployment-url, x-vercel-forwarded-for,
 *             x-vercel-ip-*, x-forwarded-for/-host/-proto, x-real-ip,
 *             x-matched-path, forwarded). Values are SHAPED like the real
 *             thing (`iad1`, `iad1::...`, `dpl_...`, `*.vercel.app`) so a
 *             gate that parses one, not merely tests for it, fires too.
 *
 * The parent runs its own pass, then re-spawns ITSELF twice (same execPath
 * + execArgv, so it works under both `npx tsx` and run-all's `--import
 * tsx`), streams each child's transcript into its own, and fails unless
 * each child exits 0 with its own label-identity guard satisfied and
 * exactly the base assertion set.
 *
 * WHY A SUBPROCESS: the pin has to land before module evaluation. A gate
 * that SNAPSHOTS the env at module scope (`const IS_PROD =
 * process.env.NODE_ENV === …`) survives an in-process env flip and would
 * not be caught by two loops in one process.
 *
 * WHY THREE AND NOT ONE MORE VARIABLE: a critic killed every audit write
 * with `if (process.env.VERCEL_REGION) return;` and with a call-site gate
 * on `req.headers.get('x-vercel-id')`, and the previous revision — which
 * modelled exactly two env vars and no proxy headers — stayed 165/165
 * green. Pinning one more variable per critique is goalpost-moving. These
 * three passes model whole RUNTIMES instead. They still do not close the
 * class; see "WHAT THIS DOES NOT CLOSE" below, which says so plainly.
 *
 * THE STUB CHECKS THE CREDENTIAL, AND THE HARNESS ASSERTS IT
 * ----------------------------------------------------------
 * A stub that 201s anything cannot see a privilege downgrade. Swap
 * createServiceRoleClient() for an anon-key client inside recordAuditEvent
 * and, in production, migration 001_initial_schema.sql:175-183 gates INSERT on
 * `auth.uid() = agency_id` (:176 is the FOR INSERT line, :181 the predicate), so the row is refused with SQLSTATE 42501 —
 * which is verbatim the body this harness already injects as `rls_denied`,
 * i.e. silent by this harness's own thesis.
 *
 * So the stub reads `apikey` / `Authorization` on every /rest/v1 request
 * and answers 403 + the real 42501 body to anything that is not the
 * service-role key configured for this run. That alone is NOT enough — the
 * code under test ignores errors, so a 403 changes nothing observable — so
 * every site x mode ALSO asserts, positively, that the audit POST arrived
 * bearing the service-role credential.
 *
 * THE STUB VALIDATES THE SCHEMA — TYPES AND CONSTRAINTS, NOT JUST NAMES
 * ---------------------------------------------------------------------
 * Real PostgREST answers 400 PGRST204 for a column that is not in the
 * schema cache, and postgrest-js resolves that into `.error` with no throw
 * and no log — so adding `actor_kind: 'client'` to the insert destroys
 * every audit row in production.
 *
 * A NAME-ONLY check was not enough, and that is not a hypothetical: adding
 * `created_at: Date.now()` — a bigint into `created_at TIMESTAMPTZ NOT
 * NULL` (001_initial_schema.sql:61) — left the previous revision at
 * 165/165 green while real PostgREST would answer 400 and every audit row
 * would be lost silently. So the stub now holds the DDL COLUMN BY COLUMN
 * (see `SCHEMA`, transcribed from 001_initial_schema.sql:56-62 and
 * 008_workbook_tab_tables.sql:80-87) and enforces:
 *
 *   unknown column        400 PGRST204
 *   bad uuid syntax       400 22P02   (uuid columns must be uuid-shaped)
 *   bad timestamptz       400 22P02   (a JSON number is not a date literal)
 *   missing/NULL NOT NULL 400 23502   (split by whether a DEFAULT exists)
 *   orphan foreign key    409 23503
 *   duplicate primary key 409 23505
 *
 * BOTH DIRECTIONS, because a 400 alone is invisible to code that never
 * reads `.error`: the same validator runs inside `verifyWriteBody`, so a
 * schema-breaking mutation fails the row-evidence assertion rather than
 * quietly getting a 400 nobody looks at.
 *
 * Consequently the fixtures are UUID-shaped (SESSION_ID, CLIENT_ID,
 * AGENCY_ID): those columns really are `uuid`, and a stub that accepted
 * 'sess-fault-injection-1' would be lying about the database.
 *
 * One deliberate divergence from a strict reading of the brief, stated at
 * `SCHEMA`: jsonb accepts any JSON value here, because Postgres does. A
 * stricter rule would make the stub reject rows production accepts.
 *
 * TARGETED FAULT (the trap this harness is built to avoid)
 * -------------------------------------------------------
 * If you break the whole Supabase client, each route bails at its FIRST
 * query and never reaches the audit write — the test then "passes" while
 * proving nothing. So the stub serves EVERY other request normally and
 * fails ONLY the POST that is the audit write itself.
 *
 * ROW COUNTER, NOT TRANSPORT COUNTER
 * ----------------------------------
 * Counting POSTs proves only that a request crossed the wire. A POST can
 * cross the wire and persist NOTHING (`insert([])` → PostgREST 201, zero
 * rows). So the stub PARSES every POST body it receives and each site-mode
 * asserts the faulted write carried a non-empty object / non-empty array
 * whose `session_id` is this session and whose `event_type` is exactly the
 * event that site is contracted to write. A write that would persist
 * nothing, or the wrong event, fails the harness.
 *
 * WRITES ARE ATTRIBUTED TO THE SITE THAT CAUSED THEM
 * ---------------------------------------------------
 * An earlier revision cleared the stub's buffers and then read
 * `writeBodies[table][0]` — so a write landing LATE from the PREVIOUS site
 * could satisfy the CURRENT site's row assertion. Observed live: four
 * sites "passed" on stale bodies belonging to their predecessor. Now the
 * stub tags every POST with the measurement window that was open when it
 * arrived (`<between-windows>` when none was), each site reads only its
 * OWN window's writes, opening a window first drains to quiescence and
 * asserts the buffers are genuinely empty, and a final assertion fails the
 * run if ANY write ever arrived outside a window.
 *
 * "SOMEBODY FINDS OUT" IS BASELINED, NOT KEYWORD-MATCHED — ON SEVEN
 * CHANNELS, AND IN ORDER
 * -------------------------------------------------------------------
 * Mode 'ok' is captured as the output BASELINE for each site. This is the
 * assertion that INVERTED: a fault mode used to have to be byte-identical to
 * that baseline (that WAS the bug, written down as a contract), and now it
 * must DIFFER from it.
 *
 * Difference alone is weak — a fix that shouted `oops` would satisfy it — so
 * each fault mode ALSO asserts the STRUCTURE of the new line: exactly one
 * `[audit-write][WRITE-FAILURE]` line, on console.error, whose single line of
 * JSON names this table, this session, this client, this event, the fault
 * kind, the HTTP status and the pg code the normaliser derived, plus a
 * non-empty route, message and 'succeeded'. The last one matters as much as
 * the rest: an operator who cannot see what DID land will go looking for data
 * loss that never happened.
 *
 * WHY console.error AND NOTHING ELSE. It is the only sink that survives
 * Supabase being down. There is no drain, no Sentry, nothing else wired, and
 * every candidate "durable" table lives in the SAME Supabase project
 * (gmvdmgcueveuedhkucsh), so a second row is not a fix. That sink is a
 * full-text search box, hence a fixed literal tag then ONE line of JSON,
 * mirroring the dashboard's proven
 * Clixsy_Dashboard/app/lib/log-admin-activity.ts:99
 * `[admin-activity][WRITE-FAILURE]`.
 *
 * AUDIT_FAILURE_RE survives only as a human-readable diagnostic, and as the
 * 'ok'-mode assertion that a HEALTHY run says nothing about an audit failure.
 *
 * The channel list grew twice, both times because of a demonstrated bypass:
 *
 *   console.* only            a fix that called
 *                             process.stderr.write('[FATAL] AUDIT ROW LOST …')
 *                             printed 14 such lines while this harness
 *                             asserted byte-identity with the baseline.
 *   + the stream layer        a fix that called
 *                             fs.writeSync(2, '[FATAL] AUDIT ROW LOST')
 *                             printed 30 such lines while every
 *                             byte-identical assertion still passed. That
 *                             is the FILE-DESCRIPTOR floor beneath the
 *                             streams, the path pino/sonic-boom takes, and
 *                             a channel Vercel captures.
 *
 * So `withCapture` now watches SEVEN channels — console.log/info/debug,
 * console.warn, console.error, process.stdout.write, process.stderr.write,
 * and fs.write/writeSync/writev/writevSync on fd 1 and fd 2 (D4) — and
 * folds all of them into ONE transcript.
 *
 * ORDER IS PART OF THE CONTRACT (D8). `consoleSignature` used to sort
 * before comparing, which made the baseline a MULTISET: a fault mode
 * emitting exactly the same lines in a different ORDER scored as
 * identical. Lines are now folded into the transcript as they are written
 * and compared as a SEQUENCE. No sort.
 *
 * Still not universal — see "WHAT THIS DOES NOT CLOSE".
 *
 * THE after() WIRING IS UNDER TEST TOO
 * ------------------------------------
 * Sites 5 and 6 are NOT driven by importing the libraries and calling them.
 * The submit route is driven for real, its `after()` registrations are
 * captured, the harness asserts there are exactly 2, and THOSE CAPTURED
 * TASKS are the drivers. Delete the `after(...)` lines in the route and
 * these sites fail — as they must, because in production no submission
 * would produce those audit events any more.
 *
 * Sites 2 and 7 now work the same way, because the session route's
 * `session_accessed` audit MOVED into the one after() block its open-event
 * sibling already used. The sibling deferred for a documented reason (a bare
 * fire-and-forget is torn down with the function on Vercel, so the request
 * never lands); doing the same for the audit takes a Supabase round trip off
 * form-load latency and makes the failure structurally unable to reach the
 * response. What is lost, stated: a hard teardown before after() flushes drops
 * the row — which is the trade the open event on the same page load already
 * accepted. Both sites assert the route registers EXACTLY ONE after() task,
 * carrying BOTH writes.
 *
 * The submit route's two `after()` registrations also MOVED, above the audit
 * write rather than below it. The two sides are not symmetric: the audit row
 * is bookkeeping and reconstructable from the session row, while the bridge
 * and the sheet export are the only things that carry the submission out of
 * Supabase, and the already-submitted 400 guard makes their loss permanent.
 * Registering first is cheap insurance; `after` only schedules, so nothing
 * runs earlier than it did. The ordering constraint that
 * exportSubmissionToSheet re-reads submitted_at (so it must stay after
 * updateSessionStep stamps it, and after the bridge) is preserved, and site 6
 * would fail if the two were swapped.
 *
 * THREE MODES
 * -----------
 *   ok           201 + normal body. The control, and the console baseline.
 *   unreachable  socket destroyed with no response → a real undici fetch
 *                failure, which postgrest-js resolves as status 0 with
 *                `code: ''` (the EMPTY STRING). The normaliser must map that
 *                to fault kind 'transport' with pg_code NULL — `error.code
 *                || null`, never `??`, which would keep the empty string and
 *                print a blank SQLSTATE that reads like a real one. Plus a
 *                separate direct probe of BOTH entry points against a
 *                genuinely closed port (127.0.0.1:1).
 *   rls_denied   HTTP 403 + the real PostgREST RLS body (SQLSTATE 42501),
 *                which must map to fault kind 'postgrest', status 403,
 *                pg_code '42501'.
 *
 *   A timeout is deliberately NOT a fourth mode. It is the same resolved
 *   status-0 shape with 'TimeoutError:' instead of 'TypeError:' at the front
 *   of the synthesised message, so it is a spelling the normaliser branches
 *   on, not a new fault class to inject.
 *
 * THE FIX, NOT THE BASELINE
 * -------------------------
 * The earlier revision of this file ran against the UNFIXED code and asserted
 * only what was true then: threw:false, nothing new logged, caller still 200
 * everywhere. Those assertions have been flipped, per site and per mode:
 *
 *   threw            still false for every SITE driver, because no disposition
 *                    lets an exception escape a handler. The throwing entry
 *                    point is pinned directly instead, in section 11.
 *   logged           INVERTED. A fault mode must now differ from the healthy
 *                    baseline, and the difference must be exactly one
 *                    structured [audit-write][WRITE-FAILURE] line.
 *   caller status    200 for the six degrade sites, 503 for the analyze route.
 *
 * Everything that made the injection real is UNCHANGED and still asserted:
 * row evidence, the credential check, the column-by-column schema check, the
 * attribution windows, the three environment passes, and the four layers of
 * hermeticity guards.
 *
 * WHAT THIS DOES NOT CLOSE — READ THIS BEFORE QUOTING THE GREEN NUMBER
 * ===================================================================
 * The environment/call-site class (D1/D2) is NOT CLOSED IN GENERAL, and no
 * amount of further enumeration would close it.
 *
 * The harness models three runtimes and one header set. Production is an
 * unbounded space of conditions: a variable no one listed, a header only a
 * particular edge region adds, a feature flag read from a remote config, a
 * `region === 'sfo1'` branch, an ISR/streaming/edge-runtime execution
 * context, a preview-vs-production deployment difference, wall-clock or
 * traffic-shape dependence. A mutation keyed on ANY of those still hides
 * from this file. Each critique that names one more condition and gets it
 * pinned moves the goalposts one variable, and the class remains open.
 *
 * State the guarantee precisely, because the useful one is narrower and
 * real:
 *
 *   WHAT IS PROVEN. Against the REAL CURRENT code, driven through the REAL
 *   call sites, with a REAL failing PostgREST: the audit write is issued,
 *   carries the right row, authenticates as service-role, is refused, and the
 *   refusal SURFACES — exactly one structured [audit-write][WRITE-FAILURE]
 *   line on console.error, naming the table, session, client, event, fault
 *   kind, status, pg code and what did succeed; the analyze route additionally
 *   answers 503 instead of proceeding with an uncounted request; every other
 *   caller still gets its 200 because its data really was committed. That is a
 *   fact about this code, established by fault injection.
 *
 *   WHAT IS NOT PROVEN. That no possible future edit can make audit rows
 *   vanish in production while this file stays green. This is mutation
 *   testing against an unbounded space; it samples, it does not prove. A
 *   green run means "the mutations we tried were caught", never "no
 *   mutation exists".
 *
 * The mutations this revision was verified to CATCH — each applied to the
 * real source, each made the run exit non-zero, each then reverted:
 *   created_at: Date.now()                    (D3, bigint into TIMESTAMPTZ)
 *   fs.writeSync(2, '[FATAL] AUDIT ROW LOST') (D4, fd-only shouting fix)
 *   if (process.env.VERCEL_REGION) return;    (D1, system-variable gate)
 *   if (req.headers.get('x-vercel-id'))       (D2, call-site header gate)
 *   insert([])                                (persists zero rows)
 *   actor_kind: 'client'                      (unknown column, PGRST204)
 *   anon-key client instead of service-role   (RLS 42501 in production)
 *   both after(...) registrations deleted     (route→library wiring)
 *   the save-step call site gated off         (call site deleted)
 *   the insert no longer awaited              (floating promise)
 *
 * And the mutations verified against the FIXED code, each applied to the real
 * source, each made this pass exit non-zero, each then reverted:
 *   the log line dropped from recordAuditRow      26 of 190 failed
 *   `error.code ?? null` in the normaliser         9 failed (pg_code "" not null)
 *   the limiter's read failing open again          4 failed (200 + a spent slot)
 *   the session route's after() split into two    12 failed (sites 2 and 7)
 *   the submit route's two after() calls swapped   9 failed (sites 5 and 6)
 *
 * And the five reverted in the final revision, each measured the same way
 * (single env pass, 488 base assertions):
 *   safeField's catch handler restored             6 failed — and the evidence
 *                                                  is `tagged=0 total=0 []`,
 *                                                  i.e. the floor emitted
 *                                                  NOTHING, which is the bug
 *   boundFaultMessage's `message: string`          15 failed — `TypeError:
 *                                                  text.slice is not a
 *                                                  function`, again with
 *                                                  `tagged=0 total=0`
 *   `error.code || null` uncoerced                  3 failed (pg_code carried a
 *                                                  JSON array/object/number)
 *   runSiteAnalysis's catch untagged again          1 failed (11k's D4 case)
 *   the sheet-export outer catch concatenating      3 failed (11g's three
 *                                                  Google stalls)
 *   save-step's session_lookup unbounded            the harness's own 300s
 *                                                  BAIL fired: the handler
 *                                                  froze and never returned,
 *                                                  which is the defect itself
 *
 * See also the ACCEPTED LIMITATIONS L1-L3 below, which are separate and
 * were already known.
 *
 * ACCEPTED LIMITATIONS — considered, deliberately NOT closed
 * ==========================================================
 * These are not oversights. Each was demonstrated against this harness and
 * then judged out of scope, so the next reader does not have to rediscover
 * them.
 *
 * L1 (was D6) — ROUTING IS NOT PINNED.
 *   Sites 1-4 are driven by importing the route module and calling its
 *   exported POST/GET. That proves the handler audits, and that the
 *   handler still audits after a change to it. It does NOT prove that
 *   production traffic still REACHES that handler: stand up a parallel
 *   endpoint (a rewrite in next.config, a proxy/middleware short-circuit,
 *   a second route file that wins the match) with no audit call in it, and
 *   this harness stays green while production stops auditing.
 *   WHY NOT CLOSED: that is a routing/deployment concern. Proving it needs
 *   a booted Next server plus a URL-level contract over the real router,
 *   which is a different harness with a different failure surface. Owning
 *   it here would mean owning Next's route resolution, which this file
 *   cannot do honestly.
 *
 * L2 (was an EARLIER critic's D8 — not this round's D8, which was the
 *     multiset-vs-sequence baseline bug and IS closed) — THE FROZEN LABEL
 *     LIST PROTECTS NAMES, NOT PREDICATES.
 *   EXPECTED_LABELS is an IDENTITY guard over assertion LABELS. It catches
 *   an assertion being dropped, renamed, duplicated, or smuggled in. It
 *   does NOT catch an assertion being HOLLOWED OUT: rewriting
 *   `assert(verdict.ok, …)` to `assert(true, …)` leaves every label
 *   byte-identical and the run green. Read the predicates, not just the
 *   label list, when reviewing a diff to this file.
 *   WHY NOT CLOSED: a self-check that a predicate is "real" is not
 *   expressible from inside the same file; it is what code review of this
 *   file is for. Stating it plainly beats implying a protection that does
 *   not exist.
 *
 * L3 (was D10) — CLOSED, AND IT WAS NOT MERELY LATENT. See section 14b.
 *   The run used to end with `process.exit(code)`, which tears the process
 *   down whether or not the event loop still has work in it. That was
 *   documented here as a latent blind spot; it was also a live FLAKE. One run
 *   in four ended with the dev child aborting at 0xC0000409 — Windows's code
 *   for a libuv `abort()`, the assertion libuv raises when exit() runs with
 *   handles still open — so the parent failed the child's `exit=0` assertion
 *   for a reason unrelated to anything under test.
 *   NOW: `finish()` sets `process.exitCode`, unrefs whatever handles a
 *   dependency left behind (never stdio, so pending output still flushes) and
 *   lets Node end the process on its own. The CI-hang risk L3 named is kept
 *   covered by an UNREF'D grace timer that hard-exits after 5s and SAYS so, so
 *   a real leak is still a loud finding rather than a silent hang.
 *
 * ===========================================================================
 * NOT FIXED IN THIS BRANCH — REAL, NAMED, AND DELIBERATELY OUT OF SCOPE
 * ===========================================================================
 * These are findings against this change that were reviewed and left alone.
 * They are written down here so the next reader does not mistake this file's
 * green number for coverage of them.
 *
 * AUD-3 — THE SUBMIT ROUTE'S after() BUDGET IS UNBUDGETED IN AGGREGATE.
 *   Every individual await on both submit-route callbacks is bounded, and the
 *   per-call bounds COMPOSE. Both callbacks are registered with `after()` and
 *   run CONCURRENTLY (Next queues them on p-queue with concurrency Infinity),
 *   so the aggregate is the LONGER CHAIN, not the sum of the two:
 *     dashboard bridge  5s Supabase read + 15s HTTP + 2s audit write ~= 22s
 *     sheet export      up to 4 bounded Supabase calls at
 *                       SUPABASE_READ_TIMEOUT_MS_AFTER (5s) + up to 5 bounded
 *                       Google calls at GOOGLE_HTTP_TIMEOUT_MS (8s) + a 2s
 *                       audit write ~= 62s worst case, ~30s on the common
 *                       path (one header read, one append).
 *   THERE IS NO AGGREGATE DEADLINE over either callback or over the pair.
 *   Nothing caps the whole background stage, so a maximally unlucky run holds
 *   the invocation for that long behind an already-delivered 200. Every stage
 *   still REPORTS, which is what this branch is about; the budget is a
 *   separate concern and it is not addressed here.
 *
 * AUD-10 — THE BOUNDING CLAIM IS NARROWED, NOT UNIVERSAL.
 *   The source used to claim this change "bounds every await upstream of a
 *   failure-reporting write". It did not, and the claim in server.ts is now
 *   the narrower one that is true: every await on the REQUEST or after() path
 *   of the seven reporting sites, OTHER than the platform-owned request-body
 *   read, has a deadline. Three things are deliberately outside it and are
 *   NOT measured here:
 *     - `await request.json()`. The body read is bounded by the platform, not
 *       by this app, and bounding it would mean writing against a stream
 *       rather than a promise.
 *     - The three discarded-result WRITES inside `runSiteAnalysis`. Their
 *       WAITING is bounded by SITE_ANALYSIS_DEADLINE_MS; they take no signal,
 *       so the losing promise is abandoned, and their own error handling is
 *       unchanged and still silent. (`createSiteIntelligenceRecord` and
 *       `attachPendingScanToSession` WERE in this list and are not any more:
 *       both now take the analyze route's signal, so both are cancelled, and
 *       the second one's `console.warn` is now a tagged line.)
 *     - Every OTHER caller of the bounded primitives — the admin routes,
 *       `admin-actions`, `gbp/actions`, `mark-welcome-seen`,
 *       `submit-feedback`. They are unbounded exactly as before, on purpose:
 *       they are not on a path to one of the seven sites, and each would need
 *       its own ruled disposition.
 *
 * AUD-6 — THE ADMIN TWIN IS THE SAME CLASS AND IS NOT ONE OF THE SEVEN.
 *   src/app/api/admin/site-intelligence/analyze/route.ts still holds
 *   `runSiteAnalysis`, `getSiteIntelligence` and `linkSiteIntelligenceToSession`
 *   inside `after()` with NO deadline on any of them and a bare
 *   `console.error` when one throws — which is exactly the shape D3 fixed on
 *   the PUBLIC route. It is a different route, it is admin-authenticated, and
 *   it is not among the seven sites this branch scoped itself to, so it is
 *   untouched and unmeasured here. The fix is the public route's, verbatim.
 *
 * AUD-9 — TRANSMIT-BUT-NOT-PERSIST IS OUT OF REACH BY CONSTRUCTION.
 *   Say it plainly rather than letting the harness imply coverage it does not
 *   have. Every call site in this change treats a 2xx with no error body as
 *   success: none requests `Prefer: return=representation`, none reads back an
 *   affected-row count, and PostgREST answers 201/204 for an insert that
 *   matched no rows just as it does for one that wrote them. So a Supabase
 *   that ACCEPTS a write and does not persist it is indistinguishable from a
 *   healthy write to this code — and therefore to this harness, whose row
 *   evidence is taken from the POST BODY the stub received, not from anything
 *   the database confirms. The stub's schema validator narrows the gap (a row
 *   that could not have persisted is rejected) but does not close it. Closing
 *   it needs a representation-returning write or a row-count check at each
 *   site, which is a change to every call site rather than to this file.
 */

// ---------------------------------------------------------------------------
// 0. Runtime prerequisites — must happen before ANY next/* module loads.
// ---------------------------------------------------------------------------
// next/dist/server/app-render/async-local-storage.js captures
// `globalThis.AsyncLocalStorage` at module-eval time and falls back to a
// FakeAsyncLocalStorage whose .run() throws. Route handlers call `after()`,
// which needs a real work-async-storage store, so we install the Node ALS
// on globalThis first. This is exactly what Next's own node runtime does.
import { AsyncLocalStorage } from 'node:async_hooks';
(globalThis as unknown as { AsyncLocalStorage?: unknown }).AsyncLocalStorage ??= AsyncLocalStorage;

import http from 'node:http';
import https from 'node:https';
import http2 from 'node:http2';
import net from 'node:net';
import tls from 'node:tls';
import dgram from 'node:dgram';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import type { AddressInfo } from 'node:net';

// The submit route has a TEST_MODE shim (route.ts:38) that swaps every
// Supabase call for in-memory fakes. That would bypass the very primitive
// under test, so make sure it is OFF.
delete process.env.ONBOARDING_SUBMIT_TEST_MODE;
process.env.ENABLE_SITE_INTELLIGENCE_PREFILL = 'true';

// ---------------------------------------------------------------------------
// 0b. ENVIRONMENT PIN — production fidelity is a dimension, not an accident.
// ---------------------------------------------------------------------------
// Every app/next module in this file is loaded by a dynamic import() inside
// run(), so assigning here genuinely precedes their module evaluation. That
// matters: a gate that snapshots the env at module scope
// (`const IS_PROD = process.env.NODE_ENV === 'production'`) is only catchable
// if the pin lands BEFORE the module is evaluated. Flipping process.env
// between two in-process passes would NOT have caught it.
type EnvPass = 'prod' | 'dev' | 'vercel';
const RAW_PASS = process.env.AUDIT_FAULT_HARNESS_ENV_PASS;
const ENV_PASS: EnvPass = RAW_PASS === 'dev' ? 'dev' : RAW_PASS === 'vercel' ? 'vercel' : 'prod';
/** True only in the top-level invocation, which owns spawning the other passes. */
const IS_PARENT_PASS = RAW_PASS === undefined;

const mutableEnv = process.env as Record<string, string | undefined>;

/**
 * PASS 'vercel' — a production-REPRESENTATIVE runtime, not just NODE_ENV.
 *
 * A critic killed every audit write with `if (process.env.VERCEL_REGION) return;`
 * and the harness stayed green, because the harness modelled two env vars and
 * production sets several dozen. Pinning one more variable each time a critic
 * names one is goalpost-moving, so this pass instead sets the DOCUMENTED Vercel
 * system environment (https://vercel.com/docs/environment-variables/system-environment-variables
 * plus the AWS Lambda variables the Node.js serverless runtime inherits) and
 * drives every route with a realistic Vercel edge header set.
 *
 * Values are shaped like the real thing (region codes, a `iad1::` deployment
 * id, a `*.vercel.app` host) so a gate that PARSES one of them, rather than
 * merely testing for presence, also fires.
 */
const VERCEL_SYSTEM_ENV: Record<string, string> = {
  // --- Vercel system environment variables, Node.js serverless runtime ---
  VERCEL: '1',
  VERCEL_ENV: 'production',
  VERCEL_TARGET_ENV: 'production',
  VERCEL_REGION: 'iad1',
  VERCEL_URL: 'onboarding-tool-9f3k2p1qz-clixsys-projects.vercel.app',
  VERCEL_BRANCH_URL: 'onboarding-tool-git-master-clixsys-projects.vercel.app',
  VERCEL_PROJECT_PRODUCTION_URL: 'onboarding.clixsy.co',
  VERCEL_DEPLOYMENT_ID: 'dpl_9f3k2p1qzKXvS7mNb4Ld6RtYwQ2h',
  VERCEL_PROJECT_ID: 'prj_ejsX97faultinjectionharness01',
  VERCEL_SKEW_PROTECTION_ENABLED: '1',
  VERCEL_GIT_PROVIDER: 'github',
  VERCEL_GIT_REPO_SLUG: 'onboarding-tool',
  VERCEL_GIT_REPO_OWNER: 'JLcilliers',
  VERCEL_GIT_REPO_ID: '812340917',
  VERCEL_GIT_COMMIT_REF: 'feat/audit-event-failure-surfacing',
  VERCEL_GIT_COMMIT_SHA: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
  VERCEL_GIT_COMMIT_MESSAGE: 'audit fault injection harness',
  VERCEL_GIT_COMMIT_AUTHOR_LOGIN: 'ClixsyDAI',
  VERCEL_GIT_COMMIT_AUTHOR_NAME: 'Clixsy Automation',
  VERCEL_GIT_PULL_REQUEST_ID: '',
  // --- what Next itself sets inside a serverless function ---
  NEXT_RUNTIME: 'nodejs',
  // --- the AWS Lambda substrate a Vercel Node function actually runs on ---
  AWS_REGION: 'us-east-1',
  AWS_DEFAULT_REGION: 'us-east-1',
  AWS_EXECUTION_ENV: 'AWS_Lambda_nodejs20.x',
  AWS_LAMBDA_FUNCTION_NAME: 'onboarding-tool-api-public-onboarding-submit',
  AWS_LAMBDA_FUNCTION_VERSION: '$LATEST',
  AWS_LAMBDA_FUNCTION_MEMORY_SIZE: '1024',
  AWS_LAMBDA_LOG_GROUP_NAME: '/aws/lambda/onboarding-tool-api',
  AWS_LAMBDA_LOG_STREAM_NAME: '2026/08/25/[$LATEST]9f3k2p1qz',
  AWS_LAMBDA_INITIALIZATION_TYPE: 'on-demand',
  LAMBDA_TASK_ROOT: '/var/task',
  LAMBDA_RUNTIME_DIR: '/var/runtime',
  NOW_REGION: 'iad1',
};

/**
 * The edge headers a request actually carries by the time a Vercel Node
 * function sees it. The critic's second kill was a CALL-SITE gate on
 * `req.headers.get('x-vercel-id')`, which no synthetic `new NextRequest(url)`
 * in the harness carried. Pass 'vercel' carries them; passes 'prod' and 'dev'
 * deliberately do NOT, so a gate keyed on their ABSENCE fails there instead.
 */
const VERCEL_EDGE_HEADERS: Record<string, string> = {
  'x-vercel-id': 'iad1::iad1::9f3k2p1qz-1756108800000-4b7c1d2e3f5a',
  'x-vercel-deployment-url': 'onboarding-tool-9f3k2p1qz-clixsys-projects.vercel.app',
  'x-vercel-forwarded-for': '203.0.113.7',
  'x-vercel-proxied-for': '203.0.113.7',
  'x-vercel-ip-country': 'US',
  'x-vercel-ip-country-region': 'GA',
  'x-vercel-ip-city': 'Atlanta',
  'x-vercel-ip-timezone': 'America/New_York',
  'x-vercel-ja4-digest': 't13d1516h2_8daaf6152771_b1ef3b1a4b1a',
  'x-forwarded-for': '203.0.113.7',
  'x-forwarded-host': 'onboarding.clixsy.co',
  'x-forwarded-proto': 'https',
  'x-real-ip': '203.0.113.7',
  'x-matched-path': '/api/public/onboarding/[...slug]',
  'forwarded': 'for=203.0.113.7;host=onboarding.clixsy.co;proto=https',
};

/** What this pass BELIEVES it pinned — asserted against process.env below. */
let EXPECTED_ENV: Record<string, string | undefined>;

if (ENV_PASS === 'prod') {
  // NODE_ENV plus the two VERCEL markers, and NOTHING else — the deliberate
  // MINIMAL production pass. Kept distinct from 'vercel' so a gate keyed on
  // the ABSENCE of a system variable is still catchable somewhere.
  mutableEnv.NODE_ENV = 'production';
  mutableEnv.VERCEL_ENV = 'production';
  mutableEnv.VERCEL = '1';
  for (const k of Object.keys(VERCEL_SYSTEM_ENV)) {
    if (k !== 'VERCEL' && k !== 'VERCEL_ENV') delete mutableEnv[k];
  }
  EXPECTED_ENV = { NODE_ENV: 'production', VERCEL_ENV: 'production', VERCEL: '1', VERCEL_REGION: undefined };
} else if (ENV_PASS === 'vercel') {
  mutableEnv.NODE_ENV = 'production';
  for (const [k, v] of Object.entries(VERCEL_SYSTEM_ENV)) mutableEnv[k] = v;
  EXPECTED_ENV = { NODE_ENV: 'production', ...VERCEL_SYSTEM_ENV };
} else {
  mutableEnv.NODE_ENV = 'development';
  for (const k of Object.keys(VERCEL_SYSTEM_ENV)) delete mutableEnv[k];
  EXPECTED_ENV = { NODE_ENV: 'development', VERCEL_ENV: undefined, VERCEL: undefined, VERCEL_REGION: undefined };
}

// ---------------------------------------------------------------------------
// 1. Assert harness (repo convention: custom assert + process.exit(1))
// ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
const failures: string[] = [];

/**
 * IDENTITY guard, not a count guard.
 *
 * A bare `EXPECTED_ASSERTIONS = 82` only proves the total moved. Deleting
 * one assertion while adding another keeps a count guard green. So every
 * assertion carries a STABLE label (no run-varying values in it — those go
 * in `detail`), the labels are collected into a Set, and the run fails
 * unless that Set is exactly EXPECTED_LABELS. Dropping, renaming,
 * duplicating or smuggling in an assertion all fail.
 */
const seenLabels = new Set<string>();
const duplicateLabels: string[] = [];

function assert(cond: boolean, label: string, detail?: string): void {
  if (seenLabels.has(label)) duplicateLabels.push(label);
  seenLabels.add(label);
  const suffix = detail ? `  ::  ${detail}` : '';
  if (cond) {
    passed++;
    out(`    PASS  ${label}`);
  } else {
    failed++;
    failures.push(`${label}${suffix}`);
    out(`    FAIL  ${label}${suffix}`);
  }
}

// All harness output goes through `out` so it survives the console swap.
const realConsoleLog = console.log.bind(console);
function out(line: string): void {
  realConsoleLog(line);
}

// ---------------------------------------------------------------------------
// 2. Hermetic guards — nothing may leave loopback, by EITHER transport.
// ---------------------------------------------------------------------------
const nonLoopbackAttempts: string[] = [];
const nonLoopbackNodeRequests: string[] = [];
const nonLoopbackSocketConnects: string[] = [];

function isLoopbackHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, '').toLowerCase();
  return h === 'localhost' || h === '::1' || h === '' || /^127\./.test(h);
}

// --- guard A: globalThis.fetch (undici; supabase-js) ------------------------
const realFetch: typeof fetch = globalThis.fetch;

globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const href =
    typeof input === 'string'
      ? input
      : input instanceof URL
        ? input.href
        : (input as Request).url;
  let host = '';
  try {
    host = new URL(href).hostname;
  } catch {
    host = '';
  }
  if (!isLoopbackHost(host) || host === '') {
    nonLoopbackAttempts.push(href);
    const cause = new Error(`hermetic guard blocked ${host || href}`);
    (cause as Error & { code?: string }).code = 'EHERMETIC';
    const err = new TypeError('fetch failed');
    (err as Error & { cause?: unknown }).cause = cause;
    throw err;
  }
  return realFetch(input, init);
}) as typeof fetch;

// ---------------------------------------------------------------------------
// 2a. D7 — MAKING GOOGLE-SIDE FAULTS REACHABLE AT ALL.
// ---------------------------------------------------------------------------
//
// WHY EVERY GOOGLE FAULT WAS PREVIOUSLY UNTESTABLE, which is why D1 hid inside
// a site that was already green. Site 6 drives exportSubmissionToSheet with
// GOOGLE_SHEETS_PRIVATE_KEY set to a placeholder string, so google-auth-
// library's jws sign REJECTS LOCALLY ('error:1E08010C:DECODER routines::
// unsupported') before a socket is ever opened. The export therefore reached
// its outer catch and its sheet_export_failed audit write by the shortest
// possible route, and NO Google-side condition — a stalled token mint, a
// stalled values read, a stalled values write — could be expressed at all.
// The hermeticity guards then turned any real Google request into an immediate
// throw, so even a correctly-signed key could not have got there.
//
// THE FIX, and what it does NOT do. It does not open the guard. A loopback
// stub serves the Google endpoints, and requests to the Google hosts are
// REWRITTEN to it before the guard's loopback check runs — so the destination
// really is 127.0.0.1 and the invariant the guards enforce ("nothing leaves
// loopback, by any transport") stays literally true. The rewrite is armed only
// while `googleStub.enabled` is set, which is only inside the Google cases; at
// every other moment a request to googleapis.com is blocked exactly as before,
// and that is asserted.
type GoogleStubMode = 'ok' | 'stall_token' | 'stall_read' | 'stall_write';

const GOOGLE_HOSTS = new Set([
  'oauth2.googleapis.com',
  'sheets.googleapis.com',
  'www.googleapis.com',
  'accounts.google.com',
]);

/** Column A1:O1 as the roster sheet really carries it (sheet-export.ts HEADER). */
const GOOGLE_STUB_HEADER_ROW: string[] = [
  'Status',
  'Client Code',
  'Business Name',
  'Primary Contact',
  'Title/Role',
  'Email',
  'Phone',
  'Website URL',
  'Physical Address',
  'Service Area',
  'Primary Services',
  '#1 Goal',
  'Website Platform',
  'Submitted Date',
  'Workbook ID',
];

const googleStub = {
  /** The rewrite is OFF by default: the guards behave exactly as they did. */
  enabled: false,
  mode: 'ok' as GoogleStubMode,
  /** Every Google request the stub actually received. */
  seen: [] as string[],
  /** Responses deliberately never sent, destroyed at teardown. */
  held: [] as http.ServerResponse[],
  /** Requests that were rewritten to loopback, for the hermeticity report. */
  redirected: [] as string[],
};

/** The real http.request, captured BEFORE guard B replaces the module's. */
const realHttpRequestForRedirect = http.request;

/**
 * The key site 6 has always run with: syntactically a PEM, cryptographically
 * nothing, so the sign REJECTS LOCALLY. That local rejection is exactly what
 * made every Google-side condition unreachable, and it is preserved because
 * site 6's contract is built on it.
 */
const BOGUS_GOOGLE_KEY = ['-----BEGIN PRIVATE KEY-----', 'not-a-real-key', '-----END PRIVATE KEY-----'].join(
  String.fromCharCode(92) + 'n',
);

/**
 * A REAL RSA key, generated per run rather than committed, so the JWT assertion
 * genuinely signs and the request genuinely leaves google-auth-library. Nothing
 * verifies the signature (the stub is not Google), which is the point: the
 * signature only has to be well-formed enough to get PAST the local reject that
 * was hiding every network-side fault.
 */
const SIGNABLE_GOOGLE_KEY = crypto.generateKeyPairSync('rsa', {
  modulusLength: 2048,
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
  publicKeyEncoding: { type: 'spki', format: 'pem' },
}).privateKey;

/**
 * Rewrite a Google URL onto the loopback stub, or return null to leave the
 * arguments alone. https is downgraded to http on purpose: the stub is a plain
 * server, so tls.connect is never reached and guard C stays untouched.
 */
let googleStubOrigin = '';
/* eslint-disable @typescript-eslint/no-explicit-any */
function rewriteGoogleUrl(args: any[]): any[] | null {
  if (!googleStub.enabled || googleStubOrigin === '') return null;
  const first = args[0];
  let href = '';
  if (typeof first === 'string') href = first;
  else if (first instanceof URL) href = first.href;
  if (href === '') return null;
  let parsed: URL;
  try {
    parsed = new URL(href);
  } catch {
    return null;
  }
  if (!GOOGLE_HOSTS.has(parsed.hostname)) return null;
  const target = new URL(googleStubOrigin);
  parsed.protocol = 'http:';
  parsed.hostname = target.hostname;
  parsed.port = target.port;
  googleStub.redirected.push(`${parsed.pathname}`);
  return [parsed.toString(), ...args.slice(1)];
}
/* eslint-enable @typescript-eslint/no-explicit-any */

// --- guard B: http.request / https.request (node-fetch; gaxios fallback) ----
// google-auth-library → gaxios → node-fetch uses node:http(s).request, which
// never touches globalThis.fetch. Without this the sheet-export path could
// reach the real Google endpoints and guard A would report "0 attempts".
/* eslint-disable @typescript-eslint/no-explicit-any */
function hostFromRequestArgs(args: any[]): string {
  const first = args[0];
  if (typeof first === 'string') {
    try {
      return new URL(first).hostname;
    } catch {
      return first;
    }
  }
  if (first instanceof URL) return first.hostname;
  const opts = (first && typeof first === 'object' ? first : args[1]) ?? {};
  const raw = String(opts.hostname ?? opts.host ?? 'localhost');
  return raw.replace(/:\d+$/, '');
}

function guardNodeRequest<T extends (...a: any[]) => any>(real: T, mod: unknown, label: string): T {
  return function guarded(this: unknown, ...args: any[]) {
    // D7: a Google URL is rewritten onto the loopback stub FIRST, so what the
    // check below sees — and what the socket actually connects to — is
    // 127.0.0.1. Off unless googleStub.enabled, so this is not a hole.
    const rewritten = rewriteGoogleUrl(args);
    if (rewritten) {
      return (realHttpRequestForRedirect as any).apply(http, rewritten);
    }
    const host = hostFromRequestArgs(args);
    if (!isLoopbackHost(host)) {
      nonLoopbackNodeRequests.push(`${label} ${host}`);
      const err = new Error(`hermetic guard blocked ${label} to ${host}`);
      (err as Error & { code?: string }).code = 'EHERMETIC';
      throw err;
    }
    return (real as any).apply(mod, args);
  } as unknown as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

http.request = guardNodeRequest(http.request, http, 'http.request');
http.get = guardNodeRequest(http.get, http, 'http.get');
https.request = guardNodeRequest(https.request, https, 'https.request');
https.get = guardNodeRequest(https.get, https, 'https.get');

// --- guard C: net.connect / tls.connect (the raw socket floor) -------------
// http(s).request and fetch are CONVENIENCES over this layer. A dependency
// (or a critic replicating guards A and B verbatim and then reaching
// 1.1.1.1:443 by hand) can skip both and open a socket directly, and the
// hermeticity assertion would have reported a clean "0 attempts". These
// guards close the floor: record AND reject any non-loopback destination.
/* eslint-disable @typescript-eslint/no-explicit-any */
function hostFromConnectArgs(args: any[]): string {
  const first = args[0];
  // net.connect(path[, cb]) — an IPC/named pipe. No host, cannot leave the box.
  if (typeof first === 'string') return 'localhost';
  // net.connect(port[, host][, cb]) / tls.connect(port[, host][, opts][, cb])
  if (typeof first === 'number') {
    const second = args[1];
    if (typeof second === 'string') return second;
    if (second && typeof second === 'object') {
      return String((second as any).host ?? (second as any).hostname ?? 'localhost');
    }
    return 'localhost';
  }
  if (first && typeof first === 'object') {
    // An options object: `path` means IPC again.
    if (typeof (first as any).path === 'string' && !(first as any).host && !(first as any).hostname) {
      return 'localhost';
    }
    return String((first as any).host ?? (first as any).hostname ?? 'localhost');
  }
  return 'localhost';
}

function guardSocketConnect<T extends (...a: any[]) => any>(real: T, mod: unknown, label: string): T {
  return function guardedConnect(this: unknown, ...args: any[]) {
    const host = String(hostFromConnectArgs(args)).replace(/^\[|\]$/g, '');
    if (!isLoopbackHost(host)) {
      nonLoopbackSocketConnects.push(`${label} ${host}`);
      const err = new Error(`hermetic guard blocked ${label} to ${host}`);
      (err as Error & { code?: string }).code = 'EHERMETIC';
      throw err;
    }
    return (real as any).apply(mod, args);
  } as unknown as T;
}
/* eslint-enable @typescript-eslint/no-explicit-any */

net.connect = guardSocketConnect(net.connect, net, 'net.connect');
net.createConnection = guardSocketConnect(net.createConnection, net, 'net.createConnection');
tls.connect = guardSocketConnect(tls.connect, tls, 'tls.connect');

// --- guard D: the PROTOTYPE floor, and the two transports nobody enumerated -
//
// D9: every guard above patches a MODULE OBJECT. A dependency that captured
// its reference at load time (`const { connect } = require('net')` evaluated
// before this file ran) keeps the unpatched function and walks straight past
// them. `net.Socket.prototype.connect` is the method `net.connect`,
// `net.createConnection`, `tls.connect`, `new net.Socket().connect()` and
// every http(s) Agent all funnel through, so patching it closes the hole for
// a destructured reference too - the reference is stale, the prototype is not.
//
// http2 and dgram are simply transports the previous revision never listed.
// `node:http2` is a first-class client in Node and touches none of the guards
// above; `node:dgram` is a raw UDP socket.
/* eslint-disable @typescript-eslint/no-explicit-any */
const realSocketConnect = net.Socket.prototype.connect;
net.Socket.prototype.connect = function guardedSocketConnect(this: any, ...args: any[]) {
  const host = String(hostFromConnectArgs(args)).replace(/^\[|\]$/g, '');
  if (!isLoopbackHost(host)) {
    nonLoopbackSocketConnects.push(`net.Socket.prototype.connect ${host}`);
    const err = new Error(`hermetic guard blocked net.Socket.prototype.connect to ${host}`);
    (err as Error & { code?: string }).code = 'EHERMETIC';
    throw err;
  }
  return realSocketConnect.apply(this, args as never);
} as typeof net.Socket.prototype.connect;

const realHttp2Connect = http2.connect;
(http2 as any).connect = function guardedHttp2Connect(authority: any, ...rest: any[]) {
  let host = '';
  try {
    host = typeof authority === 'string' ? new URL(authority).hostname : String(authority?.hostname ?? '');
  } catch {
    host = String(authority);
  }
  if (!isLoopbackHost(host)) {
    nonLoopbackSocketConnects.push(`http2.connect ${host}`);
    const err = new Error(`hermetic guard blocked http2.connect to ${host}`);
    (err as Error & { code?: string }).code = 'EHERMETIC';
    throw err;
  }
  return (realHttp2Connect as any).call(http2, authority, ...rest);
};

const realDgramCreateSocket = dgram.createSocket;
(dgram as any).createSocket = function guardedCreateSocket(...args: any[]) {
  const sock: any = (realDgramCreateSocket as any).apply(dgram, args);
  const realSend = sock.send.bind(sock);
  const realDgramConnect = sock.connect.bind(sock);
  const check = (host: unknown, label: string) => {
    const h = String(host ?? 'localhost').replace(/^\[|\]$/g, '');
    if (!isLoopbackHost(h)) {
      nonLoopbackSocketConnects.push(`${label} ${h}`);
      const err = new Error(`hermetic guard blocked ${label} to ${h}`);
      (err as Error & { code?: string }).code = 'EHERMETIC';
      throw err;
    }
  };
  sock.send = (...sendArgs: any[]) => {
    // send(msg[, offset, length][, port][, address][, cb])
    const address = sendArgs.find((a, i) => i > 0 && typeof a === 'string');
    check(address ?? 'localhost', 'dgram.send');
    return realSend(...sendArgs);
  };
  sock.connect = (...connectArgs: any[]) => {
    check(typeof connectArgs[1] === 'string' ? connectArgs[1] : 'localhost', 'dgram.connect');
    return realDgramConnect(...connectArgs);
  };
  return sock;
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// 3. Canned rows the stub serves for every non-faulted read.
// ---------------------------------------------------------------------------
const TOKEN = 'tok-fault-injection-1';
// UUID-SHAPED ON PURPOSE. `onboarding_sessions.id`, `clients.id` and
// `onboarding_audit_events.session_id` are all `UUID` columns
// (001_initial_schema.sql:57-58). The stub now enforces the real column types
// (see SCHEMA below), so a fixture like 'sess-fault-injection-1' would be a
// 22P02 invalid-input-syntax error in production and must be one here.
const SESSION_ID = '3f6b1a2c-8d4e-4c1a-9b7f-0e5a2d6c8471';
const CLIENT_ID = 'a1c4e9d2-5b73-4f8a-8e26-7d9c0b3f1a54';
const AGENCY_ID = 'b7e2d5c8-3a19-4f6b-9c04-2e8d7a1b5f63';

const SESSION_ROW: Record<string, unknown> = {
  id: SESSION_ID,
  agency_id: AGENCY_ID,
  client_id: CLIENT_ID,
  token: TOKEN,
  status: 'in_progress',
  flow_version: 'v2',
  current_step: 1,
  last_saved_at: '2026-08-24T10:00:00.000Z',
  submitted_at: '2026-08-24T10:05:00.000Z',
  logo_path: null,
  logo_url: null,
  created_at: '2026-08-24T09:00:00.000Z',
  pin_hash: null, // → session-guard returns { kind: 'ok' } without touching cookies()
  pin_attempts: 0,
  pin_lockout_until: null,
  pin_locked_at: null,
  welcome_wizard_seen: true,
  site_intelligence_id: null,
  vertical: 'law_firm',
  account_manager: 'Fault Injector',
};

const CLIENT_ROW: Record<string, unknown> = {
  id: CLIENT_ID,
  agency_id: AGENCY_ID,
  client_name: 'Fault Injection Co',
  primary_contact_name: 'Ada Lovelace',
  primary_contact_email: 'ada@faultco.invalid',
  created_at: '2026-08-24T09:00:00.000Z',
  workbook_id: 'WB-FAULT-1',
  website_url: 'https://faultco.invalid',
};

const ANSWER_ROWS: Record<string, unknown>[] = [
  {
    id: 'ans-primary-contact',
    session_id: SESSION_ID,
    step_key: 'primary_contact',
    answers: {
      main_contact_name: 'Ada Lovelace',
      main_contact_title: 'Owner',
      main_contact_email: 'ada@faultco.invalid',
      main_contact_phone: '+1 555 0100',
      website_url: 'https://faultco.invalid',
    },
    completed: true,
    updated_at: '2026-08-24T09:30:00.000Z',
  },
];

// ---------------------------------------------------------------------------
// 4. The stub PostgREST + dashboard endpoint.
// ---------------------------------------------------------------------------
/**
 * THE FOUR FAULT SHAPES, and why 'stall' is not a variation on 'unreachable'.
 *
 *   unreachable   the socket is destroyed, so undici raises a real fetch
 *                 failure. postgrest-js resolves it as status 0.
 *   rls_denied    a genuine PostgREST 403 + SQLSTATE 42501 body.
 *   stall         THE ONE SHAPE THE FIX COULD NOT SEE. The socket is ACCEPTED
 *                 and the request is fully read, and then nothing is ever
 *                 written back. Nothing upstream bounds it: the client passes
 *                 no custom fetch and no signal, and undici's own header/body
 *                 timeout is 300s, past any Vercel function lifetime. So the
 *                 primitives were TOTAL but not TERMINATING — the await never
 *                 settled, the normaliser never ran, and NO line was ever
 *                 logged. It is also the shape that exposed the sequencing
 *                 coupling in the session route's after() block: a first write
 *                 that never settles means the second is never attempted.
 *                 Bounding the write with .abortSignal(AbortSignal.timeout)
 *                 is what makes declared fault kind 'timeout' reachable.
 *   gateway_html  a 502 whose body is HTML, not a PostgREST error document.
 *                 It used to classify as 'postgrest' with a null pg_code and
 *                 dump the whole page into `message` (measured: a 756-byte
 *                 log line), sending an operator to look for a Postgres
 *                 problem that does not exist.
 */
type Mode = 'ok' | 'unreachable' | 'rls_denied' | 'stall' | 'gateway_html';

/**
 * A stock nginx 502 page, padded past the message bound so truncation is
 * exercised rather than merely available. Deliberately NOT valid JSON: that is
 * the whole point (PostgrestBuilder.ts:191 catches the JSON.parse and stuffs
 * the raw body into `message`).
 */
const GATEWAY_HTML_BODY =
  '<html>\r\n<head><title>502 Bad Gateway</title></head>\r\n<body bgcolor="white">\r\n' +
  '<center><h1>502 Bad Gateway</h1></center>\r\n<hr><center>nginx/1.24.0</center>\r\n' +
  `<!-- request-id: ${'0123456789abcdef'.repeat(40)} -->\r\n` +
  '</body>\r\n</html>\r\n';

/**
 * The verbatim PostgREST body for an RLS refusal. This is what production
 * returns when `auth.uid() = agency_id` (001_initial_schema.sql:181, inside the
 * INSERT policy at :175-183) does
 * not hold — which is exactly what a service-role → anon downgrade causes.
 */
function rlsBody(table: string): string {
  return JSON.stringify({
    code: '42501',
    details: null,
    hint: null,
    message: `new row violates row-level security policy for table "${table}"`,
  });
}

/**
 * ===========================================================================
 * THE REAL DDL, TRANSCRIBED COLUMN BY COLUMN - NOT A LIST OF NAMES.
 * ===========================================================================
 * Read out of the migrations in this repo, not guessed:
 *
 *   onboarding_audit_events - supabase/migrations/001_initial_schema.sql:56-62
 *     id         UUID PRIMARY KEY DEFAULT uuid_generate_v4()
 *     session_id UUID NOT NULL REFERENCES onboarding_sessions(id) ON DELETE CASCADE
 *     event_type TEXT NOT NULL
 *     payload    JSONB
 *     created_at TIMESTAMPTZ DEFAULT NOW() NOT NULL
 *
 *   onboarding_open_events - supabase/migrations/008_workbook_tab_tables.sql:80-87
 *     id         uuid primary key default uuid_generate_v4()
 *     session_id uuid not null references onboarding_sessions(id) on delete cascade
 *     opened_at  timestamptz not null default now()
 *     user_agent text
 *     ip_hash    text
 *     created_at timestamptz not null default now()
 *
 * WHY TYPES AND NOT JUST NAMES (D3). A name-only check passes
 * `created_at: Date.now()` - a bigint into a TIMESTAMPTZ NOT NULL. Real
 * PostgREST answers 400 `22P02 invalid input syntax for type timestamp with
 * time zone`, postgrest-js resolves that into `.error` with no throw, and
 * every audit row is lost silently while a names-only harness stays 165/165
 * green. That mutation was demonstrated against the previous revision.
 *
 * WHAT IS MODELLED: column existence, per-column type, NOT NULL (split by
 * whether the column has a DEFAULT - a NOT NULL DEFAULT column may legally be
 * omitted but may not be sent as null), uuid input syntax, timestamptz input
 * syntax, foreign keys, and primary-key uniqueness.
 *
 * WHERE THIS DELIBERATELY DIVERGES FROM THE BRIEF, and why. The instruction
 * said "jsonb must be an object or null". Postgres does not agree: a `jsonb`
 * column accepts ANY json value - `1`, `"a"`, `[1,2]` are all valid jsonb.
 * Modelling the stricter rule would make this stub REJECT rows that real
 * Postgres ACCEPTS, i.e. invent a fault. Fidelity is the whole point of the
 * stub, so jsonb accepts any JSON value here too, and the tighter expectation
 * for `payload` specifically is enforced where it belongs - in each site's own
 * requiredKeys row contract. TEXT is likewise permissive, because
 * json_populate_record casts any json scalar to text rather than erroring.
 */
type PgType = 'uuid' | 'text' | 'jsonb' | 'timestamptz';

interface ColumnSpec {
  type: PgType;
  notNull: boolean;
  /** A DEFAULT means the column may be OMITTED - it may still not be null. */
  hasDefault: boolean;
  /** Table this column references; the stub knows which keys exist. */
  references?: 'onboarding_sessions.id';
  primaryKey?: boolean;
}

const SCHEMA: Record<string, Record<string, ColumnSpec>> = {
  onboarding_audit_events: {
    id: { type: 'uuid', notNull: true, hasDefault: true, primaryKey: true },
    session_id: {
      type: 'uuid',
      notNull: true,
      hasDefault: false,
      references: 'onboarding_sessions.id',
    },
    event_type: { type: 'text', notNull: true, hasDefault: false },
    payload: { type: 'jsonb', notNull: false, hasDefault: false },
    created_at: { type: 'timestamptz', notNull: true, hasDefault: true },
  },
  onboarding_open_events: {
    id: { type: 'uuid', notNull: true, hasDefault: true, primaryKey: true },
    session_id: {
      type: 'uuid',
      notNull: true,
      hasDefault: false,
      references: 'onboarding_sessions.id',
    },
    opened_at: { type: 'timestamptz', notNull: true, hasDefault: true },
    user_agent: { type: 'text', notNull: false, hasDefault: false },
    ip_hash: { type: 'text', notNull: false, hasDefault: false },
    created_at: { type: 'timestamptz', notNull: true, hasDefault: true },
  },
};

/**
 * The only rows `onboarding_sessions` contains in this run. A `session_id`
 * outside this set is a real 23503 foreign-key violation, which PostgREST
 * answers 409 and postgrest-js - again - resolves into `.error`.
 */
const EXISTING_SESSION_IDS = new Set<string>([SESSION_ID]);

/** Primary keys already used, so a duplicate explicit `id` is a real 23505. */
const SEEN_PRIMARY_KEYS = new Set<string>();

/**
 * Postgres uuid input syntax: 32 hex digits, optionally hyphenated in the
 * canonical 8-4-4-4-12 grouping, optionally wrapped in braces. Anything else
 * is `22P02 invalid input syntax for type uuid`.
 */
function isUuidShaped(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const bare = v.trim().replace(/^\{|\}$/g, '').replace(/-/g, '');
  return /^[0-9a-fA-F]{32}$/.test(bare);
}

/**
 * TIMESTAMPTZ input from a JSON body. PostgREST hands the json value to
 * Postgres as text, so a JSON NUMBER (`Date.now()`) arrives as the bare
 * integer literal `1756108800000` and Postgres refuses it - that is not a date
 * literal. Require a string Postgres would actually accept: ISO-8601-shaped,
 * and really parseable.
 */
function isTimestamptzShaped(v: unknown): boolean {
  if (typeof v !== 'string') return false;
  const t = v.trim();
  if (!/^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}(:\d{2}(\.\d+)?)?\s*(Z|[+-]\d{2}(:?\d{2})?)?)?$/.test(t)) {
    return false;
  }
  return !Number.isNaN(Date.parse(t));
}

interface SchemaViolation {
  /** SQLSTATE / PostgREST code, verbatim from the real server. */
  code: string;
  message: string;
  /** HTTP status real PostgREST answers for this class. */
  status: number;
  details: string | null;
}

/**
 * ONE validator, used in BOTH directions - and that is the point.
 *
 * The stub uses it to answer the real PostgREST failure, which is what
 * production would do. But a 400 alone is INVISIBLE to the code under test:
 * `await supabase.from(t).insert(row)` never reads `.error`, so the harness
 * would go green while every row was refused. So `verifyWriteBody` runs the
 * SAME validator and fails the row-evidence assertion too. A schema-breaking
 * mutation therefore fails loudly here rather than silently in production.
 */
function validateRowAgainstSchema(table: string, row: unknown): SchemaViolation | null {
  const cols = SCHEMA[table];
  if (!cols) return null; // not a table this harness has read the DDL for

  if (row === null || typeof row !== 'object' || Array.isArray(row)) {
    return { code: 'PGRST102', status: 400, details: null, message: 'All object keys must match' };
  }
  const r = row as Record<string, unknown>;

  // --- unknown column: PostgREST refuses before the row reaches the table --
  for (const key of Object.keys(r)) {
    if (!cols[key]) {
      return {
        code: 'PGRST204',
        status: 400,
        details: null,
        message: `Could not find the '${key}' column of '${table}' in the schema cache`,
      };
    }
  }

  for (const [name, spec] of Object.entries(cols)) {
    const present = Object.prototype.hasOwnProperty.call(r, name);
    const value = r[name];

    // --- NOT NULL ---------------------------------------------------------
    if (spec.notNull && ((!present && !spec.hasDefault) || (present && value === null))) {
      return {
        code: '23502',
        status: 400,
        details: `Failing row contains ${JSON.stringify(r).slice(0, 200)}.`,
        message: `null value in column "${name}" of relation "${table}" violates not-null constraint`,
      };
    }
    if (!present || value === null) continue;

    // --- per-column TYPE --------------------------------------------------
    if (spec.type === 'uuid' && !isUuidShaped(value)) {
      return {
        code: '22P02',
        status: 400,
        details: null,
        message: `invalid input syntax for type uuid: "${String(value)}"`,
      };
    }
    if (spec.type === 'timestamptz' && !isTimestamptzShaped(value)) {
      return {
        code: '22P02',
        status: 400,
        details: null,
        message:
          `invalid input syntax for type timestamp with time zone: "${String(value)}"` +
          (typeof value === 'number'
            ? ' (a JSON number reaches Postgres as a bare integer literal, not a date)'
            : ''),
      };
    }
    // 'text' and 'jsonb' accept any json value - see the divergence note above.

    // --- FOREIGN KEY ------------------------------------------------------
    if (spec.references === 'onboarding_sessions.id' && !EXISTING_SESSION_IDS.has(String(value))) {
      return {
        code: '23503',
        status: 409,
        details: `Key (${name})=(${String(value)}) is not present in table "onboarding_sessions".`,
        message: `insert or update on table "${table}" violates foreign key constraint "${table}_${name}_fkey"`,
      };
    }
  }
  return null;
}

/**
 * PRIMARY KEY uniqueness. Separate from validateRowAgainstSchema because it
 * MUTATES state: only the stub may claim an id, and only once per real POST.
 * verifyWriteBody must not, or re-reading the same recorded body would
 * manufacture a duplicate that never happened.
 */
function claimPrimaryKey(table: string, row: unknown): SchemaViolation | null {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
  const id = (row as Record<string, unknown>).id;
  if (typeof id !== 'string') return null; // omitted -> uuid_generate_v4()
  const key = `${table}:${id}`;
  if (SEEN_PRIMARY_KEYS.has(key)) {
    return {
      code: '23505',
      status: 409,
      details: `Key (id)=(${id}) already exists.`,
      message: `duplicate key value violates unique constraint "${table}_pkey"`,
    };
  }
  SEEN_PRIMARY_KEYS.add(key);
  return null;
}

/** The wire body PostgREST returns for a violation. */
function schemaErrorBody(v: SchemaViolation): string {
  return JSON.stringify({ code: v.code, details: v.details, hint: null, message: v.message });
}

/** Column NAMES, derived from SCHEMA so the two can never drift apart. */
const KNOWN_COLUMNS: Record<string, readonly string[]> = Object.fromEntries(
  Object.entries(SCHEMA).map(([t, cols]) => [t, Object.keys(cols)]),
);

/** Set in run() once the ephemeral key for this run is chosen. */
let SERVICE_ROLE_KEY = '';

interface WriteRecord {
  table: string;
  /**
   * When this POST ARRIVED at the stub, in ms. Exists for one assertion: two
   * writes that share an after() callback must be ISSUED without waiting for
   * each other, and the only way to see that from outside is the gap between
   * their arrivals while the first one is deliberately not being answered.
   */
  at: number;
  /** The measurement window that was open when this POST ARRIVED. */
  window: string;
  raw: string;
  parsed: unknown;
  /** The credential the request actually presented. */
  apikey: string;
  authorization: string;
  credentialOk: boolean;
}

/**
 * How the analyze route's exact-count probe is made to fail.
 *
 *   'http_500'   a 500 the HEAD answers with NO BODY (an HTTP HEAD cannot
 *                carry one), so postgrest-js resolves `{ error: { message: '' } }`.
 *   'stall'      accepted and never answered. This is the flavour that used to
 *                be reported as fault 'postgrest' by the hand-built line, when
 *                it is a 'timeout'.
 *   'null_count' a perfectly successful 206 with NO content-range header, so
 *                PostgrestBuilder never assigns `count` (:150-155) and the
 *                route sees `count === null` with `error === null`. The one
 *                read fault class that has no error document at all.
 */
type CountReadFault = false | 'http_500' | 'stall' | 'null_count';

const BETWEEN_WINDOWS = '<between-windows>';

const stub = {
  mode: 'ok' as Mode,
  /** ONLY a POST to this table is faulted. Everything else is served normally. */
  faultTable: 'onboarding_audit_events',
  /**
   * A SECOND table to fault with the same mode, or null. Exists so the
   * independence probe can fault BOTH of the session route's tracking writes
   * at once and prove each still produces its own line — one shared fault
   * table could never show that.
   */
  faultTableSecondary: null as string | null,
  /** table -> number of POSTs the stub actually received (TRANSPORT evidence). */
  writesSeen: {} as Record<string, number>,
  /** Every POST, tagged with the window it arrived in (ATTRIBUTION evidence). */
  writes: [] as WriteRecord[],
  /** every request line the stub saw, for diagnosis when a driver bails early. */
  requestLog: [] as string[],
  /** Requests currently being handled — quiescence check before opening a window. */
  inFlight: 0,
  /** The window label stamped onto arriving writes. */
  window: BETWEEN_WINDOWS,
  /** Writes that arrived while NO window was open. Any entry fails the run. */
  strays: [] as WriteRecord[],
  /** Every /rest/v1 request whose credential was not the service-role key. */
  badCredentialRequests: [] as string[],
  /**
   * Faults the exact-count HEAD probe on onboarding_audit_events, and nothing
   * else. Separate from `mode` on purpose: `mode` faults the WRITE, and the
   * READ is a different hole in the same handler. The analyze route's limiter
   * used to read `if (!countErr && (count ?? 0) >= LIMIT)`, so a failing count
   * SKIPPED the limit entirely — the same degraded Supabase, and the bigger
   * half of the bug, because it fails the limit open BEFORE any write is even
   * attempted.
   */
  faultCountRead: false as CountReadFault,
  /**
   * Tables whose UPSTREAM READ (a GET) is stalled: the request is accepted,
   * fully read, and then NEVER ANSWERED, exactly like mode 'stall' does for a
   * write. Separate from `mode` on purpose — the point of these probes is that
   * the WRITE is healthy and the read in front of it is the thing that never
   * settles, which is the shape that produced zero operator output.
   */
  stallReadTables: [] as string[],
  /** table -> number of GETs the stub actually received. */
  readsSeen: {} as Record<string, number>,
  /** table -> how many GETs to serve normally before the stall begins. */
  stallReadSkip: {} as Record<string, number>,
  /**
   * Overrides the dashboard's 500 body. Exists for exactly one probe: a body
   * carrying NEWLINES, which is what the bridge used to CONCATENATE straight
   * into a console.error and thereby fragment the record.
   */
  dashboardBody: null as string | null,
};

/** Let the event loop settle so a straggler cannot slip in after the clear. */
async function drainToQuiescence(): Promise<void> {
  for (let i = 0; i < 20; i++) {
    await new Promise<void>((r) => setImmediate(r));
    if (stub.inFlight === 0) {
      // Two clean macrotask ticks in a row, so a request that has been
      // ISSUED but not yet accepted still has a chance to show up.
      await new Promise<void>((r) => setTimeout(r, 0));
      if (stub.inFlight === 0) return;
    }
  }
}

/** How many strays have already been reported by an openWriteWindow call. */
let straysReported = 0;

/**
 * Open a measurement window. Replaces the old `resetStubCounters()`, whose
 * bug was that it CLEARED the buffers and then let the next read pick up
 * `writeBodies[table][0]` — which a write landing late from the PREVIOUS
 * site could satisfy. Observed live: four sites "passed" on their
 * predecessor's bodies.
 *
 * Two changes fix it:
 *   1. Bodies are ATTRIBUTED, not just buffered. Every POST is stamped with
 *      the window that was open when it arrived, and a site reads only rows
 *      stamped with its OWN window. Clearing is no longer what separates
 *      one site from the next.
 *   2. Opening a window first DRAINS to quiescence and then proves nothing
 *      arrived unattributed since the last window closed — returned to the
 *      caller so it becomes an assertion, not a silent discard.
 */
async function openWriteWindow(label: string): Promise<{ empty: boolean; leftovers: string }> {
  stub.window = BETWEEN_WINDOWS;
  await drainToQuiescence();
  const fresh = stub.strays.slice(straysReported);
  straysReported = stub.strays.length;
  const empty = fresh.length === 0 && stub.inFlight === 0;
  const leftovers = empty
    ? 'no unattributed writes, 0 requests in flight'
    : `${fresh.length} write(s) arrived with NO window open ${JSON.stringify(
        fresh.map((w) => `${w.table}:${w.raw.slice(0, 80)}`),
      )}, inFlight=${stub.inFlight}`;
  stub.writesSeen = {};
  stub.readsSeen = {};
  stub.requestLog = [];
  stub.window = label;
  return { empty, leftovers };
}

/**
 * Relabel without draining or clearing — for traffic that is EXPLAINED but
 * is not the measurement (a site's `prepare()` step). Such writes are
 * attributed to the setup label, so they are neither strays nor eligible to
 * satisfy the measurement window's assertions.
 */
function labelWriteWindow(label: string): void {
  stub.window = label;
}

/** Close the current window; anything arriving from here on is a stray. */
function closeWriteWindow(): void {
  stub.window = BETWEEN_WINDOWS;
}

function wantsSingle(req: http.IncomingMessage): boolean {
  return String(req.headers['accept'] ?? '').includes('vnd.pgrst.object');
}

function wantsRepresentation(req: http.IncomingMessage): boolean {
  return String(req.headers['prefer'] ?? '').includes('return=representation');
}

function serveRead(table: string, req: http.IncomingMessage): unknown {
  const single = wantsSingle(req);
  switch (table) {
    case 'onboarding_sessions':
      return single ? SESSION_ROW : [SESSION_ROW];
    case 'clients':
      return single ? CLIENT_ROW : [CLIENT_ROW];
    case 'onboarding_answers':
      return single ? ANSWER_ROWS[0] : ANSWER_ROWS;
    case 'onboarding_site_intelligence':
      return single ? { id: 'si-record-1', status: 'queued', website_url: 'https://faultco.invalid' } : [];
    default:
      return single ? {} : [];
  }
}

function serveInsertRepresentation(table: string, body: string, req: http.IncomingMessage): unknown {
  let parsed: unknown = {};
  try {
    parsed = JSON.parse(body || '{}');
  } catch {
    parsed = {};
  }
  const row =
    table === 'onboarding_site_intelligence'
      ? { id: 'si-record-1' }
      : { id: `${table}-row-1`, ...(parsed as Record<string, unknown>) };
  return wantsSingle(req) ? row : [row];
}

function handle(req: http.IncomingMessage, res: http.ServerResponse, body: string): void {
  const url = new URL(req.url ?? '/', 'http://127.0.0.1');
  const path = url.pathname;
  stub.requestLog.push(`${req.method} ${path}`);

  // --- D7: the Google endpoints, served on loopback ------------------------
  //
  // Three fault points, one per bounded call in sheet-export: the OAuth2 token
  // mint, a values READ and a values WRITE. Each `stall` is the same shape the
  // PostgREST stall uses — accepted, read in full, and then NEVER ANSWERED —
  // because that is the condition node:http.ClientRequest has no default
  // timeout for, and the one the gaxios bound exists to end.
  if (path === '/token' || path.startsWith('/v4/spreadsheets')) {
    googleStub.seen.push(`${req.method} ${path}`);
    const isToken = path === '/token';
    const isRead = !isToken && req.method === 'GET';
    const stall =
      (isToken && googleStub.mode === 'stall_token') ||
      (isRead && googleStub.mode === 'stall_read') ||
      (!isToken && !isRead && googleStub.mode === 'stall_write');
    if (stall) {
      googleStub.held.push(res);
      return;
    }
    res.writeHead(200, { 'content-type': 'application/json' });
    if (isToken) {
      res.end(
        JSON.stringify({ access_token: 'stub-access-token', expires_in: 3600, token_type: 'Bearer' }),
      );
      return;
    }
    if (isRead) {
      // A1:O1 answers with a header row so the export does NOT take the
      // header-write branch; A2:O answers empty so it takes the APPEND branch,
      // which is the write the 'stall_write' mode faults.
      const values = path.includes('A1%3AO1') ? [GOOGLE_STUB_HEADER_ROW] : [];
      res.end(JSON.stringify({ values }));
      return;
    }
    res.end('{}');
    return;
  }

  // --- the dashboard the bridge POSTs to (NOT PostgREST) -------------------
  if (path === '/api/clients') {
    res.writeHead(500, { 'content-type': 'text/plain' });
    res.end(stub.dashboardBody ?? 'stub dashboard: forced failure so the bridge takes its audit path');
    return;
  }

  if (!path.startsWith('/rest/v1/')) {
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end('{}');
    return;
  }

  const table = path.slice('/rest/v1/'.length);

  // --- CREDENTIAL CHECK (D2) ----------------------------------------------
  // Real PostgREST decides RLS from the JWT it is handed. A stub that 201s
  // anything cannot tell a service-role client from an anon one, so swapping
  // createServiceRoleClient() for an anon-key client inside recordAuditEvent
  // would be invisible — while in production
  // 001_initial_schema.sql:175-183 refuses that INSERT with SQLSTATE 42501,
  // silently. So: anything that is not this run's service-role key gets the
  // real 403 + 42501 body, exactly as the database would.
  const apikey = String(req.headers['apikey'] ?? '');
  const authorization = String(req.headers['authorization'] ?? '');
  const credentialOk =
    SERVICE_ROLE_KEY !== '' &&
    apikey === SERVICE_ROLE_KEY &&
    authorization === `Bearer ${SERVICE_ROLE_KEY}`;
  if (!credentialOk) {
    stub.badCredentialRequests.push(
      `${req.method} ${path} apikey=${JSON.stringify(apikey)} authorization=${JSON.stringify(authorization)}`,
    );
  }

  // A non-POST with the wrong credential is refused the same way the real
  // database would refuse it — no special case for reads.
  if (!credentialOk && req.method !== 'POST') {
    res.writeHead(403, { 'content-type': 'application/json' });
    res.end(rlsBody(table));
    return;
  }

  // --- HEAD = the exact-count probe (analyze route's rate limiter) ---------
  if (req.method === 'HEAD') {
    if (stub.faultCountRead !== false && table === 'onboarding_audit_events') {
      if (stub.faultCountRead === 'stall') {
        // Accepted, never answered. Only the caller's own abort can end this,
        // which is exactly what AUDIT_READ_TIMEOUT_MS_FAIL_CLOSED is for.
        return;
      }
      if (stub.faultCountRead === 'null_count') {
        // A SUCCESS with an unusable answer: no content-range, so
        // PostgrestBuilder.ts:150-155 never assigns `count`. There is no error
        // document here at all, which is why this fault has to be synthesised.
        res.writeHead(206);
        res.end();
        return;
      }
      // 'http_500'. A 500 with no body is what an HTTP HEAD can actually
      // carry, and it is what postgrest-js turns into
      // `{ error: { message: '' }, count: null }` — resolved, not rejected,
      // exactly like the write faults.
      res.writeHead(500);
      res.end();
      return;
    }
    res.writeHead(206, { 'content-range': '*/0' });
    res.end();
    return;
  }

  if (req.method === 'GET') {
    stub.readsSeen[table] = (stub.readsSeen[table] ?? 0) + 1;
    // THE UPSTREAM STALL. The request has been fully read (this runs from req
    // 'end'), so it demonstrably crossed the wire; we simply never answer and
    // never destroy the socket. Before the reads were bounded, this froze the
    // whole after() callback BEFORE the audit write was ever issued, so the
    // write bound could not help and the operator saw nothing at all.
    if (stub.stallReadTables.includes(table)) {
      // `stallReadSkip` serves the first N reads of a table normally and
      // stalls from N+1 on. It exists because two DIFFERENT bounded calls read
      // the SAME table on the analyze route's after() path — runSiteAnalysis's
      // own record read, then getSiteIntelligence — so stalling the table
      // outright can only ever fault the first of them, and the second would
      // stay untested while looking covered.
      const skip = stub.stallReadSkip[table] ?? 0;
      if ((stub.readsSeen[table] ?? 0) > skip) return;
    }
    res.writeHead(200, { 'content-type': 'application/json', 'content-range': '0-0/1' });
    res.end(JSON.stringify(serveRead(table, req)));
    return;
  }

  if (req.method === 'PATCH') {
    res.writeHead(204, { 'content-range': '0-0/1' });
    res.end();
    return;
  }

  if (req.method === 'POST') {
    stub.writesSeen[table] = (stub.writesSeen[table] ?? 0) + 1;

    // ROW EVIDENCE: keep what this POST would actually have persisted. A
    // request that crosses the wire is not a row — `insert([])` is a 201
    // that writes nothing. `PARSE_FAILED` is a distinct sentinel so an
    // unparseable body can never be mistaken for an empty one.
    let parsedBody: unknown;
    try {
      parsedBody = JSON.parse(body === '' ? '"__EMPTY_BODY__"' : body);
    } catch {
      parsedBody = '__PARSE_FAILED__';
    }
    const record: WriteRecord = {
      table,
      at: Date.now(),
      window: stub.window,
      raw: body,
      parsed: parsedBody,
      apikey,
      authorization,
      credentialOk,
    };
    stub.writes.push(record);
    if (stub.window === BETWEEN_WINDOWS) stub.strays.push(record);

    // CREDENTIAL: the database decides RLS before it decides anything else.
    if (!credentialOk) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(rlsBody(table));
      return;
    }

    // SCHEMA (D3): the database validates the ROW, not just the column names.
    // An unknown column is 400 PGRST204; a bigint into TIMESTAMPTZ or a
    // non-uuid into UUID is 400 22P02; a missing NOT NULL column is 400 23502;
    // an orphan session_id is 409 23503; a duplicate id is 409 23505.
    // postgrest-js resolves EVERY one of those into `.error` with no throw, so
    // any of them destroys the audit trail in production, silently.
    if (SCHEMA[table]) {
      const candidateRows = Array.isArray(parsedBody) ? parsedBody : [parsedBody];
      for (const r of candidateRows) {
        const violation = validateRowAgainstSchema(table, r) ?? claimPrimaryKey(table, r);
        if (violation) {
          res.writeHead(violation.status, { 'content-type': 'application/json' });
          res.end(schemaErrorBody(violation));
          return;
        }
      }
    }

    // TARGETED FAULT: only the audit write itself, only on POST.
    if (
      (table === stub.faultTable || table === stub.faultTableSecondary) &&
      stub.mode !== 'ok'
    ) {
      if (stub.mode === 'unreachable') {
        // No response at all — kill the socket so undici raises a real
        // fetch failure (TypeError: fetch failed, cause ECONNRESET).
        res.socket?.destroy();
        return;
      }
      if (stub.mode === 'stall') {
        // THE STALL. The request has already been fully read (this runs from
        // req 'end'), and the row has already been recorded above, so the
        // write demonstrably CROSSED THE WIRE. We simply never answer, and we
        // never destroy the socket either — that is the distinction from
        // 'unreachable'. Only the caller's own abort can end this exchange,
        // which is precisely what is under test. `res` stays open; the
        // in-flight counter is released by the 'close' handler in startStub
        // when the client aborts.
        return;
      }
      if (stub.mode === 'gateway_html') {
        // A proxy, not PostgREST: HTML, not a PostgREST error document.
        res.writeHead(502, { 'content-type': 'text/html' });
        res.end(GATEWAY_HTML_BODY);
        return;
      }
      // rls_denied
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(rlsBody(table));
      return;
    }

    if (wantsRepresentation(req)) {
      res.writeHead(201, { 'content-type': 'application/json', 'content-range': '0-0/1' });
      res.end(JSON.stringify(serveInsertRepresentation(table, body, req)));
      return;
    }
    // Prefer: return=minimal (what a bare .insert() sends) → empty body.
    res.writeHead(201, { 'content-range': '0-0/1' });
    res.end();
    return;
  }

  res.writeHead(405);
  res.end();
}

function startStub(): Promise<http.Server> {
  const server = http.createServer((req, res) => {
    // In-flight tracking exists so `openWriteWindow` can prove the stub is
    // QUIESCENT before it clears the buffers. Without it, "the buffers are
    // empty" only means "nothing has ARRIVED yet".
    stub.inFlight++;
    let settled = false;
    const settle = () => {
      if (settled) return;
      settled = true;
      stub.inFlight--;
    };
    res.on('finish', settle);
    res.on('close', settle);

    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      try {
        handle(req, res, Buffer.concat(chunks).toString('utf8'));
      } catch (err) {
        try {
          res.writeHead(500);
          res.end(String(err));
        } catch {
          /* socket already gone */
        }
      }
    });
    req.on('error', () => {
      settle();
    });
  });
  server.on('clientError', (_e, socket) => socket.destroy());
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

// ---------------------------------------------------------------------------
// 4b. ROW EVIDENCE — would this POST body have persisted the right row?
// ---------------------------------------------------------------------------
interface RowVerdict {
  ok: boolean;
  reason: string;
}

/**
 * A POST body counts as a real audit write only when it is a non-empty
 * object, or a non-empty array of non-empty objects, and EVERY row carries
 * this session's id plus (for the audit table) exactly the event_type the
 * call site is contracted to write.
 *
 * `allowedKeys` is the OTHER direction, and it is the half that was missing:
 * checking only that the required keys are PRESENT lets an extra column
 * through, and an extra column is a 400 PGRST204 in production — every audit
 * row destroyed, silently. So an unknown column is a failed row here too,
 * not just a 400 from the stub (which the code under test would ignore).
 */
function verifyWriteBody(
  parsed: unknown,
  opts: {
    table: string;
    expectedEventType: string | null;
    requiredKeys: string[];
    allowedKeys: readonly string[];
  },
): RowVerdict {
  if (parsed === undefined) return { ok: false, reason: 'no POST body was recorded for this table' };
  if (parsed === '__PARSE_FAILED__') return { ok: false, reason: 'POST body was not valid JSON' };
  if (parsed === '__EMPTY_BODY__') return { ok: false, reason: 'POST body was empty — persists no row' };
  if (parsed === null) return { ok: false, reason: 'POST body was null — persists no row' };

  let rows: unknown[];
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) {
      return {
        ok: false,
        reason: 'POST body is an EMPTY ARRAY — PostgREST answers 201 and persists ZERO rows',
      };
    }
    rows = parsed;
  } else if (typeof parsed === 'object') {
    rows = [parsed];
  } else {
    return { ok: false, reason: `POST body is a ${typeof parsed}, not a row or array of rows` };
  }

  for (const [i, r] of rows.entries()) {
    if (r === null || typeof r !== 'object' || Array.isArray(r)) {
      return { ok: false, reason: `row[${i}] is not an object: ${JSON.stringify(r)}` };
    }
    const row = r as Record<string, unknown>;
    if (Object.keys(row).length === 0) {
      return { ok: false, reason: `row[${i}] is an EMPTY object — persists no columns` };
    }
    if (row.session_id !== SESSION_ID) {
      return {
        ok: false,
        reason: `row[${i}].session_id is ${JSON.stringify(row.session_id)}, expected ${JSON.stringify(SESSION_ID)}`,
      };
    }
    if (opts.expectedEventType !== null && row.event_type !== opts.expectedEventType) {
      return {
        ok: false,
        reason: `row[${i}].event_type is ${JSON.stringify(row.event_type)}, expected ${JSON.stringify(opts.expectedEventType)}`,
      };
    }
    for (const k of opts.requiredKeys) {
      if (!Object.prototype.hasOwnProperty.call(row, k)) {
        return { ok: false, reason: `row[${i}] is missing the required column "${k}"` };
      }
    }
    const unknown = Object.keys(row).filter((k) => !opts.allowedKeys.includes(k));
    if (unknown.length > 0) {
      return {
        ok: false,
        reason:
          `row[${i}] carries column(s) ${JSON.stringify(unknown)} that do NOT exist in the ` +
          `table (allowed: ${JSON.stringify(opts.allowedKeys)}). Real PostgREST answers ` +
          `400 PGRST204 and postgrest-js resolves that into .error with no throw — every ` +
          `row of this insert would be lost, silently.`,
      };
    }

    // D3: the SAME validator the stub answered with. The stub's 400 is
    // invisible to code that never reads `.error`, so the row evidence has to
    // reject the row here too or a type/NOT-NULL/FK violation stays green.
    const violation = validateRowAgainstSchema(opts.table, row);
    if (violation) {
      return {
        ok: false,
        reason:
          `row[${i}] violates the real DDL of ${opts.table}: SQLSTATE ${violation.code} — ` +
          `${violation.message}. Real PostgREST answers HTTP ${violation.status} and ` +
          `postgrest-js resolves that into .error with no throw, so this row would be lost ` +
          `silently in production.`,
      };
    }
  }
  return { ok: true, reason: `${rows.length} row(s), all well-formed: ${JSON.stringify(rows).slice(0, 300)}` };
}

// ---------------------------------------------------------------------------
// 5. Output capture - what the operator actually sees, on EVERY channel.
// ---------------------------------------------------------------------------
/**
 * SEVEN CHANNELS, ONE ORDERED TRANSCRIPT.
 *
 * Each widening below was forced by a real bypass, not by imagination:
 *
 *   console.log/info/debug/warn/error
 *       the obvious one, and on its own a REAL bypass: a genuine fix that read
 *       `.error` and called `process.stderr.write('[FATAL] AUDIT ROW LOST ...')`
 *       printed 14 such lines while this harness asserted the output was
 *       byte-identical to the healthy baseline.
 *
 *   process.stdout.write / process.stderr.write
 *       the stream layer, which is what Vercel captures... unless the writer
 *       skips it.
 *
 *   fs.writeSync / fs.write / fs.writevSync / fs.writev on fd 1 and 2   (D4)
 *       the FILE-DESCRIPTOR floor beneath the streams, and the path pino and
 *       sonic-boom actually take. A fix that shouted with
 *       `fs.writeSync(2, '[FATAL] AUDIT ROW LOST')` printed 30 such lines while
 *       every "byte-identical baseline" assertion passed. Vercel captures this
 *       channel; the previous revision of this harness did not.
 *
 * ORDER IS PART OF THE SIGNATURE (D8). `consoleSignature` used to `.sort()`
 * before comparing, which made the baseline a MULTISET: a fault mode that
 * emitted exactly the same lines in a DIFFERENT ORDER scored as identical.
 * Lines are now folded into one chronological transcript as they are written -
 * console calls and raw byte writes interleaved in real arrival order - and
 * compared as a SEQUENCE.
 *
 * RESIDUAL, stated rather than papered over: a channel nobody enumerated is
 * still a channel. Writing to fd 3+ (a file, a syslog socket), an OTLP/HTTP
 * exporter, a native addon, or a worker thread's own descriptors would not
 * land in this transcript. What IS closed is every channel an operator would
 * plausibly read in Vercel's log stream.
 */
type Channel = 'log' | 'warn' | 'error' | 'stdout' | 'stderr' | 'fd1' | 'fd2';

interface Captured {
  /** The whole transcript, in arrival order, as `channel: text`. */
  ordered: string[];
  /** Per-channel views, for the human-readable diagnostic regex only. */
  byChannel: Record<Channel, string[]>;
}

function emptyCaptured(): Captured {
  return {
    ordered: [],
    byChannel: { log: [], warn: [], error: [], stdout: [], stderr: [], fd1: [], fd2: [] },
  };
}

function stringifyArg(a: unknown): string {
  if (a instanceof Error) return `${a.name}: ${a.message}`;
  if (typeof a === 'string') return a;
  try {
    return JSON.stringify(a);
  } catch {
    return String(a);
  }
}

interface CaptureOutcome<T> {
  result?: T;
  threw: boolean;
  error?: unknown;
  captured: Captured;
}

/**
 * Folds a byte stream into whole lines AS THEY ARRIVE, so ordering across
 * channels is real rather than reconstructed. A write need not be a line, and
 * a line need not be one write, so a residual buffer is carried between writes
 * and flushed when the capture ends.
 */
function makeLineFolder(channel: Channel, captured: Captured) {
  let buf = '';
  const emit = (line: string) => {
    if (line.length === 0) return;
    captured.ordered.push(`${channel}: ${line}`);
    captured.byChannel[channel].push(line);
  };
  return {
    push(text: string): void {
      buf += text;
      let nl = buf.indexOf('\n');
      while (nl !== -1) {
        emit(buf.slice(0, nl).replace(/\r$/, ''));
        buf = buf.slice(nl + 1);
        nl = buf.indexOf('\n');
      }
    },
    flush(): void {
      if (buf.length > 0) {
        emit(buf);
        buf = '';
      }
    },
  };
}

/**
 * The stream layer. Note the ordering in `withCapture`: the stream patch goes
 * on FIRST and comes off LAST, so console.* (which writes through these streams
 * when un-patched) can never be double-counted - console.* is intercepted above
 * this layer, and never calls through.
 */
function patchStream(stream: NodeJS.WriteStream, folder: ReturnType<typeof makeLineFolder>): () => void {
  const original = stream.write.bind(stream);
  /* eslint-disable @typescript-eslint/no-explicit-any */
  (stream as any).write = (chunk: any, encoding?: any, cb?: any): boolean => {
    try {
      const text =
        typeof chunk === 'string'
          ? chunk
          : Buffer.isBuffer(chunk)
            ? chunk.toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8')
            : String(chunk);
      folder.push(text);
    } catch {
      /* the capture must never break the call it observes */
    }
    const done = typeof encoding === 'function' ? encoding : cb;
    if (typeof done === 'function') done();
    return true;
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
  return () => {
    (stream as unknown as { write: unknown }).write = original;
  };
}

// --- D4: the file-descriptor floor -----------------------------------------
//
// `fs.writeSync(2, ...)` bypasses process.stderr.write entirely. It is the path
// sonic-boom (and therefore pino) takes, and Vercel captures it. The patches
// below are installed ONCE, at module scope, so they precede every dynamically
// imported app module; they only DIVERT while a capture is active, and pass
// straight through to the real implementation otherwise (so this file's own
// `out()` is never swallowed and never self-captured).
//
// The stream patch above does not call through to fs, so a byte can be counted
// on the stream channel or the fd channel, never both.
let activeFdFolders: { fd1: ReturnType<typeof makeLineFolder>; fd2: ReturnType<typeof makeLineFolder> } | null =
  null;

/* eslint-disable @typescript-eslint/no-explicit-any */
function fdFolder(fd: unknown): ReturnType<typeof makeLineFolder> | null {
  if (!activeFdFolders) return null;
  if (fd === 1) return activeFdFolders.fd1;
  if (fd === 2) return activeFdFolders.fd2;
  return null;
}

function chunkToText(chunk: any, encoding?: unknown): string {
  if (typeof chunk === 'string') return chunk;
  if (Buffer.isBuffer(chunk)) {
    return chunk.toString(typeof encoding === 'string' ? (encoding as BufferEncoding) : 'utf8');
  }
  if (ArrayBuffer.isView(chunk)) return Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength).toString('utf8');
  return String(chunk);
}

function byteLen(chunk: any): number {
  if (typeof chunk === 'string') return Buffer.byteLength(chunk);
  if (Buffer.isBuffer(chunk) || ArrayBuffer.isView(chunk)) return chunk.byteLength;
  return Buffer.byteLength(String(chunk));
}

const realFsWriteSync = fs.writeSync;
const realFsWrite = fs.write;
const realFsWritevSync = fs.writevSync;
const realFsWritev = fs.writev;

(fs as any).writeSync = function patchedWriteSync(fd: any, ...rest: any[]): number {
  const folder = fdFolder(fd);
  if (!folder) return (realFsWriteSync as any).call(fs, fd, ...rest);
  try {
    folder.push(chunkToText(rest[0], typeof rest[1] === 'string' ? rest[1] : rest[3]));
  } catch {
    /* never break the call we observe */
  }
  return byteLen(rest[0]);
};

(fs as any).write = function patchedWrite(fd: any, ...rest: any[]): void {
  const folder = fdFolder(fd);
  if (!folder) return (realFsWrite as any).call(fs, fd, ...rest);
  const cb = rest.find((a) => typeof a === 'function');
  try {
    folder.push(chunkToText(rest[0]));
  } catch {
    /* ditto */
  }
  if (cb) process.nextTick(() => cb(null, byteLen(rest[0]), rest[0]));
};

(fs as any).writevSync = function patchedWritevSync(fd: any, buffers: any[], ...rest: any[]): number {
  const folder = fdFolder(fd);
  if (!folder) return (realFsWritevSync as any).call(fs, fd, buffers, ...rest);
  let n = 0;
  for (const b of buffers ?? []) {
    try {
      folder.push(chunkToText(b));
    } catch {
      /* ditto */
    }
    n += byteLen(b);
  }
  return n;
};

(fs as any).writev = function patchedWritev(fd: any, buffers: any[], ...rest: any[]): void {
  const folder = fdFolder(fd);
  if (!folder) return (realFsWritev as any).call(fs, fd, buffers, ...rest);
  const cb = rest.find((a) => typeof a === 'function');
  let n = 0;
  for (const b of buffers ?? []) {
    try {
      folder.push(chunkToText(b));
    } catch {
      /* ditto */
    }
    n += byteLen(b);
  }
  if (cb) process.nextTick(() => cb(null, n, buffers));
};
/* eslint-enable @typescript-eslint/no-explicit-any */

// ---------------------------------------------------------------------------
// 5a2. AUD-7 — THE ONE CHANNEL A CAPTURE CANNOT SWALLOW.
// ---------------------------------------------------------------------------
//
// `out()` writes through `realConsoleLog`, which is `console.log` bound at
// module scope. That is the REAL console.log, so it writes through
// `process.stdout.write` — which `patchStream` REPLACES for the duration of a
// capture and deliberately does NOT call through (that is how a byte is
// counted on exactly one channel and never two).
//
// Consequence, and it is the worst possible one: the 300s BAIL and the
// top-level CRASH handler both printed through `realConsoleLog`, so a hang or
// a crash that happened WHILE A CAPTURE WAS OPEN printed NOTHING. The harness
// would exit 1 with an empty transcript and the parent would report a child
// that "exited non-zero" with no reason in it — a diagnostic that disappears
// exactly when it is needed, which is the same defect class this whole branch
// is about.
//
// The fix is to write to a channel that is never patched. `realFsWriteSync` is
// the ORIGINAL `fs.writeSync` captured above, before this file replaced it, so
// a call through it goes straight to fd 2 underneath BOTH the stream patch and
// the fd patch. Two independent fallbacks after it, because an emergency
// printer that can itself fail is not an emergency printer.
function emergencyOut(line: string): void {
  const text = `${line}\n`;
  try {
    (realFsWriteSync as unknown as (fd: number, s: string) => number).call(fs, 2, text);
    return;
  } catch {
    /* fall through */
  }
  try {
    // The captured original, not the patched property.
    realConsoleLog(line);
    return;
  } catch {
    /* fall through */
  }
  try {
    process.stderr.write?.(text);
  } catch {
    /* nothing left to try */
  }
}

async function withCapture<T>(fn: () => Promise<T>): Promise<CaptureOutcome<T>> {
  const captured = emptyCaptured();
  const folders = {
    stdout: makeLineFolder('stdout', captured),
    stderr: makeLineFolder('stderr', captured),
    fd1: makeLineFolder('fd1', captured),
    fd2: makeLineFolder('fd2', captured),
  };
  const restoreStdout = patchStream(process.stdout, folders.stdout);
  const restoreStderr = patchStream(process.stderr, folders.stderr);
  activeFdFolders = { fd1: folders.fd1, fd2: folders.fd2 };

  const original = {
    log: console.log,
    warn: console.warn,
    error: console.error,
    info: console.info,
    debug: console.debug,
  };
  // A console.* call is emitted straight into the ordered transcript, so its
  // position relative to raw stream/fd writes is preserved. One call can carry
  // embedded newlines, so it is split into lines rather than trusted to be one.
  const emitConsole = (channel: Channel, args: unknown[]) => {
    const text = args.map(stringifyArg).join(' ');
    for (const line of text.split(/\r?\n/)) {
      if (line.length === 0) continue;
      captured.ordered.push(`${channel}: ${line}`);
      captured.byChannel[channel].push(line);
    }
  };
  console.log = (...args: unknown[]) => emitConsole('log', args);
  console.info = (...args: unknown[]) => emitConsole('log', args);
  console.debug = (...args: unknown[]) => emitConsole('log', args);
  console.warn = (...args: unknown[]) => emitConsole('warn', args);
  console.error = (...args: unknown[]) => emitConsole('error', args);

  const finish = () => {
    console.log = original.log;
    console.info = original.info;
    console.debug = original.debug;
    console.warn = original.warn;
    console.error = original.error;
    activeFdFolders = null;
    restoreStdout();
    restoreStderr();
    // Flush partial lines LAST, so a writer that never emitted a trailing
    // newline still contributes its text to the transcript.
    folders.stdout.flush();
    folders.stderr.flush();
    folders.fd1.flush();
    folders.fd2.flush();
  };
  try {
    const result = await fn();
    finish();
    return { result, threw: false, captured };
  } catch (error) {
    finish();
    return { threw: true, error, captured };
  }
}

/**
 * DIAGNOSTIC ONLY - never the contract.
 *
 * The contract is the ok-mode baseline (see `consoleSignature`): a fault mode
 * must produce the same ORDERED transcript as the healthy run. This regex only
 * makes a failure readable by pointing at the line that most likely carries the
 * news. A fix that shouts in other words, on another channel, or in another
 * order still fails the baseline comparison, which is the whole point.
 */
const AUDIT_FAILURE_RE =
  /onboarding_audit_events|onboarding_open_events|42501|22P02|23502|23503|PGRST204|row-level security|audit-write|WRITE-FAILURE|audit write failed|audit row lost|onboarding_open_events insert failed/i;

function auditFailureLines(c: Captured): string[] {
  return c.ordered.filter((l) => AUDIT_FAILURE_RE.test(l));
}

// ---------------------------------------------------------------------------
// 5b. THE FIXED CONTRACT'S OTHER HALF — the line that must now appear.
// ---------------------------------------------------------------------------
//
// The baseline comparison above proves only that SOMETHING new reached the
// operator. That is necessary but weak: a fix that shouted `oops` would satisfy
// it. So the fault modes ALSO assert the STRUCTURE of the new line.
//
// The shape is fixed on purpose. The only sink that survives Supabase being
// down is console.error into the Vercel runtime logs — there is no drain, no
// Sentry, and every candidate "durable" table lives in the SAME Supabase
// project, so a second row would fail for the same reason the first did. That
// sink is a full-text search box, so the contract is: a fixed literal tag, then
// ONE line of JSON (mirroring the dashboard's proven
// `[admin-activity][WRITE-FAILURE]`), carrying enough for an operator to act
// WITHOUT a second query — including what DID succeed, so nobody chases
// phantom data loss.
const WRITE_FAILURE_TAG = '[audit-write][WRITE-FAILURE]';
/**
 * The other three tags. Mirrored as literals for the same reason as the
 * message bound: this file imports no values from the code under test, so a
 * tag that was quietly renamed must not rename the assertion with it.
 *
 * ONE SHAPE FOR ALL FOUR. Every one of these is verified by the SAME
 * verifyFailureLine below, which is the whole point of R3: the read-side line
 * used to be built by hand, with a hard-coded fault, no status, no normaliser
 * and no message bound.
 */
const READ_FAILURE_TAG = '[supabase-read][READ-FAILURE]';
const SUPABASE_WRITE_FAILURE_TAG = '[supabase-write][WRITE-FAILURE]';
const RATE_LIMIT_READ_FAILURE_TAG = '[rate-limit][READ-FAILURE]';
/**
 * The two tags for the conditions that have no TABLE: an outbound HTTP call
 * and a bounded stage. Mirrored as literals for the same reason as the other
 * four — this file imports no values from the code under test.
 */
const UPSTREAM_HTTP_FAILURE_TAG = '[upstream-http][REQUEST-FAILURE]';
const BOUNDED_STAGE_FAILURE_TAG = '[bounded-stage][FAILURE]';

interface FailureLine {
  channel: string;
  parsed: Record<string, unknown> | null;
  raw: string;
}

function failureLines(c: Captured, tag: string): FailureLine[] {
  return c.ordered
    .filter((l) => l.includes(tag))
    .map((l) => {
      const at = l.indexOf(tag);
      const json = l.slice(at + tag.length).trim();
      let parsed: Record<string, unknown> | null = null;
      try {
        const p: unknown = JSON.parse(json);
        if (p !== null && typeof p === 'object' && !Array.isArray(p)) {
          parsed = p as Record<string, unknown>;
        }
      } catch {
        /* an unparseable tail is a failed assertion, not an exception */
      }
      return { channel: l.slice(0, at).split(':')[0] ?? '?', parsed, raw: l };
    });
}

function writeFailureLines(c: Captured): FailureLine[] {
  return failureLines(c, WRITE_FAILURE_TAG);
}

/** What the normaliser must have produced, per injected fault class. */
const EXPECTED_FAULT: Record<Exclude<Mode, 'ok'>, { kind: string; status: number; pgCode: string | null }> = {
  // PostgrestBuilder.ts:225 catches the fetch-layer failure and :259 resolves
  // it as status 0 with `code: ''` — the EMPTY STRING. `error.code || null`
  // normalises that to null; `?? null` would have kept '' and printed a blank
  // SQLSTATE that reads like a real one.
  unreachable: { kind: 'transport', status: 0, pgCode: null },
  // A non-2xx body is JSON.parsed into `error` at :182 and RESOLVED.
  rls_denied: { kind: 'postgrest', status: 403, pgCode: '42501' },
  // An AbortSignal.timeout abort is caught by the SAME :225 catch as any other
  // fetch failure, so it RESOLVES as status 0 with `code: ''` — identical in
  // shape to 'unreachable'. Only the synthesised message differs
  // ('TimeoutError: ...' vs 'TypeError: ...', built from `fetchError.name` at
  // :252), which is the sole thing separating kind 'timeout' from 'transport'.
  stall: { kind: 'timeout', status: 0, pgCode: null },
  // 502 with an HTML body: JSON.parse throws at :182, so :197 builds
  // `error = { message: body }` with NO code/details/hint key. That absence is
  // the discriminator for 'gateway'; the old code called it 'postgrest'.
  gateway_html: { kind: 'gateway', status: 502, pgCode: null },
};

/**
 * The message bound the log line must respect, mirrored from
 * MAX_FAULT_MESSAGE_CHARS in server.ts. Duplicated ON PURPOSE: this file
 * imports no values from the code under test, so a bound that was quietly
 * widened cannot widen the assertion with it.
 */
const EXPECTED_MAX_FAULT_MESSAGE_CHARS = 300;
const TRUNCATION_MARKER = '[truncated:';

/**
 * What one failure line must say. Explicit rather than derived from the fault
 * MODE, because the same checks now have to serve four tags and three
 * conditions the write modes do not name (a stalled upstream READ, a null
 * count, a seed upsert). The checks themselves are shared on purpose — R3's
 * complaint was that the read-side line met a lower bar than the write-side
 * one, so there is exactly one bar and both are held to it.
 */
interface LineExpectation {
  tag: string;
  table: string;
  eventType: string;
  sessionId: string;
  clientId: string | null;
  fault: string;
  status: number | null;
  pgCode: string | null;
}

/** Build the expectation the SITE MATRIX wants, from a site and a fault mode. */
function siteExpectation(
  site: { faultTable: string; logEventType: string },
  mode: Exclude<Mode, 'ok'>,
): LineExpectation {
  const want = EXPECTED_FAULT[mode];
  return {
    tag: WRITE_FAILURE_TAG,
    table: site.faultTable,
    eventType: site.logEventType,
    sessionId: SESSION_ID,
    clientId: CLIENT_ID,
    fault: want.kind,
    status: want.status,
    pgCode: want.pgCode,
  };
}

/** Why the single failure line does or does not satisfy the contract. */
function verifyFailureLine(lines: FailureLine[], want: LineExpectation): RowVerdict {
  if (lines.length !== 1) {
    return { ok: false, reason: `expected exactly 1 ${want.tag} line, saw ${lines.length}` };
  }
  const line = lines[0]!;
  if (line.channel !== 'error') {
    return { ok: false, reason: `the line landed on channel "${line.channel}", not console.error` };
  }
  if (!line.parsed) {
    return { ok: false, reason: `the tail after the tag is not ONE line of JSON: ${line.raw.slice(0, 200)}` };
  }
  const f = line.parsed;
  const checks: Array<[string, unknown, unknown]> = [
    ['table', f.table, want.table],
    ['event_type', f.event_type, want.eventType],
    ['session_id', f.session_id, want.sessionId],
    ['client_id', f.client_id, want.clientId],
    ['fault', f.fault, want.fault],
    ['status', f.status, want.status],
    ['pg_code', f.pg_code, want.pgCode],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) {
      return {
        ok: false,
        reason: `field "${field}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} (line: ${line.raw.slice(0, 300)})`,
      };
    }
  }
  for (const field of ['route', 'message', 'succeeded'] as const) {
    if (typeof f[field] !== 'string' || (f[field] as string).length === 0) {
      return {
        ok: false,
        reason: `field "${field}" must be a non-empty string so an operator can act without a second query, got ${JSON.stringify(f[field])}`,
      };
    }
  }

  // THE BOUND. `message` is the one field whose content is chosen by whatever
  // answered the request rather than by the code under test, so it is the one
  // that can push the actionable half of the line off the operator's screen.
  // Checked at EVERY site and in EVERY fault mode, not just the gateway one,
  // so no future fault class can reintroduce an unbounded line.
  const msg = f.message as string;
  const boundWithMarker = EXPECTED_MAX_FAULT_MESSAGE_CHARS + 64;
  if (msg.length > boundWithMarker) {
    return {
      ok: false,
      reason: `field "message" is ${msg.length} chars, over the ${EXPECTED_MAX_FAULT_MESSAGE_CHARS}-char bound (+ truncation marker): a proxy's HTML body must not become the log line`,
    };
  }
  if (msg.length > EXPECTED_MAX_FAULT_MESSAGE_CHARS && !msg.includes(TRUNCATION_MARKER)) {
    return {
      ok: false,
      reason: `field "message" was clipped to ${msg.length} chars with NO "${TRUNCATION_MARKER}" marker: a silently truncated message reads as a complete one`,
    };
  }
  // GREPPABILITY: still exactly one physical line. JSON.stringify escapes any
  // newline inside the HTML body, so a multi-line body must not fragment the
  // record and strand the tag on the uninteresting half.
  if (/[\r\n]/.test(line.raw)) {
    return { ok: false, reason: `the ${want.tag} record spans more than one physical line` };
  }
  return { ok: true, reason: line.raw.slice(0, 300) };
}

/**
 * THE SAME BAR, for the two tags whose subject is not a table.
 *
 * Deliberately NOT a looser check. Every structural requirement the four
 * table-shaped tags are held to is repeated here — one physical line, one line
 * of JSON, console.error, the 300-char message bound with its truncation
 * marker, and non-empty route/message/succeeded — because the whole complaint
 * that produced `verifyFailureLine` was that a second line shape had quietly
 * shipped to a lower standard. Only the two fields that genuinely differ
 * differ: `target` where the others say `table`, and `code` (a transport code)
 * where the others say `pg_code` (a SQLSTATE).
 */
interface UpstreamLineExpectation {
  tag: string;
  target: string;
  eventType: string;
  sessionId: string;
  clientId: string | null;
  fault: string;
  status: number | null;
  code: string | null;
}

function verifyUpstreamLine(
  lines: FailureLine[],
  want: UpstreamLineExpectation,
): RowVerdict {
  if (lines.length !== 1) {
    return { ok: false, reason: `expected exactly 1 ${want.tag} line, saw ${lines.length}` };
  }
  const line = lines[0]!;
  if (line.channel !== 'error') {
    return { ok: false, reason: `the line landed on channel "${line.channel}", not console.error` };
  }
  if (!line.parsed) {
    return { ok: false, reason: `the tail after the tag is not ONE line of JSON: ${line.raw.slice(0, 200)}` };
  }
  const f = line.parsed;
  if (Object.prototype.hasOwnProperty.call(f, 'pg_code')) {
    return {
      ok: false,
      reason: `this shape must NOT carry pg_code: there is no Postgres in an HTTP call, and a field that is always null trains an operator to ignore it`,
    };
  }
  const checks: Array<[string, unknown, unknown]> = [
    ['target', f.target, want.target],
    ['event_type', f.event_type, want.eventType],
    ['session_id', f.session_id, want.sessionId],
    ['client_id', f.client_id, want.clientId],
    ['fault', f.fault, want.fault],
    ['status', f.status, want.status],
    ['code', f.code, want.code],
  ];
  for (const [field, actual, expected] of checks) {
    if (actual !== expected) {
      return {
        ok: false,
        reason: `field "${field}" is ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)} (line: ${line.raw.slice(0, 300)})`,
      };
    }
  }
  for (const field of ['route', 'message', 'succeeded'] as const) {
    if (typeof f[field] !== 'string' || (f[field] as string).length === 0) {
      return {
        ok: false,
        reason: `field "${field}" must be a non-empty string, got ${JSON.stringify(f[field])}`,
      };
    }
  }
  const msg = f.message as string;
  if (msg.length > EXPECTED_MAX_FAULT_MESSAGE_CHARS + 64) {
    return {
      ok: false,
      reason: `field "message" is ${msg.length} chars, over the ${EXPECTED_MAX_FAULT_MESSAGE_CHARS}-char bound (+ marker)`,
    };
  }
  if (msg.length > EXPECTED_MAX_FAULT_MESSAGE_CHARS && !msg.includes(TRUNCATION_MARKER)) {
    return { ok: false, reason: `field "message" was clipped with NO "${TRUNCATION_MARKER}" marker` };
  }
  if (/[\r\n]/.test(line.raw)) {
    return { ok: false, reason: `the ${want.tag} record spans more than one physical line` };
  }
  return { ok: true, reason: line.raw.slice(0, 300) };
}

/** The whole ordered transcript. This IS the baseline. */
function allLines(c: Captured): string[] {
  return c.ordered;
}

/**
 * Volatile-but-not-meaningful fragments are normalised so the baseline is
 * comparable run-to-run. Wording is NOT normalised - only clock-ish values.
 */
function normaliseLine(l: string): string {
  return l
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<iso-timestamp>')
    .replace(/\b\d+\s?ms\b/g, '<ms>');
}

/**
 * D8: SEQUENCE, not multiset. The previous revision sorted before comparing,
 * so a fault mode emitting the same lines in a different ORDER - a fix that
 * reorders its logging around a new failure branch, say - scored as identical
 * to the healthy baseline. No sort.
 */
function consoleSignature(lines: string[]): string {
  return JSON.stringify(lines.map(normaliseLine));
}

// ---------------------------------------------------------------------------
// 6. Next request scope so route handlers can call after().
// ---------------------------------------------------------------------------
type AfterTask = () => unknown;
let capturedAfterTasks: AfterTask[] = [];
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let workAsyncStorage: { run: <T>(store: any, fn: () => T) => T };

function inRequestScope<T>(fn: () => Promise<T>): Promise<T> {
  const store = {
    afterContext: {
      after: (task: AfterTask) => {
        capturedAfterTasks.push(task);
        return undefined;
      },
    },
  };
  return workAsyncStorage.run(store, fn);
}

// ---------------------------------------------------------------------------
// 7. Site drivers.
// ---------------------------------------------------------------------------
interface Invocation {
  status?: number;
  body?: unknown;
}

interface Site {
  key: string;
  /** The table whose POST is the audit write for this site. */
  faultTable: string;
  /** The exact event_type this site is contracted to write (null = open-events). */
  expectedEventType: string | null;
  /**
   * The `event_type` the WRITE-FAILURE log line must name. Identical to
   * `expectedEventType` for the audit table; the open-events table has no
   * event_type COLUMN, but the log line still needs a logical name for it,
   * and the primitive supplies 'session_opened'.
   */
  logEventType: string;
  /** Columns the persisted row must carry beyond session_id. */
  requiredKeys: string[];
  /** True when the caller receives an HTTP response we can inspect. */
  http: boolean;
  /**
   * The status the caller must now receive when the audit write FAILS. 200 for
   * every degrade site; 503 for the analyze route, whose audit rows ARE the
   * rate limiter's state, so silence there fails the limit OPEN on the one
   * route in this app that spends Anthropic tokens.
   */
  faultStatus: number;
  /** Runs in mode 'ok' BEFORE counters reset and console capture starts. */
  prepare?: (mode: Mode) => Promise<void>;
  invoke: () => Promise<Invocation>;
}

// Module handles, resolved in run() after env points at the stub.
/* eslint-disable @typescript-eslint/no-explicit-any */
let routeSaveStep: any;
let routeSession: any;
let routeSubmit: any;
let routeAnalyze: any;
let serverMod: any;
let NextRequestCtor: any;
/* eslint-enable @typescript-eslint/no-explicit-any */

/**
 * A REAL AM-bypass signature for SESSION_ID, minted with the app's own signer
 * (am-bypass.ts) once the environment is final — getCookieSecret() falls back
 * to SUPABASE_SERVICE_ROLE_KEY, which this run randomises per pass, so the
 * signature cannot be a constant copied into this file. A hand-written string
 * would simply fail verification and silently test the NON-bypass path, which
 * is the exact mistake this coverage exists to close.
 */
let AM_BYPASS_SIG = '';

/**
 * Evidence that the header dimension was really applied, asserted at 12d in
 * BOTH directions so neither "we forgot the headers" nor "we accidentally sent
 * them in the plain passes" can pass unnoticed.
 */
const REQUEST_HEADER_PIN = {
  applied: false,
  requestsBuilt: 0,
  sampleXVercelId: null as string | null,
};

/**
 * Every Request the drivers build goes through here, so the edge-header set is
 * a PASS-WIDE dimension rather than something sprinkled on one driver. In pass
 * 'vercel' the documented Vercel proxy headers are applied first and the
 * driver's own headers win on conflict (so the session route's deliberate
 * `x-forwarded-for` still drives ip_hash).
 */
function makeRequest(url: string, init?: RequestInit): Request {
  REQUEST_HEADER_PIN.requestsBuilt++;
  if (ENV_PASS !== 'vercel') return new NextRequestCtor(url, init);

  const headers = new Headers(VERCEL_EDGE_HEADERS);
  if (init?.headers) {
    for (const [k, v] of new Headers(init.headers as HeadersInit).entries()) headers.set(k, v);
  }
  const req: Request = new NextRequestCtor(url, { ...init, headers });
  REQUEST_HEADER_PIN.applied = true;
  REQUEST_HEADER_PIN.sampleXVercelId = req.headers.get('x-vercel-id');
  return req;
}

async function readBody(res: Response): Promise<unknown> {
  try {
    return await res.json();
  } catch {
    return null;
  }
}

async function driveSaveStep(): Promise<Invocation> {
  capturedAfterTasks = [];
  const req = makeRequest('http://localhost/api/public/onboarding/save-step', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      token: TOKEN,
      stepKey: 'business_overview',
      stepIndex: 0,
      answers: { business_name: 'Fault Injection Co' },
      completed: false,
    }),
  });
  const res: Response = await inRequestScope(() => routeSaveStep.POST(req));
  return { status: res.status, body: await readBody(res) };
}

function sessionRequest(): Request {
  return makeRequest(`http://localhost/api/public/onboarding/session?token=${TOKEN}`, {
    method: 'GET',
    headers: {
      'user-agent': 'audit-fault-injector/1.0',
      'x-forwarded-for': '203.0.113.7',
    },
  });
}

/**
 * SITE 2's driver. The session route no longer writes `session_accessed`
 * inline: both of its tracking writes moved into the ONE after() registration
 * that already existed for the open event, so the audit write is now
 * STRUCTURALLY unable to reach the response (and one Supabase round trip came
 * off form-load latency).
 *
 * That means driving the exported GET is no longer enough to reach the write,
 * so this driver runs the route's OWN captured after() task as well — the same
 * route-to-after()-to-primitive wiring sites 5 and 6 put under test. Delete the
 * `after(...)` in the session route and this site fails, as it must.
 *
 * The HTTP response is still what is returned, so the caller-status assertion
 * keeps measuring the real caller.
 */
async function driveSessionAndRunAfter(): Promise<Invocation> {
  capturedAfterTasks = [];
  const res: Response = await inRequestScope(() => routeSession.GET(sessionRequest()));
  const invocation: Invocation = { status: res.status, body: await readBody(res) };
  const tasks = capturedAfterTasks.filter(Boolean);
  const task = tasks[0] ?? makeMissingTaskDriver('session tracking writes');
  await task();
  return invocation;
}

async function driveSubmit(): Promise<Invocation> {
  capturedAfterTasks = [];
  const req = makeRequest('http://localhost/api/public/onboarding/submit', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ token: TOKEN }),
  });
  const res: Response = await inRequestScope(() => routeSubmit.POST(req));
  return { status: res.status, body: await readBody(res) };
}

async function driveAnalyze(): Promise<Invocation> {
  return driveAnalyzeAs(false);
}

// ---------------------------------------------------------------------------
// 7a. AM-BYPASS variants of the same drivers (Sprint 2 / #4 scoping).
// ---------------------------------------------------------------------------
// Four call sites gate behaviour on `isAmBypass`, and the fail-closed 503 on
// the analyze route is scoped to the NON-bypass branch. That scoping was
// shipped unverified: with no bypass request in the harness, neither half of
// the rule was covered, so "an AM is never 503'd by a limiter that does not
// apply to them" was a claim, not a measurement. Each driver below takes the
// bypass as a parameter so the SAME code path is driven both ways and the
// difference is attributable to the signature alone.
//
// The mutating routes read the signature from the `x-am-bypass` header; the
// session-load GET reads it from the `am` query param. Both are what the real
// client sends (am-bypass.ts:73-84), so the drivers use each route's own
// channel rather than one convenient channel for all of them.
async function driveAnalyzeAs(bypass: boolean): Promise<Invocation> {
  capturedAfterTasks = [];
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bypass) headers['x-am-bypass'] = AM_BYPASS_SIG;
  const req = makeRequest('http://localhost/api/public/site-intelligence/analyze', {
    method: 'POST',
    headers,
    body: JSON.stringify({ token: TOKEN, websiteUrl: 'faultco.invalid' }),
  });
  const res: Response = await inRequestScope(() => routeAnalyze.POST(req));
  return { status: res.status, body: await readBody(res) };
}

async function driveSaveStepAs(bypass: boolean): Promise<Invocation> {
  capturedAfterTasks = [];
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bypass) headers['x-am-bypass'] = AM_BYPASS_SIG;
  const req = makeRequest('http://localhost/api/public/onboarding/save-step', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      token: TOKEN,
      stepKey: 'business_overview',
      stepIndex: 0,
      answers: { business_name: 'Fault Injection Co' },
      completed: false,
    }),
  });
  const res: Response = await inRequestScope(() => routeSaveStep.POST(req));
  return { status: res.status, body: await readBody(res) };
}

async function driveSubmitAs(bypass: boolean): Promise<Invocation> {
  capturedAfterTasks = [];
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (bypass) headers['x-am-bypass'] = AM_BYPASS_SIG;
  const req = makeRequest('http://localhost/api/public/onboarding/submit', {
    method: 'POST',
    headers,
    body: JSON.stringify({ token: TOKEN }),
  });
  const res: Response = await inRequestScope(() => routeSubmit.POST(req));
  return { status: res.status, body: await readBody(res) };
}

/**
 * The session-load GET under bypass. Returns the after() tasks it registered,
 * because THAT is the observable: under bypass the route must register NONE,
 * so there is no scheduled tracking work at all rather than scheduled work
 * that then decides to do nothing.
 */
async function driveSessionAs(bypass: boolean): Promise<{ status: number; afterTasks: number }> {
  capturedAfterTasks = [];
  const url =
    `http://localhost/api/public/onboarding/session?token=${TOKEN}` +
    (bypass ? `&am=${encodeURIComponent(AM_BYPASS_SIG)}` : '');
  const req = makeRequest(url, {
    method: 'GET',
    headers: { 'user-agent': 'audit-fault-injector/1.0', 'x-forwarded-for': '203.0.113.7' },
  });
  const res: Response = await inRequestScope(() => routeSession.GET(req));
  return { status: res.status, afterTasks: capturedAfterTasks.filter(Boolean).length };
}

// --- sites 5 and 6: driven by the submit route's OWN after() registrations --
//
// Importing fireDashboardClientBridge / exportSubmissionToSheet and calling
// them directly would prove the libraries audit their failures while saying
// NOTHING about whether a submission still schedules them. Deleting both
// `after(...)` lines in submit/route.ts must fail this harness, so the
// route's registrations ARE the drivers.
let submitAfterTasks: AfterTask[] = [];

function makeMissingTaskDriver(which: string): AfterTask {
  return () => {
    throw new Error(
      `submit route did not register the expected after() task (${which}) — ` +
        `the route→after()→library wiring is broken, so this audit event ` +
        `would never fire in production`,
    );
  };
}

async function prepareSubmitAfterTasks(mode: Mode, site: string, expected: number): Promise<void> {
  capturedAfterTasks = [];
  await driveSubmit();
  submitAfterTasks = capturedAfterTasks.filter(Boolean);
  assert(
    submitAfterTasks.length === expected,
    `[${site} | ${mode}] submit route registered exactly ${expected} after() tasks`,
    `got ${submitAfterTasks.length} (stub saw: ${stub.requestLog.join(' | ')})`,
  );
}

async function driveBridgeViaAfter(): Promise<Invocation> {
  // after() task #0 = fireDashboardClientBridge(session). The stub's
  // /api/clients returns 500, so the bridge takes its
  // `dashboard_sync_failed` → recordAuditEvent path (safeAudit is gone).
  const task = submitAfterTasks[0] ?? makeMissingTaskDriver('dashboard bridge');
  await task();
  return {};
}

async function driveSheetExportViaAfter(): Promise<Invocation> {
  // after() task #1 = exportSubmissionToSheet(session). The Google JWT is
  // signed with a bogus private key, so the Sheets call fails locally (no
  // network) → outer catch → recordAuditEvent('sheet_export_failed').
  //
  // WHAT THE INDEX PINS, stated correctly. `submitAfterTasks[1]` pins
  // REGISTRATION order — which callback the submit route handed to after()
  // second — and nothing more. It does NOT pin execution order, and no such
  // ordering exists: AfterContext queues callbacks on `new PQueue()` with no
  // options (next/dist/server/after/after-context.js), i.e. the p-queue
  // default of concurrency Infinity, so in production both callbacks run
  // CONCURRENTLY. Driving them one at a time here is a measurement choice
  // (one site's writes per window), not a claim about the runtime.
  //
  // Swapping the two registrations still fails THIS site, because its body
  // assertion would then see event_type 'dashboard_sync_failed' — that is a
  // registration-identity check, which is exactly what after() guarantees.
  const task = submitAfterTasks[1] ?? makeMissingTaskDriver('sheet export');
  await task();
  return {};
}

/**
 * Shared by sites 2 and 7: the session route must register EXACTLY ONE after()
 * task, which carries BOTH tracking writes. One registration is the contract —
 * splitting them into two would be a second scheduled unit of work per page
 * load, and collapsing them to zero would delete the writes entirely.
 */
let sessionAfterTask: AfterTask | null = null;

async function prepareSessionAfterTask(mode: Mode, siteKey: string): Promise<void> {
  capturedAfterTasks = [];
  await inRequestScope(() => routeSession.GET(sessionRequest()));
  const tasks = capturedAfterTasks.filter(Boolean);
  assert(
    tasks.length === 1,
    `[${siteKey} | ${mode}] session route registered exactly 1 after() task carrying BOTH tracking writes`,
    `got ${tasks.length} (stub saw: ${stub.requestLog.join(' | ')})`,
  );
  sessionAfterTask = tasks[0] ?? makeMissingTaskDriver('session tracking writes');
}

/**
 * Site 7: recordOpenEvent, driven through the session route's real after().
 * The task also issues the (unfaulted, succeeding) session_accessed write,
 * which lands in this window and is filtered out by table.
 */
async function driveOpenEvent(): Promise<Invocation> {
  if (!sessionAfterTask) throw new Error('sessionAfterTask missing — prepare did not run');
  await sessionAfterTask();
  return {};
}

// ---------------------------------------------------------------------------
// 7b. Wire witness — spy the client the primitive itself uses.
// ---------------------------------------------------------------------------
// The old witness issued its OWN raw insert. That proves the stub faulted;
// it proves nothing about what the primitive experienced, and stays green
// even if the primitive is gutted. This instead wraps
// PostgrestBuilder.prototype.then — the exact await inside attemptAuditWrite —
// and records the { status, error } that the primitive receives and drops.
interface WitnessEntry {
  method: string;
  path: string;
  status?: number;
  code?: string;
  message?: string;
  rejected: boolean;
}
let witnessLog: WitnessEntry[] = [];

function installPostgrestWitness(): void {
  const client = serverMod.createServiceRoleClient();
  // Building the query sends nothing — PostgrestBuilder is lazy until awaited.
  const builder = client.from('__witness_probe__').insert({});
  let proto = Object.getPrototypeOf(builder);
  while (proto && !Object.prototype.hasOwnProperty.call(proto, 'then')) {
    proto = Object.getPrototypeOf(proto);
  }
  if (!proto) {
    throw new Error('wire witness could not find PostgrestBuilder.prototype.then — cannot spy the primitive');
  }
  const originalThen = proto.then;
  /* eslint-disable @typescript-eslint/no-explicit-any */
  proto.then = function patchedThen(this: any, onFulfilled?: any, onRejected?: any) {
    // The alias is deliberate: `describe()` is called from inside the two
    // settlement callbacks below, where `this` is no longer the builder.
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    const describe = () => ({
      method: String(self?.method ?? '?'),
      path: (() => {
        try {
          return String(new URL(String(self?.url)).pathname);
        } catch {
          return String(self?.url ?? '?');
        }
      })(),
    });
    return originalThen.call(
      this,
      (res: any) => {
        try {
          witnessLog.push({
            ...describe(),
            status: res?.status,
            code: res?.error?.code,
            message: res?.error?.message,
            rejected: false,
          });
        } catch {
          /* the witness must never break the call it observes */
        }
        return onFulfilled ? onFulfilled(res) : res;
      },
      (err: any) => {
        try {
          witnessLog.push({
            ...describe(),
            status: err?.status,
            code: err?.code,
            message: err instanceof Error ? err.message : String(err),
            rejected: true,
          });
        } catch {
          /* ditto */
        }
        if (onRejected) return onRejected(err);
        throw err;
      },
    );
  };
  /* eslint-enable @typescript-eslint/no-explicit-any */
}

function witnessAuditPosts(): WitnessEntry[] {
  return witnessLog.filter((e) => e.method === 'POST' && e.path === '/rest/v1/onboarding_audit_events');
}

// ---------------------------------------------------------------------------
// 7c. Metadata the direct probes hand the primitives.
// ---------------------------------------------------------------------------
// The primitives now REQUIRE per-call-site metadata (route, what succeeded,
// optional client id) so a WRITE-FAILURE line is actionable without a second
// query. The probes below are not call sites, so they supply their own.
const WIRE_WITNESS_META = {
  clientId: CLIENT_ID,
  route: 'harness: wire witness',
  succeeded: 'nothing: this probe exists only to read what the primitive receives',
};
const DIRECT_PROBE_META = {
  clientId: CLIENT_ID,
  route: 'harness: direct primitive probe',
  succeeded: 'nothing: this probe writes no application data',
};

/**
 * The AuditWriteError.fault shape, read STRUCTURALLY. This file deliberately
 * imports no types from the code under test, so a type that quietly changed
 * shape cannot make an assertion here vacuously true.
 */
interface AuditFaultShape {
  kind?: string;
  status?: number | null;
  code?: string | null;
  message?: string;
}

// ---------------------------------------------------------------------------
// 8. Truth-table row shape.
// ---------------------------------------------------------------------------
interface Row {
  site: string;
  /** A fault MODE, or the read-side probe's own label — the write modes do not name it. */
  mode: Mode | 'count_read';
  threw: boolean;
  thrownMessage?: string;
  loggedLines: string[];
  responseStatus?: number;
  reachedWrite: boolean;
  writeCount: number;
  rowPersisted: string;
}

const rows: Row[] = [];

// ---------------------------------------------------------------------------
// 9. Run.
// ---------------------------------------------------------------------------
async function run(): Promise<void> {
  const server = await startStub();
  const port = (server.address() as AddressInfo).port;
  const origin = `http://127.0.0.1:${port}`;

  // Env MUST be final before src/lib/supabase/server.ts is imported — it
  // snapshots both values into module-level consts at line 6-7.
  process.env.NEXT_PUBLIC_SUPABASE_URL = origin;
  // Per-run and per-pass, so the stub's credential check cannot be satisfied
  // by a hard-coded string copied out of this file.
  SERVICE_ROLE_KEY = `fault-injection-service-role-${ENV_PASS}-${port}-${Math.random()
    .toString(36)
    .slice(2, 14)}`;
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = `fault-injection-ANON-key-${port}`;
  process.env.SUPABASE_ANON_KEY = `fault-injection-ANON-key-${port}`;
  process.env.DASHBOARD_BASE_URL = origin;
  process.env.SHARED_INTEGRATION_BEARER_TOKEN = 'fault-injection-bearer';
  process.env.GOOGLE_SHEETS_CLIENT_EMAIL = 'fault@injector.invalid';
  // THE DEFAULT KEY STAYS BOGUS. Site 6 is contracted on the LOCAL rejection
  // it produces (google-auth-library's jws sign refuses it before a socket is
  // opened), so swapping in a signable key globally would silently change what
  // that site measures. The signable key below is installed only for the
  // duration of the Google cases and removed again afterwards.
  process.env.GOOGLE_SHEETS_PRIVATE_KEY = BOGUS_GOOGLE_KEY;
  process.env.EXPORT_SHEET_ID = 'fault-injection-sheet';
  googleStubOrigin = origin;

  // The bail is deliberately far above the sum of every deliberate stall this
  // harness now injects. Each Supabase stall costs its 5s bound, each Google
  // stall its 8s bound, and there are enough of both that a 120s ceiling would
  // start failing runs for being thorough rather than for being broken.
  //
  // AUD-7: `emergencyOut`, not `out`/`realConsoleLog`. A hang almost always
  // happens INSIDE a driver, i.e. inside `withCapture`, and a capture replaces
  // process.stdout.write without calling through — so the old bail message was
  // swallowed by the very mechanism that was supposed to be recording the
  // failure, and the run exited 1 with an empty transcript.
  const bail = setTimeout(() => {
    emergencyOut('\nTIMEOUT: harness exceeded 300s — failing loudly rather than hanging.');
    process.exit(1);
  }, 300_000);

  try {
    workAsyncStorage = (
      await import('next/dist/server/app-render/work-async-storage.external.js')
    ).workAsyncStorage as typeof workAsyncStorage;
    NextRequestCtor = (await import('next/server')).NextRequest;

    serverMod = await import('./server');
    routeSaveStep = await import('@/app/api/public/onboarding/save-step/route');
    routeSession = await import('@/app/api/public/onboarding/session/route');
    routeSubmit = await import('@/app/api/public/onboarding/submit/route');
    routeAnalyze = await import('@/app/api/public/site-intelligence/analyze/route');

    installPostgrestWitness();

    // Minted from the app's own signer, AFTER the env pin above, so it is a
    // signature the routes will really verify rather than a literal that would
    // fail closed into the non-bypass path.
    AM_BYPASS_SIG = (await import('@/lib/onboarding/am-bypass')).signAmBypass(SESSION_ID);

    const sites: Site[] = [
      {
        key: '1 save-step route → step_saved',
        faultTable: 'onboarding_audit_events',
        expectedEventType: 'step_saved',
        logEventType: 'step_saved',
        requiredKeys: ['event_type', 'payload'],
        http: true,
        faultStatus: 200, // LOG AND CONTINUE: the answers are already persisted
        invoke: driveSaveStep,
      },
      {
        key: '2 session route → session_accessed',
        faultTable: 'onboarding_audit_events',
        expectedEventType: 'session_accessed',
        logEventType: 'session_accessed',
        requiredKeys: ['event_type', 'payload'],
        http: true,
        faultStatus: 200, // LOG AND CONTINUE
        prepare: (mode) => prepareSessionAfterTask(mode, '2 session route → session_accessed'),
        invoke: driveSessionAndRunAfter,
      },
      {
        key: '3 submit route → session_submitted',
        faultTable: 'onboarding_audit_events',
        expectedEventType: 'session_submitted',
        logEventType: 'session_submitted',
        requiredKeys: ['event_type', 'payload'],
        http: true,
        faultStatus: 200, // DEGRADE, LOUDLY: the submission is already committed
        invoke: driveSubmit,
      },
      {
        key: '4 analyze route → site_intelligence_analyze_requested',
        faultTable: 'onboarding_audit_events',
        expectedEventType: 'site_intelligence_analyze_requested',
        logEventType: 'site_intelligence_analyze_requested',
        requiredKeys: ['event_type', 'payload'],
        http: true,
        faultStatus: 503, // FAIL CLOSED: these rows ARE the rate limiter's state
        invoke: driveAnalyze,
      },
      {
        key: '5 submit after() → dashboard-bridge → dashboard_sync_failed',
        faultTable: 'onboarding_audit_events',
        expectedEventType: 'dashboard_sync_failed',
        logEventType: 'dashboard_sync_failed',
        requiredKeys: ['event_type', 'payload'],
        http: false,
        faultStatus: 200,
        prepare: (mode) =>
          prepareSubmitAfterTasks(mode, '5 submit after() → dashboard-bridge → dashboard_sync_failed', 2),
        invoke: driveBridgeViaAfter,
      },
      {
        key: '6 submit after() → sheet-export → sheet_export_failed',
        faultTable: 'onboarding_audit_events',
        expectedEventType: 'sheet_export_failed',
        logEventType: 'sheet_export_failed',
        requiredKeys: ['event_type', 'payload'],
        http: false,
        faultStatus: 200,
        prepare: (mode) =>
          prepareSubmitAfterTasks(mode, '6 submit after() → sheet-export → sheet_export_failed', 2),
        invoke: driveSheetExportViaAfter,
      },
      {
        key: '7 session after() → recordOpenEvent',
        faultTable: 'onboarding_open_events',
        expectedEventType: null, // open events have no event_type column
        logEventType: 'session_opened',
        requiredKeys: ['user_agent', 'ip_hash'],
        http: false,
        faultStatus: 200,
        prepare: (mode) => prepareSessionAfterTask(mode, '7 session after() → recordOpenEvent'),
        invoke: driveOpenEvent,
      },
    ];

    const modes: Mode[] = ['ok', 'unreachable', 'rls_denied', 'stall', 'gateway_html'];
    /** site key -> the console signature of its healthy (mode 'ok') run. */
    const consoleBaseline = new Map<string, string>();

    /**
     * TERMINATION BUDGET for the stall mode. The degrade bound is 2s and the
     * fail-closed bound is 5s (server.ts), so 20s is generous enough that a
     * slow machine cannot flake it and tight enough that "it never resolved"
     * — the pre-fix behaviour, which ran until the 120s harness bail — fails
     * it. This is the assertion that says the primitives are TERMINATING and
     * not merely total.
     */
    const TERMINATION_BUDGET_MS = 20_000;

    for (const site of sites) {
      for (const mode of modes) {
        stub.faultTable = site.faultTable;
        stub.faultTableSecondary = null;

        out(`\n--- ${site.key}  [mode=${mode}]  faultTable=${site.faultTable} ---`);

        const windowLabel = `${site.key} | ${mode}`;

        if (site.prepare) {
          // Setup traffic is EXPLAINED but is not the measurement: it is
          // stamped with its own label, so it is neither a stray nor
          // eligible to satisfy the measurement window's assertions. It also
          // runs HEALTHY, so the fault applies only to the measured call.
          labelWriteWindow(`setup: ${windowLabel}`);
          stub.mode = 'ok';
          await site.prepare(mode);
        }
        stub.mode = mode;
        // ATTRIBUTION (D7): drain, then prove nothing arrived unattributed
        // since the previous window closed.
        const opened = await openWriteWindow(windowLabel);

        const startedAt = Date.now();
        const outcome = await withCapture(() => site.invoke());
        const elapsedMs = Date.now() - startedAt;
        // Anything that arrives after this point belongs to no site and is
        // collected as a stray rather than credited to the next one.
        closeWriteWindow();

        // Only writes STAMPED WITH THIS WINDOW count. A body that arrived
        // before the window opened, or after it closed, can never satisfy
        // this site's assertions.
        const mine = stub.writes.filter(
          (w) => w.table === site.faultTable && w.window === windowLabel,
        );
        const writeCount = mine.length;
        const lines = allLines(outcome.captured);

        // --- ROW EVIDENCE ---------------------------------------------------
        const allowedKeys = KNOWN_COLUMNS[site.faultTable];
        if (!allowedKeys) {
          throw new Error(
            `no DDL recorded for ${site.faultTable} — refusing to assert on a schema this harness has not read`,
          );
        }
        const verdict = verifyWriteBody(mine[0]?.parsed, {
          table: site.faultTable,
          expectedEventType: site.expectedEventType,
          requiredKeys: site.requiredKeys,
          allowedKeys,
        });

        const row: Row = {
          site: site.key,
          mode,
          threw: outcome.threw,
          thrownMessage: outcome.threw
            ? outcome.error instanceof Error
              ? `${outcome.error.name}: ${outcome.error.message}`
              : String(outcome.error)
            : undefined,
          loggedLines: lines,
          responseStatus: outcome.result?.status,
          reachedWrite: writeCount > 0,
          writeCount,
          rowPersisted: verdict.ok ? 'yes' : 'NO',
        };
        rows.push(row);

        // --- assertions (THE FIXED CONTRACT) --------------------------------

        // ATTRIBUTION: the window this site measured in really was empty
        // when it opened, so nothing below can be crediting a predecessor's
        // write.
        assert(
          opened.empty,
          `[${site.key} | ${mode}] the measurement window opened EMPTY (no straggler from the previous site)`,
          opened.leftovers,
        );

        // Trap-avoidance evidence: the handler really reached the audit write.
        assert(
          writeCount === 1,
          `[${site.key} | ${mode}] stub received exactly 1 POST /rest/v1/${site.faultTable}`,
          `got ${writeCount} (stub saw: ${stub.requestLog.join(' | ')})`,
        );

        // CREDENTIAL evidence (D2): the write authenticated as service-role.
        // Downgrade the primitive to an anon-key client and production
        // refuses the row with SQLSTATE 42501 — the exact body this harness
        // injects as `rls_denied`, i.e. silent. The stub answers 403 to a
        // bad credential, but the code under test IGNORES errors, so a 403
        // alone changes nothing observable. This is the assertion that sees it.
        assert(
          writeCount === 1 && mine[0]?.credentialOk === true,
          `[${site.key} | ${mode}] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential`,
          `apikey=${JSON.stringify(mine[0]?.apikey ?? null)} authorization=${JSON.stringify(
            mine[0]?.authorization ?? null,
          )} expectedApikeyLen=${SERVICE_ROLE_KEY.length}`,
        );

        // ROW evidence: that POST would have persisted the RIGHT row. A
        // transport counter cannot tell an insert from an insert of nothing,
        // nor a valid row from one carrying a column the table lacks.
        assert(
          verdict.ok,
          `[${site.key} | ${mode}] the POST body persists ≥1 row for this session with event_type=${
            site.expectedEventType ?? '(none — open event)'
          } and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)`,
          `${verdict.reason} (raw: ${JSON.stringify(mine[0]?.raw ?? null)?.slice(0, 300)})`,
        );

        // THE DRIVER MUST NOT THROW. Every disposition surfaces the fault as
        // a RESPONSE and a LOG LINE, never as an exception escaping the
        // handler — including the analyze route, which converts the
        // AuditWriteError into a 503 at the call site, ABOVE the generic catch
        // that would otherwise flatten it into an opaque 500.
        assert(
          outcome.threw === false,
          `[${site.key} | ${mode}] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception`,
          `threw=${outcome.threw}${row.thrownMessage ? ` :: ${row.thrownMessage}` : ''}`,
        );

        // THE INVERTED ASSERTION. It used to read "byte-identical to the
        // healthy baseline"; that WAS the bug, stated as a contract. A fault
        // mode must now DIFFER from the healthy run, and the difference must
        // be the structured failure line an operator can act on.
        if (mode === 'ok') {
          consoleBaseline.set(site.key, consoleSignature(lines));
          assert(
            auditFailureLines(outcome.captured).length === 0,
            `[${site.key} | ok] healthy run logs nothing about an audit failure (console baseline recorded)`,
            `baseline=${consoleSignature(lines)}`,
          );
        } else {
          const base = consoleBaseline.get(site.key) ?? '<<baseline missing>>';
          const now = consoleSignature(lines);
          assert(
            now !== base,
            `[${site.key} | ${mode}] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator`,
            `baseline=${base} actual=${now}`,
          );
          const lineVerdict = verifyFailureLine(
            writeFailureLines(outcome.captured),
            siteExpectation(site, mode),
          );
          assert(
            lineVerdict.ok,
            `[${site.key} | ${mode}] exactly one ${WRITE_FAILURE_TAG} line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed`,
            lineVerdict.reason,
          );
        }

        // TERMINATION (the R2 gap). A stall is the one fault shape that used
        // to freeze the function outright: TOTAL but not TERMINATING. This is
        // the assertion that says the bound in server.ts actually bounds, and
        // it is deliberately paired with the WRITE-FAILURE assertion above —
        // terminating quietly would be no better than hanging loudly.
        if (mode === 'stall') {
          assert(
            elapsedMs < TERMINATION_BUDGET_MS,
            `[${site.key} | stall] a PostgREST that accepts the write and NEVER answers still TERMINATES this site (bounded by .abortSignal(AbortSignal.timeout), not by undici's 300s default)`,
            `elapsed ${elapsedMs}ms, budget ${TERMINATION_BUDGET_MS}ms`,
          );
        }

        if (site.http) {
          const expectedStatus = mode === 'ok' ? 200 : site.faultStatus;
          assert(
            outcome.result?.status === expectedStatus,
            `[${site.key} | ${mode}] caller received HTTP ${expectedStatus}`,
            `got ${outcome.result?.status}; body=${JSON.stringify(outcome.result?.body)?.slice(0, 300)}`,
          );
        }
      }
    }

    // -----------------------------------------------------------------------
    // 10. Wire witness — the resolved shape the normaliser is written against.
    // -----------------------------------------------------------------------
    out('\n--- wire witness: the resolved { error, status } the normaliser must map ---');
    stub.faultTable = 'onboarding_audit_events';

    stub.mode = 'unreachable';
    await openWriteWindow('wire witness | unreachable');
    witnessLog = [];
    // Captured, not because the line is under test here, but because
    // recordAuditEvent is LOUD now and its console.error would otherwise
    // interleave into this harness's own transcript.
    const wireUnreachable = await withCapture(async () => {
      await serverMod.recordAuditEvent(SESSION_ID, 'wire_witness', { probe: true }, WIRE_WITNESS_META);
      return {};
    });
    for (const l of allLines(wireUnreachable.captured)) out(`    (primitive said) ${l}`);
    const unreachableSeen = witnessAuditPosts();
    out(`    unreachable → ${JSON.stringify(unreachableSeen)}`);
    assert(
      unreachableSeen.length === 1,
      `[wire witness | unreachable] recordAuditEvent issued exactly 1 insert through the spied service-role client`,
      `saw ${JSON.stringify(witnessLog)}`,
    );
    assert(
      unreachableSeen[0]?.status === 0,
      `[wire witness | unreachable] the primitive received status 0 (PostgrestBuilder.ts:225 catch → :259 status 0, no throw)`,
      `got ${JSON.stringify(unreachableSeen[0]?.status)}`,
    );
    assert(
      typeof unreachableSeen[0]?.message === 'string' &&
        /fetch failed|socket|ECONN|terminated/i.test(String(unreachableSeen[0]?.message)),
      `[wire witness | unreachable] the primitive received a synthesised fetch-layer error`,
      `got ${JSON.stringify(unreachableSeen[0]?.message)}`,
    );

    stub.mode = 'rls_denied';
    await openWriteWindow('wire witness | rls_denied');
    witnessLog = [];
    const wireRls = await withCapture(async () => {
      await serverMod.recordAuditEvent(SESSION_ID, 'wire_witness', { probe: true }, WIRE_WITNESS_META);
      return {};
    });
    for (const l of allLines(wireRls.captured)) out(`    (primitive said) ${l}`);
    const rlsSeen = witnessAuditPosts();
    out(`    rls_denied  → ${JSON.stringify(rlsSeen)}`);
    assert(
      rlsSeen.length === 1,
      `[wire witness | rls_denied] recordAuditEvent issued exactly 1 insert through the spied service-role client`,
      `saw ${JSON.stringify(witnessLog)}`,
    );
    assert(
      rlsSeen[0]?.status === 403,
      `[wire witness | rls_denied] the primitive received status 403`,
      `got ${JSON.stringify(rlsSeen[0]?.status)}`,
    );
    assert(
      rlsSeen[0]?.code === '42501',
      `[wire witness | rls_denied] the primitive received the verbatim PostgREST body incl. SQLSTATE 42501`,
      `got ${JSON.stringify(rlsSeen[0]?.code)}`,
    );
    assert(
      rlsSeen[0]?.rejected === false && unreachableSeen[0]?.rejected === false,
      `[wire witness] BOTH fault classes RESOLVE rather than reject, which is why the normaliser is written against a resolved-value contract and NOT against a rejection contract`,
      `unreachable.rejected=${unreachableSeen[0]?.rejected} rls.rejected=${rlsSeen[0]?.rejected}`,
    );

    // -----------------------------------------------------------------------
    // 11. Direct primitive probes: the two entry points, against real faults.
    // -----------------------------------------------------------------------
    // The site matrix drives the primitives through their call sites. These
    // probe them directly, because the two entry points have DIFFERENT
    // contracts and only one of them is exercised by six of the seven sites:
    //
    //   recordAuditEvent          total. Never throws, under any input,
    //                             INCLUDING around client construction, and
    //                             logs INSIDE ITSELF so loudness never depends
    //                             on the caller remembering to.
    //   insertAuditEventOrThrow   throws AuditWriteError carrying the SAME
    //                             normalised fault, and logs nothing, because
    //                             its caller owns the response and the line.
    //
    // Two fault classes are probed: a genuinely dead host (the transport
    // class), and the ONE genuine rejection path in this code, a
    // createServiceRoleClient() that throws 'Missing Supabase environment
    // variables' (server.ts:11) BEFORE any query is built, which must be
    // re-emitted as fault kind 'client_init' rather than escaping raw from a
    // different frame than every other failure.
    out('\n--- direct probe: both entry points against a genuinely closed port 127.0.0.1:1 ---');
    const savedUrl = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = 'http://127.0.0.1:1';
    // server.ts snapshots the URL at module load, so re-import a FRESH copy
    // of the module graph with the dead URL in place.
    const deadMod = await import(`./server?closedport=${Date.now()}`);
    witnessLog = [];
    const probe = await withCapture(async () => {
      await deadMod.recordAuditEvent(SESSION_ID, 'closed_port_probe', { probe: true }, DIRECT_PROBE_META);
      return {};
    });
    const probeLines = allLines(probe.captured);
    const probeFailure = writeFailureLines(probe.captured);

    const throwProbe = await withCapture(async () => {
      await deadMod.insertAuditEventOrThrow(
        SESSION_ID,
        'closed_port_probe',
        { probe: true },
        DIRECT_PROBE_META,
      );
      return {};
    });
    process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl;

    out(`    recordAuditEvent        threw=${probe.threw}  logged=${JSON.stringify(probeLines)}`);
    out(
      `    insertAuditEventOrThrow threw=${throwProbe.threw}  error=${
        throwProbe.error instanceof Error
          ? `${throwProbe.error.name}: ${throwProbe.error.message}`
          : String(throwProbe.error)
      }  logged=${JSON.stringify(allLines(throwProbe.captured))}`,
    );
    rows.push({
      site: '0 recordAuditEvent (direct primitive)',
      mode: 'unreachable' as Mode,
      threw: probe.threw,
      thrownMessage: probe.threw ? String(probe.error) : undefined,
      loggedLines: probeLines,
      responseStatus: undefined,
      reachedWrite: false, // no stub involved: the host is genuinely dead
      writeCount: 0,
      rowPersisted: 'n/a',
    });
    rows.push({
      site: '0 insertAuditEventOrThrow (direct primitive)',
      mode: 'unreachable' as Mode,
      threw: throwProbe.threw,
      thrownMessage: throwProbe.threw
        ? throwProbe.error instanceof Error
          ? `${throwProbe.error.name}: ${throwProbe.error.message}`
          : String(throwProbe.error)
        : undefined,
      loggedLines: allLines(throwProbe.captured),
      responseStatus: undefined,
      reachedWrite: false,
      writeCount: 0,
      rowPersisted: 'n/a',
    });

    const deadHostFault = (throwProbe.error as { fault?: AuditFaultShape } | undefined)?.fault;
    assert(
      witnessAuditPosts().length === 2,
      `[direct probe | dead host] both entry points still issued their insert against the dead host`,
      `witness=${JSON.stringify(witnessLog)}`,
    );
    assert(
      probe.threw === false,
      `[direct probe | dead host] recordAuditEvent does NOT throw`,
      `threw=${probe.threw} :: ${String(probe.error)}`,
    );
    assert(
      probeFailure.length === 1 &&
        probeFailure[0]?.channel === 'error' &&
        probeFailure[0]?.parsed?.fault === 'transport' &&
        probeFailure[0]?.parsed?.status === 0 &&
        probeFailure[0]?.parsed?.pg_code === null,
      `[direct probe | dead host] recordAuditEvent LOGS one ${WRITE_FAILURE_TAG} line itself, naming fault=transport status=0 and a NULL pg_code (postgrest-js sets code to the EMPTY STRING, which the normaliser converts rather than keeps)`,
      `lines=${JSON.stringify(probeLines)}`,
    );
    assert(
      throwProbe.threw === true &&
        throwProbe.error instanceof Error &&
        throwProbe.error.name === 'AuditWriteError' &&
        deadHostFault?.kind === 'transport' &&
        deadHostFault?.status === 0 &&
        deadHostFault?.code === null,
      `[direct probe | dead host] insertAuditEventOrThrow THROWS an AuditWriteError carrying the same normalised transport fault`,
      `threw=${throwProbe.threw} error=${String(throwProbe.error)} fault=${JSON.stringify(deadHostFault ?? null)}`,
    );
    assert(
      allLines(throwProbe.captured).length === 0,
      `[direct probe | dead host] insertAuditEventOrThrow logs NOTHING itself: the throwing entry point leaves the line to the caller that owns the response`,
      `got ${JSON.stringify(allLines(throwProbe.captured))}`,
    );

    // --- the ONE genuine rejection path: createServiceRoleClient() ---------
    out('\n--- direct probe: the createServiceRoleClient rejection (server.ts:11), the one genuine throw ---');
    const savedUrl2 = process.env.NEXT_PUBLIC_SUPABASE_URL;
    process.env.NEXT_PUBLIC_SUPABASE_URL = '';
    const noEnvMod = await import(`./server?noenv=${Date.now()}`);
    const initThrow = await withCapture(async () => {
      await noEnvMod.insertAuditEventOrThrow(
        SESSION_ID,
        'client_init_probe',
        { probe: true },
        DIRECT_PROBE_META,
      );
      return {};
    });
    const initRecord = await withCapture(async () => {
      await noEnvMod.recordAuditEvent(SESSION_ID, 'client_init_probe', { probe: true }, DIRECT_PROBE_META);
      return {};
    });
    process.env.NEXT_PUBLIC_SUPABASE_URL = savedUrl2;
    const initFailure = writeFailureLines(initRecord.captured);
    const initFault = (initThrow.error as { fault?: AuditFaultShape } | undefined)?.fault;
    out(`    insertAuditEventOrThrow threw=${initThrow.threw} fault=${JSON.stringify(initFault ?? null)}`);
    out(
      `    recordAuditEvent        threw=${initRecord.threw} logged=${JSON.stringify(
        allLines(initRecord.captured),
      )}`,
    );
    assert(
      initThrow.threw === true &&
        initThrow.error instanceof Error &&
        initThrow.error.name === 'AuditWriteError' &&
        initFault?.kind === 'client_init',
      `[direct probe | client_init] insertAuditEventOrThrow re-emits the createServiceRoleClient rejection as fault kind client_init instead of letting a raw Error escape from a different frame than every other failure`,
      `threw=${initThrow.threw} error=${String(initThrow.error)} fault=${JSON.stringify(initFault ?? null)}`,
    );
    assert(
      initRecord.threw === false &&
        initFailure.length === 1 &&
        initFailure[0]?.parsed?.fault === 'client_init',
      `[direct probe | client_init] recordAuditEvent absorbs the same rejection: it stays total around CLIENT CONSTRUCTION too, and still emits one ${WRITE_FAILURE_TAG} line naming fault=client_init`,
      `threw=${initRecord.threw} lines=${JSON.stringify(allLines(initRecord.captured))}`,
    );

    // -----------------------------------------------------------------------
    // 11b. The READ side of the analyze route's limiter, which also failed open.
    // -----------------------------------------------------------------------
    // Fixing only the write would have left the bigger hole: the limiter's
    // guard was `if (!countErr && (count ?? 0) >= RATE_LIMIT_PER_HOUR)`, so a
    // count query that ERRORED skipped the limit altogether and the request
    // proceeded uncounted. Same degraded Supabase, same route, and it happens
    // BEFORE the write this harness's site 4 measures, so no assertion above
    // can see it.
    //
    // The write is left HEALTHY here on purpose: this must 503 on the read
    // alone, and it must do so WITHOUT having spent a rate-limit slot on a
    // request it then refused.
    out('\n--- analyze route: the rate-limit READ fails, the write is healthy ---');
    stub.mode = 'ok';
    stub.faultTable = 'onboarding_audit_events';
    stub.faultCountRead = 'http_500';
    const readWindow = await openWriteWindow('analyze rate-limit read failure');
    const readFault = await withCapture(() => driveAnalyze());
    closeWriteWindow();
    stub.faultCountRead = false;

    const readFaultLines = allLines(readFault.captured);
    const readFaultWrites = stub.writes.filter(
      (w) => w.table === 'onboarding_audit_events' && w.window === 'analyze rate-limit read failure',
    );
    const readFaultTagged = readFaultLines.filter((l) => l.includes('[rate-limit][READ-FAILURE]'));
    out(`    status=${readFault.result?.status} writes=${readFaultWrites.length} logged=${JSON.stringify(readFaultLines)}`);
    rows.push({
      site: '4b analyze route → rate-limit COUNT read',
      mode: 'count_read',
      threw: readFault.threw,
      thrownMessage: readFault.threw ? String(readFault.error) : undefined,
      loggedLines: readFaultLines,
      responseStatus: readFault.result?.status,
      reachedWrite: readFaultWrites.length > 0,
      writeCount: readFaultWrites.length,
      rowPersisted: 'n/a',
    });
    assert(
      readWindow.empty,
      `[analyze rate-limit read] the measurement window opened EMPTY (no straggler from the previous probe)`,
      readWindow.leftovers,
    );
    assert(
      readFault.threw === false && readFault.result?.status === 503,
      `[analyze rate-limit read] a FAILED count query now returns 503 instead of silently skipping the limit and proceeding`,
      `threw=${readFault.threw} status=${readFault.result?.status} body=${JSON.stringify(readFault.result?.body)?.slice(0, 300)}`,
    );
    assert(
      typeof (readFault.result?.body as { code?: unknown } | undefined)?.code === 'string' &&
        (readFault.result?.body as { code?: string }).code === 'rate_limit_state_unavailable',
      `[analyze rate-limit read] the 503 body carries a MACHINE code alongside its human message, so a caller can branch on it`,
      `body=${JSON.stringify(readFault.result?.body)?.slice(0, 300)}`,
    );
    assert(
      readFaultTagged.length === 1 && readFaultTagged[0]?.startsWith('error: '),
      `[analyze rate-limit read] exactly one [rate-limit][READ-FAILURE] line on console.error records the skipped-limit condition`,
      `logged=${JSON.stringify(readFaultLines)}`,
    );
    assert(
      readFaultWrites.length === 0,
      `[analyze rate-limit read] the refused request spent NO rate-limit slot: no audit row was written for a request that never ran`,
      `writes=${readFaultWrites.length} (stub saw: ${stub.requestLog.join(' | ')})`,
    );

    // -----------------------------------------------------------------------
    // 11b-ii. R3 — ONE SHAPE FOR BOTH HALVES OF THE LIMITER.
    // -----------------------------------------------------------------------
    // The read-side line existed but did not meet the bar the write-side line
    // sets. It was BUILT BY HAND: it hard-coded
    // `fault: countErr ? 'postgrest' : 'null_count'`, omitted the HTTP status
    // field entirely, and applied neither normaliseAuditFault nor
    // boundFaultMessage. Two of those were WRONG rather than merely thin — a
    // stalled read and a proxy's HTML 502 both reported as 'postgrest' — so
    // the fix is not "add a field", it is "route it through the same code".
    //
    // The proof is that the read-side line is now handed to the SAME
    // verifyFailureLine the write-side line passes, with nothing relaxed:
    // field set, channel, one-line-of-JSON, non-empty route/message/succeeded,
    // the message bound, and single-physical-line greppability.
    const readLineVerdict = verifyFailureLine(
      failureLines(readFault.captured, RATE_LIMIT_READ_FAILURE_TAG),
      {
        tag: RATE_LIMIT_READ_FAILURE_TAG,
        table: 'onboarding_audit_events',
        eventType: 'site_intelligence_analyze_requested',
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        // An HTTP HEAD carries NO BODY, so there is no code/details/hint
        // triple to discriminate on and every non-2xx answer to THIS query
        // normalises as 'gateway'. `status` is what carries the information —
        // and `status` is exactly the field the hand-built line omitted.
        fault: 'gateway',
        status: 500,
        pgCode: null,
      },
    );
    assert(
      readLineVerdict.ok,
      `[analyze rate-limit read | http 500] the ${RATE_LIMIT_READ_FAILURE_TAG} line passes the SAME verifyFailureLine checks as the write-side line: one shape for both, carrying the HTTP status the hand-built line omitted, and a fault kind produced by normaliseAuditFault rather than hard-coded`,
      readLineVerdict.reason,
    );

    /** Drive the analyze route with one flavour of count-read fault. */
    const measureCountReadFault = async (
      flavour: Exclude<CountReadFault, false>,
      label: string,
    ): Promise<{
      windowEmpty: boolean;
      leftovers: string;
      status?: number;
      code?: unknown;
      threw: boolean;
      elapsedMs: number;
      slotsSpent: number;
      lines: FailureLine[];
    }> => {
      stub.mode = 'ok';
      stub.faultTable = 'onboarding_audit_events';
      stub.faultCountRead = flavour;
      const opened = await openWriteWindow(label);
      const startedAt = Date.now();
      const outcome = await withCapture(() => driveAnalyze());
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();
      stub.faultCountRead = false;
      const lines = failureLines(outcome.captured, RATE_LIMIT_READ_FAILURE_TAG);
      rows.push({
        site: `4b analyze route → rate-limit COUNT read (${flavour})`,
        mode: 'count_read',
        threw: outcome.threw,
        thrownMessage: outcome.threw ? String(outcome.error) : undefined,
        loggedLines: allLines(outcome.captured),
        responseStatus: outcome.result?.status,
        reachedWrite: false,
        writeCount: 0,
        rowPersisted: 'n/a',
      });
      return {
        windowEmpty: opened.empty,
        leftovers: opened.leftovers,
        status: outcome.result?.status,
        code: (outcome.result?.body as { code?: unknown } | undefined)?.code,
        threw: outcome.threw,
        elapsedMs,
        slotsSpent: stub.writes.filter(
          (w) => w.table === 'onboarding_audit_events' && w.window === label,
        ).length,
        lines,
      };
    };

    // --- the STALL flavour: the misclassification the hard-coding produced --
    out('\n--- analyze route: the rate-limit READ stalls (the fault the old line called "postgrest") ---');
    const countStall = await measureCountReadFault('stall', 'analyze rate-limit read | stall');
    out(`    stall → status=${countStall.status} elapsed=${countStall.elapsedMs}ms slots=${countStall.slotsSpent}`);
    assert(
      countStall.windowEmpty &&
        countStall.threw === false &&
        countStall.status === 503 &&
        countStall.code === 'rate_limit_state_unavailable' &&
        countStall.slotsSpent === 0 &&
        countStall.elapsedMs < TERMINATION_BUDGET_MS,
      `[analyze rate-limit read | stall] a count query that is ACCEPTED AND NEVER ANSWERED still terminates, still 503s with the machine code, and still spends no rate-limit slot`,
      `windowEmpty=${countStall.windowEmpty} (${countStall.leftovers}) threw=${countStall.threw} status=${countStall.status} code=${JSON.stringify(countStall.code)} slots=${countStall.slotsSpent} elapsed=${countStall.elapsedMs}ms budget=${TERMINATION_BUDGET_MS}ms`,
    );
    const stallLineVerdict = verifyFailureLine(countStall.lines, {
      tag: RATE_LIMIT_READ_FAILURE_TAG,
      table: 'onboarding_audit_events',
      eventType: 'site_intelligence_analyze_requested',
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
      fault: 'timeout',
      status: 0,
      pgCode: null,
    });
    assert(
      stallLineVerdict.ok,
      `[analyze rate-limit read | stall] the line names fault=timeout status=0, NOT the hard-coded 'postgrest' the old line printed for every countErr: this is the misclassification, and it pointed an operator at a Postgres refusal that never happened`,
      stallLineVerdict.reason,
    );

    // --- the NULL-COUNT flavour: a success whose answer is unusable ---------
    out('\n--- analyze route: the rate-limit READ succeeds with a null count ---');
    const countNull = await measureCountReadFault('null_count', 'analyze rate-limit read | null count');
    out(`    null count → status=${countNull.status} slots=${countNull.slotsSpent}`);
    assert(
      countNull.windowEmpty &&
        countNull.threw === false &&
        countNull.status === 503 &&
        countNull.code === 'rate_limit_state_unavailable' &&
        countNull.slotsSpent === 0,
      `[analyze rate-limit read | null count] a 206 with no content-range — no error anywhere, and a null count where an exact one was requested — is still an unknown limit, so it still fails closed and still spends no slot`,
      `windowEmpty=${countNull.windowEmpty} (${countNull.leftovers}) threw=${countNull.threw} status=${countNull.status} code=${JSON.stringify(countNull.code)} slots=${countNull.slotsSpent}`,
    );
    const nullLineVerdict = verifyFailureLine(countNull.lines, {
      tag: RATE_LIMIT_READ_FAILURE_TAG,
      table: 'onboarding_audit_events',
      eventType: 'site_intelligence_analyze_requested',
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
      // SYNTHESISED, like 'client_init': there is no error document to
      // normalise, because nothing refused anything.
      fault: 'null_result',
      status: 206,
      pgCode: null,
    });
    assert(
      nullLineVerdict.ok,
      `[analyze rate-limit read | null count] the no-error fault is SYNTHESISED as kind null_result carrying the real HTTP status, and still passes the same line checks: the one read fault class with no error body does not get a second line shape`,
      nullLineVerdict.reason,
    );

    // -----------------------------------------------------------------------
    // 11c. INDEPENDENCE of the session route's two tracking writes.
    // -----------------------------------------------------------------------
    // Sites 2 and 7 each measure ONE of the session route's two tracking
    // writes, and each filters the stub's traffic down to its OWN table. That
    // is precisely why neither could see the regression that folding both
    // writes into one after() callback introduced: sequenced as
    // `await audit; await open;`, a first write that does not settle means the
    // second is NEVER ATTEMPTED. Measured on that revision, with the audit
    // table stalling: the only request issued was
    // POST /rest/v1/onboarding_audit_events, no open-event row, no line about
    // its absence, and the caller still got HTTP 200 — the same silent class
    // this whole change exists to remove, reintroduced by the change itself.
    //
    // So the contract is stated directly, in both directions: FAULTING EITHER
    // WRITE MUST NOT STOP THE OTHER FROM BEING ISSUED, and each must produce
    // its own line naming its own table. The fault mode is 'stall' on purpose
    // — under 'unreachable' or 'rls_denied' the broken sequential version
    // still issued both, so only a non-settling first write discriminates.
    out('\n--- independence: the session route\'s two tracking writes share a callback, not a fate ---');

    /**
     * The degrade-side bound from server.ts, mirrored rather than imported for
     * the same reason as the message bound: a value that was quietly widened
     * must not widen the assertion with it.
     */
    const EXPECTED_DEGRADE_TIMEOUT_MS = 2_000;
    /**
     * How far apart the two tracking writes may ARRIVE at the stub while the
     * first one is being stalled. Issued concurrently they land microseconds
     * apart; CHAINED behind an await they land a whole timeout bound apart, so
     * anything well under the bound discriminates and 500ms leaves ample room
     * for a loaded CI box.
     *
     * THIS IS THE ASSERTION THAT BITES. "Both writes eventually happened" does
     * NOT prove independence once the write is bounded: a sequential
     * `await a; await b;` still issues b, just a full bound late. It only
     * looks independent because the bound rescues it. Measuring the GAP is
     * what separates "issued independently" from "rescued by a timeout".
     */
    const CONCURRENT_ISSUE_GAP_MS = 500;

    interface IndependenceOutcome {
      auditWrites: number;
      openWrites: number;
      failureTables: string[];
      elapsedMs: number;
      /** ms between the arrivals of the two tracking writes, or null. */
      issueGapMs: number | null;
      threw: boolean;
      afterTasks: number;
    }

    const measureSessionTrackingWrites = async (label: string): Promise<IndependenceOutcome> => {
      capturedAfterTasks = [];
      // The GET itself issues only READS, so it can safely run inside the
      // window: nothing it does can be mistaken for a tracking write.
      await openWriteWindow(label);
      await inRequestScope(() => routeSession.GET(sessionRequest()));
      const tasks = capturedAfterTasks.filter(Boolean);
      const task = tasks[0] ?? makeMissingTaskDriver('session tracking writes');
      const startedAt = Date.now();
      const outcome = await withCapture(async () => {
        await task();
        return {};
      });
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();
      const mine = stub.writes.filter((w) => w.window === label);
      const failures = writeFailureLines(outcome.captured);
      const auditAt = mine.find((w) => w.table === 'onboarding_audit_events')?.at ?? null;
      const openAt = mine.find((w) => w.table === 'onboarding_open_events')?.at ?? null;
      return {
        auditWrites: mine.filter((w) => w.table === 'onboarding_audit_events').length,
        openWrites: mine.filter((w) => w.table === 'onboarding_open_events').length,
        failureTables: failures.map((f) => String(f.parsed?.table ?? '<unparseable>')).sort(),
        elapsedMs,
        issueGapMs: auditAt !== null && openAt !== null ? Math.abs(openAt - auditAt) : null,
        threw: outcome.threw,
        afterTasks: tasks.length,
      };
    };

    stub.mode = 'stall';
    stub.faultTable = 'onboarding_audit_events';
    stub.faultTableSecondary = null;
    const indepAudit = await measureSessionTrackingWrites('independence | audit stalls');
    out(`    audit stalls → ${JSON.stringify(indepAudit)}`);
    assert(
      indepAudit.openWrites === 1,
      `[independence | audit write stalls] the OPEN-EVENT write is still issued: a tracking write that never settles cannot cancel the other one that shares its after() callback`,
      `openWrites=${indepAudit.openWrites} auditWrites=${indepAudit.auditWrites} elapsed=${indepAudit.elapsedMs}ms (stub saw: ${stub.requestLog.join(' | ')})`,
    );
    assert(
      indepAudit.auditWrites === 1 &&
        indepAudit.failureTables.length === 1 &&
        indepAudit.failureTables[0] === 'onboarding_audit_events',
      `[independence | audit write stalls] exactly one ${WRITE_FAILURE_TAG} line, naming onboarding_audit_events — the stalled write is reported, the healthy one is not`,
      `auditWrites=${indepAudit.auditWrites} failureTables=${JSON.stringify(indepAudit.failureTables)}`,
    );
    assert(
      indepAudit.issueGapMs !== null && indepAudit.issueGapMs < CONCURRENT_ISSUE_GAP_MS,
      `[independence | audit write stalls] the open-event write is ISSUED WHILE the audit write is still stalling, not after it gives up: "both eventually happened" is satisfied by a chained pair that the timeout bound merely rescues, so the arrival GAP is what proves independence`,
      `gap=${indepAudit.issueGapMs}ms, must be < ${CONCURRENT_ISSUE_GAP_MS}ms; a chained pair would show ~${EXPECTED_DEGRADE_TIMEOUT_MS}ms (callback took ${indepAudit.elapsedMs}ms)`,
    );

    stub.faultTable = 'onboarding_open_events';
    stub.faultTableSecondary = null;
    const indepOpen = await measureSessionTrackingWrites('independence | open stalls');
    out(`    open stalls  → ${JSON.stringify(indepOpen)}`);
    assert(
      indepOpen.auditWrites === 1,
      `[independence | open-event write stalls] the AUDIT write is still issued: independence holds in the other direction too, not just for the write that happens to go first`,
      `auditWrites=${indepOpen.auditWrites} openWrites=${indepOpen.openWrites} elapsed=${indepOpen.elapsedMs}ms (stub saw: ${stub.requestLog.join(' | ')})`,
    );
    assert(
      indepOpen.openWrites === 1 &&
        indepOpen.failureTables.length === 1 &&
        indepOpen.failureTables[0] === 'onboarding_open_events',
      `[independence | open-event write stalls] exactly one ${WRITE_FAILURE_TAG} line, naming onboarding_open_events`,
      `openWrites=${indepOpen.openWrites} failureTables=${JSON.stringify(indepOpen.failureTables)}`,
    );
    assert(
      indepOpen.issueGapMs !== null && indepOpen.issueGapMs < CONCURRENT_ISSUE_GAP_MS,
      `[independence | open-event write stalls] and symmetrically: neither write waits on the other's settlement before being issued`,
      `gap=${indepOpen.issueGapMs}ms, must be < ${CONCURRENT_ISSUE_GAP_MS}ms (callback took ${indepOpen.elapsedMs}ms)`,
    );

    stub.faultTable = 'onboarding_audit_events';
    stub.faultTableSecondary = 'onboarding_open_events';
    const indepBoth = await measureSessionTrackingWrites('independence | both stall');
    stub.faultTableSecondary = null;
    out(`    both stall   → ${JSON.stringify(indepBoth)}`);
    assert(
      indepBoth.auditWrites === 1 && indepBoth.openWrites === 1,
      `[independence | both writes stall] BOTH writes are still issued when BOTH tables are stalling`,
      `auditWrites=${indepBoth.auditWrites} openWrites=${indepBoth.openWrites} (stub saw: ${stub.requestLog.join(' | ')})`,
    );
    assert(
      indepBoth.failureTables.length === 2 &&
        indepBoth.failureTables[0] === 'onboarding_audit_events' &&
        indepBoth.failureTables[1] === 'onboarding_open_events',
      `[independence | both writes stall] TWO ${WRITE_FAILURE_TAG} lines, one per table: neither loss is reported on the other's behalf and neither is swallowed`,
      `failureTables=${JSON.stringify(indepBoth.failureTables)}`,
    );
    assert(
      indepBoth.threw === false &&
        indepBoth.elapsedMs < EXPECTED_DEGRADE_TIMEOUT_MS * 1.5 &&
        indepBoth.issueGapMs !== null &&
        indepBoth.issueGapMs < CONCURRENT_ISSUE_GAP_MS,
      `[independence | both writes stall] the after() callback TERMINATES in ROUGHLY ONE bound, not two: with both tables stalling, a chained pair would take ${
        EXPECTED_DEGRADE_TIMEOUT_MS * 2
      }ms and hold the function open twice as long for no benefit`,
      `threw=${indepBoth.threw} elapsed=${indepBoth.elapsedMs}ms (ceiling ${
        EXPECTED_DEGRADE_TIMEOUT_MS * 1.5
      }ms) gap=${indepBoth.issueGapMs}ms (ceiling ${CONCURRENT_ISSUE_GAP_MS}ms)`,
    );

    // -----------------------------------------------------------------------
    // 11d. THE MESSAGE BOUND, measured against the body that motivated it.
    // -----------------------------------------------------------------------
    // verifyFailureLine enforces the bound at every site in every mode. This
    // measures the specific case it exists for, so the numbers are on the
    // record: a 502 whose HTML body is larger than the whole rest of the line.
    out('\n--- message bound: a proxy 502 with an HTML body ---');
    stub.mode = 'gateway_html';
    stub.faultTable = 'onboarding_audit_events';
    await openWriteWindow('message bound | gateway html');
    const gatewayProbe = await withCapture(async () => {
      await serverMod.recordAuditEvent(SESSION_ID, 'gateway_probe', { probe: true }, DIRECT_PROBE_META);
      return {};
    });
    closeWriteWindow();
    const gatewayLines = writeFailureLines(gatewayProbe.captured);
    const gatewayMessage = String(gatewayLines[0]?.parsed?.message ?? '');
    out(
      `    body=${GATEWAY_HTML_BODY.length} chars → message=${gatewayMessage.length} chars, ` +
        `fault=${JSON.stringify(gatewayLines[0]?.parsed?.fault)} pg_code=${JSON.stringify(
          gatewayLines[0]?.parsed?.pg_code,
        )}`,
    );
    assert(
      gatewayLines.length === 1 &&
        gatewayLines[0]?.parsed?.fault === 'gateway' &&
        gatewayLines[0]?.parsed?.status === 502 &&
        gatewayLines[0]?.parsed?.pg_code === null,
      `[message bound] a 502 with a non-PostgREST body is classified fault=gateway, not postgrest: an absent code/details/hint triple is the discriminator, and calling it postgrest sent an operator hunting a Postgres fault that does not exist`,
      `lines=${JSON.stringify(gatewayLines.map((l) => l.raw.slice(0, 200)))}`,
    );
    assert(
      GATEWAY_HTML_BODY.length > EXPECTED_MAX_FAULT_MESSAGE_CHARS &&
        gatewayMessage.length <= EXPECTED_MAX_FAULT_MESSAGE_CHARS + 64 &&
        gatewayMessage.includes(TRUNCATION_MARKER) &&
        gatewayMessage.includes(String(GATEWAY_HTML_BODY.length)),
      `[message bound] the ${GATEWAY_HTML_BODY.length}-char body is truncated to the ${EXPECTED_MAX_FAULT_MESSAGE_CHARS}-char bound and SAYS it was truncated, carrying the original length so the size stays diagnosable`,
      `messageLen=${gatewayMessage.length} message=${JSON.stringify(gatewayMessage.slice(0, 400))}`,
    );

    // -----------------------------------------------------------------------
    // 11e. AM-BYPASS SCOPING, both halves of the rule.
    // -----------------------------------------------------------------------
    // The analyze route's fail-closed 503 is scoped to `!isAmBypass` for a
    // reason: an AM-bypass caller is never COUNTED (their audit write is
    // suppressed), so an unknowable counter cannot fail their limit open and
    // must not refuse them. That scoping shipped with no bypass request in the
    // harness at all, so neither half was covered. Both halves are driven here
    // against the SAME injected fault, so the only variable is the signature.
    out('\n--- AM-bypass scoping: the same fault, driven with and without a valid signature ---');
    assert(
      AM_BYPASS_SIG.length > 0 &&
        (await (async () => {
          const m = await import('@/lib/onboarding/am-bypass');
          return m.verifyAmBypass(SESSION_ID, AM_BYPASS_SIG) === true;
        })()),
      `[am-bypass] the harness minted a signature the app's own verifier accepts, so a "bypass" request really takes the bypass branch instead of silently re-testing the non-bypass one`,
      `sigLen=${AM_BYPASS_SIG.length}`,
    );

    // --- analyze: the WRITE fault ------------------------------------------
    stub.mode = 'rls_denied';
    stub.faultTable = 'onboarding_audit_events';
    stub.faultCountRead = false;
    await openWriteWindow('am-bypass | analyze write fault | bypass');
    const analyzeWriteBypass = await withCapture(() => driveAnalyzeAs(true));
    closeWriteWindow();
    const analyzeWriteBypassAudits = stub.writes.filter(
      (w) => w.table === 'onboarding_audit_events' && w.window === 'am-bypass | analyze write fault | bypass',
    ).length;

    await openWriteWindow('am-bypass | analyze write fault | no bypass');
    const analyzeWriteNoBypass = await withCapture(() => driveAnalyzeAs(false));
    closeWriteWindow();

    out(
      `    analyze + audit-write fault: bypass → ${analyzeWriteBypass.result?.status} (audit POSTs ${analyzeWriteBypassAudits}), ` +
        `no bypass → ${analyzeWriteNoBypass.result?.status}`,
    );
    assert(
      analyzeWriteBypass.threw === false &&
        analyzeWriteBypass.result?.status === 200 &&
        analyzeWriteBypassAudits === 0,
      `[am-bypass | analyze write fault] a BYPASS request is NOT 503'd by a failing audit write, because it never attempts one: the row it would have written is the rate limiter's state, and an AM is not counted`,
      `status=${analyzeWriteBypass.result?.status} auditPosts=${analyzeWriteBypassAudits} body=${JSON.stringify(analyzeWriteBypass.result?.body)?.slice(0, 200)}`,
    );
    assert(
      analyzeWriteNoBypass.threw === false && analyzeWriteNoBypass.result?.status === 503,
      `[am-bypass | analyze write fault] the SAME fault on a NON-bypass request still fails closed with 503: the scoping narrows who the rule applies to, it does not weaken the rule`,
      `status=${analyzeWriteNoBypass.result?.status} body=${JSON.stringify(analyzeWriteNoBypass.result?.body)?.slice(0, 200)}`,
    );

    // --- analyze: the COUNT READ fault -------------------------------------
    stub.mode = 'ok';
    stub.faultCountRead = 'http_500';
    await openWriteWindow('am-bypass | analyze read fault | bypass');
    const analyzeReadBypass = await withCapture(() => driveAnalyzeAs(true));
    closeWriteWindow();
    await openWriteWindow('am-bypass | analyze read fault | no bypass');
    const analyzeReadNoBypass = await withCapture(() => driveAnalyzeAs(false));
    closeWriteWindow();
    stub.faultCountRead = false;
    out(
      `    analyze + count-read fault: bypass → ${analyzeReadBypass.result?.status}, ` +
        `no bypass → ${analyzeReadNoBypass.result?.status}`,
    );
    assert(
      analyzeReadBypass.threw === false && analyzeReadBypass.result?.status === 200,
      `[am-bypass | analyze read fault] a BYPASS request is NOT 503'd by an unreadable rate-limit counter either: an AM's request is never counted, so an unknown count cannot fail their limit open`,
      `status=${analyzeReadBypass.result?.status} body=${JSON.stringify(analyzeReadBypass.result?.body)?.slice(0, 200)}`,
    );
    assert(
      analyzeReadNoBypass.threw === false &&
        analyzeReadNoBypass.result?.status === 503 &&
        (analyzeReadNoBypass.result?.body as { code?: string } | undefined)?.code ===
          'rate_limit_state_unavailable',
      `[am-bypass | analyze read fault] the SAME unreadable counter on a NON-bypass request still fails closed with 503 and the machine code`,
      `status=${analyzeReadNoBypass.result?.status} body=${JSON.stringify(analyzeReadNoBypass.result?.body)?.slice(0, 200)}`,
    );

    // --- the other three isAmBypass-gated sites ----------------------------
    // Same rule, different disposition: these DEGRADE rather than fail closed,
    // so the bypass claim is not "no 503" but "no write at all, and therefore
    // nothing to lose and nothing to log". Driven under a faulted audit table
    // so a suppressed write and a failed one cannot be confused.
    stub.mode = 'rls_denied';
    stub.faultTable = 'onboarding_audit_events';

    await openWriteWindow('am-bypass | save-step | bypass');
    const saveStepBypass = await withCapture(() => driveSaveStepAs(true));
    closeWriteWindow();
    const saveStepBypassAudits = stub.writes.filter(
      (w) => w.table === 'onboarding_audit_events' && w.window === 'am-bypass | save-step | bypass',
    ).length;
    out(
      `    save-step + bypass → ${saveStepBypass.result?.status} (audit POSTs ${saveStepBypassAudits}, ` +
        `failure lines ${writeFailureLines(saveStepBypass.captured).length})`,
    );
    assert(
      saveStepBypass.result?.status === 200 &&
        saveStepBypassAudits === 0 &&
        writeFailureLines(saveStepBypass.captured).length === 0,
      `[am-bypass | save-step] a BYPASS save still persists the answers at 200 and writes NO step_saved row, so a faulted audit table produces no WRITE-FAILURE line for a write that was never meant to happen`,
      `status=${saveStepBypass.result?.status} auditPosts=${saveStepBypassAudits} lines=${JSON.stringify(allLines(saveStepBypass.captured))}`,
    );

    await openWriteWindow('am-bypass | submit | bypass');
    const submitBypass = await withCapture(() => driveSubmitAs(true));
    closeWriteWindow();
    const submitBypassAudits = stub.writes.filter(
      (w) => w.table === 'onboarding_audit_events' && w.window === 'am-bypass | submit | bypass',
    ).length;
    out(
      `    submit + bypass → ${submitBypass.result?.status} (audit POSTs ${submitBypassAudits}, ` +
        `failure lines ${writeFailureLines(submitBypass.captured).length})`,
    );
    assert(
      submitBypass.result?.status === 200 &&
        submitBypassAudits === 0 &&
        writeFailureLines(submitBypass.captured).length === 0,
      `[am-bypass | submit] a BYPASS submit still commits at 200 and writes NO session_submitted row, so the faulted audit table produces no line`,
      `status=${submitBypass.result?.status} auditPosts=${submitBypassAudits} lines=${JSON.stringify(allLines(submitBypass.captured))}`,
    );

    await openWriteWindow('am-bypass | session | bypass');
    const sessionBypass = await driveSessionAs(true);
    const sessionBypassNoBypass = await driveSessionAs(false);
    closeWriteWindow();
    out(
      `    session + bypass → status ${sessionBypass.status}, after() tasks ${sessionBypass.afterTasks}; ` +
        `without bypass → ${sessionBypassNoBypass.afterTasks} task(s)`,
    );
    assert(
      sessionBypass.status === 200 &&
        sessionBypass.afterTasks === 0 &&
        sessionBypassNoBypass.afterTasks === 1,
      `[am-bypass | session] a BYPASS page-load registers ZERO after() tasks — neither tracking write is even SCHEDULED, so an AM's prep can never reach Open History — while the same load without the signature registers exactly one`,
      `bypass: status=${sessionBypass.status} tasks=${sessionBypass.afterTasks}; plain: tasks=${sessionBypassNoBypass.afterTasks}`,
    );

    stub.mode = 'ok';

    // -----------------------------------------------------------------------
    // 11f. THE NAMED GAP — an UNBOUNDED READ UPSTREAM OF THE BOUNDED WRITE.
    // -----------------------------------------------------------------------
    // Bounding the audit WRITE was necessary and NOT sufficient. On both
    // after()-resident paths a Supabase READ sits immediately upstream of the
    // write, on the same code path, inside the same callback. Under a Supabase
    // that accepts the connection and never answers, that read never settles,
    // so the audit write is NEVER ISSUED, logAuditWriteFailure never runs, and
    // the operator gets literally zero output — while the submit's 200 has
    // long since shipped, so nothing anywhere notices.
    //
    // Measured against the previous revision, on the bridge: 10s elapsed, the
    // promise never settled, the stub saw exactly ONE request (the clients
    // GET) and zero POSTs to onboarding_audit_events, and the captured
    // operator output was empty.
    //
    // WHY THE SITE MATRIX COULD NOT SEE THIS. Every site above stalls the
    // WRITE and reaches it through healthy reads. The fault has to be injected
    // UPSTREAM to exist at all, which is what `stub.stallReadTables` does: the
    // GET is accepted, fully read, and then never answered, with the write
    // left healthy throughout.
    //
    // THE PRINCIPLE the fix states in a comment at each site: reading `.error`
    // is NECESSARY BUT NOT SUFFICIENT, because a call that never settles has
    // no `.error` to read. Two of these four sites discarded `.error`
    // outright; one of them (the pm_tracker seed) read it and logged, and was
    // still silent under a stall, which is the whole argument in one site.
    out('\n--- upstream reads: the call in FRONT of the audit write never answers ---');

    /** Register the submit route's after() tasks with everything healthy. */
    const prepareSubmitTasksQuietly = async (label: string): Promise<AfterTask[]> => {
      stub.mode = 'ok';
      stub.faultTable = 'onboarding_audit_events';
      stub.faultTableSecondary = null;
      stub.stallReadTables = [];
      stub.stallReadSkip = {};
      stub.faultCountRead = false;
      labelWriteWindow(label);
      capturedAfterTasks = [];
      await driveSubmit();
      return capturedAfterTasks.filter(Boolean);
    };

    interface UpstreamCase {
      key: string;
      /** 0 = fireDashboardClientBridge, 1 = exportSubmissionToSheet. */
      taskIndex: 0 | 1;
      /** GET tables to stall. */
      stallReads: string[];
      /** POST table to stall, for the one site that is a write. */
      stallWrite: string | null;
      /** What the failure line must name. */
      tag: string;
      table: string;
      eventType: string;
      /** Where in the source this call lives, for the transcript. */
      where: string;
    }

    const upstreamCases: UpstreamCase[] = [
      {
        key: 'bridge → clients lookup',
        taskIndex: 0,
        stallReads: ['clients'],
        stallWrite: null,
        tag: READ_FAILURE_TAG,
        table: 'clients',
        eventType: 'client_lookup',
        where: 'dashboard-bridge.ts, the clients lookup',
      },
      {
        key: 'sheet-export → clients lookup',
        taskIndex: 1,
        stallReads: ['clients'],
        stallWrite: null,
        tag: READ_FAILURE_TAG,
        table: 'clients',
        eventType: 'client_lookup',
        where: 'sheet-export.ts, the clients select (which also DISCARDED .error)',
      },
      {
        key: 'sheet-export → answers lookup',
        taskIndex: 1,
        stallReads: ['onboarding_answers'],
        stallWrite: null,
        tag: READ_FAILURE_TAG,
        table: 'onboarding_answers',
        eventType: 'answers_lookup',
        where: 'sheet-export.ts, getSessionAnswers on the after() path',
      },
      {
        key: 'sheet-export → submitted_at re-read',
        taskIndex: 1,
        stallReads: ['onboarding_sessions'],
        stallWrite: null,
        tag: READ_FAILURE_TAG,
        table: 'onboarding_sessions',
        eventType: 'submitted_at_reread',
        where: 'sheet-export.ts, the submitted_at re-read (which also DISCARDED .error)',
      },
      {
        key: 'sheet-export → pm_tracker_pushes seed',
        taskIndex: 1,
        stallReads: [],
        stallWrite: 'pm_tracker_pushes',
        tag: SUPABASE_WRITE_FAILURE_TAG,
        table: 'pm_tracker_pushes',
        eventType: 'pending_seed',
        where: 'sheet-export.ts, the pm_tracker_pushes upsert (which DID read .error, and was still silent)',
      },
    ];

    for (const c of upstreamCases) {
      const setupLabel = `setup: upstream | ${c.key}`;
      const tasks = await prepareSubmitTasksQuietly(setupLabel);
      const task = tasks[c.taskIndex] ?? makeMissingTaskDriver(`upstream ${c.key}`);

      stub.stallReadTables = c.stallReads;
      if (c.stallWrite) {
        stub.mode = 'stall';
        stub.faultTable = c.stallWrite;
        stub.faultTableSecondary = null;
      }

      const label = `upstream | ${c.key}`;
      const opened = await openWriteWindow(label);
      const startedAt = Date.now();
      const outcome = await withCapture(async () => {
        await task();
        return {};
      });
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();

      const crossedTheWire = c.stallWrite
        ? (stub.writesSeen[c.stallWrite] ?? 0)
        : (stub.readsSeen[c.table] ?? 0);
      const lines = failureLines(outcome.captured, c.tag);
      const auditPosts = stub.writes.filter(
        (w) => w.table === 'onboarding_audit_events' && w.window === label,
      ).length;

      stub.stallReadTables = [];
      stub.stallReadSkip = {};
      stub.mode = 'ok';
      stub.faultTable = 'onboarding_audit_events';
      stub.faultTableSecondary = null;

      out(
        `    ${pad(c.key, 40)} crossedWire=${crossedTheWire} elapsed=${elapsedMs}ms ` +
          `lines=${lines.length} auditPosts=${auditPosts}`,
      );
      rows.push({
        site: `8 upstream ${c.key}`,
        mode: 'stall',
        threw: outcome.threw,
        thrownMessage: outcome.threw ? String(outcome.error) : undefined,
        loggedLines: allLines(outcome.captured),
        responseStatus: undefined,
        reachedWrite: crossedTheWire > 0,
        writeCount: crossedTheWire,
        rowPersisted: 'n/a',
      });

      assert(
        opened.empty && crossedTheWire >= 1,
        `[upstream | ${c.key}] the stalled call really CROSSED THE WIRE (${c.where}): the stub accepted it, read it in full, and never answered — a fault that was never issued would prove nothing`,
        `windowEmpty=${opened.empty} (${opened.leftovers}) crossedWire=${crossedTheWire} (stub saw: ${stub.requestLog.join(' | ')})`,
      );
      assert(
        outcome.threw === false && elapsedMs < TERMINATION_BUDGET_MS,
        `[upstream | ${c.key}] the after() callback TERMINATES when the call UPSTREAM of the audit write never answers: bounding only the write left this frozen, with the 200 already shipped`,
        `threw=${outcome.threw} elapsed=${elapsedMs}ms budget=${TERMINATION_BUDGET_MS}ms`,
      );
      const verdict = verifyFailureLine(lines, {
        tag: c.tag,
        table: c.table,
        eventType: c.eventType,
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        fault: 'timeout',
        status: 0,
        pgCode: null,
      });
      assert(
        verdict.ok,
        `[upstream | ${c.key}] and it is LOUD: exactly one ${c.tag} line naming ${c.table}, fault=timeout status=0, in the same shape as the write-side line — terminating quietly would be no better than hanging`,
        verdict.reason,
      );
    }


    // -----------------------------------------------------------------------
    // 11g. D7 — GOOGLE-SIDE FAULTS, REACHABLE FOR THE FIRST TIME.
    // -----------------------------------------------------------------------
    //
    // WHY D1 HID INSIDE A GREEN SITE. Site 6 above drives the very same
    // function, in five fault modes, and passes. It reaches the
    // sheet_export_failed audit write by the SHORTEST possible route: the
    // injected private key is a placeholder, so google-auth-library's jws sign
    // rejects LOCALLY, before a socket exists. Every Google-side condition —
    // a stalled token mint, a stalled values read, a stalled values write —
    // was therefore INEXPRESSIBLE, and the hermeticity guards turned any real
    // Google request into an immediate throw so a correctly-signed key could
    // not have reached one either. A whole dependency was untested while
    // looking covered.
    //
    // The stub now serves the Google endpoints on loopback, a per-run RSA key
    // is installed for the duration of these cases so the assertion really
    // signs, and Google URLs are REWRITTEN to the stub before the guard's
    // loopback check runs. The guard is not opened: the socket really does go
    // to 127.0.0.1, and the guard-intact probe below proves the rewrite is the
    // ONLY reason the stub is reachable.
    out('\n--- google-side faults: the calls that were previously unreachable ---');

    const restoreGoogleEnv = (): void => {
      process.env.GOOGLE_SHEETS_PRIVATE_KEY = BOGUS_GOOGLE_KEY;
      googleStub.enabled = false;
      googleStub.mode = 'ok';
    };

    interface GoogleRun {
      captured: Captured;
      threw: boolean;
      elapsedMs: number;
      auditRows: WriteRecord[];
      opened: { empty: boolean; leftovers: string };
      seen: string[];
    }

    /**
     * One sheet-export, driven through the SUBMIT ROUTE'S OWN after()
     * registration (task index 1), exactly as site 6 does — importing the
     * library and calling it directly would say nothing about whether a
     * submission still schedules it.
     */
    const driveExportWithGoogle = async (
      label: string,
      mode: GoogleStubMode,
    ): Promise<GoogleRun> => {
      const tasks = await prepareSubmitTasksQuietly(`setup: ${label}`);
      const task = tasks[1] ?? makeMissingTaskDriver(`sheet export (${label})`);
      process.env.GOOGLE_SHEETS_PRIVATE_KEY = SIGNABLE_GOOGLE_KEY;
      googleStub.enabled = true;
      googleStub.mode = mode;
      googleStub.seen = [];
      const opened = await openWriteWindow(label);
      const startedAt = Date.now();
      const outcome = await withCapture(async () => {
        await task();
        return {};
      });
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();
      restoreGoogleEnv();
      return {
        captured: outcome.captured,
        threw: outcome.threw,
        elapsedMs,
        auditRows: stub.writes.filter(
          (w) => w.table === 'onboarding_audit_events' && w.window === label,
        ),
        opened,
        seen: googleStub.seen.slice(),
      };
    };

    /** The event_type a sheet-export audit row must carry, read off the body. */
    const auditEventTypes = (recs: WriteRecord[]): string[] =>
      recs.map((r) => {
        const bodyRows = Array.isArray(r.parsed) ? r.parsed : [r.parsed];
        const first = bodyRows[0];
        return first !== null && typeof first === 'object'
          ? String((first as Record<string, unknown>).event_type)
          : '<unparseable>';
      });

    // --- the POSITIVE CONTROL, and it is not optional ----------------------
    // Without it, three green stall assertions would be worthless: a stub that
    // is never reached at all also produces "the call did not answer". This
    // proves the whole chain works when Google behaves — the key signs, the
    // token mints, three values calls round-trip, the roster row is appended,
    // and NO sheet_export_failed row is written.
    const gOk = await driveExportWithGoogle('google | healthy control', 'ok');
    out(
      `    ${pad('google healthy control', 40)} seen=${gOk.seen.length} ` +
        `elapsed=${gOk.elapsedMs}ms auditRows=${gOk.auditRows.length}`,
    );
    rows.push({
      site: '9 google healthy control',
      mode: 'ok',
      threw: gOk.threw,
      loggedLines: allLines(gOk.captured),
      responseStatus: undefined,
      reachedWrite: false,
      writeCount: gOk.seen.length,
      rowPersisted: 'n/a',
    });
    assert(
      gOk.threw === false &&
        gOk.seen.length === 4 &&
        gOk.seen[0] === 'POST /token' &&
        gOk.seen.filter((r) => r.startsWith('GET /v4/spreadsheets')).length === 2 &&
        gOk.seen.some((r) => r.includes(':append')),
      `[google | control] the export really REACHES the Google endpoints: one OAuth2 token mint, two values reads and one values append, all on loopback — without this control the stall cases below could not tell "bounded correctly" from "never got there"`,
      `threw=${gOk.threw} seen=${JSON.stringify(gOk.seen)}`,
    );
    assert(
      gOk.auditRows.length === 0 &&
        allLines(gOk.captured).some((l) => l.includes('[sheet-export] ok action=created')),
      `[google | control] and a HEALTHY Google writes NO sheet_export_failed row: the bound does not manufacture failures out of a working dependency`,
      `auditRows=${JSON.stringify(auditEventTypes(gOk.auditRows))} lines=${JSON.stringify(allLines(gOk.captured))}`,
    );

    // --- the three bounded calls, each stalled in turn ---------------------
    interface GoogleCase {
      key: string;
      mode: GoogleStubMode;
      /** The `target` the failure line must name. */
      target: string;
      /** A fragment of the stub request that must have crossed the wire. */
      wire: string;
      /** Which of sheet-export's four calls this is, for the transcript. */
      where: string;
    }

    const googleCases: GoogleCase[] = [
      {
        key: 'token mint stall',
        mode: 'stall_token',
        target: 'google:oauth2 token mint',
        wire: 'POST /token',
        where: 'jwt.authorize() — gtoken/getToken.js GOOGLE_TOKEN_URL, which carries no timeout of its own',
      },
      {
        key: 'values read stall',
        mode: 'stall_read',
        target: 'google:values.get A1:O1',
        wire: 'GET /v4/spreadsheets',
        where: 'valuesGet A1:O1 — the exact call measured as never settling',
      },
      {
        key: 'values write stall',
        mode: 'stall_write',
        target: 'google:values.append A1:O',
        wire: ':append',
        where: 'valuesAppend — the roster row itself',
      },
    ];

    for (const c of googleCases) {
      const label = `google | ${c.key}`;
      const r = await driveExportWithGoogle(label, c.mode);
      const upstream = failureLines(r.captured, UPSTREAM_HTTP_FAILURE_TAG);
      const crossed = r.seen.filter((x) => x.includes(c.wire)).length;
      out(
        `    ${pad(c.key, 40)} crossedWire=${crossed} elapsed=${r.elapsedMs}ms ` +
          `lines=${upstream.length} auditRows=${r.auditRows.length}`,
      );
      rows.push({
        site: `9 google ${c.key}`,
        mode: 'stall',
        threw: r.threw,
        loggedLines: allLines(r.captured),
        responseStatus: undefined,
        reachedWrite: r.auditRows.length > 0,
        writeCount: r.auditRows.length,
        rowPersisted: 'n/a',
      });

      assert(
        r.opened.empty && crossed >= 1,
        `[${label}] the stalled Google call really CROSSED THE WIRE (${c.where}): the stub accepted it, read it in full, and never answered`,
        `windowEmpty=${r.opened.empty} (${r.opened.leftovers}) crossed=${crossed} seen=${JSON.stringify(r.seen)}`,
      );
      assert(
        r.threw === false && r.elapsedMs < TERMINATION_BUDGET_MS,
        `[${label}] exportSubmissionToSheet TERMINATES: unbounded this await never settled at all, because gaxios arms a signal only under if (opts.timeout) and node:http.ClientRequest has no default timeout — not even undici's 300s floor`,
        `threw=${r.threw} elapsed=${r.elapsedMs}ms budget=${TERMINATION_BUDGET_MS}ms`,
      );
      const verdict = verifyUpstreamLine(upstream, {
        tag: UPSTREAM_HTTP_FAILURE_TAG,
        target: c.target,
        eventType: 'sheet_export_google_call',
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        fault: 'timeout',
        status: 0,
        code: null,
      });
      assert(
        verdict.ok,
        `[${label}] and it is LOUD, naming WHICH of the four Google calls stalled: exactly one ${UPSTREAM_HTTP_FAILURE_TAG} line with target "${c.target}", fault=timeout — the raw rejection says only "The operation was aborted."`,
        verdict.reason,
      );
      assert(
        r.auditRows.length === 1 && auditEventTypes(r.auditRows)[0] === 'sheet_export_failed',
        `[${label}] and the Google stall STILL REACHES the sheet_export_failed audit write downstream of it: bounding is worth nothing if the failure-reporting write is still never issued`,
        `auditRows=${JSON.stringify(auditEventTypes(r.auditRows))} window=${label}`,
      );
      // D5. This used to look for `[sheet-export] failed session=…: …`, an
      // UNTAGGED line that CONCATENATED the rethrown Google message. It is now
      // the shared emitter's line, so the assertion tests the same fact — the
      // label travels out of googleRequest into the outer report — against the
      // structured record instead of a substring of a raw string.
      const stageVerdict = verifyUpstreamLine(
        failureLines(r.captured, BOUNDED_STAGE_FAILURE_TAG),
        {
          tag: BOUNDED_STAGE_FAILURE_TAG,
          target: 'sheet_export (google sheets roster)',
          eventType: 'sheet_export_failed',
          sessionId: SESSION_ID,
          clientId: CLIENT_ID,
          fault: 'timeout',
          status: 0,
          code: null,
        },
      );
      const stageLine = failureLines(r.captured, BOUNDED_STAGE_FAILURE_TAG)[0];
      assert(
        stageVerdict.ok &&
          typeof stageLine?.parsed?.message === 'string' &&
          (stageLine.parsed.message as string).includes(c.target.replace('google:', 'google ')),
        `[${label}] and the OUTER report is a tagged ${BOUNDED_STAGE_FAILURE_TAG} record naming the stalled call: it used to be an untagged [sheet-export] failed line that CONCATENATED the remote's text, with no fault kind, no status and no statement of what survived`,
        `${stageVerdict.reason} :: message=${JSON.stringify(stageLine?.parsed?.message ?? null)}`,
      );
    }

    // --- the rewrite is the ONLY reason the stub is reachable --------------
    // The point of D7 was to make Google faults reachable WITHOUT opening the
    // hermeticity guard. Proving that needs the negative: with a signable key
    // and the rewrite DISARMED, the same export must be blocked at the guard.
    {
      const before = nonLoopbackNodeRequests.length;
      const tasks = await prepareSubmitTasksQuietly('setup: google | guard intact');
      const task = tasks[1] ?? makeMissingTaskDriver('sheet export (guard intact)');
      process.env.GOOGLE_SHEETS_PRIVATE_KEY = SIGNABLE_GOOGLE_KEY;
      googleStub.enabled = false;
      const label = 'google | guard intact';
      const opened = await openWriteWindow(label);
      const outcome = await withCapture(async () => {
        await task();
        return {};
      });
      closeWriteWindow();
      restoreGoogleEnv();
      const blocked = nonLoopbackNodeRequests.slice(before);
      // These are the probe's OWN deliberate blocks. They are removed so the
      // hermeticity assertion at 12 keeps meaning "nothing tried to leave",
      // and they are asserted here instead — the count is not swept under a
      // rug, it is moved to the assertion that can interpret it.
      nonLoopbackNodeRequests.length = before;
      out(`    ${pad('guard intact (rewrite disarmed)', 40)} blocked=${JSON.stringify(blocked)}`);
      assert(
        opened.empty &&
          blocked.length >= 1 &&
          blocked.every((b) => /googleapis\.com|google\.com/.test(b)),
        `[google | guard intact] with the rewrite DISARMED the very same export is blocked at the hermeticity guard: the stub is reachable because requests are REWRITTEN to loopback, not because the guard was opened`,
        `blocked=${JSON.stringify(blocked)} windowEmpty=${opened.empty} threw=${outcome.threw}`,
      );
    }

    // -----------------------------------------------------------------------
    // 11h. D2 — the fail-closed 503 was itself guarded by UNBOUNDED reads.
    // -----------------------------------------------------------------------
    //
    // The analyze route's counter read is bounded and fails closed. The awaits
    // in FRONT of it were not, and they run FIRST. Under a PostgREST that
    // accepts and never answers the handler froze on one of those, so the
    // route neither failed closed nor reported anything and the bounded read
    // was never reached at all. Bounding the thing downstream of a hang is
    // worth nothing, which is the same lesson as 11f one layer further out.
    out('\n--- analyze route: the reads UPSTREAM of the fail-closed 503 ---');

    interface AnalyzeUpstreamCase {
      key: string;
      stallTable: string;
      target: string;
      /** Fixture change needed to make the call happen at all. */
      arm?: () => void;
      disarm?: () => void;
    }

    const analyzeUpstreamCases: AnalyzeUpstreamCase[] = [
      {
        key: 'session lookup',
        stallTable: 'onboarding_sessions',
        target: 'session_lookup (onboarding_sessions)',
      },
      {
        key: 'reusable scan lookup',
        stallTable: 'onboarding_site_intelligence',
        target: 'reusable_scan_lookup (onboarding_site_intelligence)',
        // findReusableScan returns null WITHOUT a query when the session has no
        // linked record, so the fixture has to carry one or the case would
        // measure nothing and still pass.
        arm: () => {
          SESSION_ROW.site_intelligence_id = 'si-record-1';
        },
        disarm: () => {
          SESSION_ROW.site_intelligence_id = null;
        },
      },
    ];

    for (const c of analyzeUpstreamCases) {
      const label = `analyze upstream | ${c.key}`;
      c.arm?.();
      stub.readsSeen[c.stallTable] = 0;
      stub.stallReadTables = [c.stallTable];
      stub.stallReadSkip = {};
      const opened = await openWriteWindow(label);
      const startedAt = Date.now();
      const outcome = await withCapture(() => driveAnalyze());
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();
      stub.stallReadTables = [];
      c.disarm?.();

      const lines = failureLines(outcome.captured, BOUNDED_STAGE_FAILURE_TAG);
      const status = outcome.result?.status;
      const code = (outcome.result?.body as { code?: string } | undefined)?.code;
      const auditPosts = stub.writes.filter(
        (w) => w.table === 'onboarding_audit_events' && w.window === label,
      ).length;
      out(
        `    ${pad(c.key, 40)} crossedWire=${stub.readsSeen[c.stallTable] ?? 0} ` +
          `elapsed=${elapsedMs}ms status=${status} lines=${lines.length} auditPosts=${auditPosts}`,
      );
      rows.push({
        site: `10 analyze upstream ${c.key}`,
        mode: 'stall',
        threw: outcome.threw,
        loggedLines: allLines(outcome.captured),
        responseStatus: status,
        reachedWrite: false,
        writeCount: auditPosts,
        rowPersisted: 'n/a',
      });

      assert(
        opened.empty && (stub.readsSeen[c.stallTable] ?? 0) >= 1,
        `[${label}] the stalled read really CROSSED THE WIRE: the stub accepted it, read it in full, and never answered`,
        `windowEmpty=${opened.empty} (${opened.leftovers}) reads=${stub.readsSeen[c.stallTable] ?? 0}`,
      );
      assert(
        outcome.threw === false && elapsedMs < TERMINATION_BUDGET_MS && status === 503,
        `[${label}] the handler FAILS CLOSED with the same 503 as any other fault instead of freezing: unbounded it never answered at all, and the 503 downstream of it was unreachable`,
        `threw=${outcome.threw} elapsed=${elapsedMs}ms status=${status}`,
      );
      // AUD-5(a). These stages used to answer with the LIMITER's code and the
      // limiter's sentence ("We could not check your analysis limit just
      // now"), which is false of all three of them: one loads the session, one
      // decides access, one looks for a scan to reuse. One code for conditions
      // that want identical handling is right; one SENTENCE for conditions
      // that are not the same condition is not. Both halves are asserted, so a
      // future edit cannot restore the limiter wording without failing here.
      const body = outcome.result?.body as { code?: string; error?: string } | undefined;
      assert(
        code === 'analyze_precondition_unavailable' &&
          typeof body?.error === 'string' &&
          !/analysis limit/i.test(body.error),
        `[${label}] and it carries the PRECONDITION machine code with a sentence that is TRUE of this stage, not the limiter's code and the limiter's "we could not check your analysis limit" wording, which named a component that was never consulted`,
        `code=${JSON.stringify(code)} body=${JSON.stringify(outcome.result?.body ?? null)}`,
      );
      const verdict = verifyUpstreamLine(lines, {
        tag: BOUNDED_STAGE_FAILURE_TAG,
        target: c.target,
        eventType: 'analyze_upstream_read',
        sessionId: c.key === 'session lookup' ? '' : SESSION_ID,
        clientId: null,
        fault: 'timeout',
        status: 0,
        code: 'DEADLINE_EXCEEDED',
      });
      assert(
        verdict.ok,
        `[${label}] and it is LOUD: exactly one ${BOUNDED_STAGE_FAILURE_TAG} line naming the stage "${c.target}", fault=timeout code=DEADLINE_EXCEEDED — a 503 with nothing in the log is a mystery, not a report`,
        verdict.reason,
      );
      assert(
        auditPosts === 0,
        `[${label}] and NOTHING was started: no rate-limit row, no analysis record, no Anthropic spend — which is what the line's succeeded field claims`,
        `auditPosts=${auditPosts}`,
      );
    }

    // -----------------------------------------------------------------------
    // 11i. D5 — under AM bypass a failed counter read was COMPLETELY silent.
    // -----------------------------------------------------------------------
    //
    // Both the log and the 503 sat inside `if (rateLimitStateUnknown &&
    // !isAmBypass)`. The ruling scoped the 503 to the non-bypass branch — an
    // AM is never counted, so an unknown counter cannot fail their limit open
    // and must not 503 them — and said nothing about the LOG. Silence there
    // was an accident of where the braces fell, and it is the worst place for
    // it: an AM's analyze click is often the first thing that touches a
    // session, so it is frequently the earliest evidence a Supabase is sick.
    //
    // BOTH DIRECTIONS, because a fix that simply always-503s would satisfy
    // "always logs" while breaking the ruling it was scoped by.
    out('\n--- analyze route: an unknown rate-limit counter under AM bypass ---');
    for (const bypass of [true, false]) {
      const label = `am-bypass counter | ${bypass ? 'bypass' : 'plain'}`;
      stub.faultCountRead = 'stall';
      const opened = await openWriteWindow(label);
      const startedAt = Date.now();
      const outcome = await withCapture(() => driveAnalyzeAs(bypass));
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();
      stub.faultCountRead = false;

      const lines = failureLines(outcome.captured, RATE_LIMIT_READ_FAILURE_TAG);
      const status = outcome.result?.status;
      out(
        `    ${pad(bypass ? 'bypass' : 'plain', 40)} status=${status} ` +
          `elapsed=${elapsedMs}ms rateLimitLines=${lines.length}`,
      );
      rows.push({
        site: `11 am-bypass counter ${bypass ? 'bypass' : 'plain'}`,
        mode: 'stall',
        threw: outcome.threw,
        loggedLines: allLines(outcome.captured),
        responseStatus: status,
        reachedWrite: false,
        writeCount: lines.length,
        rowPersisted: 'n/a',
      });

      const verdict = verifyFailureLine(lines, {
        tag: RATE_LIMIT_READ_FAILURE_TAG,
        table: 'onboarding_audit_events',
        eventType: 'site_intelligence_analyze_requested',
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        fault: 'timeout',
        status: 0,
        pgCode: null,
      });
      assert(
        verdict.ok && opened.empty,
        `[${label}] a stalled counter read is REPORTED, bypass or not: the log is not scoped to the branch the 503 is scoped to, because a degraded Supabase is degraded for everyone`,
        verdict.reason,
      );
      if (bypass) {
        assert(
          outcome.threw === false && elapsedMs < TERMINATION_BUDGET_MS && status === 200,
          `[${label}] and the AM is still NOT 503'd: the ruling scoped the STATUS to the non-bypass branch, and separating the two decisions must not quietly widen it`,
          `threw=${outcome.threw} status=${status} elapsed=${elapsedMs}ms`,
        );
      } else {
        assert(
          outcome.threw === false && elapsedMs < TERMINATION_BUDGET_MS && status === 503,
          `[${label}] while a REAL client still gets the fail-closed 503 from the same condition, so separating log from status changed the log only`,
          `threw=${outcome.threw} status=${status} elapsed=${elapsedMs}ms`,
        );
      }
    }

    // -----------------------------------------------------------------------
    // 11j. D4 — `succeeded` asserted a negative it could not know on a timeout.
    // -----------------------------------------------------------------------
    //
    // The analyze route's WRITE-failure line said "nothing was started: no
    // analysis record, no Anthropic spend" for EVERY fault kind. On a timeout
    // that sentence can be false: attemptAuditWrite's own comment records that
    // aborting does not roll back an INSERT PostgREST may already have
    // committed, and the row in question IS the rate limiter's state. So an
    // operator reading a 503 would conclude no slot was spent while each retry
    // may in fact be spending one.
    //
    // BOTH DIRECTIONS again: the sentence must become uncertain on 'timeout'
    // AND stay definite on a fault that really did refuse the row.
    out('\n--- analyze route: is `succeeded` honest about a timed-out write? ---');
    const succeededFor = async (
      mode: Mode,
      label: string,
    ): Promise<{ succeeded: string; fault: unknown; status?: number }> => {
      stub.mode = mode;
      stub.faultTable = 'onboarding_audit_events';
      stub.faultTableSecondary = null;
      await openWriteWindow(label);
      const outcome = await withCapture(() => driveAnalyze());
      closeWriteWindow();
      stub.mode = 'ok';
      const line = writeFailureLines(outcome.captured)[0];
      return {
        succeeded: String(line?.parsed?.succeeded ?? ''),
        fault: line?.parsed?.fault,
        status: outcome.result?.status,
      };
    };

    const d4Timeout = await succeededFor('stall', 'd4 | timeout');
    const d4Refused = await succeededFor('rls_denied', 'd4 | rls');
    out(`    ${pad('timeout succeeded', 40)} ${JSON.stringify(d4Timeout.succeeded)}`);
    out(`    ${pad('rls_denied succeeded', 40)} ${JSON.stringify(d4Refused.succeeded)}`);
    assert(
      d4Timeout.fault === 'timeout' &&
        d4Timeout.status === 503 &&
        /may or may not/i.test(d4Timeout.succeeded) &&
        /rate-limit row is UNCERTAIN/i.test(d4Timeout.succeeded),
      `[d4 | timeout] on a TIMEOUT the line says the rate-limit slot MAY OR MAY NOT have been spent: aborting does not roll back a row PostgREST may already have committed, so the old flat "nothing was started" was a claim this code cannot make`,
      `fault=${JSON.stringify(d4Timeout.fault)} status=${d4Timeout.status} succeeded=${JSON.stringify(d4Timeout.succeeded)}`,
    );
    assert(
      d4Refused.fault === 'postgrest' &&
        d4Refused.status === 503 &&
        d4Refused.succeeded === 'nothing was started: no analysis record, no Anthropic spend',
      `[d4 | refused] and on a fault that DEFINITELY refused the row the sentence stays definite: fault-awareness must not turn every report into a hedge`,
      `fault=${JSON.stringify(d4Refused.fault)} status=${d4Refused.status} succeeded=${JSON.stringify(d4Refused.succeeded)}`,
    );

    // -----------------------------------------------------------------------
    // 11k. D3 — the analyze route's own after() callback.
    // -----------------------------------------------------------------------
    //
    // It held runSiteAnalysis, getSiteIntelligence and
    // linkSiteIntelligenceToSession with no bound on any of them and, when one
    // threw, a bare console.error(..., err) — not a tagged line, not JSON, no
    // session id, no `succeeded`. Under a stall it did not even reach that: it
    // hung past the response, holding the invocation open, with the 200 long
    // since delivered.
    out('\n--- analyze route: the after() callback, bounded per stage ---');

    interface AfterStageCase {
      key: string;
      /** Reads of this table are stalled... */
      stallTable: string;
      /** ...but only after this many have been served normally. */
      skip: number;
      target: (recordId: string) => string;
      fault: string;
      code: string | null;
      /** A second tag this case must ALSO produce, or null. */
      alsoTag: string | null;
      /**
       * D4. `runSiteAnalysis` CATCHES its own failure, marks the record failed
       * and does NOT rethrow — so the ordinary scan failure never reached the
       * stage line above and reported only through an untagged
       * `console.error('Site analysis failed:', …)`. It now emits its own
       * BOUNDED_STAGE line with this event_type. Set where the analysis
       * actually reaches that catch; null where it throws before the try.
       */
      alsoStageEvent: string | null;
    }

    const afterStageCases: AfterStageCase[] = [
      {
        key: 'runSiteAnalysis record read',
        stallTable: 'onboarding_site_intelligence',
        skip: 0,
        target: (id) => `site_analysis (runSiteAnalysis(${id}))`,
        // The bounded read inside runSiteAnalysis ends the stall at 5s and
        // reports it; the analysis then throws its own 'record not found',
        // which is a plain Error rather than a deadline — so the STAGE line
        // must classify it honestly as 'unknown' rather than pretending the
        // stage itself timed out.
        fault: 'unknown',
        code: null,
        alsoTag: READ_FAILURE_TAG,
        // `if (!record) throw` sits OUTSIDE runSiteAnalysis's try, so this
        // case rejects before the D4 catch is reachable.
        alsoStageEvent: null,
      },
      {
        key: 'getSiteIntelligence status read',
        stallTable: 'onboarding_site_intelligence',
        // runSiteAnalysis reads this table ONCE; serving that read and
        // stalling the next is the only way to fault the SECOND bounded call
        // on the same table. Without the skip this case would silently
        // re-test the first one.
        skip: 1,
        target: () => 'analysis_status_read (onboarding_site_intelligence)',
        fault: 'timeout',
        code: 'DEADLINE_EXCEEDED',
        alsoTag: null,
        // Here the record read IS served, the analysis runs, no providers are
        // configured in the harness, and the resulting throw lands in
        // runSiteAnalysis's own catch — i.e. the most common background-scan
        // failure there is, and the one that used to report untagged.
        alsoStageEvent: 'site_analysis_failed',
      },
    ];

    for (const c of afterStageCases) {
      const setupLabel = `setup: analyze after | ${c.key}`;
      stub.stallReadTables = [];
      stub.stallReadSkip = {};
      labelWriteWindow(setupLabel);
      capturedAfterTasks = [];
      const first = await driveAnalyze();
      const recordId = String((first.body as { recordId?: string } | undefined)?.recordId ?? '');
      const tasks = capturedAfterTasks.filter(Boolean);
      assert(
        tasks.length === 1 && recordId !== '',
        `[analyze after | ${c.key}] the analyze route registered exactly 1 after() task and returned a record id — the route-to-after() wiring IS the driver, so deleting the after(...) must fail this`,
        `tasks=${tasks.length} recordId=${JSON.stringify(recordId)} status=${first.status}`,
      );
      const task = tasks[0] ?? makeMissingTaskDriver(`analyze after ${c.key}`);

      stub.readsSeen[c.stallTable] = 0;
      stub.stallReadTables = [c.stallTable];
      stub.stallReadSkip = { [c.stallTable]: c.skip };
      const label = `analyze after | ${c.key}`;
      const opened = await openWriteWindow(label);
      const startedAt = Date.now();
      const outcome = await withCapture(async () => {
        await task();
        return {};
      });
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();
      stub.stallReadTables = [];
      stub.stallReadSkip = {};

      // TWO event types now share this tag on this path, so the stage line is
      // selected by event_type rather than by "the only one". Counting alone
      // would make D4's new line look like a duplicate of the stage's.
      const stageLines = failureLines(outcome.captured, BOUNDED_STAGE_FAILURE_TAG);
      const lines = stageLines.filter(
        (l) => l.parsed?.event_type === 'site_intelligence_background_analysis',
      );
      out(
        `    ${pad(c.key, 40)} reads=${stub.readsSeen[c.stallTable] ?? 0} ` +
          `elapsed=${elapsedMs}ms lines=${lines.length} stageTagged=${stageLines.length}`,
      );
      rows.push({
        site: `12 analyze after ${c.key}`,
        mode: 'stall',
        threw: outcome.threw,
        loggedLines: allLines(outcome.captured),
        responseStatus: undefined,
        reachedWrite: false,
        writeCount: lines.length,
        rowPersisted: 'n/a',
      });

      assert(
        opened.empty && (stub.readsSeen[c.stallTable] ?? 0) > c.skip,
        `[${label}] the stalled read really CROSSED THE WIRE past the ${c.skip} read(s) served normally, so this case faults the call it names and not an earlier one on the same table`,
        `windowEmpty=${opened.empty} (${opened.leftovers}) reads=${stub.readsSeen[c.stallTable] ?? 0} skip=${c.skip}`,
      );
      assert(
        outcome.threw === false && elapsedMs < TERMINATION_BUDGET_MS,
        `[${label}] the after() callback TERMINATES: unbounded it hung past the response with only a console.error for company, holding the invocation open until the platform killed it`,
        `threw=${outcome.threw} elapsed=${elapsedMs}ms budget=${TERMINATION_BUDGET_MS}ms`,
      );
      const verdict = verifyUpstreamLine(lines, {
        tag: BOUNDED_STAGE_FAILURE_TAG,
        target: c.target(recordId),
        eventType: 'site_intelligence_background_analysis',
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        fault: c.fault,
        status: c.fault === 'timeout' ? 0 : null,
        code: c.code,
      });
      assert(
        verdict.ok,
        `[${label}] and the path that had NO failure-reporting write at all now emits one line in the same shape as every other tag, naming the stage that failed`,
        verdict.reason,
      );
      if (c.alsoTag) {
        const also = failureLines(outcome.captured, c.alsoTag);
        assert(
          also.length === 1 &&
            also[0]?.parsed?.table === 'onboarding_site_intelligence' &&
            also[0]?.parsed?.event_type === 'analysis_record_lookup' &&
            also[0]?.parsed?.fault === 'timeout',
          `[${label}] and the READ inside runSiteAnalysis reports itself too, so an operator learns WHICH await stalled rather than only that the stage did`,
          `lines=${JSON.stringify(also.map((l) => l.raw))}`,
        );
      }
      // D4 — the failure runSiteAnalysis SWALLOWS.
      const d4Lines = stageLines.filter((l) => l.parsed?.event_type === 'site_analysis_failed');
      const d4 = d4Lines[0]?.parsed ?? null;
      assert(
        c.alsoStageEvent === null
          ? d4Lines.length === 0
          : d4Lines.length === 1 &&
              d4 !== null &&
              d4.session_id === SESSION_ID &&
              typeof d4.target === 'string' &&
              (d4.target as string).startsWith('site_analysis (') &&
              typeof d4.message === 'string' &&
              (d4.message as string).length > 0 &&
              typeof d4.succeeded === 'string' &&
              (d4.succeeded as string).length > 0 &&
              d4Lines[0]!.raw.indexOf('\n') === -1,
        `[${label}] and runSiteAnalysis's OWN catch — the one that marks the record failed and does NOT rethrow, i.e. where the most common scan failure actually lands — ${
          c.alsoStageEvent === null
            ? 'is correctly NOT reached here, because this case throws before the try'
            : 'now emits its own tagged single-line record instead of the untagged two-argument console.error that used to be its only trace'
        }`,
        `d4Lines=${JSON.stringify(d4Lines.map((l) => l.raw))} expected=${
          c.alsoStageEvent === null ? 'none' : 'exactly 1'
        }`,
      );
    }

    // -----------------------------------------------------------------------
    // 11l. D6 — the bridge's own console.error lines.
    // -----------------------------------------------------------------------
    //
    // Two lines CONCATENATED remote text: `body.slice(0, 500)` on the non-2xx
    // path and a caught `message` in the outer catch. safeField and
    // JSON.stringify exist precisely so a newline in a value this code did not
    // author cannot split the record and strand the tag on the half without
    // the news — and both lines bypassed them.
    out('\n--- dashboard bridge: remote text through the emitter, not concatenated ---');
    {
      // A body shaped like what actually arrives from a sick proxy or an
      // unhandled framework error: multiple physical lines.
      const HOSTILE_BODY =
        'Internal Server Error\nTraceback (most recent call last):\n  File "app.py", line 1\n    boom\r\nRuntimeError: boom';
      stub.dashboardBody = HOSTILE_BODY;
      const tasks = await prepareSubmitTasksQuietly('setup: bridge | hostile body');
      const task = tasks[0] ?? makeMissingTaskDriver('dashboard bridge (hostile body)');
      const label = 'bridge | hostile body';
      const opened = await openWriteWindow(label);
      const outcome = await withCapture(async () => {
        await task();
        return {};
      });
      closeWriteWindow();
      stub.dashboardBody = null;

      const lines = failureLines(outcome.captured, UPSTREAM_HTTP_FAILURE_TAG);
      const transcript = allLines(outcome.captured);
      out(`    ${pad('hostile dashboard body', 40)} lines=${lines.length} transcript=${transcript.length}`);
      rows.push({
        site: '13 bridge hostile body',
        mode: 'ok',
        threw: outcome.threw,
        loggedLines: transcript,
        responseStatus: undefined,
        reachedWrite: true,
        writeCount: lines.length,
        rowPersisted: 'n/a',
      });

      const verdict = verifyUpstreamLine(lines, {
        tag: UPSTREAM_HTTP_FAILURE_TAG,
        target: `${origin}/api/clients`,
        eventType: 'dashboard_client_sync',
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        fault: 'gateway',
        status: 500,
        code: null,
      });
      assert(
        verdict.ok && opened.empty,
        `[${label}] the dashboard's non-2xx goes through the SAME emitter as everything else: ONE physical line, tag then JSON, with the multi-line remote body ESCAPED rather than concatenated — the old line fragmented here and stranded the tag`,
        verdict.reason,
      );
      assert(
        String(lines[0]?.parsed?.message ?? '').includes('RuntimeError: boom') &&
          !transcript.some((l) => l.includes('[dashboard-bridge] dashboard POST')),
        `[${label}] and nothing is lost by routing it: the whole remote body still reaches the operator inside the record, and the hand-built concatenating line is GONE rather than duplicated alongside it`,
        `message=${JSON.stringify(lines[0]?.parsed?.message ?? null)} transcript=${JSON.stringify(transcript)}`,
      );
    }

    // -----------------------------------------------------------------------
    // 11m. R4 — the "NEVER throws, under any input" claim, made true.
    // -----------------------------------------------------------------------
    // recordAuditRow's comment claimed it never throws under any input. That
    // was literally false for the two wrappers built on it: auditEventSpec and
    // openEventSpec dereferenced `opts.clientId` / `meta.clientId` OUTSIDE
    // recordAuditRow's try — a spec argument is EVALUATED BEFORE the call it
    // is passed to — so a caller handing in a null or hostile options object
    // got a raw TypeError out of a frame that promised not to throw.
    //
    // Hostile means all three shapes at once: a missing object, and an object
    // with a THROWING GETTER on each field the builder reads.
    out('\n--- hostile options objects: the totality claim, tested rather than asserted ---');
    const hostileOpts = (): Record<string, unknown> => {
      const o = Object.create(null) as Record<string, unknown>;
      for (const key of ['clientId', 'route', 'succeeded', 'userAgent', 'ipHash']) {
        Object.defineProperty(o, key, {
          enumerable: true,
          get() {
            throw new TypeError(`hostile getter for ${key}`);
          },
        });
      }
      return o;
    };

    stub.mode = 'rls_denied';
    stub.faultTable = 'onboarding_audit_events';

    await openWriteWindow('hostile | recordAuditEvent | null opts');
    const hostileNull = await withCapture(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await serverMod.recordAuditEvent(SESSION_ID, 'hostile_probe', { probe: true }, null as any);
      return {};
    });
    closeWriteWindow();
    const hostileNullLines = writeFailureLines(hostileNull.captured);
    out(`    recordAuditEvent(null opts)    threw=${hostileNull.threw} lines=${hostileNullLines.length}`);
    assert(
      hostileNull.threw === false &&
        hostileNullLines.length === 1 &&
        typeof hostileNullLines[0]?.parsed?.route === 'string' &&
        (hostileNullLines[0]?.parsed?.route as string).length > 0 &&
        typeof hostileNullLines[0]?.parsed?.succeeded === 'string' &&
        (hostileNullLines[0]?.parsed?.succeeded as string).length > 0,
      `[hostile opts | recordAuditEvent] a NULL options object no longer produces a raw TypeError from the spec builder: the call stays total and still emits one line, whose route and succeeded say plainly that the call site supplied neither`,
      `threw=${hostileNull.threw} :: ${String(hostileNull.error)} lines=${JSON.stringify(allLines(hostileNull.captured))}`,
    );

    await openWriteWindow('hostile | recordAuditEvent | throwing getters');
    const hostileGetters = await withCapture(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      await serverMod.recordAuditEvent(SESSION_ID, 'hostile_probe', { probe: true }, hostileOpts() as any);
      return {};
    });
    closeWriteWindow();
    const hostileGetterLines = writeFailureLines(hostileGetters.captured);
    out(`    recordAuditEvent(hostile opts) threw=${hostileGetters.threw} lines=${hostileGetterLines.length}`);
    assert(
      hostileGetters.threw === false &&
        hostileGetterLines.length === 1 &&
        hostileGetterLines[0]?.parsed?.fault === 'postgrest',
      `[hostile opts | recordAuditEvent] an options object whose every getter THROWS is absorbed too, and the injected Supabase fault is still the one reported — the hostile input does not become the news`,
      `threw=${hostileGetters.threw} :: ${String(hostileGetters.error)} lines=${JSON.stringify(allLines(hostileGetters.captured))}`,
    );

    stub.faultTable = 'onboarding_open_events';
    await openWriteWindow('hostile | recordOpenEvent | throwing getters');
    const hostileOpen = await withCapture(async () => {
      /* eslint-disable @typescript-eslint/no-explicit-any */
      await serverMod.recordOpenEvent(SESSION_ID, hostileOpts() as any, hostileOpts() as any);
      /* eslint-enable @typescript-eslint/no-explicit-any */
      return {};
    });
    closeWriteWindow();
    const hostileOpenLines = writeFailureLines(hostileOpen.captured);
    out(`    recordOpenEvent(hostile x2)    threw=${hostileOpen.threw} lines=${hostileOpenLines.length}`);
    assert(
      hostileOpen.threw === false &&
        hostileOpenLines.length === 1 &&
        hostileOpenLines[0]?.parsed?.table === 'onboarding_open_events',
      `[hostile opts | recordOpenEvent] the OTHER wrapper is total in its own right as well, on BOTH of the objects it dereferences: the open-events builder reads a row object and a meta object, and neither was guarded`,
      `threw=${hostileOpen.threw} :: ${String(hostileOpen.error)} lines=${JSON.stringify(allLines(hostileOpen.captured))}`,
    );

    stub.faultTable = 'onboarding_audit_events';
    await openWriteWindow('hostile | insertAuditEventOrThrow | null opts');
    const hostileThrow = await withCapture(async () => {
      await serverMod.insertAuditEventOrThrow(
        SESSION_ID,
        'hostile_probe',
        { probe: true },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        null as any,
      );
      return {};
    });
    closeWriteWindow();
    out(
      `    insertAuditEventOrThrow(null)  threw=${hostileThrow.threw} error=${
        hostileThrow.error instanceof Error ? hostileThrow.error.name : String(hostileThrow.error)
      }`,
    );
    assert(
      hostileThrow.threw === true &&
        hostileThrow.error instanceof Error &&
        hostileThrow.error.name === 'AuditWriteError',
      `[hostile opts | insertAuditEventOrThrow] the fail-closed entry point still throws the ONE error type its caller branches on, not a TypeError from the spec builder: a raw TypeError would have flattened into the analyze route's generic 500 and lost the machine-readable reason`,
      `threw=${hostileThrow.threw} error=${String(hostileThrow.error)}`,
    );
    stub.mode = 'ok';

    // -----------------------------------------------------------------------
    // 11h. R5 — the degraded line escapes what it prints.
    // -----------------------------------------------------------------------
    // logAuditWriteFailure's fallback branch used to CONCATENATE
    // `err.fault.message` raw. A message containing a newline therefore
    // fragmented the record into two physical lines and stranded the tag on
    // the half without the interesting text — the exact hazard the JSON path
    // is documented to avoid, reintroduced on the path taken when things are
    // already going badly.
    //
    // Driven directly, because the fallback is only reachable when building
    // the full record FAILS: a throwing getter on the error object gets there,
    // and nothing a stub can inject does.
    out('\n--- the degraded failure line: a newline in the message must not split the record ---');
    const NEWLINE_MESSAGE = 'first line of the refusal\nsecond line carrying the actionable part';
    const bomb = {
      table: 'onboarding_audit_events',
      fault: { kind: 'postgrest', status: 403, code: '42501', message: NEWLINE_MESSAGE },
      context: {
        eventType: 'degraded_probe',
        sessionId: SESSION_ID,
        route: 'direct probe',
        succeeded: 'nothing',
      },
    };
    // Reading client_id is what throws, so the COMPLETE record cannot be
    // built and the degraded branch is the one that runs.
    Object.defineProperty(bomb.context, 'clientId', {
      enumerable: true,
      get() {
        throw new TypeError('hostile getter for clientId');
      },
    });
    const degraded = await withCapture(async () => {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      serverMod.logAuditWriteFailure(bomb as any);
      return {};
    });
    const degradedLines = writeFailureLines(degraded.captured);
    const degradedAll = allLines(degraded.captured);
    out(`    degraded → ${JSON.stringify(degradedAll)}`);
    assert(
      degraded.threw === false && degradedLines.length === 1 && degradedAll.length === 1,
      `[degraded line] the fallback branch emits exactly ONE physical line: a message containing a newline used to fragment the record and leave the ${WRITE_FAILURE_TAG} tag on the half an operator does not need`,
      `threw=${degraded.threw} taggedLines=${degradedLines.length} totalLines=${degradedAll.length} :: ${JSON.stringify(degradedAll)}`,
    );
    assert(
      degradedLines[0]?.parsed !== null &&
        degradedLines[0]?.parsed?.message === NEWLINE_MESSAGE &&
        degradedLines[0]?.parsed?.table === 'onboarding_audit_events' &&
        degradedLines[0]?.parsed?.session_id === SESSION_ID,
      `[degraded line] and it is still JSON an operator can parse: the newline is ESCAPED rather than emitted, so the whole message survives on the tagged line alongside the table and session`,
      `parsed=${JSON.stringify(degradedLines[0]?.parsed ?? null)} raw=${JSON.stringify(degradedLines[0]?.raw ?? null)}`,
    );

    // -----------------------------------------------------------------------
    // 11n. AUD-2 — AN UNSERIALISABLE RECORD, THROUGH EACH OF THE THREE
    //      EMITTERS. THE REPORTING LAYER'S OWN SILENT-FAILURE BUG.
    // -----------------------------------------------------------------------
    //
    // This branch exists to remove silent failure. Its own reporting layer had
    // it: of the three emitters, `logSupabaseFailure` — the one SIX of the
    // seven reporting sites go through — had a bare `catch {}` where the other
    // two had a degraded fallback. When the record could not be serialised it
    // emitted ZERO lines.
    //
    // THE INJECTION IS A BIGINT, and it is not a contrivance. `JSON.stringify`
    // REFUSES a BigInt with a TypeError, so `fault.status = 1n` makes the
    // full-record path throw at exactly the point the fallback exists for,
    // without needing a hostile getter — the same class as a status field that
    // some future normaliser hands over as an exotic value.
    //
    // The contract is the same for all three: EXACTLY ONE physical line,
    // carrying the emitter's own tag, parseable as JSON, and marked degraded
    // so an operator knows they are reading the floor rather than the record.
    out('\n--- unserialisable record: every emitter must still produce exactly one tagged line ---');

    interface EmitterCase {
      key: string;
      tag: string;
      /** The subject field this shape carries: 'table' or 'target'. */
      subjectField: 'table' | 'target';
      subject: string;
      emit: () => void;
    }

    // A BigInt anywhere in the record makes JSON.stringify throw.
    const unserialisableFault = {
      kind: 'postgrest',
      // BigInt(1) rather than a 1n literal: this repo's tsconfig target is
      // below ES2020, so the literal will not compile. Same value, same refusal
      // from JSON.stringify.
      status: BigInt(1) as unknown as number,
      code: '42501',
      message: 'the write was refused and the record cannot be serialised',
    };

    const emitterCases: EmitterCase[] = [
      {
        key: 'logAuditWriteFailure',
        tag: WRITE_FAILURE_TAG,
        subjectField: 'table',
        subject: 'onboarding_audit_events',
        emit: () =>
          serverMod.logAuditWriteFailure({
            table: 'onboarding_audit_events',
            fault: unserialisableFault,
            context: {
              route: 'direct probe',
              eventType: 'unserialisable_probe',
              sessionId: SESSION_ID,
              clientId: CLIENT_ID,
              succeeded: 'nothing',
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
          } as any),
      },
      {
        key: 'logSupabaseFailure',
        tag: READ_FAILURE_TAG,
        subjectField: 'table',
        subject: 'onboarding_sessions',
        emit: () =>
          serverMod.logSupabaseFailure(
            READ_FAILURE_TAG,
            {
              route: 'direct probe',
              table: 'onboarding_sessions',
              eventType: 'unserialisable_probe',
              sessionId: SESSION_ID,
              clientId: CLIENT_ID,
              succeeded: 'nothing',
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            unserialisableFault as any,
          ),
      },
      {
        key: 'logUpstreamFailure',
        tag: UPSTREAM_HTTP_FAILURE_TAG,
        subjectField: 'target',
        subject: 'https://dashboard.invalid/api/clients',
        emit: () =>
          serverMod.logUpstreamFailure(
            UPSTREAM_HTTP_FAILURE_TAG,
            {
              route: 'direct probe',
              target: 'https://dashboard.invalid/api/clients',
              eventType: 'unserialisable_probe',
              sessionId: SESSION_ID,
              clientId: CLIENT_ID,
              succeeded: 'nothing',
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            unserialisableFault as any,
          ),
      },
    ];

    for (const c of emitterCases) {
      const outcome = await withCapture(async () => {
        c.emit();
        return {};
      });
      const tagged = failureLines(outcome.captured, c.tag);
      const every = allLines(outcome.captured);
      const parsed = tagged[0]?.parsed ?? null;
      out(
        `    ${pad(c.key, 24)} threw=${outcome.threw} taggedLines=${tagged.length} ` +
          `totalLines=${every.length} degraded=${JSON.stringify(parsed?.degraded ?? null)}`,
      );
      assert(
        outcome.threw === false && tagged.length === 1 && every.length === 1,
        `[unserialisable record | ${c.key}] a record JSON.stringify REFUSES still produces EXACTLY ONE tagged physical line: this emitter used to be the difference between a reporting layer and a reporting layer that gives up when the news is awkward`,
        `threw=${outcome.threw} :: ${String(outcome.error)} tagged=${tagged.length} total=${every.length} :: ${JSON.stringify(every)}`,
      );
      assert(
        parsed !== null &&
          parsed[c.subjectField] === c.subject &&
          parsed.session_id === SESSION_ID &&
          typeof parsed.degraded === 'string' &&
          (parsed.degraded as string).length > 0,
        `[unserialisable record | ${c.key}] and the floor is still PARSEABLE JSON naming the ${c.subjectField} and the session, and SAYS it is degraded, so an operator reading it knows which fields were dropped rather than believing the record is complete`,
        `parsed=${JSON.stringify(parsed)} raw=${JSON.stringify(tagged[0]?.raw ?? null)}`,
      );
    }

    // -----------------------------------------------------------------------
    // 11n-ii. D1 — THE DEGRADED PATH'S OWN CATCH HANDLER.
    // -----------------------------------------------------------------------
    //
    // THE HARNESS GAP THIS CLOSES, stated first, because it is the finding.
    // 11n above drives all three emitters with `fault.status = BigInt(1)`.
    // That breaks the FULL-record path only: every field READ on the degraded
    // path still succeeds, so `safeField`'s CATCH HANDLER was never entered by
    // any of the 424 assertions. Nothing anywhere drove the floor with a field
    // whose READ throws.
    //
    // And the catch handler was itself unguarded. It built
    // `<unreadable: ${err instanceof Error ? err.name : 'throw'}>`:
    //
    //   - `err instanceof Error` walks the PROTOTYPE CHAIN, so a Proxy with a
    //     throwing `getPrototypeOf` trap throws a SECOND time, from inside the
    //     handler whose only job is to absorb the first;
    //   - `err.name` is a property read on that same value, and `${…}` coerces
    //     it, so a throwing `get` trap gets there by two more routes.
    //
    // The second throw escapes `safeField`, escapes `parts.map(...)`, and
    // lands in `emitDegradedLine`'s outer `catch {}` — which is empty, because
    // a total function has to end somewhere. So the shared floor under ALL
    // THREE emitters produced ZERO LINES.
    //
    // The injection is therefore a field whose getter throws a value that is
    // hostile in BOTH ways at once. Contract, per emitter: exactly one tagged
    // record, on ONE physical line, parseable, marked degraded, still naming
    // the session, with the unreadable field rendered as an encoded sentinel
    // rather than dropped.
    out('\n--- degraded path: a field whose READ throws a hostile value, per emitter ---');

    /** Throws a value that is hostile to `instanceof` AND to every property read. */
    const throwHostile = (): never => {
      throw new Proxy(new TypeError('hostile field getter'), {
        getPrototypeOf() {
          throw new TypeError('hostile getPrototypeOf trap');
        },
        get() {
          throw new TypeError('hostile get trap');
        },
      });
    };

    /** Give `target[key]` a getter that throws that value. */
    const withThrowingGetter = <T extends object>(target: T, key: string): T => {
      Object.defineProperty(target, key, { enumerable: true, get: throwHostile });
      return target;
    };

    interface FloorCase {
      key: string;
      tag: string;
      /** The field whose getter throws, which is also the one the floor prints. */
      field: string;
      emit: () => void;
    }

    const floorCases: FloorCase[] = [
      {
        key: 'logAuditWriteFailure',
        tag: WRITE_FAILURE_TAG,
        field: 'table',
        emit: () => {
          const err = withThrowingGetter(
            {
              fault: {
                kind: 'postgrest',
                status: 403,
                code: '42501',
                message: 'refused',
              },
              context: {
                route: 'direct probe',
                eventType: 'hostile_read_probe',
                sessionId: SESSION_ID,
                clientId: CLIENT_ID,
                succeeded: 'nothing',
              },
            },
            'table',
          );
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          serverMod.logAuditWriteFailure(err as any);
        },
      },
      {
        key: 'logSupabaseFailure',
        tag: READ_FAILURE_TAG,
        field: 'table',
        emit: () => {
          const ctx = withThrowingGetter(
            {
              route: 'direct probe',
              eventType: 'hostile_read_probe',
              sessionId: SESSION_ID,
              clientId: CLIENT_ID,
              succeeded: 'nothing',
            },
            'table',
          );
          serverMod.logSupabaseFailure(
            READ_FAILURE_TAG,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx as any,
            { kind: 'postgrest', status: 403, code: '42501', message: 'refused' },
          );
        },
      },
      {
        key: 'logUpstreamFailure',
        tag: UPSTREAM_HTTP_FAILURE_TAG,
        field: 'target',
        emit: () => {
          const ctx = withThrowingGetter(
            {
              route: 'direct probe',
              eventType: 'hostile_read_probe',
              sessionId: SESSION_ID,
              clientId: CLIENT_ID,
              succeeded: 'nothing',
            },
            'target',
          );
          serverMod.logUpstreamFailure(
            UPSTREAM_HTTP_FAILURE_TAG,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ctx as any,
            { kind: 'transport', status: 0, code: null, message: 'refused' },
          );
        },
      },
    ];

    for (const c of floorCases) {
      const outcome = await withCapture(async () => {
        c.emit();
        return {};
      });
      const tagged = failureLines(outcome.captured, c.tag);
      const every = allLines(outcome.captured);
      const parsed = tagged[0]?.parsed ?? null;
      out(
        `    ${pad(c.key, 24)} threw=${outcome.threw} taggedLines=${tagged.length} ` +
          `totalLines=${every.length} ${c.field}=${JSON.stringify(parsed?.[c.field] ?? null)}`,
      );
      assert(
        outcome.threw === false && tagged.length === 1 && every.length === 1,
        `[hostile field read | ${c.key}] a record whose "${c.field}" GETTER THROWS a hostile value still produces EXACTLY ONE tagged physical line: safeField's catch handler used to run instanceof and a property read on that value, throw a second time, and leave the shared floor emitting nothing at all`,
        `threw=${outcome.threw} :: ${String(outcome.error)} tagged=${tagged.length} total=${every.length} :: ${JSON.stringify(every)}`,
      );
      assert(
        parsed !== null &&
          parsed.session_id === SESSION_ID &&
          typeof parsed.degraded === 'string' &&
          (parsed.degraded as string).length > 0 &&
          typeof parsed[c.field] === 'string' &&
          (parsed[c.field] as string).startsWith('<unreadable') &&
          tagged[0]!.raw.indexOf('\n') === -1,
        `[hostile field read | ${c.key}] and the floor is still PARSEABLE JSON on one physical line, naming the session, SAYING it is degraded, and rendering the unreadable field as an encoded sentinel rather than dropping it — so an operator can tell "this field could not be read" from "this field was not there"`,
        `parsed=${JSON.stringify(parsed)} raw=${JSON.stringify(tagged[0]?.raw ?? null)}`,
      );
    }

    // -----------------------------------------------------------------------
    // 11n-iii. D2/D6 — A `message` THAT IS NOT A STRING.
    // -----------------------------------------------------------------------
    //
    // THE OTHER HALF OF THE SAME HARNESS GAP. Nothing in the matrix ever drove
    // a normaliser with a non-string `message`, because the stub always
    // answers with a well-formed PostgREST body. `boundFaultMessage` called
    // `.slice` on the parameter, on the strength of a TypeScript annotation
    // over a value that is JSON.parse'd out of a REMOTE RESPONSE BODY — so
    // `{"message":["a","b"]}` threw `TypeError: message.slice is not a
    // function` out of every normaliser that routes through it.
    //
    // AND THE THROW HAPPENS IN ARGUMENT POSITION. Six of the seven reporting
    // sites are written as
    //
    //     logSupabaseFailure(tag, ctx, normaliseAuditFault(status, error))
    //
    // and a JavaScript argument is evaluated BEFORE the call it is passed to.
    // So the TypeError escaped one frame BELOW the logger, before its `try`
    // was ever entered: no full record, no degraded line, NOTHING. The emitter
    // floors proven in 11n and 11n-ii cannot help, because nothing reaches
    // them. That is why these cases drive the normaliser INSIDE the argument
    // list rather than normalising first and emitting second — the shape of
    // the real call site is the bug.
    //
    // D6 is the same root seen from the other end: a value that is not a
    // string but IS JSON-serialisable used to pass STRAIGHT THROUGH into a
    // field the emitter declares as `string`, so the emitted record's type was
    // a lie. Every case therefore also asserts the declared types.
    out('\n--- non-string message: every normaliser must stay total, and stay type-true ---');

    interface MessageShape {
      key: string;
      value: unknown;
    }
    const messageShapes: MessageShape[] = [
      { key: 'array', value: ['a', 'b'] },
      { key: 'object', value: { detail: 'refused', nested: { code: 42 } } },
      { key: 'number', value: 42 },
      { key: 'null', value: null },
      { key: 'undefined', value: undefined },
    ];

    interface NormaliserCase {
      key: string;
      /** Build a fault from a `message` of the given shape. */
      build: (message: unknown) => unknown;
    }
    const normaliserCases: NormaliserCase[] = [
      {
        key: 'normaliseAuditFault',
        build: (message) =>
          serverMod.normaliseAuditFault(
            403,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { message, code: '42501', details: null, hint: null } as any,
            'the write was refused with no error body',
          ),
      },
      {
        key: 'normaliseReadFault',
        build: (message) =>
          serverMod.normaliseReadFault(
            500,
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            { message, code: '42501', details: null, hint: null } as any,
            'the count query answered with a null count',
            'the count query was refused with no error body',
          ),
      },
      {
        key: 'normaliseHttpResponseFault',
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        build: (message) => serverMod.normaliseHttpResponseFault(502, message as any),
      },
      {
        key: 'normaliseThrownFault',
        build: (message) => serverMod.normaliseThrownFault({ name: 'Error', message }),
      },
    ];

    interface NormalisedShape {
      kind?: unknown;
      status?: unknown;
      code?: unknown;
      message?: unknown;
    }

    for (const n of normaliserCases) {
      for (const s of messageShapes) {
        const label = `${n.key} | message=${s.key}`;
        // A HOLDER, not a `let`: the assignment happens inside a closure, and
        // TypeScript narrows a closure-assigned `let` to its initialiser at
        // the use site. The holder keeps the declared type honest without
        // moving the call out of argument position, which is the shape under
        // test.
        const holder: { fault: NormalisedShape | null } = { fault: null };
        const outcome = await withCapture(async () => {
          // THE REAL CALL SHAPE: the normaliser is evaluated as an ARGUMENT.
          // If it throws, nothing is emitted — which is exactly what happened.
          serverMod.logSupabaseFailure(
            READ_FAILURE_TAG,
            {
              route: 'direct probe',
              table: 'onboarding_audit_events',
              eventType: 'non_string_message_probe',
              sessionId: SESSION_ID,
              clientId: CLIENT_ID,
              succeeded: 'nothing: this probe writes no application data',
            },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            (holder.fault = n.build(s.value) as NormalisedShape) as any,
          );
          return {};
        });
        const fault = holder.fault;
        const tagged = failureLines(outcome.captured, READ_FAILURE_TAG);
        const every = allLines(outcome.captured);
        out(
          `    ${pad(label, 46)} threw=${outcome.threw} lines=${tagged.length}/${every.length} ` +
            `message=${JSON.stringify(fault?.message ?? null).slice(0, 60)}`,
        );
        assert(
          outcome.threw === false && tagged.length === 1 && every.length === 1,
          `[non-string message | ${label}] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely`,
          `threw=${outcome.threw} :: ${String(outcome.error)} tagged=${tagged.length} total=${every.length} :: ${JSON.stringify(every)}`,
        );
        const line = tagged[0]?.parsed ?? null;
        assert(
          fault !== null &&
            typeof fault.message === 'string' &&
            (fault.message as string).length > 0 &&
            (fault.code === null || typeof fault.code === 'string') &&
            (fault.status === null || typeof fault.status === 'number') &&
            line !== null &&
            typeof line.message === 'string' &&
            (line.pg_code === null || typeof line.pg_code === 'string') &&
            (line.status === null || typeof line.status === 'number') &&
            tagged[0]!.raw.indexOf('\n') === -1,
          `[non-string message | ${label}] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on`,
          `fault=${JSON.stringify(fault)} line=${JSON.stringify(line)}`,
        );
      }
    }

    // A non-string CODE, which is the same D6 defect in the field an operator
    // greps by SQLSTATE. `error.code || null` copied whatever was there.
    out('\n--- non-string code: pg_code must be a SQLSTATE-shaped string or null, never a structure ---');
    for (const s of messageShapes.filter((m) => m.value !== null && m.value !== undefined)) {
      const fault = serverMod.normaliseAuditFault(
        403,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        { message: 'refused', code: s.value, details: null, hint: null } as any,
      ) as NormalisedShape;
      out(`    ${pad(`code=${s.key}`, 46)} code=${JSON.stringify(fault.code)}`);
      assert(
        typeof fault.code === 'string' && (fault.code as string).length > 0,
        `[non-string code | ${s.key}] a non-string \`code\` is COERCED to a bounded string rather than copied into a field declared string|null: an array in pg_code is emitted as a JSON array, which breaks the one field an operator filters on`,
        `code=${JSON.stringify(fault.code)} fault=${JSON.stringify(fault)}`,
      );
    }

    // -----------------------------------------------------------------------
    // 11o. AUD-4 — THE TOTALITY CLAIM, AGAINST A HOSTILE PROTOTYPE CHAIN.
    // -----------------------------------------------------------------------
    //
    // `normaliseThrownFault` is documented as TOTAL: an exotic object may not
    // turn a failure report into a second failure. It was not. Every PROPERTY
    // read was guarded, but `err instanceof DeadlineExceededError` is not a
    // property read — it walks the prototype chain — so a Proxy with a hostile
    // `getPrototypeOf` trap threw straight out of the normaliser, from inside
    // the one function whose entire job is to make a thrown value reportable.
    //
    // Three shapes, because the traps are independent: a hostile prototype
    // alone, a hostile prototype PLUS hostile property gets, and a hostile
    // prototype over a REAL DeadlineExceededError (which must still classify
    // as a deadline, since the guard answers "not an instance" and only the
    // name is left to recognise it by).
    out('\n--- hostile Proxy: an exotic thrown value may not become a second failure ---');

    const hostileProto = (target: object): unknown =>
      new Proxy(target, {
        getPrototypeOf() {
          throw new TypeError('hostile getPrototypeOf trap');
        },
      });
    const hostileProtoAndGets = (target: object): unknown =>
      new Proxy(target, {
        getPrototypeOf() {
          throw new TypeError('hostile getPrototypeOf trap');
        },
        get() {
          throw new TypeError('hostile get trap');
        },
      });

    interface NormalisedProbeFault {
      kind?: string;
      code?: string | null;
      message?: string;
    }
    interface ProxyCase {
      key: string;
      build: () => unknown;
      wantKind: string;
      wantCode: string | null;
    }
    const proxyCases: ProxyCase[] = [
      {
        key: 'hostile getPrototypeOf over a TypeError',
        build: () => hostileProto(new TypeError('fetch failed')),
        wantKind: 'transport',
        wantCode: null,
      },
      {
        key: 'hostile getPrototypeOf + hostile get',
        build: () => hostileProtoAndGets(new Error('unreadable')),
        wantKind: 'unknown',
        wantCode: null,
      },
      {
        key: 'hostile getPrototypeOf over a real deadline',
        build: () => hostileProto(new serverMod.DeadlineExceededError('probe_stage', 5000)),
        wantKind: 'timeout',
        wantCode: 'DEADLINE_EXCEEDED',
      },
    ];

    for (const c of proxyCases) {
      let threw = false;
      let error: unknown = null;
      let fault: NormalisedProbeFault | null = null;
      try {
        fault = serverMod.normaliseThrownFault(c.build()) as NormalisedProbeFault;
      } catch (err) {
        threw = true;
        error = err;
      }
      out(
        `    ${pad(c.key, 44)} threw=${threw} kind=${JSON.stringify(fault?.kind ?? null)} ` +
          `code=${JSON.stringify(fault?.code ?? null)}`,
      );
      assert(
        threw === false && fault !== null,
        `[hostile proxy | ${c.key}] normaliseThrownFault RETURNS a fault instead of throwing: an unguarded instanceof made the reporter itself the second failure, on the exact path a report is being built`,
        `threw=${threw} :: ${String(error)}`,
      );
      assert(
        fault?.kind === c.wantKind &&
          (fault?.code ?? null) === c.wantCode &&
          typeof fault?.message === 'string' &&
          (fault.message as string).length > 0,
        `[hostile proxy | ${c.key}] and the classification is still the RIGHT one, so guarding the instanceof cost no accuracy: a real deadline behind a hostile proxy is still recognised, by name, and still carries DEADLINE_EXCEEDED`,
        `kind=${JSON.stringify(fault?.kind)} code=${JSON.stringify(fault?.code)} message=${JSON.stringify(fault?.message)}`,
      );
    }

    // -----------------------------------------------------------------------
    // 11p. AUD-1 — THE TERMINAL CATCH: TAGGED, CODED AND SLOT-AWARE.
    // -----------------------------------------------------------------------
    //
    // Once the fail-closed audit write SUCCEEDS a rate-limit slot is spent.
    // Every remaining request-path failure then fell into the one untagged,
    // session-less, multi-line `console.error` left in the change, and the
    // caller got `500 {"error":"Internal server error"}` — no code, no session,
    // and no hint that a retry was no longer free.
    //
    // Driven exactly as it was driven live: the audit table is HEALTHY (so the
    // slot really is spent, 201) and `onboarding_site_intelligence` is refused
    // with a real 42501, which is what `createSiteIntelligenceRecord` hits
    // immediately after.
    out('\n--- analyze route: a failure AFTER the rate-limit slot has been spent ---');
    stub.mode = 'rls_denied';
    stub.faultTable = 'onboarding_site_intelligence';
    stub.faultCountRead = false;
    const spentLabel = 'aud1 | post-slot failure';
    const spentWindow = await openWriteWindow(spentLabel);
    const postSlot = await withCapture(() => driveAnalyze());
    closeWriteWindow();
    stub.mode = 'ok';
    stub.faultTable = 'onboarding_audit_events';

    const spentAuditPosts = stub.writes.filter(
      (w) => w.table === 'onboarding_audit_events' && w.window === spentLabel,
    ).length;
    const spentLines = failureLines(postSlot.captured, BOUNDED_STAGE_FAILURE_TAG);
    const spentBody = postSlot.result?.body as
      | { code?: string; error?: string; slotSpent?: boolean }
      | undefined;
    out(
      `    post-slot failure: status=${postSlot.result?.status} auditPosts=${spentAuditPosts} ` +
        `code=${JSON.stringify(spentBody?.code)} slotSpent=${JSON.stringify(spentBody?.slotSpent)} ` +
        `lines=${spentLines.length}`,
    );
    rows.push({
      site: '11 analyze terminal catch',
      mode: 'rls_denied',
      threw: postSlot.threw,
      loggedLines: allLines(postSlot.captured),
      responseStatus: postSlot.result?.status,
      reachedWrite: true,
      writeCount: spentAuditPosts,
      rowPersisted: 'n/a',
    });

    assert(
      spentWindow.empty && spentAuditPosts === 1,
      `[aud1 terminal catch] the SLOT REALLY WAS SPENT before the failure: the analyze-requested row landed on a healthy audit table, so this measures the branch that matters rather than an early bail`,
      `windowEmpty=${spentWindow.empty} (${spentWindow.leftovers}) auditPosts=${spentAuditPosts}`,
    );
    const spentVerdict = verifyUpstreamLine(spentLines, {
      tag: BOUNDED_STAGE_FAILURE_TAG,
      target: 'request_handler (unhandled)',
      eventType: 'analyze_request_handler',
      sessionId: SESSION_ID,
      clientId: CLIENT_ID,
      fault: 'unknown',
      status: null,
      code: null,
    });
    assert(
      spentVerdict.ok,
      `[aud1 terminal catch] the handler's last-resort failure is now ONE tagged line of JSON naming the session and the client, on the same emitter as every other failure on this route, instead of an untagged multi-line console.error nobody can grep alongside the rest`,
      spentVerdict.reason,
    );
    assert(
      typeof spentLines[0]?.parsed?.succeeded === 'string' &&
        /RATE-LIMIT SLOT WAS SPENT/.test(spentLines[0]?.parsed?.succeeded as string),
      `[aud1 terminal catch] and its succeeded field STATES that a slot was spent, so an operator does not tell a client to "just try again" and silently burn the rest of their five hourly attempts`,
      `succeeded=${JSON.stringify(spentLines[0]?.parsed?.succeeded ?? null)}`,
    );
    assert(
      postSlot.threw === false &&
        postSlot.result?.status === 500 &&
        spentBody?.code === 'analyze_request_failed' &&
        spentBody?.slotSpent === true &&
        spentBody?.error !== 'Internal server error',
      `[aud1 terminal catch] and the CALLER gets a machine code and the slot fact, not an opaque "Internal server error" that leaves both the client and their retry budget in the dark`,
      `threw=${postSlot.threw} status=${postSlot.result?.status} body=${JSON.stringify(spentBody ?? null)}`,
    );

    // -----------------------------------------------------------------------
    // 11q. AUD-5(b) — A BYPASS CALLER IS NOT REFUSED AT reusable_scan_lookup.
    // -----------------------------------------------------------------------
    //
    // The ruling on this route is that an AM-bypass caller is never 503'd by
    // limiter state they are exempt from. `reusable_scan_lookup` 503'd them
    // anyway, under the LIMITER's own machine code — so a stalled DEDUP lookup
    // told an AM their analysis limit was in doubt when they have no limit.
    //
    // BOTH DIRECTIONS, as every other bypass rule on this route is driven:
    // the same injected stall, the only variable being the signature. A fix
    // that simply stopped 503ing everyone would satisfy the bypass half and
    // break the rule it is scoped by, so the non-bypass half is asserted in
    // the same breath.
    out('\n--- AM-bypass scoping at reusable_scan_lookup: the same stall, driven both ways ---');
    SESSION_ROW.site_intelligence_id = 'si-record-1';
    const scanBypassResults: Record<'bypass' | 'plain', {
      status?: number;
      code?: string;
      lines: FailureLine[];
      threw: boolean;
      elapsedMs: number;
    }> = {
      bypass: { lines: [], threw: false, elapsedMs: 0 },
      plain: { lines: [], threw: false, elapsedMs: 0 },
    };
    for (const bypass of [true, false]) {
      const key = bypass ? 'bypass' : 'plain';
      stub.readsSeen['onboarding_site_intelligence'] = 0;
      stub.stallReadTables = ['onboarding_site_intelligence'];
      stub.stallReadSkip = {};
      await openWriteWindow(`aud5 | reusable scan stall | ${key}`);
      const startedAt = Date.now();
      const outcome = await withCapture(() => driveAnalyzeAs(bypass));
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();
      stub.stallReadTables = [];
      scanBypassResults[key] = {
        status: outcome.result?.status,
        code: (outcome.result?.body as { code?: string } | undefined)?.code,
        lines: failureLines(outcome.captured, BOUNDED_STAGE_FAILURE_TAG),
        threw: outcome.threw,
        elapsedMs,
      };
      out(
        `    ${pad(key, 8)} status=${outcome.result?.status} elapsed=${elapsedMs}ms ` +
          `code=${JSON.stringify(scanBypassResults[key].code)} lines=${scanBypassResults[key].lines.length}`,
      );
    }
    SESSION_ROW.site_intelligence_id = null;

    const scanStageLine = (lines: FailureLine[]): FailureLine | undefined =>
      lines.find((l) => l.parsed?.target === 'reusable_scan_lookup (onboarding_site_intelligence)');

    assert(
      scanBypassResults.bypass.threw === false &&
        scanBypassResults.bypass.status !== 503 &&
        scanBypassResults.bypass.elapsedMs < TERMINATION_BUDGET_MS,
      `[am-bypass | reusable scan stall] a BYPASS request is NOT 503'd when the dedup lookup stalls: the ruling is that a bypass caller is never refused over gating that does not apply to them, and a dedup lookup only ever SAVES a scan, so losing it costs one duplicate on a click an AM made deliberately`,
      `status=${scanBypassResults.bypass.status} code=${JSON.stringify(scanBypassResults.bypass.code)} elapsed=${scanBypassResults.bypass.elapsedMs}ms`,
    );
    assert(
      scanStageLine(scanBypassResults.bypass.lines) !== undefined,
      `[am-bypass | reusable scan stall] and it is still LOUD for the bypass caller: not being refused is not the same as not being reported, and an AM's analyze click is frequently the earliest evidence a session ever gets that Supabase is sick`,
      `lines=${JSON.stringify(scanBypassResults.bypass.lines.map((l) => l.raw.slice(0, 200)))}`,
    );
    assert(
      scanBypassResults.plain.threw === false &&
        scanBypassResults.plain.status === 503 &&
        scanBypassResults.plain.code === 'analyze_precondition_unavailable' &&
        scanStageLine(scanBypassResults.plain.lines) !== undefined,
      `[am-bypass | reusable scan stall] the SAME stall on a NON-bypass request still fails closed with 503 and the precondition code: the scoping narrows who the rule applies to, it does not weaken the rule`,
      `status=${scanBypassResults.plain.status} code=${JSON.stringify(scanBypassResults.plain.code)} lines=${JSON.stringify(scanBypassResults.plain.lines.map((l) => l.raw.slice(0, 200)))}`,
    );

    // -----------------------------------------------------------------------
    // 11r. D3 — THE OTHER THREE ROUTES' UNBOUNDED UPSTREAM AWAITS.
    // -----------------------------------------------------------------------
    //
    // 11h proved this for the ANALYZE route and stopped there, and the claim
    // written into the source — "bounds every await upstream of a
    // failure-reporting write" — was therefore FALSE for save-step, session
    // and submit, which between them carry five of the seven reporting sites.
    //
    // And the consequence there is worse than a slow request. On the session
    // and submit routes the reporting sites live in `after()` callbacks, and
    // `after()` REGISTRATION happens near the bottom of the handler — so a
    // stall ANYWHERE above it means the callbacks are never registered, the
    // audit and open-history writes are never attempted, and there is nothing
    // for the emitters proven in 11n / 11n-ii to emit. Bounding the write
    // while the read above it can hang forever buys nothing.
    //
    // TWO DISPOSITIONS ARE UNDER TEST, because the fix is not uniform:
    //   - FAIL CLOSED where the stalled stage decides whether the request may
    //     proceed at all (each route's session lookup);
    //   - DEGRADE where it only enriches the payload — and the degrade case
    //     asserts the thing that matters, that the after() task is still
    //     REGISTERED and its writes still land.
    out('\n--- D3: the reads upstream of save-step, session and submit ---');

    interface PublicUpstreamCase {
      key: string;
      stallTable: string;
      drive: () => Promise<Invocation>;
      wantStatus: number;
      wantCode: string;
      target: string;
      eventType: string;
      /** '' where the stall happens before the session id is known. */
      sessionId: string;
      clientId: string | null;
      /**
       * Where the stalled helper ALSO reports the read in its own vocabulary,
       * the event_type of that second line. Two lines for one event is
       * deliberate and is the pairing 11k already pins: the STAGE line says a
       * stage ran out of time, the READ line says WHICH await it was. The
       * alternative is not one line, it is one tagged line plus an untagged
       * `Error fetching answers:` stray from inside the helper.
       */
      alsoReadEvent: string | null;
    }

    const publicUpstreamCases: PublicUpstreamCase[] = [
      {
        key: 'save-step | session lookup',
        stallTable: 'onboarding_sessions',
        drive: driveSaveStep,
        wantStatus: 503,
        wantCode: 'save_step_unavailable',
        target: 'session_lookup (onboarding_sessions)',
        eventType: 'save_step_upstream_call',
        sessionId: '',
        clientId: null,
        alsoReadEvent: null,
      },
      {
        key: 'submit | session lookup',
        stallTable: 'onboarding_sessions',
        drive: driveSubmit,
        wantStatus: 503,
        wantCode: 'submit_unavailable',
        target: 'session_lookup (onboarding_sessions)',
        eventType: 'submit_upstream_call',
        sessionId: '',
        clientId: null,
        alsoReadEvent: null,
      },
      {
        key: 'session | session lookup',
        stallTable: 'onboarding_sessions',
        drive: async () => {
          capturedAfterTasks = [];
          const res: Response = await inRequestScope(() => routeSession.GET(sessionRequest()));
          return { status: res.status, body: await readBody(res) };
        },
        wantStatus: 503,
        wantCode: 'session_lookup_failed',
        target: 'session_lookup (onboarding_sessions)',
        eventType: 'session_load_upstream_call',
        sessionId: '',
        clientId: null,
        alsoReadEvent: null,
      },
      // THE ANSWERS READ, on both routes that do one, because it is the stage
      // whose DEGRADE would have been a lie. `getSessionAnswers` returns `[]`
      // for a failed read exactly as it does for an empty session, so a
      // degraded answer here means submit tells a client they have not
      // completed steps they HAVE completed, and the session route serves the
      // wizard with every field blank over answers that are perfectly fine.
      // Both therefore fail CLOSED, which is only possible because
      // `withDeadline` settles its race before it aborts.
      {
        key: 'submit | answers read',
        stallTable: 'onboarding_answers',
        drive: driveSubmit,
        wantStatus: 503,
        wantCode: 'submit_unavailable',
        target: 'answers_read (onboarding_answers)',
        eventType: 'submit_upstream_call',
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        alsoReadEvent: 'submit_answers_read',
      },
      {
        key: 'session | answers read',
        stallTable: 'onboarding_answers',
        drive: async () => {
          capturedAfterTasks = [];
          const res: Response = await inRequestScope(() => routeSession.GET(sessionRequest()));
          return { status: res.status, body: await readBody(res) };
        },
        wantStatus: 503,
        wantCode: 'session_answers_unavailable',
        target: 'answers_read (onboarding_answers)',
        eventType: 'session_load_upstream_call',
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        alsoReadEvent: 'session_answers_read',
      },
    ];

    for (const c of publicUpstreamCases) {
      const label = `public upstream | ${c.key}`;
      stub.readsSeen[c.stallTable] = 0;
      stub.stallReadTables = [c.stallTable];
      stub.stallReadSkip = {};
      const opened = await openWriteWindow(label);
      const startedAt = Date.now();
      const outcome = await withCapture(() => c.drive());
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();
      stub.stallReadTables = [];

      const lines = failureLines(outcome.captured, BOUNDED_STAGE_FAILURE_TAG);
      const status = outcome.result?.status;
      const code = (outcome.result?.body as { code?: string } | undefined)?.code;
      const posts = stub.writes.filter((w) => w.window === label).length;
      const afterTasks = capturedAfterTasks.filter(Boolean).length;
      out(
        `    ${pad(c.key, 40)} crossedWire=${stub.readsSeen[c.stallTable] ?? 0} ` +
          `elapsed=${elapsedMs}ms status=${status} code=${code} lines=${lines.length} ` +
          `afterTasks=${afterTasks} posts=${posts}`,
      );
      rows.push({
        site: `13 public upstream ${c.key}`,
        mode: 'stall',
        threw: outcome.threw,
        loggedLines: allLines(outcome.captured),
        responseStatus: status,
        reachedWrite: false,
        writeCount: posts,
        rowPersisted: 'n/a',
      });

      assert(
        opened.empty && (stub.readsSeen[c.stallTable] ?? 0) >= 1,
        `[${label}] the stalled read really CROSSED THE WIRE: the stub accepted it, read it in full, and never answered — so this measures a real non-terminating await and not a missing fixture`,
        `windowEmpty=${opened.empty} (${opened.leftovers}) reads=${stub.readsSeen[c.stallTable] ?? 0}`,
      );
      assert(
        outcome.threw === false && elapsedMs < TERMINATION_BUDGET_MS && status === c.wantStatus,
        `[${label}] the handler TERMINATES and FAILS CLOSED with ${c.wantStatus}: unbounded, this await never settled, so the handler froze, the response never shipped and — on the two after() routes — the reporting callbacks were never even registered`,
        `threw=${outcome.threw} :: ${String(outcome.error)} elapsed=${elapsedMs}ms status=${status}`,
      );
      assert(
        code === c.wantCode && status !== 404,
        `[${label}] and it answers with its OWN retryable machine code, never the 404 that "session not found" would give: getSessionByToken swallows every error and returns null, so a stall would read as "no such session" if withDeadline did not settle its race BEFORE aborting`,
        `code=${JSON.stringify(code)} status=${status} body=${JSON.stringify(outcome.result?.body ?? null)}`,
      );
      const verdict = verifyUpstreamLine(lines, {
        tag: BOUNDED_STAGE_FAILURE_TAG,
        target: c.target,
        eventType: c.eventType,
        sessionId: c.sessionId,
        clientId: c.clientId,
        fault: 'timeout',
        status: 0,
        code: 'DEADLINE_EXCEEDED',
      });
      assert(
        verdict.ok,
        `[${label}] and it is LOUD: exactly one ${BOUNDED_STAGE_FAILURE_TAG} line naming the stage "${c.target}", fault=timeout code=DEADLINE_EXCEEDED, on one physical line — a route that gives up silently is the defect this branch exists to remove`,
        verdict.reason,
      );
      assert(
        posts === 0,
        `[${label}] and NOTHING was written: the failure happened upstream of every write, which is what the line's succeeded field claims`,
        `posts=${posts} windows=${JSON.stringify(stub.writes.filter((w) => w.window === label).map((w) => w.table))}`,
      );
      const readLines = failureLines(outcome.captured, READ_FAILURE_TAG);
      const readLine = readLines[0]?.parsed ?? null;
      assert(
        c.alsoReadEvent === null
          ? readLines.length === 0
          : readLines.length === 1 &&
              readLine !== null &&
              readLine.event_type === c.alsoReadEvent &&
              readLine.session_id === SESSION_ID &&
              readLine.fault === 'timeout' &&
              typeof readLine.succeeded === 'string' &&
              (readLine.succeeded as string).length > 0 &&
              readLines[0]!.raw.indexOf('\n') === -1,
        `[${label}] and the helper itself ${
          c.alsoReadEvent === null
            ? 'says nothing extra: only the stage that ran out of time reports, because no helper-level read was involved'
            : `reports the READ in the same vocabulary (${READ_FAILURE_TAG}), so an operator learns WHICH await stalled and not only that the stage did. Without this the abort still reached getSessionAnswers' own error branch and printed an UNTAGGED "Error fetching answers:" line beside the tagged one`
        }`,
        `readLines=${JSON.stringify(readLines.map((l) => l.raw.slice(0, 240)))} expected=${
          c.alsoReadEvent ?? 'none'
        }`,
      );
    }

    // --- the DEGRADE half: a stall that must NOT cost the reporting sites ---
    //
    // The session route's client lookup only supplies a NAME for the gated
    // screen. Answering 503 for it would throw away a page-load that can be
    // served AND skip the after() registration — so the very stall that caused
    // it would go unreported by the two sites that exist to report. This case
    // is the proof that the degrade disposition keeps the callback alive: the
    // task is registered, RUN, and its two writes land.
    {
      const label = 'public upstream | session | client lookup degrades';
      stub.readsSeen['clients'] = 0;
      stub.stallReadTables = ['clients'];
      stub.stallReadSkip = {};
      const opened = await openWriteWindow(label);
      const startedAt = Date.now();
      const outcome = await withCapture(async () => {
        capturedAfterTasks = [];
        const res: Response = await inRequestScope(() => routeSession.GET(sessionRequest()));
        const invocation: Invocation = { status: res.status, body: await readBody(res) };
        const tasks = capturedAfterTasks.filter(Boolean);
        const task = tasks[0] ?? makeMissingTaskDriver('session tracking writes');
        await task();
        return invocation;
      });
      const elapsedMs = Date.now() - startedAt;
      closeWriteWindow();
      stub.stallReadTables = [];

      const lines = failureLines(outcome.captured, BOUNDED_STAGE_FAILURE_TAG);
      const status = outcome.result?.status;
      const windowWrites = stub.writes.filter((w) => w.window === label).map((w) => w.table);
      const afterTasks = capturedAfterTasks.filter(Boolean).length;
      out(
        `    ${pad('session | client lookup degrades', 40)} crossedWire=${stub.readsSeen['clients'] ?? 0} ` +
          `elapsed=${elapsedMs}ms status=${status} lines=${lines.length} ` +
          `afterTasks=${afterTasks} writes=${JSON.stringify(windowWrites)}`,
      );
      rows.push({
        site: '13 public upstream session client-lookup degrade',
        mode: 'stall',
        threw: outcome.threw,
        loggedLines: allLines(outcome.captured),
        responseStatus: status,
        reachedWrite: windowWrites.length > 0,
        writeCount: windowWrites.length,
        rowPersisted: 'n/a',
      });

      const verdict = verifyUpstreamLine(lines, {
        tag: BOUNDED_STAGE_FAILURE_TAG,
        target: 'client_lookup (clients)',
        eventType: 'session_load_upstream_call',
        sessionId: SESSION_ID,
        clientId: CLIENT_ID,
        fault: 'timeout',
        status: 0,
        code: 'DEADLINE_EXCEEDED',
      });
      assert(
        opened.empty &&
          (stub.readsSeen['clients'] ?? 0) >= 1 &&
          outcome.threw === false &&
          elapsedMs < TERMINATION_BUDGET_MS &&
          status === 200 &&
          verdict.ok,
        `[${label}] a stall on a stage that only ENRICHES the payload is bounded, REPORTED and then degraded to a 200: refusing the page over a missing company name would cost the client their form and cost us the report`,
        `windowEmpty=${opened.empty} reads=${stub.readsSeen['clients'] ?? 0} threw=${outcome.threw} :: ${String(outcome.error)} elapsed=${elapsedMs}ms status=${status} :: ${verdict.reason}`,
      );
      assert(
        afterTasks === 1 &&
          windowWrites.includes('onboarding_audit_events') &&
          windowWrites.includes('onboarding_open_events'),
        `[${label}] and BOTH reporting sites survive it: the after() task is still REGISTERED and both tracking writes still reach the wire. Unbounded, this stall froze the handler ABOVE the after(...) call, so session_accessed and the open-history row were never attempted and nothing said so`,
        `afterTasks=${afterTasks} writes=${JSON.stringify(windowWrites)}`,
      );
    }

    // -----------------------------------------------------------------------
    // 12. Hermeticity — both transports.
    // -----------------------------------------------------------------------
    out('\n--- hermeticity ---');
    out(`    non-loopback fetch()         attempts blocked: ${JSON.stringify(nonLoopbackAttempts)}`);
    out(`    non-loopback http(s).request attempts blocked: ${JSON.stringify(nonLoopbackNodeRequests)}`);
    out(`    non-loopback net/tls.connect attempts blocked: ${JSON.stringify(nonLoopbackSocketConnects)}`);
    assert(
      nonLoopbackAttempts.length === 0,
      `[hermeticity] no dependency attempted a non-loopback fetch()`,
      `blocked: ${JSON.stringify(nonLoopbackAttempts)}`,
    );
    assert(
      nonLoopbackNodeRequests.length === 0,
      `[hermeticity] no dependency attempted a non-loopback http(s).request (the gaxios/node-fetch path the fetch guard cannot see)`,
      `blocked: ${JSON.stringify(nonLoopbackNodeRequests)}`,
    );
    // D5: fetch and http(s).request are conveniences over this layer. Guard
    // them both and a hand-rolled net.connect(443, '1.1.1.1') still reaches
    // the internet while the two assertions above report a clean zero.
    assert(
      nonLoopbackSocketConnects.length === 0,
      `[hermeticity] no dependency attempted a non-loopback net/tls/http2/dgram connection, including via net.Socket.prototype.connect (the raw socket floor under both guards above, and the one a destructured module reference cannot skip)`,
      `blocked: ${JSON.stringify(nonLoopbackSocketConnects)}`,
    );

    // -----------------------------------------------------------------------
    // 12b. Attribution — no write ever escaped a measurement window.
    // -----------------------------------------------------------------------
    closeWriteWindow();
    await drainToQuiescence();
    const finalStrays = stub.strays.slice(straysReported);
    straysReported = stub.strays.length;
    out(
      `\n--- attribution: writes that arrived with no window open: ${
        stub.strays.length === 0 ? 'none' : JSON.stringify(stub.strays.map((w) => `${w.table}:${w.raw.slice(0, 90)}`))
      } ---`,
    );
    assert(
      stub.strays.length === 0,
      `[attribution] no POST ever reached the stub outside a labelled window — every row asserted on is attributable to the site that caused it`,
      `strays=${JSON.stringify(
        stub.strays.map((w) => `${w.table}:${w.raw.slice(0, 120)}`),
      )} (of which ${finalStrays.length} arrived after the last site finished)`,
    );

    // -----------------------------------------------------------------------
    // 12c. Credential — the stub was never satisfied by a downgraded key.
    // -----------------------------------------------------------------------
    assert(
      stub.badCredentialRequests.length === 0,
      `[credential] every /rest/v1 request in this run presented the service-role key the harness configured`,
      `refused: ${JSON.stringify(stub.badCredentialRequests.slice(0, 10))} (total ${stub.badCredentialRequests.length})`,
    );

    // -----------------------------------------------------------------------
    // 12d. Environment pin — this pass really ran as the environment it claims.
    // -----------------------------------------------------------------------
    const envKeys = Object.keys(EXPECTED_ENV);
    const envActual: Record<string, string | undefined> = {};
    for (const k of envKeys) envActual[k] = process.env[k];
    const envMismatches = envKeys.filter((k) => envActual[k] !== EXPECTED_ENV[k]);
    out(
      `\n--- environment pass: ${ENV_PASS} → ${envKeys.length} pinned vars; ` +
        `NODE_ENV=${process.env.NODE_ENV} VERCEL_ENV=${process.env.VERCEL_ENV} ` +
        `VERCEL_REGION=${process.env.VERCEL_REGION} AWS_LAMBDA_FUNCTION_NAME=${process.env.AWS_LAMBDA_FUNCTION_NAME} ---`,
    );
    assert(
      envMismatches.length === 0,
      `[env pin] this pass ran with the environment it pinned, and the pin landed before any app module was imported`,
      `pass=${ENV_PASS} pinned=${envKeys.length} mismatched=${JSON.stringify(
        envMismatches.map(
          (k) => `${k}: expected ${JSON.stringify(EXPECTED_ENV[k])} got ${JSON.stringify(envActual[k])}`,
        ),
      )}`,
    );

    // The REQUEST-HEADER dimension is a pin too, and it is checked in BOTH
    // directions: pass 'vercel' must really have driven every route with the
    // edge header set, and passes 'prod'/'dev' must really NOT have. A
    // call-site gate on `x-vercel-id` is only catchable if that holds.
    const headerPassExpected = ENV_PASS === 'vercel';
    out(
      `--- request-header pass: built ${REQUEST_HEADER_PIN.requestsBuilt} Request(s), ` +
        `vercelEdgeHeaders=${REQUEST_HEADER_PIN.applied} ---`,
    );
    assert(
      REQUEST_HEADER_PIN.applied === headerPassExpected && REQUEST_HEADER_PIN.requestsBuilt > 0,
      `[env pin] every Request this pass built carried exactly the header set this pass is contracted to send`,
      `pass=${ENV_PASS} expectedVercelEdgeHeaders=${headerPassExpected} applied=${REQUEST_HEADER_PIN.applied} ` +
        `requestsBuilt=${REQUEST_HEADER_PIN.requestsBuilt} sampleXVercelId=${JSON.stringify(
          REQUEST_HEADER_PIN.sampleXVercelId,
        )}`,
    );

    // -----------------------------------------------------------------------
    // 13. Truth table.
    // -----------------------------------------------------------------------
    printTruthTable();
  } finally {
    clearTimeout(bail);
    (server as http.Server & { closeAllConnections?: () => void }).closeAllConnections?.();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
}

function pad(s: string, n: number): string {
  return s.length >= n ? s.slice(0, n) : s + ' '.repeat(n - s.length);
}

function printTruthTable(): void {
  out('\n==========================================================================================================');
  out('  TRUTH TABLE — THE FIXED CONTRACT');
  out('==========================================================================================================');
  out(
    `  ${pad('SITE', 62)}${pad('MODE', 13)}${pad('REACHED', 9)}${pad('ROW', 5)}${pad('THREW', 7)}${pad('STATUS', 8)}LOGGED`,
  );
  out('  ' + '-'.repeat(116));
  for (const r of rows) {
    out(
      `  ${pad(r.site, 62)}${pad(r.mode, 13)}${pad(r.reachedWrite ? `yes(${r.writeCount})` : 'no', 9)}${pad(
        r.rowPersisted,
        5,
      )}${pad(String(r.threw), 7)}${pad(r.responseStatus === undefined ? '-' : String(r.responseStatus), 8)}${
        r.loggedLines.length === 0 ? '[]' : JSON.stringify(r.loggedLines)
      }`,
    );
  }
  out('==========================================================================================================');
  out('  READING: every fault row still reaches the write and still puts a real row on the wire, and the row is');
  out('  still refused (socket killed / RLS 42501 / never answered / 502 HTML). What CHANGED is the last two');
  out('  columns. Every fault row now carries an [audit-write][WRITE-FAILURE] line the healthy run does not, so');
  out('  the failure reaches an operator through the one sink that survives Supabase being down. No driver');
  out('  throws: the analyze route converts its AuditWriteError into a 503, because those rows ARE its rate');
  out('  limiter and silence there would fail the limit OPEN on the route that spends Anthropic tokens; every');
  out('  other site degrades at 200 because its user data was already committed. Both `safeAudit` wrappers are');
  out('  gone, and the direct probes pin the two entry points: recordAuditEvent is total and loud,');
  out('  insertAuditEventOrThrow throws a normalised AuditWriteError and logs nothing, including on the one');
  out('  genuine rejection path, client_init.');
  out('');
  out('  THE TWO ROWS TO READ TWICE. `stall` is a PostgREST that accepts the write and never answers: nothing');
  out('  upstream bounds it (undici\'s own timeout is 300s), so before .abortSignal(AbortSignal.timeout) these');
  out('  primitives were TOTAL but not TERMINATING — the await never settled, no fault was normalised, no line');
  out('  was logged, and declared fault kind `timeout` was unreachable in production. `gateway_html` is a proxy');
  out('  502 whose HTML body used to be classified `postgrest` with a null pg_code and dumped verbatim into a');
  out('  756-byte log line; it is now `gateway`, bounded, and marked as truncated.');
  out('==========================================================================================================');
}

// ---------------------------------------------------------------------------
// 13b. The OTHER environment passes (D1/D2).
// ---------------------------------------------------------------------------
/**
 * The parent pass runs the MINIMAL production pin (NODE_ENV + VERCEL +
 * VERCEL_ENV, nothing else). This re-spawns the same file twice more:
 *
 *   'dev'     NODE_ENV=development, every VERCEL_ / AWS_LAMBDA_ variable
 *             deleted. Catches a gate keyed on production.
 *   'vercel'  NODE_ENV=production plus the documented Vercel system
 *             environment (VERCEL_REGION, VERCEL_URL, VERCEL_DEPLOYMENT_ID,
 *             VERCEL_PROJECT_PRODUCTION_URL, the AWS_LAMBDA_* substrate, …)
 *             AND every Request built with the real Vercel edge header set
 *             (x-vercel-id, x-vercel-forwarded-for, x-forwarded-host,
 *             x-forwarded-proto, x-real-ip, …). Catches a gate keyed on a
 *             system variable or on a proxy header, neither of which the
 *             other two passes carry.
 *
 * so a gate keyed on ANY of the three modelled runtimes has nowhere to hide:
 *
 *     if (process.env.NODE_ENV === 'production') return;      // dev pass
 *     if (process.env.VERCEL_REGION) return;                  // vercel pass
 *     if (req.headers.get('x-vercel-id')) return;             // vercel pass
 *     if (!process.env.VERCEL_REGION) return;                 // prod + dev
 *
 * READ THE HEADER'S "WHAT THIS DOES NOT CLOSE" SECTION: three runtimes is
 * three points sampled from an unbounded space, not a proof.
 *
 * A SUBPROCESS, not a second in-process loop, because the pin has to land
 * before module evaluation: a gate that snapshots the env at module scope
 * (`const IS_PROD = …`) would survive an in-process env flip.
 *
 * `process.execArgv` is reused verbatim so this works identically under
 * `npx tsx <file>` (which injects tsx's preflight + loader) and under
 * test/run-all.mjs's `node --import tsx <file>`.
 */
function runOtherEnvPass(pass: Exclude<EnvPass, 'prod'>): void {
  const labels = ENV_MATRIX_LABELS[pass];
  const entry = process.argv[1];
  if (!entry) {
    assert(false, labels.ran, 'process.argv[1] is empty — cannot re-spawn this file');
    assert(false, labels.clean, 'no child pass ran');
    return;
  }

  // `NodeJS.ProcessEnv` types NODE_ENV as readonly (next-env.d.ts), so build
  // the child's environment as a plain record. The child re-pins its own
  // environment at module scope from AUDIT_FAULT_HARNESS_ENV_PASS — what is
  // set here only has to be a clean slate it can pin FROM.
  const childEnv: Record<string, string | undefined> = {
    ...process.env,
    AUDIT_FAULT_HARNESS_ENV_PASS: pass,
    NODE_ENV: pass === 'dev' ? 'development' : 'production',
  };
  for (const k of Object.keys(VERCEL_SYSTEM_ENV)) delete childEnv[k];

  out('\n==========================================================================================================');
  out(`  ENVIRONMENT PASS '${pass}' — re-spawning this file`);
  out(
    pass === 'dev'
      ? '  NODE_ENV=development, every VERCEL_ / AWS_LAMBDA_ variable unset, no Vercel edge headers'
      : `  NODE_ENV=production + ${Object.keys(VERCEL_SYSTEM_ENV).length} documented Vercel/AWS system variables, ` +
          `and every Request built with ${Object.keys(VERCEL_EDGE_HEADERS).length} Vercel edge headers`,
  );
  out(
    `  (this pass ran as NODE_ENV=${process.env.NODE_ENV} VERCEL_ENV=${process.env.VERCEL_ENV} ` +
      `VERCEL_REGION=${process.env.VERCEL_REGION})`,
  );
  out('==========================================================================================================');

  const child = spawnSync(process.execPath, [...process.execArgv, entry], {
    env: childEnv as NodeJS.ProcessEnv,
    encoding: 'utf8',
    timeout: 300_000,
    maxBuffer: 128 * 1024 * 1024,
  });

  const transcript = `${child.stdout ?? ''}${child.stderr ?? ''}`;
  for (const line of transcript.split(/\r?\n/)) out(`  [${pass}-pass] ${line}`);

  assert(
    child.status === 0,
    labels.ran,
    `exit=${JSON.stringify(child.status)} signal=${JSON.stringify(child.signal)} error=${
      child.error ? String(child.error) : 'none'
    }`,
  );

  const summary = /(\d+) passed, (\d+) failed/.exec(transcript);
  const childPassed = summary ? Number(summary[1]) : -1;
  const childFailed = summary ? Number(summary[2]) : -1;
  const childIdentityOk = transcript.includes('LABEL IDENTITY OK');
  assert(
    childIdentityOk && childFailed === 0 && childPassed === BASE_LABELS.length,
    labels.clean,
    `child reported passed=${childPassed} failed=${childFailed} identityOk=${childIdentityOk}; ` +
      `expected passed=${BASE_LABELS.length} failed=0 identityOk=true`,
  );
}

// ---------------------------------------------------------------------------
// 14. Frozen label list — the identity guard.
// ---------------------------------------------------------------------------
// Regenerate deliberately, never reflexively: if a label here no longer
// matches, an assertion was added, deleted or renamed and that is a REVIEW
// EVENT, not a paperwork chore.
//
// SCOPE, stated plainly (see ACCEPTED LIMITATION L2 in the header): this is
// an identity guard over assertion NAMES. It cannot see a predicate being
// hollowed out — `assert(true, <same label>)` passes it. Review predicates.
//
// BASE_LABELS is what BOTH environment passes run. The parent pass adds the
// two supervision assertions over its child; the child runs BASE alone, and
// the parent asserts the child's total equals BASE_LABELS.length.
const BASE_LABELS: readonly string[] = Object.freeze([
  "[1 save-step route → step_saved | ok] the measurement window opened EMPTY (no straggler from the previous site)",
  "[1 save-step route → step_saved | ok] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[1 save-step route → step_saved | ok] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[1 save-step route → step_saved | ok] the POST body persists ≥1 row for this session with event_type=step_saved and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[1 save-step route → step_saved | ok] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[1 save-step route → step_saved | ok] healthy run logs nothing about an audit failure (console baseline recorded)",
  "[1 save-step route → step_saved | ok] caller received HTTP 200",
  "[1 save-step route → step_saved | unreachable] the measurement window opened EMPTY (no straggler from the previous site)",
  "[1 save-step route → step_saved | unreachable] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[1 save-step route → step_saved | unreachable] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[1 save-step route → step_saved | unreachable] the POST body persists ≥1 row for this session with event_type=step_saved and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[1 save-step route → step_saved | unreachable] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[1 save-step route → step_saved | unreachable] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[1 save-step route → step_saved | unreachable] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[1 save-step route → step_saved | unreachable] caller received HTTP 200",
  "[1 save-step route → step_saved | rls_denied] the measurement window opened EMPTY (no straggler from the previous site)",
  "[1 save-step route → step_saved | rls_denied] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[1 save-step route → step_saved | rls_denied] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[1 save-step route → step_saved | rls_denied] the POST body persists ≥1 row for this session with event_type=step_saved and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[1 save-step route → step_saved | rls_denied] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[1 save-step route → step_saved | rls_denied] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[1 save-step route → step_saved | rls_denied] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[1 save-step route → step_saved | rls_denied] caller received HTTP 200",
  "[1 save-step route → step_saved | stall] the measurement window opened EMPTY (no straggler from the previous site)",
  "[1 save-step route → step_saved | stall] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[1 save-step route → step_saved | stall] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[1 save-step route → step_saved | stall] the POST body persists ≥1 row for this session with event_type=step_saved and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[1 save-step route → step_saved | stall] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[1 save-step route → step_saved | stall] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[1 save-step route → step_saved | stall] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[1 save-step route → step_saved | stall] a PostgREST that accepts the write and NEVER answers still TERMINATES this site (bounded by .abortSignal(AbortSignal.timeout), not by undici's 300s default)",
  "[1 save-step route → step_saved | stall] caller received HTTP 200",
  "[1 save-step route → step_saved | gateway_html] the measurement window opened EMPTY (no straggler from the previous site)",
  "[1 save-step route → step_saved | gateway_html] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[1 save-step route → step_saved | gateway_html] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[1 save-step route → step_saved | gateway_html] the POST body persists ≥1 row for this session with event_type=step_saved and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[1 save-step route → step_saved | gateway_html] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[1 save-step route → step_saved | gateway_html] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[1 save-step route → step_saved | gateway_html] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[1 save-step route → step_saved | gateway_html] caller received HTTP 200",
  "[2 session route → session_accessed | ok] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[2 session route → session_accessed | ok] the measurement window opened EMPTY (no straggler from the previous site)",
  "[2 session route → session_accessed | ok] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[2 session route → session_accessed | ok] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[2 session route → session_accessed | ok] the POST body persists ≥1 row for this session with event_type=session_accessed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[2 session route → session_accessed | ok] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[2 session route → session_accessed | ok] healthy run logs nothing about an audit failure (console baseline recorded)",
  "[2 session route → session_accessed | ok] caller received HTTP 200",
  "[2 session route → session_accessed | unreachable] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[2 session route → session_accessed | unreachable] the measurement window opened EMPTY (no straggler from the previous site)",
  "[2 session route → session_accessed | unreachable] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[2 session route → session_accessed | unreachable] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[2 session route → session_accessed | unreachable] the POST body persists ≥1 row for this session with event_type=session_accessed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[2 session route → session_accessed | unreachable] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[2 session route → session_accessed | unreachable] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[2 session route → session_accessed | unreachable] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[2 session route → session_accessed | unreachable] caller received HTTP 200",
  "[2 session route → session_accessed | rls_denied] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[2 session route → session_accessed | rls_denied] the measurement window opened EMPTY (no straggler from the previous site)",
  "[2 session route → session_accessed | rls_denied] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[2 session route → session_accessed | rls_denied] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[2 session route → session_accessed | rls_denied] the POST body persists ≥1 row for this session with event_type=session_accessed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[2 session route → session_accessed | rls_denied] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[2 session route → session_accessed | rls_denied] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[2 session route → session_accessed | rls_denied] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[2 session route → session_accessed | rls_denied] caller received HTTP 200",
  "[2 session route → session_accessed | stall] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[2 session route → session_accessed | stall] the measurement window opened EMPTY (no straggler from the previous site)",
  "[2 session route → session_accessed | stall] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[2 session route → session_accessed | stall] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[2 session route → session_accessed | stall] the POST body persists ≥1 row for this session with event_type=session_accessed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[2 session route → session_accessed | stall] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[2 session route → session_accessed | stall] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[2 session route → session_accessed | stall] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[2 session route → session_accessed | stall] a PostgREST that accepts the write and NEVER answers still TERMINATES this site (bounded by .abortSignal(AbortSignal.timeout), not by undici's 300s default)",
  "[2 session route → session_accessed | stall] caller received HTTP 200",
  "[2 session route → session_accessed | gateway_html] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[2 session route → session_accessed | gateway_html] the measurement window opened EMPTY (no straggler from the previous site)",
  "[2 session route → session_accessed | gateway_html] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[2 session route → session_accessed | gateway_html] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[2 session route → session_accessed | gateway_html] the POST body persists ≥1 row for this session with event_type=session_accessed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[2 session route → session_accessed | gateway_html] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[2 session route → session_accessed | gateway_html] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[2 session route → session_accessed | gateway_html] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[2 session route → session_accessed | gateway_html] caller received HTTP 200",
  "[3 submit route → session_submitted | ok] the measurement window opened EMPTY (no straggler from the previous site)",
  "[3 submit route → session_submitted | ok] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[3 submit route → session_submitted | ok] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[3 submit route → session_submitted | ok] the POST body persists ≥1 row for this session with event_type=session_submitted and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[3 submit route → session_submitted | ok] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[3 submit route → session_submitted | ok] healthy run logs nothing about an audit failure (console baseline recorded)",
  "[3 submit route → session_submitted | ok] caller received HTTP 200",
  "[3 submit route → session_submitted | unreachable] the measurement window opened EMPTY (no straggler from the previous site)",
  "[3 submit route → session_submitted | unreachable] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[3 submit route → session_submitted | unreachable] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[3 submit route → session_submitted | unreachable] the POST body persists ≥1 row for this session with event_type=session_submitted and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[3 submit route → session_submitted | unreachable] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[3 submit route → session_submitted | unreachable] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[3 submit route → session_submitted | unreachable] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[3 submit route → session_submitted | unreachable] caller received HTTP 200",
  "[3 submit route → session_submitted | rls_denied] the measurement window opened EMPTY (no straggler from the previous site)",
  "[3 submit route → session_submitted | rls_denied] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[3 submit route → session_submitted | rls_denied] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[3 submit route → session_submitted | rls_denied] the POST body persists ≥1 row for this session with event_type=session_submitted and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[3 submit route → session_submitted | rls_denied] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[3 submit route → session_submitted | rls_denied] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[3 submit route → session_submitted | rls_denied] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[3 submit route → session_submitted | rls_denied] caller received HTTP 200",
  "[3 submit route → session_submitted | stall] the measurement window opened EMPTY (no straggler from the previous site)",
  "[3 submit route → session_submitted | stall] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[3 submit route → session_submitted | stall] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[3 submit route → session_submitted | stall] the POST body persists ≥1 row for this session with event_type=session_submitted and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[3 submit route → session_submitted | stall] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[3 submit route → session_submitted | stall] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[3 submit route → session_submitted | stall] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[3 submit route → session_submitted | stall] a PostgREST that accepts the write and NEVER answers still TERMINATES this site (bounded by .abortSignal(AbortSignal.timeout), not by undici's 300s default)",
  "[3 submit route → session_submitted | stall] caller received HTTP 200",
  "[3 submit route → session_submitted | gateway_html] the measurement window opened EMPTY (no straggler from the previous site)",
  "[3 submit route → session_submitted | gateway_html] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[3 submit route → session_submitted | gateway_html] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[3 submit route → session_submitted | gateway_html] the POST body persists ≥1 row for this session with event_type=session_submitted and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[3 submit route → session_submitted | gateway_html] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[3 submit route → session_submitted | gateway_html] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[3 submit route → session_submitted | gateway_html] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[3 submit route → session_submitted | gateway_html] caller received HTTP 200",
  "[4 analyze route → site_intelligence_analyze_requested | ok] the measurement window opened EMPTY (no straggler from the previous site)",
  "[4 analyze route → site_intelligence_analyze_requested | ok] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[4 analyze route → site_intelligence_analyze_requested | ok] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[4 analyze route → site_intelligence_analyze_requested | ok] the POST body persists ≥1 row for this session with event_type=site_intelligence_analyze_requested and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[4 analyze route → site_intelligence_analyze_requested | ok] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[4 analyze route → site_intelligence_analyze_requested | ok] healthy run logs nothing about an audit failure (console baseline recorded)",
  "[4 analyze route → site_intelligence_analyze_requested | ok] caller received HTTP 200",
  "[4 analyze route → site_intelligence_analyze_requested | unreachable] the measurement window opened EMPTY (no straggler from the previous site)",
  "[4 analyze route → site_intelligence_analyze_requested | unreachable] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[4 analyze route → site_intelligence_analyze_requested | unreachable] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[4 analyze route → site_intelligence_analyze_requested | unreachable] the POST body persists ≥1 row for this session with event_type=site_intelligence_analyze_requested and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[4 analyze route → site_intelligence_analyze_requested | unreachable] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[4 analyze route → site_intelligence_analyze_requested | unreachable] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[4 analyze route → site_intelligence_analyze_requested | unreachable] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[4 analyze route → site_intelligence_analyze_requested | unreachable] caller received HTTP 503",
  "[4 analyze route → site_intelligence_analyze_requested | rls_denied] the measurement window opened EMPTY (no straggler from the previous site)",
  "[4 analyze route → site_intelligence_analyze_requested | rls_denied] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[4 analyze route → site_intelligence_analyze_requested | rls_denied] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[4 analyze route → site_intelligence_analyze_requested | rls_denied] the POST body persists ≥1 row for this session with event_type=site_intelligence_analyze_requested and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[4 analyze route → site_intelligence_analyze_requested | rls_denied] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[4 analyze route → site_intelligence_analyze_requested | rls_denied] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[4 analyze route → site_intelligence_analyze_requested | rls_denied] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[4 analyze route → site_intelligence_analyze_requested | rls_denied] caller received HTTP 503",
  "[4 analyze route → site_intelligence_analyze_requested | stall] the measurement window opened EMPTY (no straggler from the previous site)",
  "[4 analyze route → site_intelligence_analyze_requested | stall] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[4 analyze route → site_intelligence_analyze_requested | stall] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[4 analyze route → site_intelligence_analyze_requested | stall] the POST body persists ≥1 row for this session with event_type=site_intelligence_analyze_requested and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[4 analyze route → site_intelligence_analyze_requested | stall] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[4 analyze route → site_intelligence_analyze_requested | stall] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[4 analyze route → site_intelligence_analyze_requested | stall] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[4 analyze route → site_intelligence_analyze_requested | stall] a PostgREST that accepts the write and NEVER answers still TERMINATES this site (bounded by .abortSignal(AbortSignal.timeout), not by undici's 300s default)",
  "[4 analyze route → site_intelligence_analyze_requested | stall] caller received HTTP 503",
  "[4 analyze route → site_intelligence_analyze_requested | gateway_html] the measurement window opened EMPTY (no straggler from the previous site)",
  "[4 analyze route → site_intelligence_analyze_requested | gateway_html] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[4 analyze route → site_intelligence_analyze_requested | gateway_html] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[4 analyze route → site_intelligence_analyze_requested | gateway_html] the POST body persists ≥1 row for this session with event_type=site_intelligence_analyze_requested and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[4 analyze route → site_intelligence_analyze_requested | gateway_html] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[4 analyze route → site_intelligence_analyze_requested | gateway_html] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[4 analyze route → site_intelligence_analyze_requested | gateway_html] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[4 analyze route → site_intelligence_analyze_requested | gateway_html] caller received HTTP 503",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | ok] submit route registered exactly 2 after() tasks",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | ok] the measurement window opened EMPTY (no straggler from the previous site)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | ok] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | ok] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | ok] the POST body persists ≥1 row for this session with event_type=dashboard_sync_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | ok] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | ok] healthy run logs nothing about an audit failure (console baseline recorded)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | unreachable] submit route registered exactly 2 after() tasks",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | unreachable] the measurement window opened EMPTY (no straggler from the previous site)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | unreachable] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | unreachable] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | unreachable] the POST body persists ≥1 row for this session with event_type=dashboard_sync_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | unreachable] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | unreachable] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | unreachable] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | rls_denied] submit route registered exactly 2 after() tasks",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | rls_denied] the measurement window opened EMPTY (no straggler from the previous site)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | rls_denied] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | rls_denied] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | rls_denied] the POST body persists ≥1 row for this session with event_type=dashboard_sync_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | rls_denied] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | rls_denied] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | rls_denied] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | stall] submit route registered exactly 2 after() tasks",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | stall] the measurement window opened EMPTY (no straggler from the previous site)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | stall] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | stall] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | stall] the POST body persists ≥1 row for this session with event_type=dashboard_sync_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | stall] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | stall] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | stall] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | stall] a PostgREST that accepts the write and NEVER answers still TERMINATES this site (bounded by .abortSignal(AbortSignal.timeout), not by undici's 300s default)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | gateway_html] submit route registered exactly 2 after() tasks",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | gateway_html] the measurement window opened EMPTY (no straggler from the previous site)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | gateway_html] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | gateway_html] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | gateway_html] the POST body persists ≥1 row for this session with event_type=dashboard_sync_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | gateway_html] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | gateway_html] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[5 submit after() → dashboard-bridge → dashboard_sync_failed | gateway_html] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[6 submit after() → sheet-export → sheet_export_failed | ok] submit route registered exactly 2 after() tasks",
  "[6 submit after() → sheet-export → sheet_export_failed | ok] the measurement window opened EMPTY (no straggler from the previous site)",
  "[6 submit after() → sheet-export → sheet_export_failed | ok] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[6 submit after() → sheet-export → sheet_export_failed | ok] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[6 submit after() → sheet-export → sheet_export_failed | ok] the POST body persists ≥1 row for this session with event_type=sheet_export_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[6 submit after() → sheet-export → sheet_export_failed | ok] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[6 submit after() → sheet-export → sheet_export_failed | ok] healthy run logs nothing about an audit failure (console baseline recorded)",
  "[6 submit after() → sheet-export → sheet_export_failed | unreachable] submit route registered exactly 2 after() tasks",
  "[6 submit after() → sheet-export → sheet_export_failed | unreachable] the measurement window opened EMPTY (no straggler from the previous site)",
  "[6 submit after() → sheet-export → sheet_export_failed | unreachable] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[6 submit after() → sheet-export → sheet_export_failed | unreachable] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[6 submit after() → sheet-export → sheet_export_failed | unreachable] the POST body persists ≥1 row for this session with event_type=sheet_export_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[6 submit after() → sheet-export → sheet_export_failed | unreachable] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[6 submit after() → sheet-export → sheet_export_failed | unreachable] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[6 submit after() → sheet-export → sheet_export_failed | unreachable] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[6 submit after() → sheet-export → sheet_export_failed | rls_denied] submit route registered exactly 2 after() tasks",
  "[6 submit after() → sheet-export → sheet_export_failed | rls_denied] the measurement window opened EMPTY (no straggler from the previous site)",
  "[6 submit after() → sheet-export → sheet_export_failed | rls_denied] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[6 submit after() → sheet-export → sheet_export_failed | rls_denied] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[6 submit after() → sheet-export → sheet_export_failed | rls_denied] the POST body persists ≥1 row for this session with event_type=sheet_export_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[6 submit after() → sheet-export → sheet_export_failed | rls_denied] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[6 submit after() → sheet-export → sheet_export_failed | rls_denied] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[6 submit after() → sheet-export → sheet_export_failed | rls_denied] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[6 submit after() → sheet-export → sheet_export_failed | stall] submit route registered exactly 2 after() tasks",
  "[6 submit after() → sheet-export → sheet_export_failed | stall] the measurement window opened EMPTY (no straggler from the previous site)",
  "[6 submit after() → sheet-export → sheet_export_failed | stall] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[6 submit after() → sheet-export → sheet_export_failed | stall] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[6 submit after() → sheet-export → sheet_export_failed | stall] the POST body persists ≥1 row for this session with event_type=sheet_export_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[6 submit after() → sheet-export → sheet_export_failed | stall] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[6 submit after() → sheet-export → sheet_export_failed | stall] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[6 submit after() → sheet-export → sheet_export_failed | stall] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[6 submit after() → sheet-export → sheet_export_failed | stall] a PostgREST that accepts the write and NEVER answers still TERMINATES this site (bounded by .abortSignal(AbortSignal.timeout), not by undici's 300s default)",
  "[6 submit after() → sheet-export → sheet_export_failed | gateway_html] submit route registered exactly 2 after() tasks",
  "[6 submit after() → sheet-export → sheet_export_failed | gateway_html] the measurement window opened EMPTY (no straggler from the previous site)",
  "[6 submit after() → sheet-export → sheet_export_failed | gateway_html] stub received exactly 1 POST /rest/v1/onboarding_audit_events",
  "[6 submit after() → sheet-export → sheet_export_failed | gateway_html] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[6 submit after() → sheet-export → sheet_export_failed | gateway_html] the POST body persists ≥1 row for this session with event_type=sheet_export_failed and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[6 submit after() → sheet-export → sheet_export_failed | gateway_html] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[6 submit after() → sheet-export → sheet_export_failed | gateway_html] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[6 submit after() → sheet-export → sheet_export_failed | gateway_html] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[7 session after() → recordOpenEvent | ok] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[7 session after() → recordOpenEvent | ok] the measurement window opened EMPTY (no straggler from the previous site)",
  "[7 session after() → recordOpenEvent | ok] stub received exactly 1 POST /rest/v1/onboarding_open_events",
  "[7 session after() → recordOpenEvent | ok] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[7 session after() → recordOpenEvent | ok] the POST body persists ≥1 row for this session with event_type=(none — open event) and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[7 session after() → recordOpenEvent | ok] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[7 session after() → recordOpenEvent | ok] healthy run logs nothing about an audit failure (console baseline recorded)",
  "[7 session after() → recordOpenEvent | unreachable] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[7 session after() → recordOpenEvent | unreachable] the measurement window opened EMPTY (no straggler from the previous site)",
  "[7 session after() → recordOpenEvent | unreachable] stub received exactly 1 POST /rest/v1/onboarding_open_events",
  "[7 session after() → recordOpenEvent | unreachable] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[7 session after() → recordOpenEvent | unreachable] the POST body persists ≥1 row for this session with event_type=(none — open event) and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[7 session after() → recordOpenEvent | unreachable] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[7 session after() → recordOpenEvent | unreachable] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[7 session after() → recordOpenEvent | unreachable] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[7 session after() → recordOpenEvent | rls_denied] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[7 session after() → recordOpenEvent | rls_denied] the measurement window opened EMPTY (no straggler from the previous site)",
  "[7 session after() → recordOpenEvent | rls_denied] stub received exactly 1 POST /rest/v1/onboarding_open_events",
  "[7 session after() → recordOpenEvent | rls_denied] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[7 session after() → recordOpenEvent | rls_denied] the POST body persists ≥1 row for this session with event_type=(none — open event) and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[7 session after() → recordOpenEvent | rls_denied] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[7 session after() → recordOpenEvent | rls_denied] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[7 session after() → recordOpenEvent | rls_denied] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[7 session after() → recordOpenEvent | stall] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[7 session after() → recordOpenEvent | stall] the measurement window opened EMPTY (no straggler from the previous site)",
  "[7 session after() → recordOpenEvent | stall] stub received exactly 1 POST /rest/v1/onboarding_open_events",
  "[7 session after() → recordOpenEvent | stall] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[7 session after() → recordOpenEvent | stall] the POST body persists ≥1 row for this session with event_type=(none — open event) and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[7 session after() → recordOpenEvent | stall] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[7 session after() → recordOpenEvent | stall] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[7 session after() → recordOpenEvent | stall] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[7 session after() → recordOpenEvent | stall] a PostgREST that accepts the write and NEVER answers still TERMINATES this site (bounded by .abortSignal(AbortSignal.timeout), not by undici's 300s default)",
  "[7 session after() → recordOpenEvent | gateway_html] session route registered exactly 1 after() task carrying BOTH tracking writes",
  "[7 session after() → recordOpenEvent | gateway_html] the measurement window opened EMPTY (no straggler from the previous site)",
  "[7 session after() → recordOpenEvent | gateway_html] stub received exactly 1 POST /rest/v1/onboarding_open_events",
  "[7 session after() → recordOpenEvent | gateway_html] the audit POST authenticated with the service-role key (apikey + Authorization), not a downgraded credential",
  "[7 session after() → recordOpenEvent | gateway_html] the POST body persists ≥1 row for this session with event_type=(none — open event) and satisfying the real DDL (columns, types, NOT NULL, uuid syntax, FK)",
  "[7 session after() → recordOpenEvent | gateway_html] the driver did not throw: the fault surfaces as a response and a log line, never as an escaping exception",
  "[7 session after() → recordOpenEvent | gateway_html] console output is NO LONGER byte-identical to the healthy ok-mode baseline: the failure reaches the operator",
  "[7 session after() → recordOpenEvent | gateway_html] exactly one [audit-write][WRITE-FAILURE] line on console.error, one line of JSON, naming this table, session, client, event, fault kind, status and pg code, plus a non-empty route, message and what DID succeed",
  "[wire witness | unreachable] recordAuditEvent issued exactly 1 insert through the spied service-role client",
  "[wire witness | unreachable] the primitive received status 0 (PostgrestBuilder.ts:225 catch → :259 status 0, no throw)",
  "[wire witness | unreachable] the primitive received a synthesised fetch-layer error",
  "[wire witness | rls_denied] recordAuditEvent issued exactly 1 insert through the spied service-role client",
  "[wire witness | rls_denied] the primitive received status 403",
  "[wire witness | rls_denied] the primitive received the verbatim PostgREST body incl. SQLSTATE 42501",
  "[wire witness] BOTH fault classes RESOLVE rather than reject, which is why the normaliser is written against a resolved-value contract and NOT against a rejection contract",
  "[direct probe | dead host] both entry points still issued their insert against the dead host",
  "[direct probe | dead host] recordAuditEvent does NOT throw",
  "[direct probe | dead host] recordAuditEvent LOGS one [audit-write][WRITE-FAILURE] line itself, naming fault=transport status=0 and a NULL pg_code (postgrest-js sets code to the EMPTY STRING, which the normaliser converts rather than keeps)",
  "[direct probe | dead host] insertAuditEventOrThrow THROWS an AuditWriteError carrying the same normalised transport fault",
  "[direct probe | dead host] insertAuditEventOrThrow logs NOTHING itself: the throwing entry point leaves the line to the caller that owns the response",
  "[direct probe | client_init] insertAuditEventOrThrow re-emits the createServiceRoleClient rejection as fault kind client_init instead of letting a raw Error escape from a different frame than every other failure",
  "[direct probe | client_init] recordAuditEvent absorbs the same rejection: it stays total around CLIENT CONSTRUCTION too, and still emits one [audit-write][WRITE-FAILURE] line naming fault=client_init",
  "[analyze rate-limit read] the measurement window opened EMPTY (no straggler from the previous probe)",
  "[analyze rate-limit read] a FAILED count query now returns 503 instead of silently skipping the limit and proceeding",
  "[analyze rate-limit read] the 503 body carries a MACHINE code alongside its human message, so a caller can branch on it",
  "[analyze rate-limit read] exactly one [rate-limit][READ-FAILURE] line on console.error records the skipped-limit condition",
  "[analyze rate-limit read] the refused request spent NO rate-limit slot: no audit row was written for a request that never ran",
  "[analyze rate-limit read | http 500] the [rate-limit][READ-FAILURE] line passes the SAME verifyFailureLine checks as the write-side line: one shape for both, carrying the HTTP status the hand-built line omitted, and a fault kind produced by normaliseAuditFault rather than hard-coded",
  "[analyze rate-limit read | stall] a count query that is ACCEPTED AND NEVER ANSWERED still terminates, still 503s with the machine code, and still spends no rate-limit slot",
  "[analyze rate-limit read | stall] the line names fault=timeout status=0, NOT the hard-coded 'postgrest' the old line printed for every countErr: this is the misclassification, and it pointed an operator at a Postgres refusal that never happened",
  "[analyze rate-limit read | null count] a 206 with no content-range — no error anywhere, and a null count where an exact one was requested — is still an unknown limit, so it still fails closed and still spends no slot",
  "[analyze rate-limit read | null count] the no-error fault is SYNTHESISED as kind null_result carrying the real HTTP status, and still passes the same line checks: the one read fault class with no error body does not get a second line shape",
  "[independence | audit write stalls] the OPEN-EVENT write is still issued: a tracking write that never settles cannot cancel the other one that shares its after() callback",
  "[independence | audit write stalls] exactly one [audit-write][WRITE-FAILURE] line, naming onboarding_audit_events — the stalled write is reported, the healthy one is not",
  "[independence | audit write stalls] the open-event write is ISSUED WHILE the audit write is still stalling, not after it gives up: \"both eventually happened\" is satisfied by a chained pair that the timeout bound merely rescues, so the arrival GAP is what proves independence",
  "[independence | open-event write stalls] the AUDIT write is still issued: independence holds in the other direction too, not just for the write that happens to go first",
  "[independence | open-event write stalls] exactly one [audit-write][WRITE-FAILURE] line, naming onboarding_open_events",
  "[independence | open-event write stalls] and symmetrically: neither write waits on the other's settlement before being issued",
  "[independence | both writes stall] BOTH writes are still issued when BOTH tables are stalling",
  "[independence | both writes stall] TWO [audit-write][WRITE-FAILURE] lines, one per table: neither loss is reported on the other's behalf and neither is swallowed",
  "[independence | both writes stall] the after() callback TERMINATES in ROUGHLY ONE bound, not two: with both tables stalling, a chained pair would take 4000ms and hold the function open twice as long for no benefit",
  "[message bound] a 502 with a non-PostgREST body is classified fault=gateway, not postgrest: an absent code/details/hint triple is the discriminator, and calling it postgrest sent an operator hunting a Postgres fault that does not exist",
  "[message bound] the 836-char body is truncated to the 300-char bound and SAYS it was truncated, carrying the original length so the size stays diagnosable",
  "[am-bypass] the harness minted a signature the app's own verifier accepts, so a \"bypass\" request really takes the bypass branch instead of silently re-testing the non-bypass one",
  "[am-bypass | analyze write fault] a BYPASS request is NOT 503'd by a failing audit write, because it never attempts one: the row it would have written is the rate limiter's state, and an AM is not counted",
  "[am-bypass | analyze write fault] the SAME fault on a NON-bypass request still fails closed with 503: the scoping narrows who the rule applies to, it does not weaken the rule",
  "[am-bypass | analyze read fault] a BYPASS request is NOT 503'd by an unreadable rate-limit counter either: an AM's request is never counted, so an unknown count cannot fail their limit open",
  "[am-bypass | analyze read fault] the SAME unreadable counter on a NON-bypass request still fails closed with 503 and the machine code",
  "[am-bypass | save-step] a BYPASS save still persists the answers at 200 and writes NO step_saved row, so a faulted audit table produces no WRITE-FAILURE line for a write that was never meant to happen",
  "[am-bypass | submit] a BYPASS submit still commits at 200 and writes NO session_submitted row, so the faulted audit table produces no line",
  "[am-bypass | session] a BYPASS page-load registers ZERO after() tasks — neither tracking write is even SCHEDULED, so an AM's prep can never reach Open History — while the same load without the signature registers exactly one",
  "[upstream | bridge → clients lookup] the stalled call really CROSSED THE WIRE (dashboard-bridge.ts, the clients lookup): the stub accepted it, read it in full, and never answered — a fault that was never issued would prove nothing",
  "[upstream | bridge → clients lookup] the after() callback TERMINATES when the call UPSTREAM of the audit write never answers: bounding only the write left this frozen, with the 200 already shipped",
  "[upstream | bridge → clients lookup] and it is LOUD: exactly one [supabase-read][READ-FAILURE] line naming clients, fault=timeout status=0, in the same shape as the write-side line — terminating quietly would be no better than hanging",
  "[upstream | sheet-export → clients lookup] the stalled call really CROSSED THE WIRE (sheet-export.ts, the clients select (which also DISCARDED .error)): the stub accepted it, read it in full, and never answered — a fault that was never issued would prove nothing",
  "[upstream | sheet-export → clients lookup] the after() callback TERMINATES when the call UPSTREAM of the audit write never answers: bounding only the write left this frozen, with the 200 already shipped",
  "[upstream | sheet-export → clients lookup] and it is LOUD: exactly one [supabase-read][READ-FAILURE] line naming clients, fault=timeout status=0, in the same shape as the write-side line — terminating quietly would be no better than hanging",
  "[upstream | sheet-export → answers lookup] the stalled call really CROSSED THE WIRE (sheet-export.ts, getSessionAnswers on the after() path): the stub accepted it, read it in full, and never answered — a fault that was never issued would prove nothing",
  "[upstream | sheet-export → answers lookup] the after() callback TERMINATES when the call UPSTREAM of the audit write never answers: bounding only the write left this frozen, with the 200 already shipped",
  "[upstream | sheet-export → answers lookup] and it is LOUD: exactly one [supabase-read][READ-FAILURE] line naming onboarding_answers, fault=timeout status=0, in the same shape as the write-side line — terminating quietly would be no better than hanging",
  "[upstream | sheet-export → submitted_at re-read] the stalled call really CROSSED THE WIRE (sheet-export.ts, the submitted_at re-read (which also DISCARDED .error)): the stub accepted it, read it in full, and never answered — a fault that was never issued would prove nothing",
  "[upstream | sheet-export → submitted_at re-read] the after() callback TERMINATES when the call UPSTREAM of the audit write never answers: bounding only the write left this frozen, with the 200 already shipped",
  "[upstream | sheet-export → submitted_at re-read] and it is LOUD: exactly one [supabase-read][READ-FAILURE] line naming onboarding_sessions, fault=timeout status=0, in the same shape as the write-side line — terminating quietly would be no better than hanging",
  "[upstream | sheet-export → pm_tracker_pushes seed] the stalled call really CROSSED THE WIRE (sheet-export.ts, the pm_tracker_pushes upsert (which DID read .error, and was still silent)): the stub accepted it, read it in full, and never answered — a fault that was never issued would prove nothing",
  "[upstream | sheet-export → pm_tracker_pushes seed] the after() callback TERMINATES when the call UPSTREAM of the audit write never answers: bounding only the write left this frozen, with the 200 already shipped",
  "[upstream | sheet-export → pm_tracker_pushes seed] and it is LOUD: exactly one [supabase-write][WRITE-FAILURE] line naming pm_tracker_pushes, fault=timeout status=0, in the same shape as the write-side line — terminating quietly would be no better than hanging",
  "[google | control] the export really REACHES the Google endpoints: one OAuth2 token mint, two values reads and one values append, all on loopback — without this control the stall cases below could not tell \"bounded correctly\" from \"never got there\"",
  "[google | control] and a HEALTHY Google writes NO sheet_export_failed row: the bound does not manufacture failures out of a working dependency",
  "[google | token mint stall] the stalled Google call really CROSSED THE WIRE (jwt.authorize() — gtoken/getToken.js GOOGLE_TOKEN_URL, which carries no timeout of its own): the stub accepted it, read it in full, and never answered",
  "[google | token mint stall] exportSubmissionToSheet TERMINATES: unbounded this await never settled at all, because gaxios arms a signal only under if (opts.timeout) and node:http.ClientRequest has no default timeout — not even undici's 300s floor",
  "[google | token mint stall] and it is LOUD, naming WHICH of the four Google calls stalled: exactly one [upstream-http][REQUEST-FAILURE] line with target \"google:oauth2 token mint\", fault=timeout — the raw rejection says only \"The operation was aborted.\"",
  "[google | token mint stall] and the Google stall STILL REACHES the sheet_export_failed audit write downstream of it: bounding is worth nothing if the failure-reporting write is still never issued",
  "[google | token mint stall] and the OUTER report is a tagged [bounded-stage][FAILURE] record naming the stalled call: it used to be an untagged [sheet-export] failed line that CONCATENATED the remote's text, with no fault kind, no status and no statement of what survived",
  "[google | values read stall] the stalled Google call really CROSSED THE WIRE (valuesGet A1:O1 — the exact call measured as never settling): the stub accepted it, read it in full, and never answered",
  "[google | values read stall] exportSubmissionToSheet TERMINATES: unbounded this await never settled at all, because gaxios arms a signal only under if (opts.timeout) and node:http.ClientRequest has no default timeout — not even undici's 300s floor",
  "[google | values read stall] and it is LOUD, naming WHICH of the four Google calls stalled: exactly one [upstream-http][REQUEST-FAILURE] line with target \"google:values.get A1:O1\", fault=timeout — the raw rejection says only \"The operation was aborted.\"",
  "[google | values read stall] and the Google stall STILL REACHES the sheet_export_failed audit write downstream of it: bounding is worth nothing if the failure-reporting write is still never issued",
  "[google | values read stall] and the OUTER report is a tagged [bounded-stage][FAILURE] record naming the stalled call: it used to be an untagged [sheet-export] failed line that CONCATENATED the remote's text, with no fault kind, no status and no statement of what survived",
  "[google | values write stall] the stalled Google call really CROSSED THE WIRE (valuesAppend — the roster row itself): the stub accepted it, read it in full, and never answered",
  "[google | values write stall] exportSubmissionToSheet TERMINATES: unbounded this await never settled at all, because gaxios arms a signal only under if (opts.timeout) and node:http.ClientRequest has no default timeout — not even undici's 300s floor",
  "[google | values write stall] and it is LOUD, naming WHICH of the four Google calls stalled: exactly one [upstream-http][REQUEST-FAILURE] line with target \"google:values.append A1:O\", fault=timeout — the raw rejection says only \"The operation was aborted.\"",
  "[google | values write stall] and the Google stall STILL REACHES the sheet_export_failed audit write downstream of it: bounding is worth nothing if the failure-reporting write is still never issued",
  "[google | values write stall] and the OUTER report is a tagged [bounded-stage][FAILURE] record naming the stalled call: it used to be an untagged [sheet-export] failed line that CONCATENATED the remote's text, with no fault kind, no status and no statement of what survived",
  "[google | guard intact] with the rewrite DISARMED the very same export is blocked at the hermeticity guard: the stub is reachable because requests are REWRITTEN to loopback, not because the guard was opened",
  "[analyze upstream | session lookup] the stalled read really CROSSED THE WIRE: the stub accepted it, read it in full, and never answered",
  "[analyze upstream | session lookup] the handler FAILS CLOSED with the same 503 as any other fault instead of freezing: unbounded it never answered at all, and the 503 downstream of it was unreachable",
  "[analyze upstream | session lookup] and it carries the PRECONDITION machine code with a sentence that is TRUE of this stage, not the limiter's code and the limiter's \"we could not check your analysis limit\" wording, which named a component that was never consulted",
  "[analyze upstream | session lookup] and it is LOUD: exactly one [bounded-stage][FAILURE] line naming the stage \"session_lookup (onboarding_sessions)\", fault=timeout code=DEADLINE_EXCEEDED — a 503 with nothing in the log is a mystery, not a report",
  "[analyze upstream | session lookup] and NOTHING was started: no rate-limit row, no analysis record, no Anthropic spend — which is what the line's succeeded field claims",
  "[analyze upstream | reusable scan lookup] the stalled read really CROSSED THE WIRE: the stub accepted it, read it in full, and never answered",
  "[analyze upstream | reusable scan lookup] the handler FAILS CLOSED with the same 503 as any other fault instead of freezing: unbounded it never answered at all, and the 503 downstream of it was unreachable",
  "[analyze upstream | reusable scan lookup] and it carries the PRECONDITION machine code with a sentence that is TRUE of this stage, not the limiter's code and the limiter's \"we could not check your analysis limit\" wording, which named a component that was never consulted",
  "[analyze upstream | reusable scan lookup] and it is LOUD: exactly one [bounded-stage][FAILURE] line naming the stage \"reusable_scan_lookup (onboarding_site_intelligence)\", fault=timeout code=DEADLINE_EXCEEDED — a 503 with nothing in the log is a mystery, not a report",
  "[analyze upstream | reusable scan lookup] and NOTHING was started: no rate-limit row, no analysis record, no Anthropic spend — which is what the line's succeeded field claims",
  "[am-bypass counter | bypass] a stalled counter read is REPORTED, bypass or not: the log is not scoped to the branch the 503 is scoped to, because a degraded Supabase is degraded for everyone",
  "[am-bypass counter | bypass] and the AM is still NOT 503'd: the ruling scoped the STATUS to the non-bypass branch, and separating the two decisions must not quietly widen it",
  "[am-bypass counter | plain] a stalled counter read is REPORTED, bypass or not: the log is not scoped to the branch the 503 is scoped to, because a degraded Supabase is degraded for everyone",
  "[am-bypass counter | plain] while a REAL client still gets the fail-closed 503 from the same condition, so separating log from status changed the log only",
  "[d4 | timeout] on a TIMEOUT the line says the rate-limit slot MAY OR MAY NOT have been spent: aborting does not roll back a row PostgREST may already have committed, so the old flat \"nothing was started\" was a claim this code cannot make",
  "[d4 | refused] and on a fault that DEFINITELY refused the row the sentence stays definite: fault-awareness must not turn every report into a hedge",
  "[analyze after | runSiteAnalysis record read] the analyze route registered exactly 1 after() task and returned a record id — the route-to-after() wiring IS the driver, so deleting the after(...) must fail this",
  "[analyze after | runSiteAnalysis record read] the stalled read really CROSSED THE WIRE past the 0 read(s) served normally, so this case faults the call it names and not an earlier one on the same table",
  "[analyze after | runSiteAnalysis record read] the after() callback TERMINATES: unbounded it hung past the response with only a console.error for company, holding the invocation open until the platform killed it",
  "[analyze after | runSiteAnalysis record read] and the path that had NO failure-reporting write at all now emits one line in the same shape as every other tag, naming the stage that failed",
  "[analyze after | runSiteAnalysis record read] and the READ inside runSiteAnalysis reports itself too, so an operator learns WHICH await stalled rather than only that the stage did",
  "[analyze after | runSiteAnalysis record read] and runSiteAnalysis's OWN catch — the one that marks the record failed and does NOT rethrow, i.e. where the most common scan failure actually lands — is correctly NOT reached here, because this case throws before the try",
  "[analyze after | getSiteIntelligence status read] the analyze route registered exactly 1 after() task and returned a record id — the route-to-after() wiring IS the driver, so deleting the after(...) must fail this",
  "[analyze after | getSiteIntelligence status read] the stalled read really CROSSED THE WIRE past the 1 read(s) served normally, so this case faults the call it names and not an earlier one on the same table",
  "[analyze after | getSiteIntelligence status read] the after() callback TERMINATES: unbounded it hung past the response with only a console.error for company, holding the invocation open until the platform killed it",
  "[analyze after | getSiteIntelligence status read] and the path that had NO failure-reporting write at all now emits one line in the same shape as every other tag, naming the stage that failed",
  "[analyze after | getSiteIntelligence status read] and runSiteAnalysis's OWN catch — the one that marks the record failed and does NOT rethrow, i.e. where the most common scan failure actually lands — now emits its own tagged single-line record instead of the untagged two-argument console.error that used to be its only trace",
  "[bridge | hostile body] the dashboard's non-2xx goes through the SAME emitter as everything else: ONE physical line, tag then JSON, with the multi-line remote body ESCAPED rather than concatenated — the old line fragmented here and stranded the tag",
  "[bridge | hostile body] and nothing is lost by routing it: the whole remote body still reaches the operator inside the record, and the hand-built concatenating line is GONE rather than duplicated alongside it",
  "[hostile opts | recordAuditEvent] a NULL options object no longer produces a raw TypeError from the spec builder: the call stays total and still emits one line, whose route and succeeded say plainly that the call site supplied neither",
  "[hostile opts | recordAuditEvent] an options object whose every getter THROWS is absorbed too, and the injected Supabase fault is still the one reported — the hostile input does not become the news",
  "[hostile opts | recordOpenEvent] the OTHER wrapper is total in its own right as well, on BOTH of the objects it dereferences: the open-events builder reads a row object and a meta object, and neither was guarded",
  "[hostile opts | insertAuditEventOrThrow] the fail-closed entry point still throws the ONE error type its caller branches on, not a TypeError from the spec builder: a raw TypeError would have flattened into the analyze route's generic 500 and lost the machine-readable reason",
  "[degraded line] the fallback branch emits exactly ONE physical line: a message containing a newline used to fragment the record and leave the [audit-write][WRITE-FAILURE] tag on the half an operator does not need",
  "[degraded line] and it is still JSON an operator can parse: the newline is ESCAPED rather than emitted, so the whole message survives on the tagged line alongside the table and session",
  "[unserialisable record | logAuditWriteFailure] a record JSON.stringify REFUSES still produces EXACTLY ONE tagged physical line: this emitter used to be the difference between a reporting layer and a reporting layer that gives up when the news is awkward",
  "[unserialisable record | logAuditWriteFailure] and the floor is still PARSEABLE JSON naming the table and the session, and SAYS it is degraded, so an operator reading it knows which fields were dropped rather than believing the record is complete",
  "[unserialisable record | logSupabaseFailure] a record JSON.stringify REFUSES still produces EXACTLY ONE tagged physical line: this emitter used to be the difference between a reporting layer and a reporting layer that gives up when the news is awkward",
  "[unserialisable record | logSupabaseFailure] and the floor is still PARSEABLE JSON naming the table and the session, and SAYS it is degraded, so an operator reading it knows which fields were dropped rather than believing the record is complete",
  "[unserialisable record | logUpstreamFailure] a record JSON.stringify REFUSES still produces EXACTLY ONE tagged physical line: this emitter used to be the difference between a reporting layer and a reporting layer that gives up when the news is awkward",
  "[unserialisable record | logUpstreamFailure] and the floor is still PARSEABLE JSON naming the target and the session, and SAYS it is degraded, so an operator reading it knows which fields were dropped rather than believing the record is complete",
  "[hostile field read | logAuditWriteFailure] a record whose \"table\" GETTER THROWS a hostile value still produces EXACTLY ONE tagged physical line: safeField's catch handler used to run instanceof and a property read on that value, throw a second time, and leave the shared floor emitting nothing at all",
  "[hostile field read | logAuditWriteFailure] and the floor is still PARSEABLE JSON on one physical line, naming the session, SAYING it is degraded, and rendering the unreadable field as an encoded sentinel rather than dropping it — so an operator can tell \"this field could not be read\" from \"this field was not there\"",
  "[hostile field read | logSupabaseFailure] a record whose \"table\" GETTER THROWS a hostile value still produces EXACTLY ONE tagged physical line: safeField's catch handler used to run instanceof and a property read on that value, throw a second time, and leave the shared floor emitting nothing at all",
  "[hostile field read | logSupabaseFailure] and the floor is still PARSEABLE JSON on one physical line, naming the session, SAYING it is degraded, and rendering the unreadable field as an encoded sentinel rather than dropping it — so an operator can tell \"this field could not be read\" from \"this field was not there\"",
  "[hostile field read | logUpstreamFailure] a record whose \"target\" GETTER THROWS a hostile value still produces EXACTLY ONE tagged physical line: safeField's catch handler used to run instanceof and a property read on that value, throw a second time, and leave the shared floor emitting nothing at all",
  "[hostile field read | logUpstreamFailure] and the floor is still PARSEABLE JSON on one physical line, naming the session, SAYING it is degraded, and rendering the unreadable field as an encoded sentinel rather than dropping it — so an operator can tell \"this field could not be read\" from \"this field was not there\"",
  "[non-string message | normaliseAuditFault | message=array] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseAuditFault | message=array] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseAuditFault | message=object] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseAuditFault | message=object] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseAuditFault | message=number] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseAuditFault | message=number] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseAuditFault | message=null] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseAuditFault | message=null] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseAuditFault | message=undefined] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseAuditFault | message=undefined] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseReadFault | message=array] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseReadFault | message=array] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseReadFault | message=object] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseReadFault | message=object] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseReadFault | message=number] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseReadFault | message=number] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseReadFault | message=null] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseReadFault | message=null] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseReadFault | message=undefined] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseReadFault | message=undefined] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseHttpResponseFault | message=array] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseHttpResponseFault | message=array] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseHttpResponseFault | message=object] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseHttpResponseFault | message=object] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseHttpResponseFault | message=number] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseHttpResponseFault | message=number] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseHttpResponseFault | message=null] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseHttpResponseFault | message=null] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseHttpResponseFault | message=undefined] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseHttpResponseFault | message=undefined] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseThrownFault | message=array] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseThrownFault | message=array] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseThrownFault | message=object] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseThrownFault | message=object] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseThrownFault | message=number] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseThrownFault | message=number] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseThrownFault | message=null] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseThrownFault | message=null] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string message | normaliseThrownFault | message=undefined] the normaliser is TOTAL and the site still emits EXACTLY ONE tagged line: boundFaultMessage assumed a string and called .slice, and because the normaliser runs in ARGUMENT POSITION the TypeError escaped below the logger — so a remote sending a non-string message silenced the report entirely",
  "[non-string message | normaliseThrownFault | message=undefined] and the DECLARED TYPES are true of the value: AuditFault says message is a string and code is string|null, and a JSON-serialisable non-string used to pass straight through into both, so the emitted record's type was a lie an operator's parser would trip on",
  "[non-string code | array] a non-string `code` is COERCED to a bounded string rather than copied into a field declared string|null: an array in pg_code is emitted as a JSON array, which breaks the one field an operator filters on",
  "[non-string code | object] a non-string `code` is COERCED to a bounded string rather than copied into a field declared string|null: an array in pg_code is emitted as a JSON array, which breaks the one field an operator filters on",
  "[non-string code | number] a non-string `code` is COERCED to a bounded string rather than copied into a field declared string|null: an array in pg_code is emitted as a JSON array, which breaks the one field an operator filters on",
  "[hostile proxy | hostile getPrototypeOf over a TypeError] normaliseThrownFault RETURNS a fault instead of throwing: an unguarded instanceof made the reporter itself the second failure, on the exact path a report is being built",
  "[hostile proxy | hostile getPrototypeOf over a TypeError] and the classification is still the RIGHT one, so guarding the instanceof cost no accuracy: a real deadline behind a hostile proxy is still recognised, by name, and still carries DEADLINE_EXCEEDED",
  "[hostile proxy | hostile getPrototypeOf + hostile get] normaliseThrownFault RETURNS a fault instead of throwing: an unguarded instanceof made the reporter itself the second failure, on the exact path a report is being built",
  "[hostile proxy | hostile getPrototypeOf + hostile get] and the classification is still the RIGHT one, so guarding the instanceof cost no accuracy: a real deadline behind a hostile proxy is still recognised, by name, and still carries DEADLINE_EXCEEDED",
  "[hostile proxy | hostile getPrototypeOf over a real deadline] normaliseThrownFault RETURNS a fault instead of throwing: an unguarded instanceof made the reporter itself the second failure, on the exact path a report is being built",
  "[hostile proxy | hostile getPrototypeOf over a real deadline] and the classification is still the RIGHT one, so guarding the instanceof cost no accuracy: a real deadline behind a hostile proxy is still recognised, by name, and still carries DEADLINE_EXCEEDED",
  "[aud1 terminal catch] the SLOT REALLY WAS SPENT before the failure: the analyze-requested row landed on a healthy audit table, so this measures the branch that matters rather than an early bail",
  "[aud1 terminal catch] the handler's last-resort failure is now ONE tagged line of JSON naming the session and the client, on the same emitter as every other failure on this route, instead of an untagged multi-line console.error nobody can grep alongside the rest",
  "[aud1 terminal catch] and its succeeded field STATES that a slot was spent, so an operator does not tell a client to \"just try again\" and silently burn the rest of their five hourly attempts",
  "[aud1 terminal catch] and the CALLER gets a machine code and the slot fact, not an opaque \"Internal server error\" that leaves both the client and their retry budget in the dark",
  "[am-bypass | reusable scan stall] a BYPASS request is NOT 503'd when the dedup lookup stalls: the ruling is that a bypass caller is never refused over gating that does not apply to them, and a dedup lookup only ever SAVES a scan, so losing it costs one duplicate on a click an AM made deliberately",
  "[am-bypass | reusable scan stall] and it is still LOUD for the bypass caller: not being refused is not the same as not being reported, and an AM's analyze click is frequently the earliest evidence a session ever gets that Supabase is sick",
  "[am-bypass | reusable scan stall] the SAME stall on a NON-bypass request still fails closed with 503 and the precondition code: the scoping narrows who the rule applies to, it does not weaken the rule",
  "[public upstream | save-step | session lookup] the stalled read really CROSSED THE WIRE: the stub accepted it, read it in full, and never answered — so this measures a real non-terminating await and not a missing fixture",
  "[public upstream | save-step | session lookup] the handler TERMINATES and FAILS CLOSED with 503: unbounded, this await never settled, so the handler froze, the response never shipped and — on the two after() routes — the reporting callbacks were never even registered",
  "[public upstream | save-step | session lookup] and it answers with its OWN retryable machine code, never the 404 that \"session not found\" would give: getSessionByToken swallows every error and returns null, so a stall would read as \"no such session\" if withDeadline did not settle its race BEFORE aborting",
  "[public upstream | save-step | session lookup] and it is LOUD: exactly one [bounded-stage][FAILURE] line naming the stage \"session_lookup (onboarding_sessions)\", fault=timeout code=DEADLINE_EXCEEDED, on one physical line — a route that gives up silently is the defect this branch exists to remove",
  "[public upstream | save-step | session lookup] and NOTHING was written: the failure happened upstream of every write, which is what the line's succeeded field claims",
  "[public upstream | save-step | session lookup] and the helper itself says nothing extra: only the stage that ran out of time reports, because no helper-level read was involved",
  "[public upstream | submit | session lookup] the stalled read really CROSSED THE WIRE: the stub accepted it, read it in full, and never answered — so this measures a real non-terminating await and not a missing fixture",
  "[public upstream | submit | session lookup] the handler TERMINATES and FAILS CLOSED with 503: unbounded, this await never settled, so the handler froze, the response never shipped and — on the two after() routes — the reporting callbacks were never even registered",
  "[public upstream | submit | session lookup] and it answers with its OWN retryable machine code, never the 404 that \"session not found\" would give: getSessionByToken swallows every error and returns null, so a stall would read as \"no such session\" if withDeadline did not settle its race BEFORE aborting",
  "[public upstream | submit | session lookup] and it is LOUD: exactly one [bounded-stage][FAILURE] line naming the stage \"session_lookup (onboarding_sessions)\", fault=timeout code=DEADLINE_EXCEEDED, on one physical line — a route that gives up silently is the defect this branch exists to remove",
  "[public upstream | submit | session lookup] and NOTHING was written: the failure happened upstream of every write, which is what the line's succeeded field claims",
  "[public upstream | submit | session lookup] and the helper itself says nothing extra: only the stage that ran out of time reports, because no helper-level read was involved",
  "[public upstream | session | session lookup] the stalled read really CROSSED THE WIRE: the stub accepted it, read it in full, and never answered — so this measures a real non-terminating await and not a missing fixture",
  "[public upstream | session | session lookup] the handler TERMINATES and FAILS CLOSED with 503: unbounded, this await never settled, so the handler froze, the response never shipped and — on the two after() routes — the reporting callbacks were never even registered",
  "[public upstream | session | session lookup] and it answers with its OWN retryable machine code, never the 404 that \"session not found\" would give: getSessionByToken swallows every error and returns null, so a stall would read as \"no such session\" if withDeadline did not settle its race BEFORE aborting",
  "[public upstream | session | session lookup] and it is LOUD: exactly one [bounded-stage][FAILURE] line naming the stage \"session_lookup (onboarding_sessions)\", fault=timeout code=DEADLINE_EXCEEDED, on one physical line — a route that gives up silently is the defect this branch exists to remove",
  "[public upstream | session | session lookup] and NOTHING was written: the failure happened upstream of every write, which is what the line's succeeded field claims",
  "[public upstream | session | session lookup] and the helper itself says nothing extra: only the stage that ran out of time reports, because no helper-level read was involved",
  "[public upstream | submit | answers read] the stalled read really CROSSED THE WIRE: the stub accepted it, read it in full, and never answered — so this measures a real non-terminating await and not a missing fixture",
  "[public upstream | submit | answers read] the handler TERMINATES and FAILS CLOSED with 503: unbounded, this await never settled, so the handler froze, the response never shipped and — on the two after() routes — the reporting callbacks were never even registered",
  "[public upstream | submit | answers read] and it answers with its OWN retryable machine code, never the 404 that \"session not found\" would give: getSessionByToken swallows every error and returns null, so a stall would read as \"no such session\" if withDeadline did not settle its race BEFORE aborting",
  "[public upstream | submit | answers read] and it is LOUD: exactly one [bounded-stage][FAILURE] line naming the stage \"answers_read (onboarding_answers)\", fault=timeout code=DEADLINE_EXCEEDED, on one physical line — a route that gives up silently is the defect this branch exists to remove",
  "[public upstream | submit | answers read] and NOTHING was written: the failure happened upstream of every write, which is what the line's succeeded field claims",
  "[public upstream | submit | answers read] and the helper itself reports the READ in the same vocabulary ([supabase-read][READ-FAILURE]), so an operator learns WHICH await stalled and not only that the stage did. Without this the abort still reached getSessionAnswers' own error branch and printed an UNTAGGED \"Error fetching answers:\" line beside the tagged one",
  "[public upstream | session | answers read] the stalled read really CROSSED THE WIRE: the stub accepted it, read it in full, and never answered — so this measures a real non-terminating await and not a missing fixture",
  "[public upstream | session | answers read] the handler TERMINATES and FAILS CLOSED with 503: unbounded, this await never settled, so the handler froze, the response never shipped and — on the two after() routes — the reporting callbacks were never even registered",
  "[public upstream | session | answers read] and it answers with its OWN retryable machine code, never the 404 that \"session not found\" would give: getSessionByToken swallows every error and returns null, so a stall would read as \"no such session\" if withDeadline did not settle its race BEFORE aborting",
  "[public upstream | session | answers read] and it is LOUD: exactly one [bounded-stage][FAILURE] line naming the stage \"answers_read (onboarding_answers)\", fault=timeout code=DEADLINE_EXCEEDED, on one physical line — a route that gives up silently is the defect this branch exists to remove",
  "[public upstream | session | answers read] and NOTHING was written: the failure happened upstream of every write, which is what the line's succeeded field claims",
  "[public upstream | session | answers read] and the helper itself reports the READ in the same vocabulary ([supabase-read][READ-FAILURE]), so an operator learns WHICH await stalled and not only that the stage did. Without this the abort still reached getSessionAnswers' own error branch and printed an UNTAGGED \"Error fetching answers:\" line beside the tagged one",
  "[public upstream | session | client lookup degrades] a stall on a stage that only ENRICHES the payload is bounded, REPORTED and then degraded to a 200: refusing the page over a missing company name would cost the client their form and cost us the report",
  "[public upstream | session | client lookup degrades] and BOTH reporting sites survive it: the after() task is still REGISTERED and both tracking writes still reach the wire. Unbounded, this stall froze the handler ABOVE the after(...) call, so session_accessed and the open-history row were never attempted and nothing said so",
  "[hermeticity] no dependency attempted a non-loopback fetch()",
  "[hermeticity] no dependency attempted a non-loopback http(s).request (the gaxios/node-fetch path the fetch guard cannot see)",
  "[hermeticity] no dependency attempted a non-loopback net/tls/http2/dgram connection, including via net.Socket.prototype.connect (the raw socket floor under both guards above, and the one a destructured module reference cannot skip)",
  "[attribution] no POST ever reached the stub outside a labelled window — every row asserted on is attributable to the site that caused it",
  "[credential] every /rest/v1 request in this run presented the service-role key the harness configured",
  "[env pin] this pass ran with the environment it pinned, and the pin landed before any app module was imported",
  "[env pin] every Request this pass built carried exactly the header set this pass is contracted to send",
]);

/** Parent-pass only: supervision of the two child environment passes. */
const ENV_MATRIX_LABELS: Record<Exclude<EnvPass, 'prod'>, { ran: string; clean: string }> = {
  dev: {
    ran: "[env matrix | dev] the development pass (a re-spawn with NODE_ENV=development and every VERCEL_ / AWS_LAMBDA_ variable deleted, pinned before module load) ran the full matrix and exited 0",
    clean: "[env matrix | dev] the development pass reported 0 failures and its own label-identity guard satisfied, with exactly the base assertion set",
  },
  vercel: {
    ran: "[env matrix | vercel] the production-representative pass (a re-spawn with the documented Vercel system environment AND the real Vercel edge request headers, pinned before module load) ran the full matrix and exited 0",
    clean: "[env matrix | vercel] the production-representative pass reported 0 failures and its own label-identity guard satisfied, with exactly the base assertion set",
  },
};
const PARENT_ONLY_LABELS: readonly string[] = Object.freeze([
  ENV_MATRIX_LABELS.dev.ran,
  ENV_MATRIX_LABELS.dev.clean,
  ENV_MATRIX_LABELS.vercel.ran,
  ENV_MATRIX_LABELS.vercel.clean,
]);

const EXPECTED_LABELS: readonly string[] = Object.freeze(
  IS_PARENT_PASS ? [...BASE_LABELS, ...PARENT_ONLY_LABELS] : [...BASE_LABELS],
);

function checkLabelIdentity(): boolean {
  const expected = new Set(EXPECTED_LABELS);
  const missing = [...expected].filter((l) => !seenLabels.has(l));
  const unexpected = [...seenLabels].filter((l) => !expected.has(l));
  if (missing.length === 0 && unexpected.length === 0 && duplicateLabels.length === 0) {
    out(`  LABEL IDENTITY OK: all ${expected.size} frozen assertion labels ran, and only those`);
    return true;
  }
  out('  LABEL IDENTITY GUARD FAILED — the assertion SET changed, not just its size.');
  for (const l of missing) out(`    MISSING (frozen, did not run): ${l}`);
  for (const l of unexpected) out(`    UNEXPECTED (ran, not frozen): ${l}`);
  for (const l of duplicateLabels) out(`    DUPLICATE label (masks a deletion): ${l}`);
  if (process.env.DUMP_LABELS === '1') {
    out('\n  PASTE-READY EXPECTED_LABELS:');
    for (const l of seenLabels) out(`  ${JSON.stringify(l)},`);
  }
  return false;
}

// ---------------------------------------------------------------------------
// 14b. AUD-8 — MAKE THE EXIT DETERMINISTIC.
// ---------------------------------------------------------------------------
//
// MEASURED: one run in four ended with the DEV CHILD aborting at 0xC0000409.
// That is STATUS_STACK_BUFFER_OVERRUN, which is what Windows reports for a
// libuv `abort()` — the assertion libuv raises when `process.exit()` tears the
// loop down while handles are still live. The parent then failed the child's
// `exit=0` assertion, so a green change failed one run in four for a reason
// that had nothing to do with the code under test. A flaky harness in CI is
// worse than a slow one: it trains everyone to re-run instead of to read.
//
// THE FIX IS TO STOP RACING THE LOOP. Set `process.exitCode`, release what is
// still holding the loop open, and let Node end the process on its own — the
// path that flushes stdio properly and never reaches the assertion. `run()`
// already closes the stub server (with closeAllConnections) and clears the
// bail timer in its finally, and the children are spawned SYNCHRONOUSLY, so
// what remains is whatever a dependency left behind: an undici keep-alive
// socket, an agent timer. Those are unref'd rather than destroyed, because
// destroying a socket a dependency still holds is how you turn a clean exit
// into an unhandled 'error' event.
//
// L3 SAID DROPPING process.exit() WOULD RISK A CI HANG, AND THAT IS STILL
// TRUE, so it is not simply dropped: an UNREF'D grace timer keeps the hard
// exit as a last resort. Unref'd, so it cannot itself be the thing holding the
// process open. If it ever fires, that is real news — something leaked — and
// the message says so instead of exiting silently.
const EXIT_GRACE_MS = 5_000;

/** Unref every active handle except stdio, so pending output still flushes. */
function releaseLingeringHandles(): string[] {
  const names: string[] = [];
  const getHandles = (process as unknown as { _getActiveHandles?: () => unknown[] })
    ._getActiveHandles;
  if (typeof getHandles !== 'function') return names;
  let handles: unknown[] = [];
  try {
    handles = getHandles.call(process) ?? [];
  } catch {
    return names;
  }
  for (const handle of handles) {
    if (handle === process.stdout || handle === process.stderr || handle === process.stdin) {
      continue;
    }
    try {
      const h = handle as { unref?: () => void; constructor?: { name?: string } };
      names.push(h?.constructor?.name ?? 'unknown');
      h.unref?.();
    } catch {
      /* a handle that refuses to be unref'd is what the grace timer is for */
    }
  }
  return names;
}

function finish(code: number): void {
  process.exitCode = code;
  const lingering = releaseLingeringHandles();
  if (lingering.length > 0) {
    out(`  (exit: unref'd ${lingering.length} lingering handle(s): ${lingering.join(', ')})`);
  }
  const grace = setTimeout(() => {
    emergencyOut(
      `\nEXIT: the event loop was still busy ${EXIT_GRACE_MS}ms after the run finished — ` +
        `forcing exit(${code}). Something leaked a handle that could not be unref'd.`,
    );
    process.exit(code);
  }, EXIT_GRACE_MS);
  (grace as unknown as { unref?: () => void }).unref?.();
}

run()
  .then(() => {
    // D1/D2: the same matrix, again, under the two OTHER runtimes. Runs only
    // in the top-level invocation; a child never re-spawns.
    if (IS_PARENT_PASS) {
      runOtherEnvPass('dev');
      runOtherEnvPass('vercel');
    }

    const total = passed + failed;
    out('\n=========================================');
    out(`  ${passed} passed, ${failed} failed  (${total} assertions)`);
    if (failed > 0) {
      out('  FAILED:');
      for (const f of failures) out(`    - ${f}`);
    }
    const identityOk = checkLabelIdentity();
    out('=========================================');
    finish(failed > 0 || !identityOk ? 1 : 0);
  })
  .catch((err) => {
    // AUD-7: the crash path prints on the channel a capture cannot swallow. A
    // crash inside a driver runs with process.stdout.write replaced, so this
    // used to produce an EMPTY transcript alongside a non-zero exit — the
    // least useful pair of facts a harness can hand you.
    emergencyOut(`\nTest harness crashed: ${err instanceof Error ? err.stack : String(err)}`);
    finish(1);
  });
