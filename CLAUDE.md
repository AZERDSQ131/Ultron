# CLAUDE.md — ULTRON

Instructions pour toute session Claude Code travaillant sur ce repo.

## Contexte du projet

ULTRON est un agent IA personnel construit sur mesure par l'utilisateur, en remplacement d'OpenClaw et Hermes Agent. Raison du choix : perte de controle ressentie avec ces frameworks (cf. cas documente ou un agent OpenClaw a supprime des centaines d'emails malgre une consigne d'attendre une approbation — aucun checkpoint technique ne bloquait l'action).

Le contexte complet des recherches (derniers modeles IA, comparatif OpenClaw vs Hermes Agent, failles de securite/architecture a eviter, idees de use-cases vie perso) est dans [docs/agent-ia-personnel.md](docs/agent-ia-personnel.md). A lire avant toute decision d'architecture qui s'ecarte du plan initial.

## Decisions d'architecture actees

- **Modele** : Nemotron (API NVIDIA) exclusivement pour l'instant — pas de multi-provider.
- **Orchestrateur** : LangGraph.js — l'utilisateur possede la boucle et le state, pas un framework "boite noire".
- **Memoire** : Postgres local (base `ultron`), checkpointing LangGraph natif (`@langchain/langgraph-checkpoint-postgres`). Un seul thread persistant (`ultron-main`) pour l'instant.
- **Interface** : terminal en v0.1, Telegram viendra ensuite (grammY prevu).
- **Securite volontairement allegee** : l'utilisateur a explicitement demande **pas de Docker, pas de gestion de secrets renforcee, bypass complet des permissions/confirmations manuelles**. Ce n'est PAS un oubli — ne pas reintroduire de sandboxing ou de garde-fous de confirmation sans demande explicite.
- **Logs** : explicitement non requis par l'utilisateur pour l'instant. Ne pas ajouter de systeme de logging/audit sans qu'il le demande.
- **Arret** : Ctrl+C doit pouvoir interrompre la boucle a tout moment, y compris pendant un appel LLM en cours (AbortController).
- **Pas de sous-agents pour coder ce projet** : l'utilisateur a explicitement demande de ne pas utiliser l'outil Agent/sous-agents pour developper ULTRON. Travailler directement.

## Roadmap connue (a ne pas anticiper sans demande)

1. Boucle + memoire (etape actuelle)
2. Interface Telegram
3. Outils avec scopes (read / write / destructive) — meme si les confirmations manuelles sont desactivees par choix utilisateur, garder les scopes déclarés dans le code pour lisibilite
4. Application separee style "Codex" pour le vibe coding, avec une conversation principale qui orchestre des sous-agents en arriere-plan pour gerer des projets. Ne pas commencer cette partie sans demande explicite — elle a ete volontairement mise de cote lors de la conception initiale.

## Stack

TypeScript (Node 24+) / pnpm / LangGraph.js / Postgres / `@langchain/openai` (client compatible OpenAI pointe vers l'API NVIDIA).

## Conventions Git

- `main` : stable
- `develop` : travail courant
- Commit + push a chaque modification du code (demande explicite de l'utilisateur — ne pas grouper plusieurs changements en un seul commit differe).
