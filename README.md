# AI Coding Review

> Evidence-driven code review: prepare the requirements, review implementation and counter-evidence, then submit one explicit human conclusion.

[![VS Marketplace Version](https://img.shields.io/visual-studio-marketplace/v/changjian-wang.ai-coding-review?label=Marketplace&color=blue)](https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review)
[![Installs](https://img.shields.io/visual-studio-marketplace/i/changjian-wang.ai-coding-review)](https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review)
[![Rating](https://img.shields.io/visual-studio-marketplace/r/changjian-wang.ai-coding-review)](https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review)

VS Code extension · powered by the GitHub CLI and Copilot models

English | [简体中文](README.zh-CN.md)

<img src="docs/images/workbench-en.png" width="820" alt="AI Coding Review Workbench (English)" />

<p><em>Live language switch preview (English ↔ 中文):</em></p>

<img src="docs/images/workbench-zh.png" width="820" alt="AI Coding Review Workbench (Chinese)" />

## Review vNext

This describes the source-built workflow; the Marketplace version may differ. The screenshots above show the earlier interface.

### Prepare

- Choose a PR, current-branch changes against an explicit base, the complete committed branch snapshot, or local source files.
- Paste requirements, read UTF-8 Markdown/TXT, import a GitHub issue/PR description, or read a direct HTTPS text link. Each source is limited to 64,000 characters; selected sources total at most 128,000.
- Inspect the full requirement text and original source versions. Human additions remain verbatim; AI-derived checks are not new acceptance rules.
- Revise requirements in place, or explicitly exclude one with a reason. Confirm applicability once when starting. Without requirements, review is technical only and requirement consistency remains unreviewed.

### Review

- One workbench contains source/full-file Diff, business chains, findings and their evidence. Related material is distinguished from whole-file review targets; there is no separate scope dialog.
- One action reviews the selected roots and runs cross-file discovery plus a separate counter-evidence/business-judgment pass. Every unresolved candidate receives an explicit premise classification.
- Previously confirmed issues must be re-verified, not silently forgotten when a rerun omits them. Disproved candidates and reasonable trade-offs remain traceable.
- Fix proposals retain explicit apply/undo. Applying a patch invalidates review evidence; it does not prove a requirement is fulfilled. Translation, explanation, notes and document tools remain available.
- Cancellation preserves valid partial results. A retry reuses completed roots only when the requirements, repository snapshot and evidence fingerprints still match.

### Conclude

- One preview combines the report, reviewer statement and inline comments. Copy and save use that same content.
- **Approve** requires complete/current necessary review, disposition of actionable defects, no unresolved critical conflicts/premises, and one final human confirmation.
- **Comment / Request Changes** can submit valid partial feedback; they do not imply approval or resolve critical unknowns.
- PR reviews always bind to an explicit commit. PR head, repository evidence and preview content are checked again after confirmation; a late response never approves a different snapshot.
- Feedback outside commentable PR diff lines is included in the review body rather than sent as an invalid inline comment. Local-source conclusions stay local.

Visible-line progress is an auxiliary reading signal, never proof of understanding or an approval gate. Noncritical unknowns and ordinary context-budget notices do not automatically block approval. Missing necessary analysis, truncated primary source, stale evidence and unresolved critical premises do.

## Boundaries and privacy

- Requirements and their immutable original snapshots are stored locally in VS Code `workspaceState`. Selected material is sent to the chosen Copilot model for understanding/review; it is not automatically posted to GitHub.
- Direct links do not use browser cookies or site credentials and do not follow redirects. HTML pages can be pasted as text instead.
- Imported sources are snapshots, not continuously monitored documents. Re-read/import a changed source to create a new version.
- Pinned PR/branch review requires the Git root, matching HEAD and a clean workspace. Commit/stash and refresh, or choose local source review. Branch comparison itself does not switch branches or auto-stash.
- Repository context and model inputs are bounded. Coverage limits and excluded non-text resources are reported; omitted primary source is never treated as completely reviewed.
- Citation validation proves source/version/line correspondence, not semantic correctness. Model agreement is not independent proof, and source review does not mean tests were executed.
- The extension does not merge PRs or control GitHub branch-protection rules. A posted approval remains a human decision.
- Request forecasts and `countTokens` totals are local estimates, not provider billing.

## Language (bilingual)

AI Coding Review is fully bilingual (English / 简体中文), **English by default**.

- `codereview.language` drives the **whole experience** — both the extension UI (status bar, prompts, webview panels) and all LLM output (findings, fix proposals, explanations, global conclusions).
  - `en` (default): everything in English
  - `zh-CN`: everything in Simplified Chinese
  - `auto`: follow the VS Code display language
- Switching the setting takes effect **live** — the status bar and any open webview panels re-render immediately, no reload needed.
- Confirmed requirements, original sources and saved responses retain their original text. Switching language controls UI labels and subsequent generation; a background translation does not silently rewrite an approved preview.
- Command titles in the Command Palette follow the **VS Code display language** (a platform limitation for static contribution points), localized via `package.nls`.

## Commands and settings

### Commands

| Command | Description |
|---------|-------------|
| `codereview.openOrStart` | Open or start a review (status-bar entry) |
| `codereview.openInNewWindow` | Open the review workbench in a separate window |
| `codereview.startReview` | Pick a scope and start a review |
| `codereview.openWorkbench` | Open the review workbench |
| `codereview.analyzeFile` | Analyze repository behavior rooted at the current file |
| `codereview.globalAnalysis` | Review or continue the current scope |
| `codereview.showGlobalReport` | Open the unified conclusion page |
| `codereview.submitConclusion` | Open the conclusion preview; publishing is explicit |
| `codereview.jumpToNextUnseen` | Jump to the next unseen line |
| `codereview.pickModel` | Select the analysis model |
| `codereview.pickLanguage` | Switch the experience language (UI + LLM output) |

### Settings

| Setting | Default | Description |
|---------|---------|-------------|
| `codereview.language` | `en` | Language for the whole experience (UI + LLM output): `en` / `zh-CN` / `auto` |
| `codereview.focusedWorkbench` | `false` | When opening the workbench, hide the side bar / activity bar so it takes over the main editor area; restored on close |
| `codereview.repositoryAwareAnalysis` | `auto` | Build related repository context; `off` limits the file pass, not the necessary global review |
| `codereview.repositoryContextTokenBudget` | `28000` | Maximum estimated repository-context input tokens; lower-value related excerpts are removed first |

## Architecture

```text
src/
  extension.ts          activation entry, command registration, orchestration, gate
  i18n/                 language resolver + English/Chinese message catalogs
  gh/                   GitHub CLI wrapper (auth / pr view / pr diff / write back review)
  scope/                review scopes: PR / branch diff / working tree / file selection + tree-picker webview
  review/               versioned requirements, run coordinator, gates, source access and persistence
  ai/                   model selection + file-level / global analysis + fix proposals + language directive
  ui/                   three-stage review center, embedded source, document/fix tools and report composition
```

## Persistence

- `workspaceState` (local), isolated by repository directory and scope/snapshot. Same-named folders do not share requirement material.
- Applied-fix snapshots are persisted, so "undo fix" and "locate" still work after a reload.
- Code and requirement changes invalidate result/approval evidence. Old approvals, baselines and disposition reasons are history, not exemptions for a new context; reading progress and annotations are preserved separately.
- Note: `workspaceState` **does not follow your GitHub account and is not cross-device**; cross-device capability is reserved via the `ReviewStore` interface for a future remote implementation.

## Model and language

- Lists the models currently authorized for Copilot via the VS Code Language Model API, supports `Auto`, and remembers the choice per workspace.
- `codereview.language` controls the language of the whole experience (UI + all LLM output); see [Language](#language-bilingual) above.

## Development and packaging

```bash
npm install
npm run compile            # or npm run watch; press F5 to launch the Extension Development Host
npm test                   # run the unit tests (vitest)
npm run package            # production build (esbuild --production)
npx @vscode/vsce package   # produce a .vsix
```

PR scope and writing back to a PR require the GitHub CLI installed and logged in: `gh auth login`.

## Roadmap

- [ ] Cross-device / account-following review progress (a remote `ReviewStore` implementation).
