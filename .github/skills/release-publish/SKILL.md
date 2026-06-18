---
description: |
  Use when: Cutting and shipping a new version of the AI Coding Review extension to the VS Code Marketplace AND publishing a matching GitHub release with the packaged `.vsix` attached; setting up or refreshing the publish credential (PAT); diagnosing a failed `vsce publish`
  Don't use when:
    - Writing extension code or fixing behavior (use vscode-extension-conventions)
    - Only building/compiling locally with no intent to publish (`npm run compile`)
    - Editing README prose unrelated to release
  Inputs: A committed, compiling change you want live on the Marketplace
  Outputs: A new published Marketplace version, a matching GitHub release tagged `vX.Y.Z` with the packaged `.vsix` attached, README badges auto-updating, the version-bump commit pushed
  Success criteria: `vsce publish` prints `Published changjian-wang.ai-coding-review vX.Y.Z`, `git push` syncs the bump commit, and `gh release view vX.Y.Z` shows the release with the `ai-coding-review-X.Y.Z.vsix` asset
---

# Release & Publish Skill

Ships **AI Coding Review** to the VS Code Marketplace **and** cuts a matching
GitHub release with the packaged `.vsix` attached. Mirrors
[`docs/RELEASING.md`](../../../docs/RELEASING.md) but is the agent-facing,
step-driven version.

## Identity (do not change casually)

| Thing | Value | Source |
|------|-------|--------|
| Marketplace item id | `changjian-wang.ai-coding-review` | `publisher` + `name` in `package.json` |
| Publisher | `changjian-wang` | marketplace.visualstudio.com/manage |
| Store title | `AI Coding Review` | `displayName` |
| Repo | `changjian-wang/ai-coding-review` (public) | GitHub |

> The bare id `codereview` is taken on the Marketplace, so `name` is `ai-coding-review`. **Changing `name` or `publisher` rewrites the install id AND every README badge/link `itemName`** (`https://img.shields.io/visual-studio-marketplace/.../changjian-wang.ai-coding-review`). If you must change it, grep both READMEs for the old `itemName` and fix every occurrence or the badges/links die. If `name` ever regresses to `codereview`, `vsce` fails with `ERROR The extension 'codereview' already exists`.

## Publish a new version (the happy path)

Ship the **same** artifact to both the Marketplace and a GitHub release: package
once, then publish that exact `.vsix` and attach it to the release. Work the steps
in order; the callout under each step is the constraint that bites there.

### 1. Compile

```bash
# compile must pass (tsc --noEmit + esbuild). compile does NOT produce a vsix.
npm run compile
```

> `dist/extension.js is large (510 KB)` is a *warning*, not an error — it does not block publishing.

### 2. Bump the version

Your code changes should already be committed before starting this workflow. First, edit
`package.json` to the **new** version number (e.g. `0.1.3` → `0.1.4`), then create a single
new commit that contains **only** that version number change. This keeps the bump commit
clean and separate from feature work.

Only AFTER the bump is committed, obtain the new version by running
`node -p "require('./package.json').version"` and substitute that output for every
`<version>` placeholder in the commands below. Reading the version before editing
`package.json` would capture the OLD version and ship the wrong number everywhere.

> **Always bump first.** Republishing or re-tagging the same version fails — `vsce` rejects a duplicate version and `gh release create` rejects an existing tag. Reinstalling a same-numbered vsix also won't refresh.

### 3. Package once

```bash
# produces ai-coding-review-<version>.vsix — the artifact that ships to BOTH the
# Marketplace and the GitHub release, byte-identical.
npx --yes @vscode/vsce package
```

> - **`vsce` is not a dependency** — always invoke via `npx --yes @vscode/vsce`.
> - **`.vscodeignore` excludes `docs/**` and `*.vsix`** — screenshots and stray local builds stay out of the package, so the packaged vsix never contains other vsix files.
> - **Attach this exact vsix in step 6** — do not rebuild between publish and release, or the Marketplace and GitHub ship different bytes.

### 4. Publish that exact package

```bash
# Confirm the artifact from step 3 still exists before publishing.
ls -lh ai-coding-review-<version>.vsix

# vsce stays logged in across this machine.
npx --yes @vscode/vsce publish --packagePath ai-coding-review-<version>.vsix
```

> **Verify the vsix exists first.** If `ai-coding-review-<version>.vsix` is missing (e.g. the agent session restarted), re-run step 3 to repackage — do NOT bump the version again.

> **A non-zero exit does NOT always mean the publish failed.** A network error or timeout can fire AFTER the Marketplace already accepted the version. Before retrying, check the publisher dashboard at https://marketplace.visualstudio.com/manage to see whether the version is live. If it is already live, treat this as a publish success and proceed to step 5 — do NOT re-run `vsce publish` for an already-published version.

> **README screenshots use absolute `raw.githubusercontent.com` URLs** — these only resolve on the Marketplace detail page because the repo is **public**; relative paths do NOT render there.

### 5. Push the bump commit

```bash
git push
```

> **If `git push` fails, diagnose before retrying.** Run `git rev-list --left-right --count origin/main...HEAD` to confirm local/remote state (more reliable than the sometimes-misleading CLI text). For an HTTP 400 on big PNGs, verify `http.postBuffer` is at least `524288000` — the default is 1 MB; this repo is set to 500 MB locally via `git config http.postBuffer 524288000`. For a rejected push, do NOT force-push — report the conflict to the user. Do not proceed to step 6 until the push is confirmed landed.

### 6. Cut the GitHub release

```bash
# Confirm the artifact from step 3 still exists before attaching it.
ls -lh ai-coding-review-<version>.vsix

# --target main tags the just-pushed bump commit.
gh release create v<version> ai-coding-review-<version>.vsix \
  --target main \
  --title "v<version>" \
  --notes "<one-line summary of what shipped>"
```

> **Verify the vsix exists before attaching.** If `ai-coding-review-<version>.vsix` is missing and `vsce publish` already succeeded for this version, tell the user the vsix is lost and the GitHub release cannot be byte-identical with the published Marketplace build; do NOT re-run `vsce publish`. If publish has not yet run, re-run step 3 to repackage.

> **`gh release create` uses a DIFFERENT credential than publishing** — it needs the `gh` CLI logged in (`gh auth login`), the GitHub token, NOT the Azure DevOps PAT that `vsce` uses. A working `vsce publish` says nothing about whether `gh` is authed. If the tag `v<version>` already exists, re-attach the vsix with `gh release upload v<version> ai-coding-review-<version>.vsix --clobber` instead of recreating the release.

The README shows **live Marketplace badges** (version/installs/rating) — there is no
hand-written version number to update; badges self-update once the new version is live
(a few minutes).

## One-time credential setup (already done; redo when the PAT lapses)

1. **Azure DevOps PAT** — the publish credential (NOT a GitHub token):
   - org `changjian-wang` at https://dev.azure.com (reach it via `https://aex.dev.azure.com/me`; the bare `dev.azure.com` may bounce to the marketing page)
   - Scope: **Show all scopes → Marketplace → Manage**
   - **Expires 2026-07-07.** When it lapses, regenerate and re-login.
2. `npx --yes @vscode/vsce login changjian-wang` — paste the PAT into the terminal.
   **Never** route the PAT through chat / the question tool; the user types it directly.

> **`vsce login` 401 / verify-failed** → the PAT scope is wrong (needs Marketplace → Manage) or the token was mis-copied.

## Verify after publishing

```bash
# itemName page should become 200 within a few minutes
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review"

# the GitHub release exists and carries the vsix asset
gh release view v<version>           # shows title, notes, and the .vsix under Assets
```

> **Confirm the asset is attached.** After `gh release view`, check that `ai-coding-review-<version>.vsix` appears under Assets — the title and notes rendering does not guarantee the asset uploaded. If the asset is absent, run `gh release upload v<version> ai-coding-review-<version>.vsix --clobber` to attach it.

> If the curl check still returns a non-200 status after 10 minutes, report the status code to the user and suggest checking the publisher dashboard at https://marketplace.visualstudio.com/manage for propagation errors or moderation holds. Do not re-run `vsce publish`.

## Partial-failure recovery

If `vsce publish` already succeeded for `v<version>` but the GitHub release step did not finish, do NOT bump the version again and do NOT re-run `vsce publish`. Work this decision table top to bottom:

1. **Does the vsix exist locally?** Run `ls -lh ai-coding-review-<version>.vsix`. If it is missing, re-run step 3 (package only — do NOT bump or re-publish).
2. **Run `gh release view v<version>`.** If the command fails (no release exists), run the full `gh release create` command from step 6.
3. **Release exists but has no vsix asset?** Run `gh release upload v<version> ai-coding-review-<version>.vsix --clobber`.
4. **Release exists and the asset is present?** Verify and stop.
