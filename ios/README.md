# ULTRON iOS

App SwiftUI native (iOS 17+, zéro dépendance externe) qui parle au serveur web
ULTRON existant (`src/interfaces/web/server.ts`) en HTTP/SSE, exactement comme
le fait `src/interfaces/cli/remote.ts` — pas de nouvelle API mobile dédiée,
pas d'authentification (Tailscale reste le seul périmètre de sécurité, comme
documenté dans le `CLAUDE.md` racine).

## Ouvrir le projet

```bash
open ULTRON.xcodeproj
```

Le projet est généré depuis `project.yml` via [XcodeGen](https://github.com/yonaskolb/XcodeGen)
(`brew install xcodegen`). Le `.xcodeproj` généré est committé pour pouvoir
ouvrir directement dans Xcode sans installer XcodeGen ; si tu modifies
`project.yml` (nouvelle cible, réglages), régénère avec :

```bash
xcodegen generate
```

## Configurer le serveur

Au premier lancement, l'app demande l'adresse du serveur ULTRON (ex. l'adresse
Tailscale du Jetson, `http://100.x.x.x:4173`, ou `http://localhost:4173` en
local pendant le dev — lancer `pnpm web` à la racine du repo). Réglable à tout
moment via l'icône ⚙️ du menu principal.

## Architecture

- `ULTRON/Networking/ULTRONClient.swift` — client HTTP/SSE unique, `@MainActor`,
  qui mirror l'API du serveur (chats, turns/SSE, modèles/provider, finance,
  santé, usage, memory, skills, tools). Aucune logique métier côté client : le
  serveur reste la seule source de vérité.
- `ULTRON/Networking/SSEParser.swift` — parsing de frames SSE fait main.
- `ULTRON/Screens/Menu/` — menu principal (modules + liste de conversations
  groupée par date).
- `ULTRON/Screens/Chat/` — écran de conversation : bulles, groupes d'appels
  d'outils repliables, carte d'approbation, barre de composition (modèle /
  mode de tâche / permission).
- `ULTRON/Screens/{Finance,Health,Tokens,Skills,Memory}/` — les 5 modules.

## Hors scope v1

Panneau Agents/Schedules, mode Goal, upload de fichiers/photos, notifications
push, bloc "Thinking" repliable (aucun événement SSE dédié au raisonnement
n'existe côté serveur aujourd'hui). Voir le plan d'implémentation d'origine
pour le détail des décisions.
