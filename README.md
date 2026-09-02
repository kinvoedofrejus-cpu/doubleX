# Tontine Bot — Telegram + USDT (TRC20) sur Cloudflare Workers

Robot Telegram pour épargne individuelle en USDT : chaque utilisateur choisit un
plan (créé par l'administrateur), dépose de l'USDT (réseau TRC20), et le
compte à rebours vers sa date de ramassage démarre dès la confirmation du
dépôt. Retraits automatiques (avec seuil de validation manuelle optionnel).
Annonces diffusables à tous les utilisateurs directement depuis le bot.

## Stack

- **Cloudflare Workers** (TypeScript) — hébergement serverless, edge
- **D1** — base de données (SQLite géré par Cloudflare)
- **Cron Triggers** — vérifie les dépôts, les échéances et traite les retraits toutes les 5 min
- **TronGrid API** — lecture/écriture blockchain TRON (aucun SDK Node, juste `fetch`)
- **@noble/secp256k1** + **@noble/hashes** — génération de portefeuilles TRON (pur JS, compatible Workers)

## ⚠️ Note sur les secrets et le déploiement

Si tu utilises l'intégration "Connect to Git" du dashboard Cloudflare
(déploiement automatique à chaque push GitHub), sache qu'il existe un bug
connu côté Cloudflare qui peut effacer les secrets à chaque déploiement dans
ce mode précis. Si ça t'arrive, la solution consiste à redéfinir tes secrets
dans **Settings → Variables and Secrets** après chaque déploiement (comme tu
le fais déjà), ou à désactiver le déploiement auto au profit d'un déploiement
manuel (`wrangler deploy` depuis Termux, ou bouton "Deploy" manuel du
dashboard) que tu déclenches toi-même quand le code est prêt.

## Mise en place

### 1. Créer la base D1

```bash
npx wrangler d1 create tontine-db
```

Copie le `database_id` renvoyé dans `wrangler.toml`.

### 2. Initialiser le schéma

```bash
npm run db:init:remote
```

### 3. Créer le portefeuille central (reçoit tous les dépôts balayés)

Génère une adresse TRON (ex: via Tronlink ou tout portefeuille TRON), et **finance-la
avec un peu de TRX** (~50-100 TRX pour commencer) pour qu'elle puisse elle-même payer
les frais des envois de gas vers chaque adresse de dépôt lors du sweep.

### 4. Configurer les secrets (jamais dans le code ni sur GitHub)

```bash
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put ADMIN_API_KEY
npx wrangler secret put WALLET_ENCRYPTION_KEY
npx wrangler secret put TRONGRID_API_KEY
npx wrangler secret put CENTRAL_WALLET_ADDRESS
npx wrangler secret put CENTRAL_WALLET_PRIVATE_KEY
```

- `TELEGRAM_BOT_TOKEN` : obtenu via @BotFather
- `TELEGRAM_WEBHOOK_SECRET` : une chaîne aléatoire que tu inventes
- `ADMIN_API_KEY` : une chaîne aléatoire pour protéger l'espace admin
- `WALLET_ENCRYPTION_KEY` : une chaîne aléatoire longue (chiffre les clés privées en base)
- `TRONGRID_API_KEY` : clé gratuite sur https://www.trongrid.io/
- `CENTRAL_WALLET_ADDRESS` : l'adresse TRON créée à l'étape 3
- `CENTRAL_WALLET_PRIVATE_KEY` : sa clé privée — **extrêmement sensible**, ne la partage jamais, ne la commit jamais

⚠️ Ce portefeuille central détient (à terme) la totalité des fonds de la
plateforme. Sa clé privée en `wrangler secret` est déjà mieux que du code en
clair, mais pour de gros volumes, envisage un cold wallet + limites de
retrait strictes, voire un multi-sig, plutôt qu'une clé unique accessible
au Worker.

### 5. Déployer

```bash
npm install
npm run deploy
```

### 6. Brancher le webhook et le menu de commandes

Ouvre une seule fois cette URL dans ton navigateur (remplace les valeurs) —
elle configure à la fois le webhook Telegram et le menu de commandes
persistant en bas de l'écran :

```
https://<ton-worker>.workers.dev/setup?key=<ADMIN_API_KEY>
```

Tu dois voir une réponse JSON avec `"ok": true` pour les deux parties. À
relancer si tu changes de token bot ou de domaine de Worker.

### 7. Créer ton premier plan (via l'API admin)

```bash
curl -X POST https://<ton-worker>.workers.dev/admin/api/plans \
  -H "Authorization: Bearer <ADMIN_API_KEY>" \
  -H "Content-Type: application/json" \
  -d '{
    "name": "Plan Découverte",
    "amount_type": "fixed",
    "amount_fixed": 20,
    "duration_days": 30,
    "gain_percent": 10
  }'
```

### 8. Bannière d'accueil (optionnel)

Héberge une image en ligne (GitHub — glisse-la dans un dossier `assets/` de
ton dépôt et utilise son lien "Raw" —, Imgur, etc.) et mets son URL dans
`WELCOME_IMAGE_URL` (`wrangler.toml`, variable normale, pas un secret). Le
bot l'affichera en bannière au-dessus du menu à chaque `/start`. Format
recommandé : image carrée ou légèrement horizontale, en dessous de 5 Mo.

### 9. Groupe de discussion et chaîne d'annonces

1. Crée un **groupe** Telegram classique, génère un lien d'invitation, et mets-le
   dans `TELEGRAM_GROUP_LINK` (`wrangler.toml`, pas un secret). Le bot l'affiche
   automatiquement aux utilisateurs après `/start`.
2. Crée une **chaîne** Telegram, ajoute ton bot comme administrateur, puis
   récupère son ID numérique (négatif, ex: `-100123456789` — envoie un message
   dans la chaîne et regarde via `https://api.telegram.org/bot<TOKEN>/getUpdates`,
   ou ajoute temporairement un bot comme @getidsbot). Mets cet ID dans
   `TELEGRAM_ANNOUNCEMENT_CHANNEL_ID`. Chaque retrait envoyé y sera annoncé
   automatiquement (montant + adresse tronquée, sans donnée personnelle).

## Endpoints admin disponibles

- `GET /admin/api/plans` — liste tous les plans
- `POST /admin/api/plans` — crée un plan
- `PUT /admin/api/plans/:id` — modifie un plan
- `DELETE /admin/api/plans/:id` — désactive un plan (garde l'historique)
- `GET /admin/api/deposits?limit=&offset=` — liste paginée des dépôts
- `GET /admin/api/deposits/matured?limit=&offset=` — comptes arrivés à terme, avec
  leur adresse de retrait enregistrée, statut du retrait et infos Telegram
- `GET /admin/api/deposits/mismatched` — dépôts à montant hors plan, en attente de régularisation
- `POST /admin/api/deposits/:id/regularize` — accepte le montant reçu tel quel, le dépôt reprend son cours normal
- `POST /admin/api/deposits/:id/refund` — rembourse le montant reçu vers une adresse fournie (`{ "destination_address": "T..." }`)
- `GET /admin/api/withdrawals/pending?limit=&offset=` — retraits en attente de validation manuelle
- `POST /admin/api/withdrawals/:id/approve` — valide un retrait (envoyé au prochain cron)
- `POST /admin/api/withdrawals/:id/reject` — refuse/bloque un retrait (fonctionne aussi
  pendant la fenêtre de délai, avant l'envoi réel)
- `GET /admin/api/withdrawals/upcoming?limit=&offset=` — retraits approuvés pas encore
  envoyés (dans la fenêtre de délai `WITHDRAWAL_HOLD_MINUTES`) — c'est ici que tu peux
  bloquer un retrait suspect avant qu'il ne parte, même sans seuil configuré
- `POST /admin/api/broadcast` — envoie une annonce à **tous** les utilisateurs du bot
  (`{ "message": "texte de l'annonce" }`), en plus de la chaîne si configurée
- `GET /admin/api/users?search=` — recherche un utilisateur par @pseudo ou ID Telegram
- `POST /admin/api/users/:id/block` — force la validation manuelle sur tous les futurs
  retraits de cet utilisateur, quel que soit le montant
- `POST /admin/api/users/:id/unblock` — retire ce blocage
- `GET /admin/api/audit-log?limit=&offset=` — journal des actions admin (qui a fait quoi, quand)

## Site web utilisateur (en plus du bot Telegram)

`site/index.html` est un site autonome (un seul fichier HTML/JS, aucune
dépendance) qui offre **exactement les mêmes fonctionnalités que le bot** :
choisir un plan, déposer, suivre ses dépôts, retirer, gérer son adresse de
retrait. Comme il tape dans la même base D1 via `../user/actions.ts` (le
même code que le bot utilise), **une action faite sur le site apparaît
immédiatement dans le bot, et inversement** — c'est un seul compte, deux
façons d'y accéder.

### Comment l'identité est partagée entre le bot et le site

Le site utilise le widget officiel **"Login with Telegram"** : l'utilisateur
clique sur "Se connecter avec Telegram", confirme dans l'app Telegram, et le
site reçoit une preuve cryptographique signée par Telegram (vérifiée côté
Worker avec ton `TELEGRAM_BOT_TOKEN`) prouvant son identité — sans mot de
passe, sans double inscription. Cette identité correspond exactement au même
`telegram_id` que celui utilisé quand la personne parle au bot.

### Mise en place

1. **Autorise ton domaine auprès de @BotFather** — le widget de connexion ne
   fonctionne que sur un domaine explicitement approuvé :
   - Ouvre @BotFather → `/setdomain` → sélectionne ton bot → colle le domaine
     où tu vas héberger `site/index.html` (ex: `tonpseudo.github.io`, sans
     `https://` ni chemin)
2. **Héberge `site/index.html`** — le plus simple est GitHub Pages, comme
   pour le tableau de bord admin (Settings → Pages → branche `main` →
   dossier `/site`).
3. **Ajoute le secret `SESSION_SECRET`** sur Cloudflare (Settings → Variables
   and Secrets → type Secret) — une chaîne aléatoire longue, différente de
   tous les autres secrets. Elle signe les sessions du site.
4. *(Optionnel mais recommandé)* Renseigne `SITE_ORIGIN` dans `wrangler.toml`
   avec l'URL exacte de ton site une fois hébergé (ex:
   `https://tonpseudo.github.io`), pour que seul ton site puisse appeler
   l'API utilisateur avec les identifiants d'un visiteur. Laisse vide (`*`)
   pendant les tests.
5. Ouvre ton site — au premier lancement, il te demande l'URL de ton Worker
   et le nom d'utilisateur de ton bot (sans `@`), stockés localement dans le
   navigateur.

## Espace admin dans Telegram

En plus du tableau de bord web, tu peux tout gérer directement depuis Telegram
avec la commande **`/admin`** (visible uniquement dans le menu des chats listés
dans `ADMIN_TELEGRAM_CHAT_ID` — invisible pour tout autre utilisateur, et la
commande ne répond à personne d'autre même si quelqu'un la tape).

Ce que tu peux y faire :
- Voir un résumé (plans actifs, comptes à terme, montants à régulariser, retraits à valider)
- Valider ou refuser un retrait en attente, un par un
- Régulariser ou rembourser un dépôt à montant erroné (envoie l'adresse de destination en réponse)
- Bloquer un utilisateur (envoie son @pseudo ou son ID Telegram en réponse)
- Envoyer une annonce à tous les utilisateurs

Pratique pour les actions rapides depuis ton téléphone ; le tableau de bord web
reste plus complet pour la création de plans, la pagination des listes, et le
journal d'audit détaillé. Les deux partagent la même logique (`src/admin/actions.ts`)
et le même journal d'audit — chaque action y est marquée `"source": "telegram"`
ou `"source": "web"`.

## Interface web admin

Un tableau de bord autonome est fourni dans `admin-panel/index.html` — un seul
fichier HTML/JS sans dépendance, à ouvrir directement dans un navigateur (ou à
héberger n'importe où : GitHub Pages, Cloudflare Pages, etc.). Renseigne
l'URL de ton Worker et ta clé `ADMIN_API_KEY` au premier lancement (stockées
localement dans le navigateur). Onglets : Plans, Dépôts, Comptes à terme,
Montants erronés (régularisation/remboursement), Retraits en attente,
Utilisateurs (recherche + blocage), Annonces, Journal d'audit.

## Garde-fous ajoutés

- **Verrou anti-chevauchement du cron** (`cron_locks`) — empêche deux exécutions
  de tourner en parallèle si un passage prend plus de temps que prévu.
- **Détection des montants hors plan** — un dépôt qui ne respecte pas la plage
  min/max du plan passe en statut `mismatched_amount` au lieu d'être traité en
  silence ; l'admin est notifié sur Telegram (`ADMIN_TELEGRAM_CHAT_ID`) et peut
  régulariser ou rembourser depuis l'espace admin.
- **Notification admin automatique** — chaque retrait nécessitant une validation
  manuelle envoie une alerte Telegram à l'admin (une seule fois, via `notified_admin_at`).
- **Retraits automatiques par défaut** — sans seuil ni délai configurés, un
  retrait part dès le prochain passage du cron (~5 min). Le seul levier de
  contrôle est le **blocage par utilisateur** ci-dessous : bloque un utilisateur
  *avant* qu'il ne demande un retrait si tu veux garder un œil sur son cas —
  ses futurs retraits passeront alors en validation manuelle.
- **Blocage par utilisateur** (onglet "👤 Utilisateurs") — force la validation
  manuelle sur tous les futurs retraits d'un utilisateur précis, quel que soit
  le montant, indépendamment du seuil global.
- *(Optionnel)* Un délai de sécurité avant envoi peut être réactivé via
  `WITHDRAWAL_HOLD_MINUTES` (0 par défaut = instantané) si tu préfères garder
  une fenêtre pour intervenir sur *tous* les retraits plutôt que seulement
  ceux des utilisateurs bloqués.
- **Anti-abus** — un utilisateur ne peut pas générer plus de 3 adresses de dépôt
  en attente simultanément pour le même plan (limite dans `handleChoosePlan`).
- **Journal d'audit** — chaque action admin (création/modif de plan, validation/refus
  de retrait, régularisation, remboursement, blocage/déblocage utilisateur, annonce)
  est enregistrée dans `admin_audit_log`.
- **`/help`** — commande d'aide dans le bot.
- **Interface plus présentative** — menu principal en grille 2×2, boutons
  "🏠 Retour au menu" sur les écrans secondaires, cartes de plans mises en forme,
  menu de commandes persistant (`/plans`, `/depots`, `/parametres`, `/help`)
  visible en bas de l'écran Telegram, bannière d'accueil optionnelle.
- **Annonces diffusées** — envoie un message à tous les utilisateurs du bot
  d'un coup, depuis l'onglet "📢 Annonces" de l'espace admin.

## ⚠️ Points de sécurité à valider avant mise en production

1. **Signature des transactions TRON** (`src/tron/trongrid.ts`) — implémentée mais
   à tester intensivement sur le testnet TRON (Nile/Shasta) avant d'y faire
   transiter de vrais fonds.
2. **Sweep automatique** — chaque dépôt confirmé est balayé vers le portefeuille
   central (`sweepConfirmedDeposits` dans `src/scheduled.ts`) : le central envoie
   d'abord un peu de TRX à l'adresse de dépôt pour payer les frais, puis
   l'adresse de dépôt renvoie tout l'USDT au central. Vérifie que le solde TRX
   du portefeuille central reste suffisant pour financer ces envois de gas en continu.
3. **Tests sur testnet obligatoires** — ceci ne peut pas être "corrigé" par du
   code : il faut déployer ce projet sur le testnet TRON (Nile ou Shasta,
   `TRONGRID_API_URL` a un équivalent testnet) et faire tourner des dépôts/retraits
   réels avant de connecter de vrais fonds. Aucune quantité de relecture ne
   remplace un test en conditions réelles pour du code qui manipule des clés privées.
4. **Cadre légal** — un système de collecte de fonds avec promesse de gain
   (+X% à l'échéance) peut relever de la réglementation sur les produits
   financiers/l'épargne selon ton pays. C'est un point juridique, pas technique :
   fais-le valider par quelqu'un de qualifié avant toute diffusion publique.
5. **Espace admin visuel** — une première version existe maintenant
   (`admin-panel/index.html`), fonctionnelle mais volontairement simple (pas de
   design poussé, pas d'authentification multi-admin). À étoffer selon tes besoins.

## Structure du projet

```
tontine-bot/
├── wrangler.toml          # Config Cloudflare Workers
├── schema.sql              # Schéma D1
├── migrations/
│   ├── 002_add_sweep_columns.sql   # Sweep vers portefeuille central
│   ├── 003_add_settings.sql        # Adresse de retrait + état de conversation
│   ├── 004_add_safeguards.sql      # Verrou cron, journal d'audit, statuts montant erroné
│   ├── 005_add_withdrawal_hold.sql # Fenêtre de délai avant envoi d'un retrait
│   └── 006_add_user_blocking.sql   # Blocage des retraits par utilisateur
├── admin-panel/
│   └── index.html          # Tableau de bord admin web (autonome, HTML/JS)
├── site/
│   └── index.html          # Site utilisateur (mêmes fonctions que le bot, connecté via Telegram)
├── src/
│   ├── index.ts            # Point d'entrée (webhook, API admin, API site, /setup, cron)
│   ├── scheduled.ts         # Détection dépôts, sweep, échéances, retraits auto
│   ├── bot/
│   │   ├── telegram.ts      # Appels API Telegram
│   │   ├── handlers.ts      # Logique des commandes du bot (utilise user/actions.ts)
│   │   └── admin.ts         # Espace admin dans Telegram (utilise admin/actions.ts)
│   ├── user/
│   │   └── actions.ts       # Logique métier utilisateur, partagée bot + site web
│   ├── admin/
│   │   ├── api.ts           # API REST pour le tableau de bord admin
│   │   └── actions.ts       # Logique métier admin, partagée API web + Telegram
│   ├── web/
│   │   └── api.ts           # API REST pour le site utilisateur (auth Telegram Login)
│   ├── tron/
│   │   ├── wallet.ts        # Génération d'adresse TRON
│   │   └── trongrid.ts      # Appels TronGrid (lecture/envoi)
│   └── utils/
│       ├── base58.ts        # Encodage adresse TRON
│       ├── crypto.ts        # Chiffrement des clés privées (AES-GCM)
│       └── session.ts       # Jetons de session + vérification Telegram Login Widget
```
