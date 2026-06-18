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

> The bare id `codereview` is taken on the Marketplace, so `name` is `ai-coding-review`. **Changing `name` or `publisher` rewrites the install id AND every README badge/link `itemName`** (`https://img.shields.io/visual-studio-marketplace/.../changjian-wang.ai-coding-review`). If you must change it, grep both READMEs for the old `itemName` and fix every occurrence or the badges/links die.

## Publish a new version (the happy path)

Ship the **same** artifact to both the Marketplace and a GitHub release: package
once, then publish that exact `.vsix` and attach it to the release.

```bash
# 1. compile must pass (tsc --noEmit + esbuild). compile does NOT produce a vsix.
npm run compile

# 2. bump the version in package.json (e.g. 0.1.3 -> 0.1.4) and commit the
#    behavior change + bump together — one commit per release.

# 3. package ONCE — produces ai-coding-review-<version>.vsix (the artifact that
#    ships to BOTH the Marketplace and the GitHub release, byte-identical).
npx --yes @vscode/vsce package

# 4. publish that exact package (vsce stays logged in across this machine).
npx --yes @vscode/vsce publish --packagePath ai-coding-review-<version>.vsix

# 5. push the bump commit so GitHub and the Marketplace agree.
git push

# 6. tag the release on GitHub and attach the vsix. Uses the `gh` CLI auth
#    (GitHub), NOT the Azure DevOps PAT that vsce uses — two different creds.
#    --target main tags the just-pushed bump commit.
gh release create v<version> ai-coding-review-<version>.vsix \
  --target main \
  --title "v<version>" \
  --notes "<one-line summary of what shipped>"
```

Replace `<version>` with the value now in `package.json`. The README shows **live
Marketplace badges** (version/installs/rating) — there is no hand-written version
number to update; badges self-update once the new version is live (a few minutes).

## One-time credential setup (already done; redo when the PAT lapses)

1. **Azure DevOps PAT** — the publish credential (NOT a GitHub token):
   - org `changjian-wang` at https://dev.azure.com (reach it via `https://aex.dev.azure.com/me`; the bare `dev.azure.com` may bounce to the marketing page)
   - Scope: **Show all scopes → Marketplace → Manage**
   - **Expires 2026-07-07.** When it lapses, regenerate and re-login.
2. `npx --yes @vscode/vsce login changjian-wang` — paste the PAT into the terminal.
   **Never** route the PAT through chat / the question tool; the user types it directly.

## Gotchas (all observed in this repo)

- **`name` collision** → `ERROR The extension 'codereview' already exists`. Pick a hyphenated id and sync README `itemName`s.
- **`dist/extension.js is large (510 KB)`** is a *warning*, not an error — it does not block publishing.
- **Republishing the same version fails** — always bump first. Reinstalling a same-numbered vsix also won't refresh.
- **README screenshots use absolute `raw.githubusercontent.com` URLs** — these only resolve because the repo is **public**; relative paths do NOT render on the Marketplace detail page.
- **`.vscodeignore` excludes `docs/**` and `*.vsix`** — screenshots and stray local builds stay out of the package.
- **`git push` HTTP 400 on big PNGs**: default `http.postBuffer` is 1 MB; this repo is set to 500 MB locally (`git config http.postBuffer 524288000`). Verify a push really landed with `git rev-list --left-right --count origin/main...HEAD`, not the (sometimes misleading) CLI text.
- **`vsce login` 401 / verify-failed** → PAT scope is wrong (needs Marketplace → Manage) or the token was mis-copied.
- **`vsce` is not a dependency** — always invoke via `npx --yes @vscode/vsce`.
- **The GitHub release uses a DIFFERENT credential than publishing** — `gh release create` needs the `gh` CLI logged in (`gh auth login`), which is the GitHub token, NOT the Azure DevOps PAT that `vsce` uses. A working `vsce publish` says nothing about whether `gh` is authed.
- **`gh release create` fails if the tag `vX.Y.Z` already exists** — same root cause as "republishing the same version fails": always bump first. To re-attach a vsix to an existing release use `gh release upload vX.Y.Z <file> --clobber`.
- **Attach the vsix built in step 3** — do not rebuild between publish and release, or the Marketplace and GitHub ship different bytes. `.vscodeignore` excludes `*.vsix`, so the packaged vsix never contains other vsix files.

## Verify after publishing

```bash
# itemName page should become 200 within a few minutes
curl -s -o /dev/null -w "%{http_code}\n" \
  "https://marketplace.visualstudio.com/items?itemName=changjian-wang.ai-coding-review"

# the GitHub release exists and carries the vsix asset
gh release view v<version>           # shows title, notes, and the .vsix under Assets
```
