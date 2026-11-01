# CLAUDE.md

All project rules live in `AGENTS.md` so that every agent reads the same instructions:

@AGENTS.md

## Claude Code notes

- Start each session by reading `docs/phase1-step1-action-plan.md` to see which step is in progress.
- The Step 1 code is on PR #1 (`step1-register/`) and the canonical schema is on `feature/step1-foundation`. If they
  are not on your branch yet, inspect them with `git fetch origin pull/1/head` / `git show origin/<branch>:<path>`
  or a temporary `git worktree`. Don't merge `feature/step1-foundation` into `main` (see AGENTS.md §2).
- Local Postgres 16 is usually available at `/usr/lib/postgresql/16/bin`. Use it to prove migrations apply.
- Supabase MCP tools may be connected. The only existing project, `SiteSelection`, is **unrelated**. Never apply
  migrations to it, and ask before you create a new project.
