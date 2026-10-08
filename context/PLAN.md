# Nanobrowser × Jev implementation plan

## Agreed scope

Fork `nanobrowser/nanobrowser` into `yuxiaoli/nanobrowser`. Preserve `master` for upstream tracking and implement on `develop`. Keep Planner, Navigator, browser actions, provider configuration, and WXT packaging. Jev is an optional decision engine, never an OpenAI-compatible generative provider. Settings default to disabled.

The approved execution scope is offline validation and installable prereleases. No paid/live TypeSafe or LLM calls are authorized for this implementation. Live connectivity, browser task success, and online performance comparisons remain pending; this delivery must not claim they passed or that Jev improves performance.

Offline delivery is complete: all three phase prereleases are published, and the final published ZIP passed the actual-browser checks with mocked providers in CI. See [the release acceptance record](RELEASES.md) for tags, source commits, artifact hashes, and evidence; the remaining online acceptance below is still pending.

## Architecture and interfaces

Actual source lives under `src/background/agent/`. Add a `decision/` module with an injectable `DecisionEngine`, `JevDecisionEngine`, and `NoopDecisionEngine`. Inputs carry task identity, task text, relevant redacted browser state, execution outcomes, and an `AbortSignal`.

- Action evaluation returns `proceed`, `reconsider`, or `confirm` before action execution, including history replay and batches.
- Completion verification returns `complete`, `incomplete`, or `needs_verification`. It distinguishes successful completion from a handoff for login or clarification and covers both Navigator and Planner completion exits.
- Routing returns `fast`, `capable`, `planner`, or `confirm` and uses existing `ModelConfig` values.
- Experimental selection chooses an existing candidate ID or falls back. Arbitrary text and novel action parameters remain generative Navigator responsibilities.

Use the documented TypeSafe `POST https://api.typesafe.ai/v1/systemone` endpoint, strict response validation, bounded retries, cancellation, and a total default decision timeout of 10 seconds. Default thresholds are 0.8 for proceed/selection and 0.9 for completion. They are configurable initial values, not measured reliability guarantees.

The approved replacement safety choice preserves Nanobrowser's prompts and URL firewall without adding a deterministic sensitive-action gate. Confirmation requested by the decision engine must use explicit approve/reject messages bound to a task, action, and state; ordinary resume cannot approve an action.

## Incremental implementation

1. **MVP:** evaluate actual proposed actions, feed reconsideration back to Navigator, support explicit confirmation, verify completion with cached unchanged evidence, allow at most one read-only refresh when verification is needed, and stop unresolved decisions after bounded reconsideration.
2. **Optimization:** choose fast/capable configured models at task start, escalate uncertain tasks to Planner, collect redacted decisions/outcomes/timing/usage, and add 20 fixed bilingual offline fixtures plus a paired online evaluation protocol.
3. **Experimental:** enumerate valid DOM-derived actions; ask Jev to choose a candidate, revalidate its target, run the normal evaluation path, and fall back to Navigator on low confidence, stale targets, complex tasks, or missing candidates.

Expose settings in the existing options page: enable, API key/model, timeout/thresholds, optional routing models, and experimental selection. Direct requests are the first release approach. Store the user's key in Chrome local storage as existing providers do; never include it in the repository, package, telemetry, decisions, or errors. Strip passwords, tokens, cookies, sensitive form values, and URL query information; cap text before sending it.

## Validation and release acceptance

- Unit tests cover decisions, thresholds, malformed API replies, failure/timeout/cancellation, fallback, confirmation rejection/expiry, completion exits, routing, history replay, batches, and experimental candidates.
- Compare disabled and mocked decision paths using the same 20 synthetic bilingual task fixtures. Label reported timings as mock transport timings; leave live success, incorrect-action rate, latency, and costs unmeasured.
- Run the pinned pnpm 10.34.6 on Node 24 LTS: `pnpm test`, `pnpm type-check`, non-fixing ESLint, `pnpm build`, and `pnpm zip`. Do not commit generated outputs.
- CI validates PRs and `develop`, packages ZIPs, verifies ZIP/manifest structure, and uploads checksums and evaluation data. `jev-v*` tags create prereleases in the fork only.
- Load the unpacked artifact in Chrome where the browser environment permits it; verify options, mocked decisions, approval/rejection, cancellation, and completion. Report an unavailable extension-loading environment explicitly rather than substituting a manifest check for end-to-end verification.
- Document installation/configuration/privacy/limitations. Publish installable GitHub prereleases when validation passes and record release URLs.

## Remaining online acceptance

With later live-call authorization and configured provider keys, verify the actual TypeSafe response contract and run paired browser tasks with Jev disabled/enabled against the same page states and LLM models. Measure success, incorrect actions, calls, latency, token usage, and configured-price costs. The original full Definition of Done additionally requires this live end-to-end acceptance; offline prereleases do not prove it.
