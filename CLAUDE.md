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
- **Interface**: terminal (v0.1) and a local web UI (`src/interfaces/web/`) — both point at the same SQLite file and thread, so they share memory and slash commands (`/compact`, `/retry`, `/archive`, `/resume`, `/chat`). Telegram is next (grammY planned). `/chat` (CLI, `src/interfaces/cli/index.ts`) opens any chat by search/id — including a `spawn_agent` sub-agent's own execution chat — mirroring what the web sidebar already let you do; bare `/chat` opens a picker (same UX as `/resume`), `/chat <text>` switches directly.
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
- API NVIDIA exclusivement, modèle par défaut `deepseek-ai/deepseek-v4-flash`.
- SQLite local (`node:sqlite`, natif à Node — aucune dépendance native
  supplémentaire) via un `SqliteSaver` écrit à la main dans
  `src/core/memory/checkpointer.ts`, partagé par le CLI et le serveur web.
- `chalk`, `dotenv` et `zod` pour le CLI, la configuration et les outils ;
  aucun framework serveur (le serveur web utilise `node:http` directement).

## Architecture du repo

- `src/core/logger.ts` : `log(prefix, message)` partagé par `graph.ts`,
  `server.ts` et les outils qui journalisent leurs propres diagnostics
  (`tools/agents.ts`, `tools/schedules.ts`) — écrit toujours dans
  `ultron-web.log`, et sur stderr seulement si `disableConsoleEcho()` n'a
  pas été appelé. Le CLI l'appelle en tout premier dans `main()` : il prend
  le contrôle du terminal en mode brut et redessine tout l'écran depuis son
  propre buffer (`transcript`), donc un `console.error` isolé (ex. la ligne
  de debug `[graph] agent start thread=...`) atterrissait littéralement au
  milieu d'une réponse affichée — corrigé en centralisant tous ces appels
  derrière ce logger désactivable plutôt qu'en les retirant (le fichier de
  log reste alimenté normalement, y compris pour le CLI).
- `src/interfaces/cli/index.ts` : point d'entrée CLI, affichage, streaming, statistiques,
  jauge de contexte et interruption Ctrl+C. `formatToolResult` y donne un
  rendu dédié par outil (web_search : résultats numérotés avec URLs en
  cyan soulignées ; fetch_url/http_request : en-tête status/url en dim,
  corps tronqué ; spawn_agent : préfixe `[agent]` distinct) au lieu du
  dump générique gris uniforme utilisé auparavant pour tout ; tout le
  reste passe par une troncature générique (`capForDisplay`, ~1400
  caractères/16 lignes affichés, le modèle garde le contenu complet) pour
  qu'un gros résultat n'inonde plus le terminal. Réutilisé à la fois par
  le flux live et par `showRestoredMessages` (relecture d'un chat) pour
  un rendu identique. La ligne de stats `/verbose` (`formatTurnStats`,
  `src/core/llm/usage.ts`, partagée avec `server.ts`) affiche désormais
  `model | X in | Y out | Zs | $coût` (ex. `deepseek-v4-flash | 7,688 in |
  303 out | 10s | $0.14`) au lieu du seul temps écoulé/tokens de sortie ;
  le coût est une estimation configurable (`NEMOTRON_PRICE_IN_PER_M`/
  `NEMOTRON_PRICE_OUT_PER_M`, `.env.example`), pas un tarif réel de
  NVIDIA NIM qui n'en publie pas.
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
  sous-agents, `open_app`/`applescript_run` (`macos.ts` — lancer une app
  macOS par son nom via `open -a`, ou piloter une app qui expose un
  dictionnaire AppleScript/JXA comme Finder, Notes, Calendar, System
  Events — préférés à un agent générique de contrôle GUI par clics/pixels,
  abandonné après plusieurs tentatives : les modèles disponibles via
  l'API NVIDIA n'étaient pas assez fiables pour du clic à l'aveugle
  autonome, voir l'historique git de `src/core/computerUse.ts` supprimé),
  et une to-do list par chat (`todo_write`/`todo_read`,
  `src/core/memory/todos.ts`) que le modèle tient à jour sur les tâches
  longues et que l'UI web affiche en direct dans un panneau à droite
  (`public/js/todos.js`, `GET /api/chats/:id/todos`). La seule consigne
  écrite dans `AGENT.md` ne suffisant pas à faire suivre `todo_write` de
  façon fiable par Nemotron, l'UI web ajoute un sélecteur explicite
  « task mode » (None / To-Do / Plan, à côté du raisonnement et de la
  sécurité) qui injecte une directive `<task_mode>` juste avant le tour
  courant (`taskModeDirective` dans `graph.ts`, propagé par
  `configurable.taskMode` depuis `/api/turn` et `/api/approve`) — un mode
  choisi par l'utilisateur plutôt qu'une inférence du modèle. Le CLI a la
  même chose via `/task none|todo|plan` (`src/interfaces/cli/index.ts`,
  variable locale `taskMode` propagée au `configurable` de `graph.stream`,
  comme `/think`) ; l'approbation d'un `plan_propose` y a aussi un rendu
  dédié dans `promptToolApproval` (plan numéroté, prompt « start? »)
  au lieu du bloc JSON générique utilisé pour les autres outils. Un second
  rappel plus court (`taskModeReminder`) est en plus ajouté après tout
  l'historique, juste avant l'appel au modèle, car un run réel a montré
  que la directive seule en tête du system prompt ne suffisait pas
  toujours (six recherches avant le premier `todo_write`) ; ce rappel
  change de formulation selon que `todo_write` a déjà été appelé ou non
  dans le tour courant (`todoStartedThisTurn`). La détection des faux
  appels d'outils écrits en texte (`extractFakeToolCall`) a aussi été
  généralisée : elle reconnaît maintenant n'importe quel outil (pas
  seulement `schedule_task`) sous trois formes, y compris encadré par
  `<tool_call>...</tool_call>` ou une fence ```json — un vrai `todo_write`
  émis sous cette forme atterrissait auparavant comme réponse finale
  cassée au lieu d'être exécuté ou corrigé par un retry.
- Un run en mode "To-Do" a aussi montré le modèle rappeler `todo_write`
  (liste entière) juste pour clore le dernier item, au lieu de ne changer
  que son statut — risque de perte/renumérotation du reste de la liste.
  Ajout de `todo_update` (`index`, `status?`, `content?`) qui modifie un
  seul item par sa position 1-based ; `todo_write` est réservé à la
  création initiale et à la restructuration du plan. Les directives de
  `taskModeDirective`/`taskModeReminder` et `AGENT.md` disent maintenant
  explicitement de préférer `todo_update` pour les changements de statut.
- `src/core/memory/goals.ts` (`GoalRegistry`) + `src/core/goalJudge.ts` +
  the CLI's `/task goal` mode (`src/interfaces/cli/index.ts`) : **CLI-only**
  goal mode, not wired into the web UI. `"goal"` is a fourth value of
  `TaskMode` (`graph.ts`) alongside `none`/`todo`/`plan` — `/task goal` just
  arms the mode exactly like `/task todo`/`/task plan` do, with no argument.
  There is no separate `/goal` command and no pause/resume/clear/status
  subcommands: the next non-retry message the user sends while in goal mode
  becomes the objective (`goals.set(...)`, called from the same
  turn-boundary spot that clears the todo list for todo/plan mode) and runs
  as a normal turn; after that turn `driveGoalLoop` calls a *separate*
  short-lived LLM call (`judgeGoal`, `createNemotronModel("low")`) that
  reads only the worker's final reply plus a bounded `git status`/`git diff
  HEAD` snapshot (`gatherCodeContext`, capped ~6k chars) — deliberately not
  the full tool-call history, so the judge has its own small, cheap context
  instead of re-consuming everything the main turn just spent. On
  "continue" it appends a corrective `[Goal check] ...` human-role message
  (`buildContinuationPrompt`) and replays `executeTurn` (the same
  tool-approval-aware turn path a human-typed message gets — extracted out
  of the old inline main-loop code specifically so the goal loop reuses it
  verbatim, not a simplified copy) automatically, with no user input, up to
  `GOAL_MAX_TURNS` (default 20) before self-pausing. "done" marks the goal
  complete; "blocked" pauses it. Every `goals.set(...)` call unconditionally
  overwrites whatever goal existed for the chat before — there's no
  "already active" guard and no resume-by-command: a paused/blocked goal is
  simply superseded by the next message sent in goal mode, same as todo/plan
  discarding a stale list at the next turn boundary. Ctrl+C aborts a
  goal-loop turn (or the judge call itself) the same way it aborts a normal
  turn. `taskModeDirective`/`taskModeReminder` (`graph.ts`) short-circuit to
  `""` for `mode === "goal"` — the model just sees a normal user message,
  since the loop is driven entirely on the CLI side, not via a system-prompt
  directive like todo/plan.
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
- `GRAPH_RECURSION_LIMIT` : optionnel ; défaut `150`. LangGraph compte
  chaque visite de nœud (pas chaque appel d'outil) contre sa limite par
  défaut de 25 — un tour en mode To-Do/Plan avec plusieurs sous-tâches,
  chacune suivie de son propre aller-retour `todo_update`, la dépassait
  largement sur une tâche par ailleurs saine (`GRAPH_RECURSION_LIMIT`
  atteint). Propagé à tous les appels `graph.stream`/`graph.invoke`
  (CLI, serveur web, tâches planifiées, `spawn_agent`).
- Le mode "Plan" ne se contente plus de forcer `todo_write` en amont : il
  utilise un nouvel outil `plan_propose` (`src/core/tools/plan.ts`, même
  forme que `todo_write` sans le champ `status`) qui **suspend toujours**
  l'exécution pour une confirmation explicite de l'utilisateur, quel que
  soit le mode de sécurité du chat (cas spécial dans `needsApproval` de
  `toolsNode`, `graph.ts` — ce n'est pas la porte de sécurité
  bypass/accept_edit/manual, c'est le contrôle de workflow propre à "Plan").
  Réutilise entièrement le mécanisme `interrupt()`/`Command`/`/api/approve`
  déjà en place pour l'approbation des outils destructifs. Sur refus, le
  `ToolMessage` renvoyé au modèle lui dit explicitement de discuter en
  langage naturel plutôt que de rappeler `plan_propose` immédiatement ; sur
  acceptation, l'outil s'exécute réellement et écrit le plan dans le même
  registre que `todo_write`/`todo_update`. `taskModeReminder`/`taskModeDirective`
  et l'UI web (`addApprovalBlock` dans `thread.js`, rendu dédié "Plan
  proposé" avec boutons Start/Discuss) reflètent ce cycle
  propose → (accepte → exécute) | (refuse → discute → re-propose).
- `GOAL_MAX_TURNS` : optionnel ; défaut `20`. Nombre de tours d'auto-continuation
  que le mode `/task goal` (CLI uniquement, voir ci-dessus) s'autorise avant
  de se mettre en pause tout seul.
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

## To-do : persistance par chat et reprise de tâche non liée

La liste to-do (`memory/todos.ts`) est scoppée par `chat_id`, donc elle
survit indéfiniment à travers les tours d'un même chat — y compris un
redémarrage d'ULTRON (SQLite persiste) suivi d'une demande totalement sans
rapport dans le même chat. `todoState()` (`graph.ts`) ne regardait que
« la liste est-elle vide ou non » pour décider d'autoriser `todo_write`,
donc une demande sans rapport avec une liste déjà existante faisait
continuer/mettre à jour l'ancienne liste au lieu d'en repartir sur une
nouvelle — reproduit et corrigé sur deux fronts :
- **Déterministe** : `TodoRegistry.clear()` +
  `DELETE /api/chats/:id/todos` + bouton "✕" dans l'en-tête du panneau
  web (`todos.js`) — l'utilisateur peut toujours forcer un nouveau départ
  sans dépendre du jugement du modèle.
- **Consigne** : `taskModeDirective`/`taskModeReminder` (`graph.ts`) et
  `AGENT.md` disent maintenant explicitement de repartir d'un `todo_write`/
  `plan_propose` neuf (pas `todo_update`) si la demande courante n'est pas
  la continuation de ce que la liste existante suivait.

## Modèle utilisateur passif (parité Hermes Agent)

Ajouté pour combler un écart identifié face à Hermes Agent (voir
`docs/agent-ia-personnel.md`, section 2) : une mémoire qui apprend en
continu, sans qu'on le lui demande, plutôt qu'uniquement sur déclaration
explicite de l'utilisateur (`MEMORY.md`, `memory_write`).

- `src/core/memory/userModel.ts` (`UserModelRegistry`) : table SQLite
  `user_model_observations`, globale (pas scoppée par chat, comme
  `MEMORY.md`) — chaque ligne est une observation courte
  (`preference`/`fact`/`pattern`) avec sa source (`chat_id` d'origine) et sa
  date. Volontairement **séparée** de `MEMORY.md` : ce fichier reste la
  mémoire éditée et validée à la main par l'utilisateur, jamais réécrite
  automatiquement — voir l'historique du projet (incident OpenClaw,
  suppression de mails malgré l'instruction d'attendre) qui est la raison
  d'être de tout ULTRON ; reproduire la même perte de contrôle côté mémoire
  aurait été absurde.
- `src/core/userModelExtractor.ts` : après chaque tour réussi (CLI
  `executeTurn`, web `streamGraphTurn`), un appel LLM séparé et bon marché
  (`createNemotronModel("low")`, même schéma que `judgeGoal` dans
  `goalJudge.ts`) lit uniquement le dernier échange (message utilisateur +
  réponse d'ULTRON, pas tout l'historique) et répond soit `{"observation":
  null}`, soit une observation courte. Jamais attendu par le flux principal
  (`void recordUserModelObservation(...)`) : une extraction ratée est
  silencieuse, jamais bloquante ni remontée à l'utilisateur.
- `graph.ts` : `buildSystemPrompt` injecte un nouveau bloc `<user_model>`
  (même mécanisme que `<daily_memory>`), entre `<memory>` et
  `<daily_memory>`, résumant les observations accumulées (plafonné à 40
  pour ne pas faire grossir le prompt sans limite). Absent du prompt d'un
  sous-agent (`buildAgentSystemPrompt`), pour la même raison que
  `MEMORY.md` en est déjà exclu.
- `/memory` (CLI uniquement, `src/interfaces/cli/index.ts`) : liste les
  observations accumulées (`/memory`), les efface toutes (`/memory clear`)
  ou une seule par id (`/memory forget <id>`) — la surface de revue/purge
  explicitement promise avant l'implémentation, pas de fusion automatique
  vers `MEMORY.md`.
- Pas encore fait : promotion explicite d'une observation vers `MEMORY.md`
  (l'utilisateur ou ULTRON, sur demande, édite `MEMORY.md` à la main via les
  outils fichiers existants — aucun outil dédié pour l'instant), et aucune
  passe de consolidation/dédoublonnage des observations dans le temps.
