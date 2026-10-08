# Jev decision layer

This fork retains Nanobrowser's generative Planner and Navigator. The optional Jev layer evaluates their proposed actions, checks completion, routes tasks between configured models, and can experimentally select from a bounded set of browser actions. It is disabled by default.

Phase 1 (`jev-v0.2.1-alpha.1`, extension version 0.2.1) activates action evaluation and completion verification. Phase 2 (`jev-v0.2.2-alpha.1`, version 0.2.2) additionally activates model routing. Phase 3 (`jev-v0.2.3-alpha.1`, version 0.2.3) additionally activates experimental System-1 selection. Settings and adapter interfaces may already appear in earlier packages, but routing and experimental controls affect execution only in their corresponding phase builds. Install the latest phase to use every feature described below.

## Install a prerelease

1. Download the extension ZIP and `SHA256SUMS` from [this fork's releases](https://github.com/yuxiaoli/nanobrowser/releases).
2. Verify the ZIP's SHA-256 checksum if desired, then extract it into a persistent directory. The directory containing `manifest.json` is the extension root.
3. Open `chrome://extensions/` (or `edge://extensions/`), enable Developer mode, choose **Load unpacked**, and select that directory.
4. Open Nanobrowser's settings and configure your normal Navigator and Planner LLM providers.

The Chrome Web Store link in the upstream README installs upstream Nanobrowser; it does not install this fork. Updates to this unpacked extension require replacing the extracted files and reloading the extension.

## Configure Jev

Open the **Jev** tab in settings and use **Save settings** after editing.

| Setting               | Default      | Behavior                                                                |
| --------------------- | ------------ | ----------------------------------------------------------------------- |
| Enable Jev            | Off          | Off uses the compatibility no-op path.                                  |
| TypeSafe API key      | Empty        | Your own key, saved in Chrome local storage.                            |
| Model                 | `jev-latest` | Model sent to TypeSafe's System One API.                                |
| Total timeout         | 10,000 ms    | Total per-decision budget, including bounded retries.                   |
| Proceed confidence    | 0.8          | Minimum confidence for approving an action.                             |
| Completion confidence | 0.9          | Minimum confidence for accepting completion.                            |
| Selection confidence  | 0.8          | Minimum confidence for experimental candidate selection.                |
| Model routing         | Off          | Chooses fast/capable models from your existing provider configurations. |
| Fast / capable model  | Unset        | Unset choices retain the existing configured model.                     |
| Experimental System-1 | Off          | Selects bounded candidates with generative Navigator fallback.          |

Approval, completion, and candidate selection require both the API-reported confidence and the selected-answer probability to meet the configured threshold. These defaults are initial engineering choices; they have not been calibrated against live browser tasks. Jev does not replace your LLM provider configuration. Missing or invalid API configuration must be corrected before enabled Jev decisions can run.

## What to expect

Before a browser action, Jev may approve it, request reconsideration by Navigator, or pause for explicit confirmation. Approve/reject applies to the displayed action and current task/state; resuming the task does not grant approval. A changed state or restarted background worker invalidates pending approvals.

Before accepting a completion claim, the decision engine checks available task evidence. Incomplete work returns to Navigator. Insufficient evidence allows a bounded read-only verification step; unresolved evidence is shown as needing verification. Login and clarification handoffs remain distinct from completed user tasks.

Routing evaluates task complexity once at task start. Experimental System-1 is suited to existing DOM candidates such as clicks, scrolling, dropdowns, and tab actions. Free text, complex reasoning, low confidence, and stale targets fall back to generative Navigator.

Turning Jev off returns to the original generative execution path. With Jev enabled, exhausted API errors fail through Nanobrowser's task error flow; network failure does not implicitly approve an action. Cancel stops in-flight decisions. Existing safety prompts and URL restrictions remain in place. This release does not add a separate deterministic sensitive-action policy.

## Privacy and API contract

The first release calls [TypeSafe's documented API](https://docs.typesafe.ai/api) directly at `https://api.typesafe.ai/v1/systemone`. It sends the task, relevant redacted page text/state, proposed action parameters, and applicable evidence. Passwords, common token/secret patterns, cookies, sensitive input values, and URL query values are removed, and text is bounded. Automated redaction cannot guarantee that arbitrary prose contains no personal information; use tasks and pages whose remaining contents may be sent to your configured provider.

Chrome local storage follows the existing provider-key convention and is not an encrypted credential vault. No shared service key is bundled. Decisions and diagnostic records avoid credentials and raw API bodies. A server-side authenticated proxy is a future deployment option rather than a component of this direct-call prerelease.

## Development and validation

Use Node 24 LTS and the package-pinned pnpm 10.34.6. Run `pnpm install --frozen-lockfile`, `pnpm test`, `pnpm type-check`, `pnpm exec eslint . --ext .ts,.tsx`, `pnpm build`, and `pnpm zip`. ZIPs appear in `dist-zip/`; unpacked output is `dist/`.

The automated fixture report and its limitations are documented in [evaluation methodology](jev-evaluation.md). Offline acceptance does not demonstrate TypeSafe connectivity, live task accuracy, or improved cost/latency. See [the implementation plan](../context/PLAN.md) for the remaining online acceptance requirements.
