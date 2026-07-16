# CLAUDE.md — ULTRON

Instructions for any Claude Code session working on this repo.

## Project context

ULTRON is a personal AI agent built from scratch by the user, replacing OpenClaw and Hermes Agent. Reason for the switch: loss of control felt with those frameworks (see documented case where an OpenClaw agent deleted hundreds of emails despite being instructed to wait for approval — no technical checkpoint blocked the action).

The full research context (latest AI models, OpenClaw vs Hermes Agent comparison, security/architecture pitfalls to avoid, personal-life use case ideas) lives in [docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) — written in French, kept as-is as a historical research artifact. Read it before any architecture decision that departs from the original plan.

## Architecture decisions already made

- **Model**: Nemotron (NVIDIA API) exclusively for now — no multi-provider setup.
- **Orchestrator**: LangGraph.js — the user owns the loop and the state, not a black-box framework.
- **Memory**: local Postgres (`ultron` database), native LangGraph checkpointing (`@langchain/langgraph-checkpoint-postgres`). Single persistent thread (`ultron-main`) for now.
- **Interface**: terminal in v0.1, Telegram is next (grammY planned).
- **Language**: the project itself (code, comments, console labels, docs) is in English. ULTRON's conversational replies match whatever language the user is currently writing in (French in → French out, English in → English out) — this is enforced in [AGENT.md](AGENT.md). Do not let it default to English regardless of input language.
- **System prompt split**: [SOUL.md](SOUL.md) is personality only (voice, tone, examples). [AGENT.md](AGENT.md) is everything else — tool-use protocol, language matching, other operational rules. Don't fold one into the other; `src/agent/graph.ts` concatenates both at startup.
- **Security intentionally minimal**: the user explicitly asked for **no Docker, no hardened secret management, full bypass of manual permissions/confirmations**. This is NOT an oversight — do not reintroduce sandboxing or confirmation gates without an explicit request.
- **Logs**: explicitly not required by the user for now. Do not add a logging/audit system without being asked.
- **Stop**: Ctrl+C must interrupt the loop at any time, including mid LLM call (AbortController).
- **No sub-agents for coding this project**: the user explicitly asked not to use the Agent/sub-agent tool to develop ULTRON. Work directly.
- **Docs stay current**: update PLAN.md / README.md / CLAUDE.md whenever a change makes them stale (new tool, new phase started, a decision changes) — don't let them drift from the actual code state.

## Known roadmap (do not build ahead of a request)

1. Loop + memory (current stage, done)
2. Telegram interface
3. Tools with scopes (read / write / destructive) — even with manual confirmations disabled by choice, keep scopes declared in code for clarity. In progress: shell + filesystem tools done (`src/tools/`), mail/calendar still pending (need OAuth).
4. Separate "Codex-style" app for vibe coding, with a main conversation orchestrating background sub-agents to manage projects. Do not start this without an explicit request — it was deliberately deferred during initial design.

## Stack

TypeScript (Node 24+) / pnpm / LangGraph.js / Postgres / `@langchain/openai` (OpenAI-compatible client pointed at the NVIDIA API).

## Git conventions

- `main`: stable
- `develop`: current work
- Commit + push on every code change (explicit user request — do not batch multiple changes into one deferred commit).

---

# État opérationnel du dépôt

## Vue d'ensemble

ULTRON est un agent IA personnel développé directement par l'utilisateur pour
conserver la maîtrise de la boucle d'exécution, des outils et de la mémoire.
La version actuelle fournit une conversation terminal persistante sur un fil
unique (`ultron-main`). Telegram, les intégrations mail/calendrier et
l'application de vibe-coding sont prévues mais ne sont pas implémentées.

## Stack technique

- TypeScript strict, Node.js 24+ attendu, pnpm 9.15.4.
- LangGraph.js pour l'état et l'orchestration.
- `@langchain/openai` contre l'endpoint OpenAI-compatible de NVIDIA.
- Nemotron exclusivement, modèle par défaut `nvidia/nemotron-3-super-120b-a12b`.
- PostgreSQL local avec `@langchain/langgraph-checkpoint-postgres`.
- `chalk`, `dotenv`, `pg` et `zod` pour le CLI, la configuration et les outils.

## Architecture du repo

- `src/index.ts` : point d'entrée CLI, affichage, streaming, statistiques,
  jauge de contexte et interruption Ctrl+C.
- `src/agent/graph.ts` : prompt système, graphe agent/outils, routage,
  nettoyage de l'historique et retries des erreurs transitoires ou faux appels.
- `src/llm/nemotron.ts` : construction du client ChatOpenAI configuré pour NVIDIA.
- `src/memory/checkpointer.ts` : initialisation paresseuse et setup du saver
  PostgreSQL LangGraph.
- `src/tools/` : onze outils avec scopes déclarés dans `index.ts` : shell,
  fichiers, HTTP/web et processus.
- `AGENT.md` / `SOUL.md` : règles opérationnelles et personnalité, concaténées
  au démarrage ; ils ne doivent pas être fusionnés.
- `PLAN.md`, `README.md` et `docs/agent-ia-personnel.md` : périmètre,
  feuille de route et recherche historique en français.

## Exécution locale

Pré-requis : Node.js 24+, pnpm, PostgreSQL démarré avec une base `ultron`, et
un fichier `.env` basé sur `.env.example` contenant `NVIDIA_API_KEY`.

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm dev
pnpm start
```

Il n'existe actuellement ni script de test ni script de lint. Le démarrage
réel dépend à la fois de PostgreSQL et de l'accès API NVIDIA ; le build et le
typecheck sont indépendants de ces services.

## Configuration et secrets

- `NVIDIA_API_KEY` : obligatoire, chargé par `src/config.ts`.
- `NEMOTRON_MODEL` : optionnel ; valeur par défaut documentée ci-dessus.
- `NEMOTRON_BASE_URL` : optionnel ; défaut `https://integrate.api.nvidia.com/v1`.
- `DATABASE_URL` : optionnel ; défaut `postgresql://localhost:5432/ultron`.
- `CONTEXT_WINDOW_TOKENS` : optionnel ; défaut `262144`, utilisé uniquement
  pour la jauge CLI.
- `.env` est ignoré par Git ; `.env.example` est le contrat de configuration.

## Qualité et tests

Le compilateur TypeScript est strict et `pnpm typecheck` ainsi que `pnpm build`
passent actuellement. Aucun test automatisé n'est présent. Les zones les plus
importantes à couvrir seront le routage agent/outils, les retries et le
nettoyage des faux appels, le Ctrl+C, les outils fichiers/processus et le
checkpointer PostgreSQL.

## Risques techniques

1. Les outils shell, fichiers, HTTP et processus ont un accès direct et aucun
   garde-fou d'autorisation : c'est une décision explicite du projet, mais
   l'impact d'un mauvais appel est élevé.
2. Les appels d'outils dépendent encore de la fiabilité du modèle Nemotron ;
   le mécanisme de retry atténue les faux appels mais ne les élimine pas.
3. Les estimations de tokens sont approximatives, car l'endpoint NVIDIA ne
   fournit pas l'usage dans le streaming.
4. La mémoire est un fil PostgreSQL unique et persistant ; une corruption ou
   une pollution d'historique affecte directement les tours suivants.
5. Le parsing HTML et la recherche DuckDuckGo sont volontairement légers et
   peuvent échouer sur des pages dynamiques ou des changements de format.

## Prochaines actions recommandées

1. Ajouter des tests unitaires ciblés sans changer la posture de sécurité
   choisie.
2. Préparer la phase Telegram avec grammY en réutilisant `buildGraph` et le
   même `thread_id`, sans démarrer la phase vibe-coding.
3. Concevoir les intégrations mail/calendrier et leur OAuth avant d'ajouter
   leurs outils.
4. Corriger les écarts documentaires au fur et à mesure de chaque nouveau
   changement de code, conformément à `AGENTS.md`.
