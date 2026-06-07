# Releasing

How to cut and publish a new version of **Code Review Gate** to the VS Code Marketplace.

## Identity (do not change casually)

| Thing | Value | Where |
|------|-------|-------|
| Marketplace item | `codereview-dev.code-review-gate` | derived from `publisher` + `name` in `package.json` |
| Publisher | `codereview-dev` | https://marketplace.visualstudio.com/manage |
| Store title | `Code Review Gate` | `displayName` in `package.json` |
| Repo | `changjian-wang/codereview` (public) | GitHub |

> The bare id `codereview` is already taken on the Marketplace — that is why the
> extension id (`name`) is `code-review-gate`. Changing `name` or `publisher`
> breaks the README badge/link `itemName` and the install id; avoid it.

## One-time setup (already done, here for reference)

1. **Azure DevOps PAT** (the publish credential, not a GitHub token):
   - Org `changjian-wang` at https://dev.azure.com
   - Scope: **Marketplace → Manage**
   - PAT **expires 2026-07-07** — regenerate and re-login when it lapses.
2. **Publisher** `codereview-dev` created at https://marketplace.visualstudio.com/manage
3. `npx --yes @vscode/vsce login codereview-dev` (paste the PAT into the terminal — never share it).

## Publish a new version

```sh
# 1. sanity check: types + bundle compile
npm run compile

# 2. publish (bumps version in package.json, packages, uploads in one shot)
npx --yes @vscode/vsce publish patch      # 0.0.50 -> 0.0.51
#   use `minor` / `major` for bigger bumps, or plain `publish` to ship the
#   version already in package.json.

# 3. sync the version-bump commit back to GitHub
git push
```

The README shows live Marketplace badges (version / installs / rating), so there
is **no hand-written version number to update** — the badges self-update once the
new version is live.

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
