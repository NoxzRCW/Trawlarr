# 🎬 Radarr Media Search

Un site web auto-hébergé (Docker) qui s'intercale entre **l'API TMDB** et **l'API Radarr**
pour offrir une recherche de films bien plus poussée que celle intégrée à Radarr —
avec **tous les filtres TMDB Discover** — et un ajout en un clic vers ta bibliothèque Radarr.

## ✨ Fonctionnalités

- **Recherche avancée (TMDB Discover)** exploitant l'intégralité des filtres :
  - Tri (popularité, date, note, votes, revenus, titre…)
  - Genres (inclure **et** exclure : `Maj+clic`)
  - Dates de sortie (plage `de`/`à`, année exacte)
  - Note moyenne min/max et nombre de votes minimum
  - Durée min/max
  - Langue originale & pays d'origine
  - Certification (classification d'âge) par pays, min/max
  - Personnes (acteurs / réalisateurs) avec autocomplétion
  - Mots-clés avec autocomplétion
  - Sociétés de production avec autocomplétion
  - Plateformes de streaming (watch providers) + type (abonnement, location, achat…)
  - Contenu adulte (option)
- **Recherche par titre** classique en complément.
- Indication **« déjà dans Radarr »** sur chaque résultat.
- **Ajout à Radarr** en un clic : choix du profil de qualité, du dossier racine,
  de la disponibilité minimale, du monitoring et du lancement de recherche immédiat.
- Les clés API restent **côté serveur** : le navigateur ne les voit jamais.

## 🚀 Démarrage rapide

1. Copie la configuration et renseigne tes valeurs :
   ```bash
   cp .env.example .env
   # puis édite .env : TMDB_API_KEY, RADARR_URL, RADARR_API_KEY
   ```

2. Lance le conteneur :
   ```bash
   docker compose up -d --build
   ```

3. Ouvre **http://localhost:8080**

## ⚙️ Configuration (.env)

| Variable | Description | Défaut |
|---|---|---|
| `TMDB_API_KEY` | Clé API TMDB v3 | — |
| `TMDB_LANGUAGE` | Langue des métadonnées | `fr-FR` |
| `TMDB_REGION` | Région (sorties / providers) | `FR` |
| `RADARR_URL` | URL de l'instance Radarr | — |
| `RADARR_API_KEY` | Clé API Radarr (Settings → General) | — |
| `RADARR_QUALITY_PROFILE_ID` | Profil par défaut à l'ajout | 1er dispo |
| `RADARR_ROOT_FOLDER` | Dossier racine par défaut | 1er dispo |
| `RADARR_MINIMUM_AVAILABILITY` | `announced`/`inCinemas`/`released` | `released` |
| `RADARR_MONITOR` | Surveiller à l'ajout | `true` |
| `RADARR_SEARCH_ON_ADD` | Lancer la recherche à l'ajout | `true` |

> **Radarr en Docker ?** Si Radarr tourne dans un autre conteneur sur le même hôte,
> mets-le sur le même réseau Docker et utilise `http://<nom_du_service_radarr>:7878`,
> ou bien `http://host.docker.internal:7878`.

## 🧱 Architecture

```
Navigateur ──> FastAPI (ce service) ──> TMDB API   (recherche / discover)
                                   └──> Radarr API (lookup / ajout / bibliothèque)
```

- **Backend** : FastAPI (`app/`) — proxy + logique métier, expose `/api/*`.
- **Frontend** : SPA statique en JS vanilla (`app/static/`).

### Endpoints principaux

| Endpoint | Rôle |
|---|---|
| `GET /api/discover?...` | Recherche avancée (tous les params TMDB Discover) |
| `GET /api/search?query=` | Recherche par titre |
| `GET /api/tmdb/genres` · `watch-providers` · `certifications` | Données de référence |
| `GET /api/tmdb/search/{person,company,keyword}` | Autocomplétion |
| `GET /api/radarr/quality-profiles` · `root-folders` | Options Radarr |
| `POST /api/radarr/add` | Ajout d'un film |
| `GET /api/health` | État des connexions TMDB / Radarr |

## 🔒 Sécurité

`.env` est ignoré par git : tes clés ne sont **pas** versionnées. Ne les commit pas.

## 🛠️ Développement local (sans Docker)

```bash
pip install -r requirements.txt
uvicorn app.main:app --reload --port 8080
```
