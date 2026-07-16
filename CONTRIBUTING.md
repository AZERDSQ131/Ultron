# Contributing to ULTRON

Thanks for taking an interest in ULTRON. The project is intentionally being
developed in public from an early stage, so discussion and small, focused
contributions are especially welcome.

## Before starting

Please read:

- [README.md](README.md) for setup and the current state;
- [PLAN.md](PLAN.md) for scope and roadmap;
- [AGENT.md](AGENT.md) and [SOUL.md](SOUL.md) for the prompt split;
- [CLAUDE.md](CLAUDE.md) for repository-specific operating instructions.

Do not start work on the deferred vibe-coding app without an explicit project
decision. Mail and calendar integrations also require an agreed OAuth design.

## Development setup

```bash
pnpm install
cp .env.example .env
pnpm typecheck
pnpm build
```

You need a local PostgreSQL database named `ultron` and an NVIDIA API key to
run the full application. Do not commit `.env`, API keys, personal data,
database dumps or local conversation history.

## Making a change

1. Open an issue or describe the intended change clearly in a pull request.
2. Keep the change focused and consistent with the existing architecture.
3. Update `README.md`, `PLAN.md` or the relevant instructions when behavior or
   scope changes.
4. Run `pnpm typecheck` and `pnpm build` before submitting.
5. Explain what was tested and what still depends on local services.

There is no automated test suite yet. New behavior should include tests when
the relevant test structure is introduced, especially around the graph,
retries, tools and interruption handling.

## Security and tools

ULTRON's current security posture is intentionally minimal. Its shell,
filesystem, HTTP and process tools can perform real actions without a manual
confirmation gate. Do not weaken or broaden this behavior casually. Report
security concerns privately to the maintainer rather than publishing usable
credentials or exploit details in an issue.

## Style

- Use English for code, comments, repository documentation and console labels.
- Keep conversational language behavior in `AGENT.md`.
- Follow the existing TypeScript style and strict compiler settings.
- Prefer direct, readable changes over introducing a framework for a small task.

## Pull requests

A good pull request states:

- the problem and the chosen approach;
- files or modules affected;
- verification performed;
- documentation or roadmap impact;
- any known limitation or security implication.

Be patient with the project: it is a personal agent becoming public, not a
finished platform. The architecture is still evolving, but its decisions are
deliberate.
