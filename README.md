# ULTRON

Agent IA personnel. Construit sur mesure (pas OpenClaw, pas Hermes Agent) pour garder le controle total sur l'architecture, les permissions et la memoire.

## Etat actuel (v0.1)

- Boucle conversationnelle en terminal (pas encore Telegram)
- Modele : Nemotron (API NVIDIA) via l'API OpenAI-compatible
- Memoire persistante via LangGraph + Postgres (checkpointing, thread `ultron-main`)
- Aucun outil branche pour l'instant — uniquement la boucle + la memoire
- Pas de sandboxing (Docker), pas de confirmation manuelle par action — choix assume par l'utilisateur

## Setup

```bash
pnpm install
cp .env.example .env   # renseigner NVIDIA_API_KEY
pnpm dev
```

Necessite un Postgres local actif avec une base `ultron` (deja creee via `createdb ultron`).

## Arreter l'agent

`Ctrl+C` a tout moment, y compris pendant qu'il repond — la requete en cours est annulee proprement.

## Documentation

Voir [docs/agent-ia-personnel.md](docs/agent-ia-personnel.md) pour toutes les recherches et decisions d'architecture ayant mene a ce projet (modeles IA, comparatif OpenClaw/Hermes, failles a eviter, stack choisie).

## Roadmap

1. ~~Boucle + memoire~~ (en cours)
2. Interface Telegram (remplace/complete le terminal)
3. Outils (avec scopes read / write / destructive)
4. App "vibe coding" style Codex avec sous-agents orchestres en arriere-plan
