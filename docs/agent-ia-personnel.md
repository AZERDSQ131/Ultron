# Recherches : Agent IA personnel "surboosté"

Compilation des recherches effectuées sur les modèles d'IA récents, OpenClaw vs Hermes Agent, les idées de use-cases pour un agent personnel universel, et la configuration pour un contrôle autonome du PC.

---

## 1. Derniers modèles d'IA (juillet 2026)

### LLM / modèles de langage
- **Claude Fable 5** (Anthropic) — leader général et sur le coding (80,3% SWE-Bench Pro)
- **Claude Sonnet 5** (Anthropic, 30 juin 2026) — meilleur pour le style d'écriture, la fidélité vocale et le suivi d'instructions complexes ; tarif d'introduction à 2$/10$ par million de tokens jusqu'au 31 août 2026
- **Claude Opus 4.8** (Anthropic) — également dans le top
- **GPT-5.6** (OpenAI, 9 juillet 2026) — famille Sol/Terra/Luna. Sol excelle en agentique (code, biologie, cybersécurité) ; Terra reprend les perfs de GPT-5.5 à moitié prix ; Luna vise vitesse et coût réduit
- **GLM 5.2 max** (Z.ai, Chine) — meilleur modèle open-weight du classement Artificial Analysis
- **Gemini 3.5 Flash** (Google) — modèle de raisonnement, 1M tokens de contexte
- **Grok 4.5** (xAI) — annoncé comme "classe Opus" mais plus rapide et moins cher
- **Seed 2.1 Pro** (ByteDance) — bon en React

### Image / vidéo
- **Seedream 5.0 Pro** (ByteDance, 8 juillet 2026) — infographies complexes, portraits réalistes, texte natif multilingue
- **Seedance 2.0** (Dreamina) — n°1 text-to-video et image-to-video
- **Muse Image** (Meta, 7 juillet 2026) — blending de photos, QR codes fonctionnels

### NVIDIA Nemotron (précision sur "Neomotron")
Le modèle utilisé est probablement **Nemotron 3** :
- **Nemotron 3 Ultra** (juin 2026) — 55B actifs / 550B total, MoE hybride Mamba-Transformer, le plus capable
- **Nemotron 3 Super** — 120B, 12B actifs, positionné pour les workloads agentiques
- **Nemotron 3 Nano / Nano Omni** — versions légères, Omni supporte image/vidéo/audio/texte
- Conçu spécifiquement pour l'agentic reasoning → bon choix pour un agent connecté à des outils

**Sources** :
- https://www.blogdumoderateur.com/ia-meilleurs-modeles-code-developpement-web-juillet-2026/
- https://felloai.com/best-ai-models/
- https://www.oreilly.com/radar/radar-trends-to-watch-july-2026/
- https://llm-stats.com/llm-updates
- https://aireleasetracker.com/latest
- https://www.nextgov.com/artificial-intelligence/2026/07/openais-advanced-gpt-56-models-be-available-public/414651/
- https://nvidianews.nvidia.com/news/nvidia-debuts-nemotron-3-family-of-open-models
- https://research.nvidia.com/labs/nemotron/Nemotron-3-Ultra/

---

## 2. OpenClaw vs Hermes Agent

### Vue d'ensemble
- **OpenClaw** : lancé fin 2025 par Peter Steinberger, 345 000 étoiles GitHub début avril 2026. Force = **breadth** (intégrations, channels, skills communautaires)
- **Hermes Agent** (Nous Research) : centré sur la **mémoire** et l'apprentissage continu (learning loop). 110-140k étoiles en 10-90 jours, framework le plus utilisé selon OpenRouter

### Sécurité
- OpenClaw : 9 CVE en 4 jours (mars 2026, dont un CVSS 9.9), ~12% de skills malveillants sur ClawHub, 135 000+ instances exposées publiquement
- Hermes : modèle de sécurité "7 couches", pas de marketplace communautaire (skills auto-générés) → évite le vecteur supply chain

### Répartition communautaire (r/openclaw, analyse de 1300+ commentaires)
- ~35% restent sur OpenClaw (écosystème de skills)
- ~30% ont basculé vers Hermes (setup plus simple, meilleure mémoire par défaut)
- ~20% utilisent les deux
- ~15% méfiants envers Hermes (soupçon d'astroturfing)
- Point de friction commun : l'auto-hébergement

### Style de messages / tâches / sous-agents
- OpenClaw : personnalisation via `SOUL.md` (nom, personnalité, limites, vibe de l'agent)
- Hermes : ton qui s'adapte progressivement via un modèle utilisateur construit dans le temps (Honcho dialectic)
- Sous-agents OpenClaw : modèle **hub-and-spoke** (orchestrateur + sous-agents isolés, chacun avec son modèle/contexte/mémoire propres, rapportent au principal)
- Sous-agents Hermes : outil `delegate_task`, dashboard web local (`localhost:port`) pour inspecter mémoire/skills/historique en direct

### Modèles recommandés selon la tâche (OpenClaw)
- Codage → Claude Opus / GPT haut de gamme
- Recherche/contenu → Claude Sonnet
- Routage/classification simple → modèles légers

**Sources** :
- https://kilo.ai/openclaw/vs-hermes
- https://thenewstack.io/persistent-ai-agents-compared/
- https://composio.dev/content/openclaw-vs-hermes-agent
- https://www.forbes.com/sites/sandycarter/2026/05/25/hermes-agentic-ai-overtakes-openclaw-10-shifts-leaders-need-to-know/
- https://xcloud.host/openclaw-sub-agent-configurations/
- https://github.com/NousResearch/hermes-agent/blob/main/README.md
- https://amankhan1.substack.com/p/how-to-make-your-openclaw-agent-useful

---

## 3. Idées pour booster l'agent Epona (mails/DB)

- **Sync auto DB ↔ Obsidian** : mise à jour automatique du vault EPONA quand la DB change
- **Digest matinal Epona** : emails urgents, rapports en attente, anomalies (client sans réponse depuis X jours)
- **Agent Forex séparé** connecté à `~/Desktop/Forex`, alertes sur seuils, journal de trades auto
- **Architecture multi-agents** (hub-and-spoke) : agent Mails, agent Code/DB, agent Recherche/Veille, agent Finance, agent Vie perso — chacun dans son topic Telegram
- **"Overnight builder"** : objectif donné le soir, exécution nocturne, résultat au matin
- **Mémoire universelle recherchable** : tout ce qui est envoyé au bot est indexé
- **Check-ins proactifs** : le bot relance sur les tâches en attente
- **Meeting → tâches structurées**
- **Agent "gardien de cohérence"** (idée composite) : compare en continu DB / mails / vault Obsidian, signale les incohérences cross-source

**Sources** :
- https://github.com/hesamsheikh/awesome-openclaw-usecases
- https://openclaw.report/ecosystem/awesome-openclaw-usecases
- https://www.roborhythms.com/openclaw-automation-ideas/
- https://www.dan-malone.com/blog/building-a-multi-agent-ai-team-in-a-telegram-forum
- https://dev.to/onin/one-openclaw-gateway-multiple-isolated-ai-assistants-one-telegram-bot-per-worker-3k97

---

## 4. Agent IA "universel" pour la vie perso

### Administration & logistique
- Brief matinal (météo, agenda, actus, tâches)
- Gestion mails/documents (extraction, classement, notification si important)
- Voyages : réservations, replanification automatique
- Vie admin : abonnements, factures, dates limites — la qualité vient surtout du **contexte** fourni, pas seulement des prompts

### Santé & bien-être
- Suivi alimentaire/sport connecté à un tracker fitness
- Suivi stress/sommeil avec recommandations adaptées au moment de la journée
- Aide à la préparation de rendez-vous médicaux, rappels de médicaments

### Finance personnelle
- Suivi des dépenses, budget, détection d'anomalies
- Conseils investissement/retraite/fiscalité (liaison possible avec vault Forex)

### Mémoire augmentée / "second brain"
- Capture vocale → note structurée (ex: "appel avec X, veut pousser à juillet" → fiche CRM + rappel)
- Auto-maintenance du vault (notes orphelines, liens cassés, score de santé)
- Rappel aléatoire de vieilles notes archivées

### Carrière / travail
- Veille emploi : scan quotidien, comparaison au profil, lettres de motivation, soumission avec approbation
- Prépa réunions, relances automatiques

### Créativité / loisirs
- Génération de mélodies, retouche photo, scripts
- Transformation de contenu long → scripts courts + idées de posts programmés
- Idées cadeaux personnalisées générées par IA

### Principe clé 2026
Un agent personnel n'attend pas la commande : il **planifie, décide, agit, apprend** — via des triggers planifiés (cron/heartbeat) plutôt que des requêtes ponctuelles. C'est le plus gros levier manquant vs un usage purement réactif.

### Idée composite : "second brain proactif"
Fusionner mémoire (capture vocale/texte), finance (Forex/dépenses), santé (sommeil/stress) et admin (factures/voyages) dans une seule mémoire persistante partagée, un seul point d'entrée (Telegram) mais des routines de fond spécialisées par domaine.

**Sources** :
- https://www.lindy.ai/blog/how-use-ai-daily-life
- https://medium.com/illumination/how-a-personal-ai-agent-can-completely-transform-your-life-starting-in-just-one-day-fd94635ea9c9
- https://www.syntaxdispatch.com/blog/best-ai-agents-for-personal-use
- https://aimultiple.com/ai-usecases
- https://www.getprosper.ai/blog/ai-agents-for-healthcare-hipaa-ehr-integration
- https://www.jenova.ai/en/resources/personal-ai-assistant-app
- https://www.iwoszapar.com/p/build-second-brain-ai-agent
- https://community.latenode.com/t/creative-ai-agent-ideas-for-personal-entertainment-and-hobbies/25475

---

## 5. Contrôle autonome du PC (organisation de fichiers)

### Deux approches
- **A. Accès filesystem direct** (recommandé pour organiser des fichiers) — MCP filesystem ou capacités natives OpenClaw, pas besoin de souris/clavier
- **B. Computer Use** (contrôle visuel complet, écran + souris/clavier) — Claude Cowork (macOS, janvier 2026), ChatGPT Agent Mode (CUA). Plus lent, plus cher, utile seulement pour piloter des apps sans accès fichier direct

### Ce que ça permet
- Tri automatique de Downloads par classification de contenu
- Renommage selon le contenu réel
- Création d'arborescence à la volée
- Cron jobs pour maintien continu
- Traitement de 1000+ fichiers en une passe

### ⚠️ Sécurité — point critique
> "File access rules... are instructions the language model follows, not hard technical boundaries."

Dire à l'agent "ne touche pas à tel dossier" dans un prompt n'est **pas une garantie technique**.

Mesures réelles :
- **Isoler l'agent** : Docker, VM dédiée, machine séparée — pas la machine principale ("Don't Run OpenClaw on Your Main Machine")
- **Monter uniquement les dossiers voulus** (bind mount Docker)
- **Ne jamais autoriser l'accès à** : gestionnaire de mots de passe, clés SSH, dossiers bancaires/confidentiels
- L'agent tourne avec les permissions du compte utilisateur — mêmes droits que toi manuellement
- Mode "approbation explicite avant chaque action fichier" recommandé au départ

### Setup pratique suggéré
1. Nouvelle instance isolée (Docker/VM) dédiée à l'organisation de fichiers, séparée de l'instance Epona (mails/DB)
2. Monter seulement les dossiers cibles (`~/Downloads`, `~/Desktop`) en lecture/écriture
3. Cron job pour passage régulier + déclenchement à la demande via Telegram
4. Mode approbation activé au début, resserré progressivement selon la confiance
5. Ajouter Computer Use seulement si besoin de piloter des applis graphiques

**Sources** :
- https://cisomarketplace.com/blog/agentic-desktop-agents-ai-local-file-access-security
- https://thedrive.ai/blog/best-ai-file-organizer-2026
- https://lumadock.com/tutorials/openclaw-file-management-automation
- https://sfailabs.com/guides/openclaw-file-system-access
- https://blog.skypilot.co/openclaw-on-skypilot/
- https://markaicode.com/openclaw-auto-organize-files/
- https://www.atomicwork.com/esm/what-is-openclaw
- https://platform.claude.com/docs/en/agents-and-tools/tool-use/computer-use-tool
- https://thenewstack.io/give-claude-ai-full-access-to-your-local-filesystem-with-mcp/
- https://pluto.security/blog/inside-claude-cowork-how-anthropics-autonomous-agent-actually-works/
