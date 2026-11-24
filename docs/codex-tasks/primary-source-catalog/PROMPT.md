# Task: prefer a catalogued source as the article's primary source

You are working in the hp-vlog repository (current directory), branch `fix/primary-source-catalog`.

Read these two files first and follow them exactly:

- `docs/codex-tasks/primary-source-catalog/README.md` (background and policy)
- `docs/codex-tasks/primary-source-catalog/01-primary-source.md` (requirements R1-R3, tests, files you may change, things you must not change)

Rules:

- Change only the files listed under 「変えてよいファイル」 in `01-primary-source.md`.
- Do not change the source guard judgement (`scripts/lib/source-alignment.js`, `scripts/lib/source-guard.js`), `scripts/lib/llm-source-selector.js`, anything under `data/` or `content/`.
- Keep existing tests passing; do not weaken or delete existing assertions.
- Run every command listed under 「実行する試験」 through `sbx`, and fix failures.
- Do not commit, push or install anything.
- Code comments follow the repository (Japanese).

Final report (Japanese): files changed with a one-line summary each, how R1-R3 were implemented, the exact test commands with their PASS/FAIL counts, and anything you could not do or were unsure about.
