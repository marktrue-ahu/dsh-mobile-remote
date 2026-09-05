# Agent instructions

## Git remotes

- `origin` is the only configured remote: `git@github.com:marktrue-ahu/dsh-mobile-remote.git`.
- Before any pull, rebase, merge, push, or tag operation, verify the current branch and `origin` target.

## Agent skills

### Issue tracker

Issues and PRDs are tracked in the GitHub Issues for the repository identified by `origin`. See `docs/agents/issue-tracker.md`.

### Triage labels

Use the canonical labels `needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, and `wontfix`. See `docs/agents/triage-labels.md`.

### Domain docs

This is a single-context repository using a root `CONTEXT.md` and `docs/adr/`. See `docs/agents/domain.md`.
