# Jev evaluation methodology

## Offline fixtures

`docs/evaluation/jev-fixtures.json` defines 20 fixed synthetic browser tasks, each in English and Chinese, with task state and expected control outcomes. The evaluation runner uses actual decision-engine implementations and deterministic mocked TypeSafe responses. No external API is contacted, no browser task is executed, and no real user data is used.

The baseline is `NoopDecisionEngine` (Jev disabled). The enhanced path is `JevDecisionEngine` with an injected mock transport. The fixture's supplied model decision is an input; it is not a prediction produced by Jev. Passing a fixture proves that the adapter, thresholds, and control outcome preserve that response. It does not establish action judgment quality or task success.

Reports identify transport calls, adapter elapsed time, and observed outcomes. Mock elapsed time is not network or browser latency. Synthetic usage is not billable provider usage. Live task success, incorrect actions, latency, and estimated cost remain `null` until measured. Tests separately exercise malformed replies, failure, cancellation, privacy redaction, timeout, confirmation lifecycle, and executor integration.

## Actual extension checks with mock providers

After building, run `pnpm exec node scripts/verify-extension.mjs --zip=path/to/nanobrowser-jev.zip --all-phases` against a phase-3 ZIP. The script extracts into an isolated directory, records the ZIP hash, loads the real extension in a fresh headless Chrome profile, and exercises its options, service worker, and DOM executor against a local synthetic page. Jev and LLM transports are mocked in memory; external DNS is blocked. It requires a local Chrome executable: the default is the standard Windows installation path; override it with `--browser=/path/to/chrome` or `JEV_TEST_BROWSER`.

For earlier phase packages omit `--all-phases` to run MVP checks. The report defaults to `.git/jev-browser-report.json`; choose `--report=path/to/report.json` to preserve separate runs. A passing browser report establishes the packaged extension's mocked control flow, not live provider connectivity or representative-task accuracy.

## Online paired protocol (pending authorization)

Use the same 20 task definitions, controlled test pages, fixed initial browser state, provider/model configurations, and maximum step budget. For each task run baseline and enhanced modes in randomized order; repeat each pair at least three times. Start from a fresh session per run. Form interactions must use local or dedicated sandbox pages, never live purchases or messages.

Record task ID, language, mode, model configurations, attempt, externally verified task success, incorrect executed actions, wall-clock duration, LLM/Jev request counts, input/output tokens, cancellations/errors, and explicit confirmations. An evaluator independent of the agent checks the task's acceptance statement against the final page/result. Report paired differences and variation, including failed runs. Do not discard failures or compare unlike starting states.

Estimated cost uses recorded token usage multiplied by prices explicitly supplied for the tested models, plus documented request fees if applicable. Report unknown cost when pricing or usage is unavailable. Never infer a performance improvement merely because a decision layer was added.

## Current status

The initial offline adapter run passed **40/40 control checks**: all 20 tasks in English and Chinese. It made **zero external API calls**. The generated JSON report is attached to each prerelease; its per-decision values describe mock transport behavior and synthetic token usage. Later builds regenerate the report rather than relying on this initial count.

The **published phase-3 extension ZIP** (`0.2.3`) passed **16/16 actual-browser checks** in GitHub Actions using isolated Chrome `154.0.8037.97`, with real extension pages, its service worker, and DOM execution. The checks cover settings, disabled-path compatibility, action/completion decisions, reconsideration bounds, approval/rejection/cancellation, stale approval, resume, all four model-routing strategies, and experimental selection/fallback. Jev and LLM transports were mocked, and external DNS was blocked. The [saved CI browser report](jev-browser-verification.json) identifies the exact [published ZIP](https://github.com/yuxiaoli/nanobrowser/releases/download/jev-v0.2.3-alpha.1/nanobrowser-jev.zip) by SHA-256 `09cdde04fd874184dd7afb6f17b4c6a1c0f4edf8c0b5698360131acc8b33e3c4`. Its digest matches both GitHub's asset digest and the attached `SHA256SUMS`. See [the release acceptance record](../context/RELEASES.md) for source and CI identity.

Offline report generation, repository validation, and packaged-extension checks with mocked providers are part of this prerelease. Live TypeSafe connectivity and paired browser evaluation have not been run. The original full live end-to-end acceptance remains outstanding until those online runs are completed.
