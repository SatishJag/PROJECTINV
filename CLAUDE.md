# CLAUDE.md

All project rules live in `AGENTS.md` so that every agent reads the same instructions:

@AGENTS.md

## Claude Code notes

- Start each session by reading `docs/phase1-step1-action-plan.md` to see which step is in progress.
- The Step 1 code is on PR #1 (`step1-register/`) and the canonical schema is on `feature/step1-foundation`. If they
  are not on your branch yet, inspect them with `git fetch origin pull/1/head` / `git show origin/<branch>:<path>`
  or a temporary `git worktree`. Don't merge `feature/step1-foundation` into `main` (see AGENTS.md §2).
- Local Postgres 16 is usually available at `/usr/lib/postgresql/16/bin`. Use it to prove migrations apply.
- The target platform is Azure (see AGENTS.md "Platform"), not Supabase. Supabase MCP tools may still be connected;
  the only project there, `SiteSelection`, is **unrelated**. Never apply migrations to it.
- Azure Blob code is tested against Azurite (`node_modules/.bin/azurite-blob`), which `test/filestore.test.ts` starts
  by itself. No Azure account is needed for tests.
- Don't use `pkill -f <pattern>` in Bash: it matches the shell's own command line and kills it. Kill by PID.
