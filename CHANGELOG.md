# Changelog

All notable changes to the **AI Coding Review** extension are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.4.0] - 2026-07-07

### Added

- Manual PR review comments as a **GitHub-native pending review**: select one or
  more lines, add a comment, and submit them together with the verdict as a single
  review (`Approve` / `Request Changes` / `Comment`).
- AI-assisted drafting: expand a brief reviewer point into a polished review comment.
- Finding dispositions marked as *commented* now flow into the same pending review
  instead of being posted immediately.

### Fixed

- Document panel no longer freezes after repeated source/reading view or file
  switches, including while Markdown auto-translation is running (source-render RAF
  cancellation plus translation de-dupe/cancellation on switch).

## [0.3.0] - 2026-07-01

### Added

- Automatic per-repo GitHub CLI account selection — no more manual `gh auth switch`
  between personal and enterprise repos; the accessible account is resolved and used
  per call.
- Side-by-side CN/EN bilingual reading view for documents: whole-document streamed
  translation with the original preserved on the left.

## [0.2.0] - 2026-06-30

### Added

- PR list picker with double-click-to-review.
- Document prewarm and auto-stash when switching on a dirty working tree.

### Changed

- Auxiliary-window-safe inline model / branch / scope switches.
- Collapsible overall-review section.
- Faster branch switching: no full status scan, patch-based label update.
- 3:7 layout fixes.

## [0.1.5] - 2026-06-18

### Changed

- Packaging and Marketplace metadata iteration (no functional changes recorded).

## [0.1.4] - 2026-06-18

### Changed

- Packaging and Marketplace metadata iteration (no functional changes recorded).

## [0.1.3] - 2026-06-18

### Added

- Activity Bar entry point with a launcher view — open/start a review, open in a new
  window, pick the model or language.

### Changed

- Minimum VS Code engine lowered to **1.90** (the floor where the Language Model API
  was finalized), improving Marketplace discoverability.
- Activity Bar icon refresh.
- `.github/` excluded from the packaged extension.

## [0.1.2] - 2026-06-17

### Changed

- Packaging and Marketplace metadata iteration (no functional changes recorded).

## [0.1.1] - 2026-06-17

### Changed

- Packaging and Marketplace metadata iteration (no functional changes recorded).

## [0.1.0] - 2026-06-16

### Added

- Initial release: distrust-driven code review with per-line coverage gate,
  file-level and cross-file AI analysis, per-finding disposition
  (fix / comment / ignore), and conclusion write-back for PR scopes via the GitHub CLI.

[Unreleased]: https://github.com/changjian-wang/ai-coding-review/compare/v0.4.0...HEAD
[0.4.0]: https://github.com/changjian-wang/ai-coding-review/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/changjian-wang/ai-coding-review/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/changjian-wang/ai-coding-review/compare/v0.1.5...v0.2.0
[0.1.5]: https://github.com/changjian-wang/ai-coding-review/compare/v0.1.4...v0.1.5
[0.1.4]: https://github.com/changjian-wang/ai-coding-review/compare/v0.1.3...v0.1.4
[0.1.3]: https://github.com/changjian-wang/ai-coding-review/compare/v0.1.2...v0.1.3
[0.1.2]: https://github.com/changjian-wang/ai-coding-review/compare/v0.1.1...v0.1.2
[0.1.1]: https://github.com/changjian-wang/ai-coding-review/compare/v0.1.0...v0.1.1
[0.1.0]: https://github.com/changjian-wang/ai-coding-review/releases/tag/v0.1.0
