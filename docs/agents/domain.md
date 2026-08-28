# Domain docs

This is a single-context repository. Engineering skills must consume the repository's domain documentation before exploring or changing the relevant code.

## Before exploring

- Read the root `CONTEXT.md` for the project's canonical domain language.
- Read the relevant accepted or proposed decisions in `docs/adr/` for the area being changed.
- If either location does not exist, continue silently. Do not create domain documentation until terminology or a decision is actually resolved.

## Layout

```text
/
├── CONTEXT.md
├── docs/
│   └── adr/
└── ...
```

There is no `CONTEXT-MAP.md` and no separate Flutter/mobile-remote domain context. Both sides use the root glossary and the shared ADR set.

## Use the glossary vocabulary

Use terms defined in `CONTEXT.md` when naming domain concepts in issues, specs, implementation plans, code, tests, and documentation. Do not drift to synonyms that the glossary explicitly marks as avoided.

If a required concept is absent, reconsider whether the task is inventing unnecessary language. When a genuine domain gap exists, resolve it through the project's domain-design workflow before treating the new term as canonical.

## Respect ADRs

Do not silently override an ADR. If a proposed implementation conflicts with an existing decision, identify the ADR and explain why it may need to be revisited before implementation proceeds.
