# Jev prerelease acceptance record

The source fork is [yuxiaoli/nanobrowser](https://github.com/yuxiaoli/nanobrowser). `master` tracks upstream; implementation is on `develop`.

## Phase 1 — MVP

- Extension version: `0.2.1`; tag: `jev-v0.2.1-alpha.1`.
- Source commit: `2e5bf41e384d8f966e722ba97c44b12868de9cf0`.
- [Installable prerelease and assets](https://github.com/yuxiaoli/nanobrowser/releases/tag/jev-v0.2.1-alpha.1).
- [CI run](https://github.com/yuxiaoli/nanobrowser/actions/runs/37800530954): unit tests, type check, lint, 40/40 offline fixture controls, build, ZIP integrity, artifact upload, and publication all passed.
- Downloaded published ZIP: manifest version `0.2.1`, MV3 worker present; SHA-256 `8f16e2f13e869d30df2630dcffa119c1754cab537ac4c22191ccbee34901418a` matches GitHub's published asset digest.
- Published offline report identifies the same source commit, 20 bilingual tasks / 40 control checks, and zero external API calls.

### Browser exercise

Eight checks passed in an isolated Chrome `154.0.8037.98` profile using actual extension pages, service worker, and DOM action execution with mocked Jev and LLM transports: settings persistence, disabled-path compatibility, approval/completion, reconsideration bounds, explicit confirmation, rejection, cancellation, and one-refresh completion verification.

This initial browser run used a built phase-1 working-tree snapshot before the final completion-cache and history-replay fixes. It is not an exact-release browser acceptance for commit `2e5bf41e384d8f966e722ba97c44b12868de9cf0`. The released commit passed the full automated CI checks above; a browser rerun on the final build is tracked separately. No live provider calls were made.

## Phase 2 — Model routing

- Extension version: `0.2.2`; tag: `jev-v0.2.2-alpha.1`.
- Source commit: `a5befcf4a1df655b46617ca1e97fbcd37b08ea32`.
- [Installable prerelease and assets](https://github.com/yuxiaoli/nanobrowser/releases/tag/jev-v0.2.2-alpha.1).
- [CI run](https://github.com/yuxiaoli/nanobrowser/actions/runs/37801290049): validation, packaging, ZIP integrity, and publication all passed.
- Downloaded published ZIP: manifest `0.2.2`, MV3 worker present; SHA-256 `47471d0a17142cfdd0419af0b9d0f69f2bbe0a9c52c59729dda17940169a1e79` matches GitHub's published asset digest.
- Published report identifies extension `0.2.2` and the same source commit: 40/40 mocked control checks and zero external API calls.

## Remaining acceptance

The local phase-3 ZIP (`0.2.3`) passed 16/16 actual-extension checks in Chrome `154.0.8037.98` with mocked Jev/LLM transports and external DNS blocked. Its SHA-256 is `cdfddf19c14594ebeec76ecf67b774dff9df8f8897a6fab92ac5143765bea096`; [the saved report](../docs/jev-browser-verification.json) binds the checks to that local artifact. This rerun includes the corrected completion/approval behavior plus routing and experimental selection.

The phase-3 published release record will be appended after CI publication and asset verification. Live TypeSafe connectivity and paired browser task performance are outside the authorized offline implementation scope and remain unmeasured. Offline fixture checks validate supplied mocked responses; they are not task-success measurements.
