# Issue tracker: GitHub

This repository's issues and specs are stored in GitHub Issues at `marktrue-ahu/dsh-mobile-remote`. Always pass this repository explicitly so that issue operations target the user's `origin` fork and never the read-only `source` repository.

## CLI environment

GitHub CLI is installed on the Windows host and is available from WSL at:

```sh
DSH_GH='/mnt/c/Program Files/GitHub CLI/gh.exe'
```

GitHub CLI requests must use the local HTTP proxy:

```sh
env HTTP_PROXY=http://127.0.0.1:1080/ HTTPS_PROXY=http://127.0.0.1:1080/ "$DSH_GH" ...
```

## Conventions

- **Create an issue:** `"$DSH_GH" issue create --repo marktrue-ahu/dsh-mobile-remote --title "..." --body-file <path>`.
- **Read an issue:** `"$DSH_GH" issue view <number> --repo marktrue-ahu/dsh-mobile-remote --comments`; request JSON when labels or comments need filtering.
- **List issues:** `"$DSH_GH" issue list --repo marktrue-ahu/dsh-mobile-remote --state open --json number,title,body,labels,comments`; add label and state filters as needed.
- **Comment on an issue:** `"$DSH_GH" issue comment <number> --repo marktrue-ahu/dsh-mobile-remote --body-file <path>`.
- **Apply or remove labels:** `"$DSH_GH" issue edit <number> --repo marktrue-ahu/dsh-mobile-remote --add-label "..."` or `--remove-label "..."`.
- **Close an issue:** `"$DSH_GH" issue close <number> --repo marktrue-ahu/dsh-mobile-remote --comment "..."`.

Apply the proxy environment shown above to every GitHub CLI invocation. Prefer `--body-file` for multiline content.

## Skill instructions

When a skill says “publish to the issue tracker,” create an issue in `marktrue-ahu/dsh-mobile-remote`.

When a skill says “fetch the relevant ticket,” read the corresponding issue, its labels, and its comments from that repository.
