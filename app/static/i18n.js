/*
 * Minimal i18n. English is the source language: every user-visible string in
 * index.html and app.js is written in English, and a locale is just a map from
 * that English string to its translation.
 *
 * Adding a language = adding one entry to LOCALES below. Pull requests welcome.
 */
const LOCALES = {
  fr: {
    // --- header / navigation
    "Show/hide filters": "Afficher/masquer les filtres",
    "Movies": "Films",
    "TV Shows": "Séries",
    "Advanced filters": "Filtres avancés",
    "Title search": "Recherche texte",
    "Movie title": "Titre du film",
    "TV show title": "Titre de la série",
    "Year": "Année",
    "Include adult content": "Inclure le contenu adulte",
    // --- filters
    "Sort by": "Trier par",
    "Popularity ↓": "Popularité ↓",
    "Popularity ↑": "Popularité ↑",
    "Release date ↓": "Date de sortie ↓",
    "Release date ↑": "Date de sortie ↑",
    "First air date ↓": "Première diffusion ↓",
    "First air date ↑": "Première diffusion ↑",
    "Rating ↓": "Note ↓",
    "Rating ↑": "Note ↑",
    "Vote count ↓": "Nb de votes ↓",
    "Revenue ↓": "Revenus ↓",
    "Title A→Z": "Titre A→Z",
    "Genres": "Genres",
    "include": "inclure",
    "exclude": "exclure",
    "Release dates": "Dates de sortie",
    "First air date": "Première diffusion",
    "Last air date": "Dernière diffusion",
    "From": "À partir du",
    "To": "Jusqu'au",
    "Exact year": "Année exacte",
    "Rating": "Note",
    "Min vote count": "Nb de votes min",
    "Runtime (minutes)": "Durée (minutes)",
    "Language & origin": "Langue & origine",
    "Original language": "Langue originale",
    "Any": "Toutes",
    "English": "Anglais",
    "French": "Français",
    "Japanese": "Japonais",
    "Korean": "Coréen",
    "Spanish": "Espagnol",
    "German": "Allemand",
    "Italian": "Italien",
    "Chinese": "Chinois",
    "Origin country (ISO)": "Pays d'origine (ISO)",
    "Age certification": "Certification (âge)",
    "Country": "Pays",
    "People (cast & crew)": "Personnes (acteurs / réal.)",
    "Search for a person…": "Chercher une personne…",
    "Keywords": "Mots-clés",
    "Production companies": "Sociétés de production",
    "Streaming providers": "Plateformes de streaming",
    "Type": "Type",
    "All": "Tous",
    "Subscription": "Abonnement",
    "Free": "Gratuit",
    "With ads": "Avec pub",
    "Rent": "Location",
    "Buy": "Achat",
    "Search": "Rechercher",
    "Reset": "Réinitialiser",
    "Create auto-list": "Créer une liste auto",
    "My lists": "Mes listes",
    // --- results
    "Hide movies already in Radarr": "Masquer les films déjà dans Radarr",
    "Hide TV shows already in Sonarr": "Masquer les séries déjà dans Sonarr",
    "Per page": "Par page",
    "selected": "sélectionné(s)",
    "Select all": "Tout sélectionner",
    "Clear selection": "Tout désélectionner",
    "Add selection": "Ajouter la sélection",
    "No results.": "Aucun résultat.",
    "Select": "Sélectionner",
    "Details": "Détails",
    "Audio summary": "Résumé audio",
    "Already in": "Déjà dans",
    "Previous": "Précédent",
    "movies": "film(s)",
    "TV shows": "série(s)",
    "owned movies": "films possédés",
    "owned shows": "séries possédées",
    "added": "ajouté(s)",
    "failed": "échec(s)",
    "suggested": "suggéré(s)",
    "Suggested by AI": "Résultats proposés par l'IA",
    // --- add modal
    "Quality profile": "Profil de qualité",
    "Root folder": "Dossier racine",
    "Minimum availability": "Disponibilité minimale",
    "Announced": "Annoncé",
    "In cinemas": "En salle",
    "Released": "Sorti",
    "Monitor": "Surveiller",
    "Add the whole collection": "Ajouter toute la collection",
    "Search on add": "Lancer la recherche à l'ajout",
    "Add to": "Ajouter à",
    "Add": "Ajouter",
    "Cancel": "Annuler",
    "Close": "Fermer",
    "titles from the collection added": "titre(s) de la collection ajouté(s)",
    "already there": "déjà présent(s)",
    // --- details
    "Episode runtime": "Durée d'un épisode",
    "Networks": "Réseaux",
    "Created by": "Créé par",
    "Spoken languages": "Langues parlées",
    "Popularity": "Popularité",
    "episodes": "épisode(s)",
    "ep.": "ép.",
    "Crew": "Équipe technique",
    "Videos & trailers": "Vidéos & bandes-annonces",
    "Where to watch": "Où regarder",
    "backdrops": "arrière-plan(s)",
    "posters": "affiche(s)",
    "logos": "logo(s)",
    // --- auto-lists
    "Create an auto-list": "Créer une liste automatique",
    "List name": "Nom de la liste",
    "TMDB pages scanned per run (≈20 titles/page)": "Pages TMDB scannées par passage (≈20 médias/page)",
    "Save list": "Enregistrer la liste",
    "Update": "Mettre à jour",
    "Updating…": "Mise à jour…",
    "Saving…": "Enregistrement…",
    "Preview": "Aperçu",
    "My auto-lists": "Mes listes automatiques",
    "Re-scanned every 12h (and on startup). New titles matching the filters are added to Radarr (movies) or Sonarr (TV shows) automatically.":
      "Rescannées toutes les 12h (et au démarrage). Les nouveaux médias correspondant aux filtres sont ajoutés automatiquement à Radarr (films) ou Sonarr (séries).",
    "Give the list a name": "Donnez un nom à la liste",
    "List": "Liste",
    "created": "créée",
    "updated": "mise à jour",
    "scanned": "média(s) analysés",
    "new to add": "nouveau(x) à ajouter",
    "total on TMDB": "au total côté TMDB",
    "Nothing matches these filters.": "Aucun média ne correspond à ces filtres.",
    "Already there": "Déjà présent",
    "New": "Nouveau",
    "No lists yet. Set some filters, then hit “Create auto-list”.":
      "Aucune liste pour le moment. Réglez des filtres puis « Créer une liste auto ».",
    "pages scanned": "page(s) scannée(s)",
    "last run": "dernier scan",
    "Last run": "Dernier passage",
    "never": "jamais",
    "total added": "total ajoutés",
    "errors": "erreur(s)",
    "Delete this list permanently?": "Supprimer définitivement cette liste ?",
    "Movies (Radarr)": "Films (Radarr)",
    "TV shows (Sonarr)": "Séries (Sonarr)",
    "no filter (everything)": "aucun filtre (tout)",
    "until": "jusqu'à",
    "year": "année",
    // --- voice assistant
    "Voice assistant": "Assistant vocal",
    "AI voice assistant": "Assistant vocal IA",
    "Tap the mic and speak…": "Appuyez sur le micro et parlez…",
    "Speak": "Parler",
    "Listening…": "Je vous écoute…",
    "Thinking…": "Je réfléchis…",
    "Done": "Terminé",
    "Speech recognition is not supported by this browser — type your request below.":
      "Reconnaissance vocale non supportée par ce navigateur — tapez votre demande ci-dessous.",
    "Microphone denied — allow it in your browser.": "Micro refusé — autorisez le micro dans le navigateur.",
    "I did not catch that. Try again.": "Je n'ai rien entendu. Réessayez.",
    "Summary": "Résumé",
    "Voice": "Voix",
    "Replay": "Réécouter",
    "system default voice": "voix système par défaut",
    "Generating the AI summary…": "Génération du résumé par l'IA…",
    "No description.": "Pas de description.",
    "Next": "Suivant",
    "Original title": "Titre original",
    "seasons": "saison(s)",
    "Origin country": "Pays d'origine",
    "Production countries": "Pays de production",
    "TMDB rating": "Note moyenne TMDB",
    "Seasons": "Saisons",
    "View on JustWatch": "Voir sur JustWatch",
    "Similar titles": "Titres similaires",
    "Alternative titles": "Titres alternatifs",
    "Microphone error": "Erreur micro",
    "Could not load the options": "Impossible de charger les options",
    "Startup error": "Erreur d'initialisation",
    "Clear": "Effacer",
    "Overview": "Synopsis",
    "Gallery": "Galerie d'images",
    "External links": "Liens externes",
    "Release date": "Date de sortie",
    "Budget": "Budget",
    "Revenue": "Recettes",
    "Collection": "Collection",
    "Status": "Statut",
    "In production": "En production",
    "Cast": "Distribution",
    "Reviews": "Avis",
    "Filters": "Filtres",
    "Adding…": "Ajout…",
    "Yes": "Oui",
    "No": "Non",
    "Here we go!": "C'est parti !",
    "sort": "tri",
    "genres": "genres",
    "except": "sauf",
    "from": "depuis",
    "rating ≥": "note ≥",
    "language": "langue",
    "country": "pays",
    "Active": "Active",
    "Paused": "En pause",
    "Pause": "Mettre en pause",
    "Enable": "Activer",
    "none (all)": "aucun (tout)",
    "new list": "nouvelle liste",
    "Scanning…": "Analyse en cours…",
    "Loading…": "Chargement…",
    "Searching…": "Recherche…",
    "Connection failed": "Connexion impossible",
    "unavailable": "indisponible",
    "free": "libres",
    "Recommendations": "Recommandations",
    "Enter a title.": "Saisissez un titre.",
    "Official site": "Site officiel",
    "AI suggestions": "Suggestions de l'IA",
    "Delete": "Supprimer",
    "Run now": "Lancer maintenant",
    "Edit": "Modifier",
    "Adding… ({i}/{n})": "Ajout… ({i}/{n})",
    // --- startup failure screen
    "Trawlarr can't reach TMDB": "Trawlarr ne peut pas joindre TMDB",
    "Trawlarr failed to start": "Trawlarr n'a pas pu démarrer",
    "Check TMDB_API_KEY in your .env, then restart the container. See the README.":
      "Vérifiez TMDB_API_KEY dans votre fichier .env, puis redémarrez le conteneur. Voir le README.",
    "Trawlarr could not load its settings. Check the container logs, then restart it. See the README.":
      "Trawlarr n'a pas pu charger sa configuration. Consultez les logs du conteneur, puis redémarrez-le. Voir le README.",
    "Technical details": "Détails techniques",
    "Skip to results": "Aller aux résultats",
    "Results": "Résultats",
    "Add to your library": "Ajouter à la bibliothèque",
    "Title details": "Détails du média",
    "Auto-list preview": "Aperçu de la liste",
    "Spoken summary": "Résumé audio",
    // --- generic
    "Failed": "Échec",
    "Error": "Erreur",
  },
};

const LANG = (() => {
  const forced = document.documentElement.getAttribute("data-lang");
  const saved = (() => { try { return localStorage.getItem("ui-lang"); } catch (_) { return null; } })();
  const guess = (navigator.language || "en").slice(0, 2).toLowerCase();
  const pick = forced || saved || guess;
  return LOCALES[pick] ? pick : "en";
})();

/** Translate one source (English) string, with optional {placeholders}. */
function tr(str, vars) {
  let out = (LOCALES[LANG] && LOCALES[LANG][str]) || str;
  if (vars) for (const k in vars) out = out.split("{" + k + "}").join(vars[k]);
  return out;
}

/** Walk the DOM and translate text nodes, placeholders, titles and aria-labels. */
function applyI18n(root) {
  if (LANG === "en") return;
  root = root || document.body;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const todo = [];
  while (walker.nextNode()) todo.push(walker.currentNode);
  for (const node of todo) {
    const raw = node.nodeValue.trim();
    if (!raw) continue;
    const hit = LOCALES[LANG][raw];
    if (hit) node.nodeValue = node.nodeValue.replace(raw, hit);
  }
  for (const attr of ["placeholder", "title", "aria-label", "label"]) {
    root.querySelectorAll("[" + attr + "]").forEach((elm) => {
      const hit = LOCALES[LANG][elm.getAttribute(attr)];
      if (hit) elm.setAttribute(attr, hit);
    });
  }
}

/** BCP-47 locale used for dates and numbers. */
function uiLocale() {
  return LANG === "en" ? (navigator.language || "en-US") : LANG;
}

/** BCP-47 locale handed to speech synthesis and recognition. */
function speechLocale() {
  const map = { en: "en-US", fr: "fr-FR", de: "de-DE", es: "es-ES", it: "it-IT", pt: "pt-PT", nl: "nl-NL" };
  return map[LANG] || navigator.language || "en-US";
}

document.addEventListener("DOMContentLoaded", () => {
  document.documentElement.lang = LANG;
  applyI18n();
});
