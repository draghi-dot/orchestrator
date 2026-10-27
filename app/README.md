# Kestrel QA

Desktop app (Electron) for agent-run QA. Agents execute test cases; deterministic code decides pass or fail from recorded evidence; every step lands in a durable, replayable event log.

Built from the patterns in `../kestrel-qa-reference-2026-10-27/` (run contract, state machine, event bus, one UI fold, evidence store, operator commands), renamed to QA vocabulary at the domain boundary.

## Run it

```bash
npm install
npm run dev        # dev mode with hot reload
npm run build && npm start   # production build
npm test           # 34 tests: lifecycle, idempotency, replay, cancellation, policy, omp adapter
npm run typecheck
```

On first launch the app seeds a **Demo Shop** project. It serves a tiny shop on `http://127.0.0.1:4870` with one planted defect: `SAVE20` takes 25% off instead of 20%. Start a run, and the `checkout-discount-20` case fails with `expected total == 96 · actual total == 90`.

Data lives in Electron's `userData` folder (`~/Library/Application Support/kestrel-qa/` on macOS): `kestrel-qa.sqlite`, `evidence/<sha256>`, `agent-settings.json`.

## Agents

| Adapter | What it does |
| --- | --- |
| **Scripted** | No model. Follows each step's literal request. Always available, used by the tests. |
| **oh-my-pi** | Spawns `omp --mode rpc` for each attempt ([oh-my-pi](https://github.com/can1357/oh-my-pi)). Built-in tools are off (`--no-tools`). The app registers QA host tools with `set_host_tools`, so the model can act only through `qa_step`, `qa_http_request`, `qa_note`, and `qa_report_blocked`. |

To use oh-my-pi:

```bash
brew install can1357/tap/omp      # or: curl -fsSL https://omp.sh/install | sh
omp                               # sign in to a model provider once (/login)
```

Then choose oh-my-pi on the **Agent** screen or in the New run panel. A model, and optional built-in tools such as `browser`, are set there. Traffic from built-in tools is not checked against the environment's allowed origins, and the UI warns about this.

## Rules the code enforces

- **Immutable run contract.** The suite version, build, environment snapshot, agent profile, and initiator are hashed at start. Reusing an idempotency key with a different contract is rejected.
- **Explicit lifecycle.** `queued → running ⇄ pause_requested → paused`, `cancel_requested → cancelled`, `completed`, `failed`. Illegal transitions throw. A cancel request latches. A failed assertion still *completes* the run; the run is marked `failed` only when orchestration breaks.
- **Commands record intent.** Pause and cancel return `*_requested`. The worker acknowledges at a safe boundary in a separate event. If it does not stop within the grace period, its lease generation is revoked, the run is cancelled with `force_stopped`, and any late write is rejected.
- **Code is the authority.** An assertion without an observation is `blocked`, never `passed`. An empty, malformed, crashed, or timed-out agent produces an `error`.
- **Tool policy.** Requests are limited to allowed origins. Mutating methods require environment permission. Credential headers are refused. Each tool call ID executes once.
- **Evidence.** Content-addressed blobs are re-hashed on every read. `set-cookie` and auth headers are redacted before storage.
- **One fold.** `src/shared/fold.ts` drives live, catch-up, and replay views. A test checks that live with duplicate delivery equals a cold replay at every playhead.
- **Restart recovery.** Runs left active by a previous process are marked failed, or cancelled if cancellation had been requested, and their leases are revoked.

## Layout

```
src/shared/      domain types, lifecycle tables, event registry, fold, assertions, IPC contract
src/main/        composition root (index.ts), SQLite store, evidence store, orchestrator,
                 tool belt, adapters/{scripted,omp}, API, demo app + seed
src/preload/     contextBridge: query / command / subscribe
src/renderer/    React UI: Runs, Run workspace (live + replay), Review, Projects, Agent
tests/           vitest suites + fake omp speaking the RPC protocol
```

## Not built yet (phases 3–4 from the reference README)

- Browser tool through host tools (screenshots, traces) with origin policy
- Real secret store (refs exist; nothing resolves them yet), per-environment leases, fixtures and cleanup
- Retries as new attempts from the UI, suite editing UI, worker pools, retention
- Packaging (`electron-builder`) and code signing
