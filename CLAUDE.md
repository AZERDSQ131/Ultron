# CLAUDE.md — ULTRON

Instructions for any Claude Code session working on this repo.

## Project context

ULTRON is a personal AI agent built from scratch by the user, replacing OpenClaw and Hermes Agent. Reason for the switch: loss of control felt with those frameworks (see documented case where an OpenClaw agent deleted hundreds of emails despite being instructed to wait for approval — no technical checkpoint blocked the action).

The full research context (latest AI models, OpenClaw vs Hermes Agent comparison, security/architecture pitfalls to avoid, personal-life use case ideas) lives in [docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) — written in French, kept as-is as a historical research artifact. Read it before any architecture decision that departs from the original plan.

## Architecture decisions already made

- **Model**: Nemotron (NVIDIA API) exclusively for now — no multi-provider setup.
- **Orchestrator**: LangGraph.js — the user owns the loop and the state, not a black-box framework.
- **Memory**: local SQLite checkpoint database (`ultron-state.sqlite3`), custom `SqliteSaver` in `src/core/memory/checkpointer.ts` implementing LangGraph's `BaseCheckpointSaver` directly on Node's built-in `node:sqlite` (no `@langchain/langgraph-checkpoint-postgres`/`pg`, no `@langchain/langgraph-checkpoint-sqlite` — neither package's published versions match this project's `@langchain/core` ^0.3 / `langgraph` ^0.2 pin, and `node:sqlite` needs zero extra dependencies since Node 24 is already required).
- **Chats**: conversations are no longer a single hardcoded thread. `src/core/memory/chats.ts` (`ChatRegistry`) tracks every chat (id, title, timestamps) in the same database file; a chat's `id` doubles as its LangGraph `thread_id`. The web UI's sidebar lists/creates/renames/deletes chats. The CLI keeps one "current chat" per process, resuming whichever chat was most recently active on either interface at startup; `/archive` finalizes the current chat and starts a fresh one rather than exiting. The legacy hardcoded thread id (`ultron-main`, exported as `LEGACY_CHAT_ID`) is migrated into the registry on first run via `chats.ensure(...)` so pre-existing history isn't orphaned.
- **Interface**: terminal (v0.1) and a local web UI (`src/interfaces/web/`) — both point at the same SQLite file and thread, so they share memory and slash commands (`/compact`, `/retry`, `/archive`, `/resume`). Telegram is next (grammY planned).
- **Language**: the project itself (code, comments, console labels, docs) is in English. ULTRON's conversational replies match whatever language the user is currently writing in (French in → French out, English in → English out) — this is enforced in [AGENT.md](AGENT.md). Do not let it default to English regardless of input language.
- **System prompt split**: [SOUL.md](SOUL.md) is personality only (voice, tone, examples). [AGENT.md](AGENT.md) is everything else — tool-use protocol, language matching, other operational rules. Don't fold one into the other; `src/core/graph.ts` concatenates both at startup.
- **Security intentionally minimal**: the user explicitly asked for **no Docker, no hardened secret management, full bypass of manual permissions/confirmations**. This is NOT an oversight — do not reintroduce sandboxing or confirmation gates without an explicit request.
- **Logs**: explicitly not required by the user for now. Do not add a logging/audit system without being asked.
- **Stop**: Ctrl+C must interrupt the loop at any time, including mid LLM call (AbortController).
- **No sub-agents for coding this project**: the user explicitly asked not to use the Agent/sub-agent tool to develop ULTRON. Work directly.
- **Docs stay current**: update PLAN.md / README.md / CLAUDE.md whenever a change makes them stale (new tool, new phase started, a decision changes) — don't let them drift from the actual code state.

## Known roadmap (do not build ahead of a request)

1. Loop + memory (current stage, done)
2. Telegram interface
3. Tools with scopes (read / write / destructive) — even with manual confirmations disabled by choice, keep scopes declared in code for clarity. In progress: shell + filesystem tools done (`src/core/tools/`), mail/calendar still pending (need OAuth).
4. Separate "Codex-style" app for vibe coding, with a main conversation orchestrating background sub-agents to manage projects. Do not start this without an explicit request — it was deliberately deferred during initial design.

## Stack

TypeScript (Node 24+) / pnpm / LangGraph.js / SQLite (`node:sqlite`, no external database) / `@langchain/openai` (OpenAI-compatible client pointed at the NVIDIA API).

## Git conventions

- `main`: stable
- `develop`: current work
- Commit + push on every code change (explicit user request — do not batch multiple changes into one deferred commit).

---

# État opérationnel du dépôt

## Vue d'ensemble

ULTRON est un agent IA personnel développé directement par l'utilisateur pour
conserver la maîtrise de la boucle d'exécution, des outils et de la mémoire.
La version actuelle fournit plusieurs conversations persistantes, accessibles
depuis deux interfaces qui partagent le même état : le terminal
(`src/interfaces/cli/index.ts`) et une interface web locale (`src/interfaces/web/`). Telegram,
les intégrations mail/calendrier et l'application de vibe-coding sont prévues
mais ne sont pas implémentées.

## Stack technique

- TypeScript strict, Node.js 24+ attendu, pnpm 9.15.4.
- LangGraph.js pour l'état et l'orchestration.
- `@langchain/openai` contre l'endpoint OpenAI-compatible de NVIDIA.
- Nemotron exclusivement, modèle par défaut `nvidia/nemotron-3-super-120b-a12b`.
- SQLite local (`node:sqlite`, natif à Node — aucune dépendance native
  supplémentaire) via un `SqliteSaver` écrit à la main dans
  `src/core/memory/checkpointer.ts`, partagé par le CLI et le serveur web.
- `chalk`, `dotenv` et `zod` pour le CLI, la configuration et les outils ;
  aucun framework serveur (le serveur web utilise `node:http` directement).

## Architecture du repo

- `src/interfaces/cli/index.ts` : point d'entrée CLI, affichage, streaming, statistiques,
  jauge de contexte et interruption Ctrl+C.
- `src/interfaces/web/server.ts` + `src/interfaces/web/public/` : interface web locale (HTTP + SSE),
  sidebar de gestion des chats (créer, renommer, supprimer, changer de chat) ;
  frontend HTML/CSS + modules ES natifs (`public/js/*.js`), sans framework ni bundler.
  Refonte complète (2026-07-16) : palette de commandes `⌘/Ctrl K` (chats + recherche plein
  texte cross-chat + commandes), actions au survol des messages (copier, brut/rendu, éditer/
  régénérer sur le dernier tour de chaque rôle uniquement, seule chose que `prepareEdit`/
  `prepareRetry` côté backend peuvent défaire), blocs d'appel d'outil badgés par scope, et un
  panneau réglages/raccourcis coulissant avec bascule clair/sombre/système manuelle.
- `src/core/graph.ts` : prompt système, graphe agent/outils, routage,
  nettoyage de l'historique, retries des erreurs transitoires ou faux appels,
  et archive/reprise de conversation (`archiveThread` / `resumeThread`).
- `src/core/llm/nemotron.ts` : construction du client ChatOpenAI configuré pour NVIDIA.
- `src/core/memory/checkpointer.ts` : `SqliteSaver` (implémente `BaseCheckpointSaver`
  de LangGraph sur `node:sqlite`) — c'est ce fichier qui permet au CLI et au
  serveur web de partager mémoire et commandes : chaque processus ouvre sa
  propre connexion vers le même fichier `.sqlite3`.
- `src/core/memory/chats.ts` : `ChatRegistry` — la liste des chats (id, titre,
  horodatages) dans ce même fichier SQLite ; l'`id` d'un chat sert aussi de
  `thread_id` LangGraph. Le CLI garde un « chat courant » par processus (repris
  au démarrage sur le chat le plus récemment actif, toutes interfaces confondues) ;
  `/archive` clôture le chat courant et en démarre un nouveau au lieu de quitter,
  pour que le chat archivé reste consultable depuis la sidebar web.
- `src/core/tools/` : outils avec scopes déclarés dans `index.ts` : shell,
  fichiers, HTTP/web, processus, date/heure courante, tâches planifiées,
  sous-agents, et une to-do list par chat (`todo_write`/`todo_read`,
  `src/core/memory/todos.ts`) que le modèle tient à jour sur les tâches
  longues et que l'UI web affiche en direct dans un panneau à droite
  (`public/js/todos.js`, `GET /api/chats/:id/todos`). La seule consigne
  écrite dans `AGENT.md` ne suffisant pas à faire suivre `todo_write` de
  façon fiable par Nemotron, l'UI web ajoute un sélecteur explicite
  « task mode » (None / To-Do / Plan, à côté du raisonnement et de la
  sécurité) qui injecte une directive `<task_mode>` juste avant le tour
  courant (`taskModeDirective` dans `graph.ts`, propagé par
  `configurable.taskMode` depuis `/api/turn` et `/api/approve`) — un mode
  choisi par l'utilisateur plutôt qu'une inférence du modèle.
- `AGENT.md` / `SOUL.md` : règles opérationnelles et personnalité, concaténées
  au démarrage ; ils ne doivent pas être fusionnés.
- `PLAN.md`, `README.md` et `docs/agent-ia-personnel.md` : périmètre,
  feuille de route et recherche historique en français.

## Exécution locale

Pré-requis : Node.js 24+, pnpm, et un fichier `.env` basé sur `.env.example`
contenant `NVIDIA_API_KEY`. Aucune base de données externe à démarrer — le
fichier SQLite est créé automatiquement au premier lancement.

```bash
pnpm install
pnpm typecheck
pnpm build
pnpm dev        # CLI
pnpm web        # interface web (http://localhost:4173 par défaut)
pnpm start
pnpm start:web
```

Il n'existe actuellement ni script de test ni script de lint. Le démarrage
réel dépend de l'accès API NVIDIA ; le build et le typecheck en sont
indépendants.

## Configuration et secrets

- `NVIDIA_API_KEY` : obligatoire, chargé par `src/config.ts`.
- `NEMOTRON_MODEL` : optionnel ; valeur par défaut documentée ci-dessus.
- `NEMOTRON_BASE_URL` : optionnel ; défaut `https://integrate.api.nvidia.com/v1`.
- `DATABASE_PATH` : optionnel ; défaut `ultron-state.sqlite3` à la racine du
  projet — fichier de checkpoint partagé par le CLI et le serveur web.
- `WEB_PORT` : optionnel ; défaut `4173`, port de l'interface web locale.
- `CONTEXT_WINDOW_TOKENS` : optionnel ; défaut `262144`, utilisé uniquement
  pour la jauge de contexte.
- `.env` est ignoré par Git ; `.env.example` est le contrat de configuration.

## Qualité et tests

Le compilateur TypeScript est strict et `pnpm typecheck` ainsi que `pnpm build`
passent actuellement. Aucun test automatisé n'est présent. Les zones les plus
importantes à couvrir seront le routage agent/outils, les retries et le
nettoyage des faux appels, le Ctrl+C, les outils fichiers/processus et le
   checkpointer SQLite.

## Risques techniques

1. Les outils shell, fichiers, HTTP et processus ont un accès direct et aucun
   garde-fou d'autorisation : c'est une décision explicite du projet, mais
   l'impact d'un mauvais appel est élevé.
2. Les appels d'outils dépendent encore de la fiabilité du modèle Nemotron ;
   le mécanisme de retry atténue les faux appels mais ne les élimine pas.
3. Le nombre de tokens générés par tour est désormais exact (usage réel
   renvoyé par NVIDIA sur le dernier chunk du stream, voir
   `src/core/llm/nemotron.ts`) ; seule la jauge de contexte totale reste une
   estimation approximative (chars/4), car elle inclut l'historique complet
   sans relancer d'appel.
4. La mémoire est un fil SQLite unique et persistant, partagé par le CLI et
   le serveur web ; une corruption ou une pollution d'historique affecte
   directement les deux interfaces. Le `SqliteSaver` étant écrit à la main
   (pas de package officiel compatible avec les versions actuelles de
   `@langchain/core`/`langgraph`), toute divergence avec le comportement
   attendu de `BaseCheckpointSaver` reste à la charge du projet.
5. Le parsing HTML et la recherche DuckDuckGo sont volontairement légers et
   peuvent échouer sur des pages dynamiques ou des changements de format.

## Prochaines actions recommandées

1. Ajouter des tests unitaires ciblés sans changer la posture de sécurité
   choisie.
2. Préparer la phase Telegram avec grammY en réutilisant `buildGraph` et le
   même `thread_id`, sans démarrer la phase vibe-coding.
3. Concevoir les intégrations mail/calendrier et leur OAuth avant d'ajouter
   leurs outils.
4. Définir le modèle persistant et le cycle de vie des tâches planifiées avant
   d'implémenter les crons : exécution non interactive, reprise après arrêt,
   prévention des chevauchements et rattachement à un chat dédié.
5. Corriger les écarts documentaires au fur et à mesure de chaque nouveau
   changement de code, conformément à `AGENTS.md`.
