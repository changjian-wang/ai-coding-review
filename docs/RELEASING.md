# Releasing

How to cut and publish a new version of **AI Coding Review** to the VS Code
Marketplace, and cut a matching GitHub release with the packaged `.vsix`
attached.

## Identity (do not change casually)

| Thing | Value | Where |
|------|-------|-------|
| Marketplace item | `changjian-wang.ai-coding-review` | derived from `publisher` + `name` in `package.json` |
| Publisher | `changjian-wang` | https://marketplace.visualstudio.com/manage |
| Store title | `AI Coding Review` | `displayName` in `package.json` |
| Repo | `changjian-wang/ai-coding-review` (public) | GitHub |

> The bare id `codereview` is taken on the Marketplace, so the extension id
> (`name`) is `ai-coding-review`. Changing `name` or `publisher`
> breaks the README badge/link `itemName` and the install id; avoid it.

## One-time setup (already done, here for reference)

1. **Azure DevOps PAT** (the publish credential, not a GitHub token):
   - Org `changjian-wang` at https://dev.azure.com
   - Scope: **Marketplace → Manage**
   - PAT **expires 2026-07-07** — regenerate and re-login when it lapses.
2. **Publisher** `changjian-wang` created at https://marketplace.visualstudio.com/manage
3. `npx --yes @vscode/vsce login changjian-wang` (paste the PAT into the terminal — never share it).

## Publish a new version

Ship the **same** artifact to both the Marketplace and a GitHub release: package
once, then publish that exact `.vsix` and attach it to the release.

```sh
# 1. sanity check: types + bundle compile
npm run compile

# 2. bump the version in package.json (e.g. 0.1.3 -> 0.1.4) and commit the
#    behavior change + bump together.

# 3. package ONCE -> ai-coding-review-<version>.vsix (shipped to BOTH targets).
npx --yes @vscode/vsce package

# 4. publish that exact package.
npx --yes @vscode/vsce publish --packagePath ai-coding-review-<version>.vsix

# 5. sync the version-bump commit back to GitHub.
git push

# 6. cut the GitHub release and attach the vsix (uses `gh` auth, not the PAT).
gh release create v<version> ai-coding-review-<version>.vsix \
  --target main --title "v<version>" --notes "<one-line summary>"
```

Replace `<version>` with the value now in `package.json`. The README shows live
Marketplace badges (version / installs / rating), so there is **no hand-written
version number to update** — the badges self-update once the new version is live.

## Notes / gotchas

- `dist/extension.js is large (510 KB)` during packaging is a **warning, not an
  error** — it does not block publishing.
- `docs/**` and `*.vsix` are excluded from the package via `.vscodeignore`; the
  README screenshots load from absolute `raw.githubusercontent.com` URLs (works
  only because the repo is public).
- Pushing commits that add large PNGs can hit `HTTP 400` if `http.postBuffer` is
  the 1 MB default; this repo is configured to 500 MB locally.
- If `vsce login` fails with 401, the PAT scope is wrong (needs Marketplace →
  Manage) or the token was mis-copied.
- The **GitHub release uses a different credential than publishing**: `gh release
  create` needs `gh auth login` (a GitHub token), not the Azure DevOps PAT that
  `vsce` uses. Verify with `gh release view v<version>` (shows the `.vsix` asset).
- `gh release create` fails if the tag `v<version>` already exists — bump first,
  or re-attach with `gh release upload v<version> <file> --clobber`.
