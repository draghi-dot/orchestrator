# QA Arena

An Electron app for evidence-driven application audits. Five worker roles build the app, investigate it, challenge findings, write a report, and propose improvements to their rules. The six screens are **Projects**, **Audit setup**, **Arena**, **Findings**, **DNA**, and **Settings**.

## Run locally

Use Node 22.13+ with `node:sqlite` available (development tested with Node 25). From this directory:

```bash
npm ci
npm run dev
```

For the compiled app:

```bash
npm run build
npm start
```

Local HTTP ports must be allowed: the app uses a loopback tool gateway and starts imported test apps on loopback. Project startup scripts run on your machine; only enable commands for source you trust. This is a development app, without a signed installer or OS-level sandbox for imported build scripts.

## First audit

1. Open the bundled **Sample Shop** in Projects, then **Set up audit**.
2. Choose **Use offline workers** to exercise the complete pipeline without a model account. The sample defaults to both source and HTTP testing, with the `alice` and `bob` test accounts.
3. Start the audit. Arena shows the five phases, workers, debate rounds, host verdicts, event replay, worker scores, and artifacts.
4. Open a finding to inspect its reproduction, source quote, challenge, verification, and generated regression test. Export the report from Arena.
5. Review unresolved findings in Findings. Accept or reject proposed worker rules in DNA; acceptance creates a new version for future runs.

The sample deliberately contains four defects: SAVE20 applies 15% instead of 20%; customers can read another customer's order; free shipping incorrectly excludes an exact $100 subtotal; negative quantities are accepted. Unknown coupons correctly return 422. The offline researcher deliberately proposes that last case as a decoy to exercise rejection. Its sample probes are deterministic fixtures, **not a measure of model discovery ability**. Sample scoring matches finding titles/descriptions against host-only ground truth.

## Provider accounts and workers

Settings discovers the installed `claude`, `codex`, and `omp` executables; absolute paths can also be configured. Claude and Codex offer sign-in, sign-out, status, browser links, and cancellation inside the app. They use the official CLI authentication flows; provider credentials remain under the CLI's control. Codex uses device authentication. If Claude requests a pasted authorization code, the sign-in panel accepts it. oh-my-pi authentication is managed in its own CLI.

Each role has an independent runtime/model choice. Empty model fields use that CLI's default. The default lineup uses offline Builder, Codex Researcher, Claude Thinker and Reporter, and Codex Improver. Use offline workers until your providers are signed in. Changing a provider's sign-in is refused while a queued or active run uses it.

Model workers operate in an empty scratch directory with native tools disabled and the QA bridge configured as their tool surface. Source, request, account, budget, and lease checks live in the host. Real provider compatibility must be validated with the installed CLI versions; protocol fixtures alone do not prove a working provider connection.

## Audit behavior

- **Build:** creates a working copy and starts a local app if explicitly allowed. Source-only audits and authorized test URLs skip local startup. Black-box researchers and challengers cannot read source; a local Builder still reads startup instructions.
- **Research:** follows the frozen scope, exclusions, focus, depth, account selection, and optional library setting. Claims include category, severity reason, suggested fix, and either a replayable HTTP reproduction or a file:line quote.
- **Challenge:** the Thinker agrees, disputes, or remains unsure. The host independently replays HTTP or checks quoted source lines. Contested findings may be amended or withdrawn in later rounds. Only the current round's challenges settle amended evidence.
- **Report:** saves an interim report after research, then records the final outcome and coverage limits. If a blocked reporter produces no report, the host writes a factual fallback.
- **Improve:** proposes rule additions/removals. They remain pending until you decide with a reason.

Host outcomes are **confirmed**, **rejected**, **inconclusive**, or **needs review**. A successful run means orchestration finished; it does not mean the project has no bugs. Blocked tasks remain visible. Quote verification establishes that code exists at the cited location; it does not execute the code or independently prove the claimed semantics.

Confirmed HTTP findings become standalone `node:test` files. The host runs them immediately and checks for a failing assertion. A passing test or an execution error sends the finding back to review. Source-only findings do not yet get executable regression tests. For exported HTTP tests, start the application and provide `APP_URL`; account-based tests additionally require the `QA_ACCOUNT_<NAME>_HEADER` and `QA_ACCOUNT_<NAME>_VALUE` environment variables named in the file. Credentials are not embedded in exports.

HTTP requests stay on the selected app origin and do not follow redirects. External deployment testing accepts GET, HEAD, and OPTIONS only; writes require the local app copy. Reproductions preserve permitted request headers. This HTTP client is not a browser session: there is no browser automation, cookie jar, screenshot capture of target apps, or JavaScript-driven page testing yet.

## Writeup library

Set a local Markdown directory in Settings. On a fresh development installation, the app detects `../ctf-important-writeups` if present. The existing curated collection has 120 Markdown writeups plus JSON metadata; the loader uses `index.json` for attribution and searches Markdown with a local keyword index. No embedding service is required. Retrieved excerpts are labeled background and never count as application evidence. The library and the Kestrel reference directory remain outside Git.

## Persistence and controls

Data lives in Electron's `userData` directory (normally `~/Library/Application Support/QA Arena` on macOS): `qa-arena.sqlite`, `runtime-settings.json`, snapshots, runs, and content-addressed evidence. Test-account headers live in the local SQLite database, whose file permissions are restricted to the current user; they are not encrypted in a separate vault. Renderer queries return only account names/header names/configuration status. Host-injected values are redacted from captured HTTP responses and regression logs.

Runs freeze the snapshot, scope, lineup, limits, and DNA version. Start requests are idempotent. A single queue executes runs; pause takes effect at a safe checkpoint. Cancellation stops workers, revokes their leases, and rejects late writes. Restart marks interrupted active work failed/cancelled and continues queued work. Live view and event replay use the same reducer. Evidence is checked against its hash when opened or exported. Test accounts cannot change while their project has active/queued work. Operator decisions preserve the original host verdict.

This build uses a new database name and does not migrate the earlier test-case prototype's `kestrel-qa.sqlite` file.

## Verification

```bash
npm run typecheck
npm run build
npm test                 # unit/protocol tests + real local HTTP integration
npm run test:isolated    # same suite with an in-process sample HTTP transport
npm run check:desktop    # real Electron UI + nine screenshots, isolated database
npm run test:live        # actual Claude and Codex CLI + MCP connectivity; uses model accounts
```

The isolated transport invokes the real sample request handler without opening a socket. It also executes the generated regression test files in Node subprocesses, first against defective behavior and then against repaired behavior. It is not a substitute for real TCP or desktop checks. Live-provider checks are a separate explicit command so normal tests never consume model usage.

Validation in the restricted development session on 2026-10-27:

- Typecheck and production build passed.
- 54 isolated tests passed, covering the five-phase sample, repaired regressions, debate revisions, cancellation/timeouts, pause/resume, orphan recovery, scope, redaction, import validation, API reviews, versioned DNA, paginated replay, and CLI protocol errors.
- The standard suite's two HTTP pipeline checks were blocked by `listen EPERM` on `127.0.0.1`; the remaining 52 tests passed.
- Both live-provider checks were blocked at gateway startup by the same port restriction, before model execution.
- Staging the app with Git failed because this session cannot create `.git/index.lock`; the continuation is not committed or pushed.
- Launching Electron exited with `SIGABRT` before a window opened. The automated desktop check hit the same abort. Desktop click-through and screenshots are still unverified.

Remaining acceptance checks on an unrestricted local session: run `npm test`, `npm run test:live`, and `npm run check:desktop`; launch the app; complete one offline Sample Shop audit; inspect/export evidence; exercise review/DNA decisions and account sign-in; capture all six screens. Packaging and code signing are not configured.

## Source layout

```text
resources/       sample shop and stdio MCP bridge
src/shared/      domain, questionnaire, verdicts, lifecycle, event fold, IPC
src/main/        orchestration, store, tools, verification, imports, accounts, runtimes
src/preload/     narrow query/command/event bridge
src/renderer/    React screens and custom SVG icons
tests/           integration, API, tool, runtime fixtures, opt-in live-provider checks
```
