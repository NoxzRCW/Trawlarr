"use strict";

const api = (path, opts) => fetch(`/api${path}`, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
  return data;
});

const state = {
  config: null,
  imageBase: "https://image.tmdb.org/t/p",
  media: "movie",     // "movie" (Radarr) | "tv" (Sonarr)
  mode: "discover",
  cursor: 0,          // absolute item index where the current page starts
  viewPage: 1,        // page number shown to the user
  cursorStack: [],    // history of start cursors, for the "Précédent" button
  nextCursor: 0,      // cursor for the next page, returned by the backend
  hasMore: false,
  totalResults: 0,
  // selections
  genres: new Map(),       // id -> "include" | "exclude"
  people: new Map(),       // id -> name
  keywords: new Map(),     // id -> name
  companies: new Map(),    // id -> name
  providers: new Map(),    // id -> name
  profiles: [],
  folders: [],
  pendingMovie: null,
  bulkMovies: null,
  pendingListFilters: {},
  editingListId: null,
  listModalMedia: "movie",
  listModalProfiles: [],
  listModalFolders: [],
  hideOwned: false,
  pageSize: 20,
  selected: new Map(),   // tmdb id -> movie (current selection for bulk add)
  currentResults: [],    // movies shown on the current page
};

const $ = (sel) => document.querySelector(sel);
const el = (tag, cls, txt) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (txt != null) e.textContent = txt;
  return e;
};

function toast(msg, ok = true) {
  const t = el("div", `toast ${ok ? "ok" : "err"}`, msg);
  document.body.appendChild(t);
  setTimeout(() => t.remove(), 3500);
}

// ----------------------- media helpers -----------------------
const isTv = () => state.media === "tv";
// Library-membership flag set by the backend (Radarr for movies, Sonarr for series).
const isOwned = (m) => (isTv() ? m.in_sonarr : m.in_radarr);
const libName = () => (isTv() ? "Sonarr" : "Radarr");
const paths = () => (isTv()
  ? { discover: "/tv/discover", search: "/tv/search", genres: "/tmdb/tv/genres",
      providers: "/tmdb/tv/watch-providers", profiles: "/sonarr/quality-profiles",
      folders: "/sonarr/root-folders", add: "/sonarr/add" }
  : { discover: "/discover", search: "/search", genres: "/tmdb/genres",
      providers: "/tmdb/watch-providers", profiles: "/radarr/quality-profiles",
      folders: "/radarr/root-folders", add: "/radarr/add" });
const libDefaults = () => (isTv() ? state.config.sonarr_defaults : state.config.defaults) || {};

// Adapt filter UI to the selected media type (TV has no people / certification
// filters and uses first-air-date wording).
function applyMediaUI() {
  $("#fs-people").classList.toggle("hidden", isTv());
  $("#fs-cert").classList.toggle("hidden", isTv());
  $("#fs-dates-legend").textContent = isTv() ? "Première diffusion" : "Dates de sortie";
  const sort = $("#f-sort");
  const movieSort = [
    ["popularity.desc", "Popularité ↓"], ["popularity.asc", "Popularité ↑"],
    ["primary_release_date.desc", "Date de sortie ↓"], ["primary_release_date.asc", "Date de sortie ↑"],
    ["vote_average.desc", "Note ↓"], ["vote_average.asc", "Note ↑"],
    ["vote_count.desc", "Nb de votes ↓"], ["revenue.desc", "Revenus ↓"],
    ["original_title.asc", "Titre A→Z"],
  ];
  const tvSort = [
    ["popularity.desc", "Popularité ↓"], ["popularity.asc", "Popularité ↑"],
    ["first_air_date.desc", "Première diffusion ↓"], ["first_air_date.asc", "Première diffusion ↑"],
    ["vote_average.desc", "Note ↓"], ["vote_average.asc", "Note ↑"],
    ["vote_count.desc", "Nb de votes ↓"], ["name.asc", "Titre A→Z"],
  ];
  sort.innerHTML = (isTv() ? tvSort : movieSort)
    .map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  $("#hide-owned-label").textContent = isTv()
    ? "Masquer les séries déjà dans Sonarr"
    : "Masquer les films déjà dans Radarr";
  $("#q-text-label") && ($("#q-text-label").textContent = isTv() ? "Titre de la série" : "Titre du film");
}

// ----------------------- init -----------------------
async function init() {
  state.config = await api("/config");
  state.imageBase = state.config.image_base;
  document.title = state.config.title;

  applyMediaUI();
  if (state.config.integrations && state.config.integrations.mistral) {
    $("#assistant-fab").classList.remove("hidden");
  }
  await Promise.all([loadHealth(), loadGenres(), loadProviders(), loadLibraryOptions()]);
  bindUI();
  search();
}

async function loadHealth() {
  try {
    const h = await api("/health");
    // Each service: status dot + name + (version on desktop only).
    const svc = (name, ok, ver) =>
      `<span class="svc" title="${ver || (ok ? "OK" : "indisponible")}">` +
      `<span class="dot ${ok ? "ok" : "ko"}"></span>${name}` +
      `${ver ? `<span class="ver">${ver}</span>` : ""}</span>`;
    $("#health").innerHTML =
      svc("TMDB", h.tmdb) + svc("Radarr", h.radarr, h.radarr_version) + svc("Sonarr", h.sonarr, h.sonarr_version);
  } catch (e) { $("#health").textContent = "Connexion impossible"; }
}

async function loadGenres() {
  state.genres.clear();
  const { genres } = await api(paths().genres);
  const box = $("#f-genres");
  box.innerHTML = "";
  genres.forEach((g) => {
    const chip = el("span", "chip", g.name);
    chip.dataset.gid = g.id;
    chip.onclick = (ev) => {
      const cur = state.genres.get(g.id);
      if (ev.shiftKey) {
        // PC shortcut: jump straight to exclude (toggle).
        state.genres.set(g.id, cur === "exclude" ? undefined : "exclude");
      } else {
        // Touch-friendly cycle: rien → inclure → exclure → rien.
        state.genres.set(g.id, cur === undefined ? "include" : cur === "include" ? "exclude" : undefined);
      }
      const mode = state.genres.get(g.id);
      if (!mode) state.genres.delete(g.id);
      chip.className = "chip" + (mode ? " " + mode : "");
    };
    box.appendChild(chip);
  });
}

async function loadProviders() {
  state.providers.clear();
  const { results } = await api(paths().providers);
  const box = $("#f-providers");
  box.innerHTML = "";
  (results || []).slice(0, 25).forEach((p) => {
    const chip = el("span", "chip", p.provider_name);
    chip.onclick = () => {
      if (state.providers.has(p.provider_id)) {
        state.providers.delete(p.provider_id);
        chip.classList.remove("include");
      } else {
        state.providers.set(p.provider_id, p.provider_name);
        chip.classList.add("include");
      }
    };
    box.appendChild(chip);
  });
}

async function loadLibraryOptions() {
  try {
    state.profiles = await api(paths().profiles);
    state.folders = await api(paths().folders);
    $("#modal-profile").innerHTML = state.profiles
      .map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    $("#modal-folder").innerHTML = state.folders
      .map((f) => `<option value="${f.path}">${f.path} (${fmtBytes(f.freeSpace)} libres)</option>`).join("");
  } catch (e) {
    console.warn(`${libName()} options unavailable`, e);
  }
}

// ----------------------- autocomplete factories -----------------------
function setupAutocomplete(inputSel, resultsSel, selectedSel, endpoint, store, labelKey) {
  const input = $(inputSel), results = $(resultsSel), selected = $(selectedSel);
  let timer;
  input.addEventListener("input", () => {
    clearTimeout(timer);
    const q = input.value.trim();
    if (q.length < 2) { results.innerHTML = ""; return; }
    timer = setTimeout(async () => {
      try {
        const data = await api(`${endpoint}?query=${encodeURIComponent(q)}`);
        results.innerHTML = "";
        (data.results || []).slice(0, 8).forEach((item) => {
          const opt = el("div", "opt", item[labelKey] + (item.known_for_department ? ` (${item.known_for_department})` : ""));
          opt.onclick = () => {
            store.set(item.id, item[labelKey]);
            renderSelected(selected, store);
            results.innerHTML = "";
            input.value = "";
          };
          results.appendChild(opt);
        });
      } catch (e) { /* ignore */ }
    }, 300);
  });
}

function renderSelected(container, store) {
  container.innerHTML = "";
  store.forEach((name, id) => {
    const chip = el("span", "chip", name + " ✕");
    chip.onclick = () => { store.delete(id); renderSelected(container, store); };
    container.appendChild(chip);
  });
}

// ----------------------- build query -----------------------
function val(sel) { const v = $(sel).value.trim(); return v === "" ? null : v; }

function buildDiscoverParams() {
  const p = new URLSearchParams();
  const add = (k, v) => { if (v != null && v !== "") p.set(k, v); };

  add("sort_by", $("#f-sort").value);
  add("cursor", state.cursor);
  add("page_size", state.pageSize);
  if (state.hideOwned) add("hide_owned", "true");
  if ($("#f-adult").checked) add("include_adult", "true");

  const inc = [...state.genres].filter(([, m]) => m === "include").map(([id]) => id);
  const exc = [...state.genres].filter(([, m]) => m === "exclude").map(([id]) => id);
  if (inc.length) add("with_genres", inc.join(","));
  if (exc.length) add("without_genres", exc.join(","));

  // Date fields differ between movies (release date) and series (first air date).
  if (isTv()) {
    add("first_air_date.gte", val("#f-date-gte"));
    add("first_air_date.lte", val("#f-date-lte"));
    add("first_air_date_year", val("#f-year"));
  } else {
    add("primary_release_date.gte", val("#f-date-gte"));
    add("primary_release_date.lte", val("#f-date-lte"));
    add("primary_release_year", val("#f-year"));
  }

  add("vote_average.gte", val("#f-vote-gte"));
  add("vote_average.lte", val("#f-vote-lte"));
  add("vote_count.gte", val("#f-votecount-gte"));

  add("with_runtime.gte", val("#f-runtime-gte"));
  add("with_runtime.lte", val("#f-runtime-lte"));

  add("with_original_language", val("#f-language"));
  // Origin country as an OR condition: TMDB treats "," as AND and "|" as OR.
  const originCountry = val("#f-origin-country");
  if (originCountry) add("with_origin_country", originCountry.replace(/[,\s]+/g, "|"));

  // Certification and people filters only apply to movies.
  if (!isTv()) {
    const certCountry = val("#f-cert-country");
    if (certCountry) {
      add("certification_country", certCountry);
      add("certification.gte", val("#f-cert-gte"));
      add("certification.lte", val("#f-cert-lte"));
    }
    if (state.people.size) add("with_people", [...state.people.keys()].join(","));
  }

  if (state.keywords.size) add("with_keywords", [...state.keywords.keys()].join(","));
  if (state.companies.size) add("with_companies", [...state.companies.keys()].join(","));

  if (state.providers.size) {
    add("with_watch_providers", [...state.providers.keys()].join("|"));
    add("watch_region", state.config.region);
    add("with_watch_monetization_types", val("#f-monetization"));
  }
  return p;
}

// ----------------------- search -----------------------
// Start a brand-new search: reset the pagination cursor to the first page.
function newSearch() {
  state.cursor = 0;
  state.viewPage = 1;
  state.cursorStack = [];
  state.selected.clear();
  if (state.closeFilters) state.closeFilters();
  search();
}

async function search() {
  $("#status").textContent = "Recherche…";
  $("#results").innerHTML = "";
  try {
    let data;
    if (state.mode === "search") {
      const q = val("#q-text");
      if (!q) { $("#status").textContent = "Saisissez un titre."; return; }
      const params = new URLSearchParams({ query: q, cursor: state.cursor });
      if (val("#q-year")) params.set("year", val("#q-year"));
      if ($("#q-adult-search").checked) params.set("include_adult", "true");
      if (state.hideOwned) params.set("hide_owned", "true");
      params.set("page_size", state.pageSize);
      data = await api(`${paths().search}?${params}`);
    } else {
      data = await api(`${paths().discover}?${buildDiscoverParams()}`);
    }
    state.nextCursor = data.next_cursor ?? 0;
    state.hasMore = !!data.has_more;
    state.totalResults = data.total_results ?? (data.results || []).length;
    renderResults(data.results || []);
    const noun = isTv() ? "série(s)" : "film(s)";
    const owned = isTv() ? "séries possédées" : "films possédés";
    const count = state.hideOwned
      ? `${state.totalResults} ${noun} au total (${owned} masqué(e)s)`
      : `${state.totalResults} ${noun}`;
    $("#status").textContent = `${count} · page ${state.viewPage}`;
    renderPagination();
  } catch (e) {
    $("#status").textContent = "Erreur : " + e.message;
  }
}

function renderResults(movies) {
  state.currentResults = movies;
  const grid = $("#results");
  grid.innerHTML = "";
  if (!movies.length) {
    grid.innerHTML = "<p style='color:var(--muted)'>Aucun résultat.</p>";
    updateSelectionBar();
    return;
  }
  movies.forEach((m) => {
    const card = el("div", "card");
    if (state.selected.has(m.id)) card.classList.add("selected");
    const img = el("img", "poster");
    img.src = m.poster_path ? `${state.imageBase}/w342${m.poster_path}` : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
    img.loading = "lazy";
    card.appendChild(img);

    // Selection checkbox (only for items not already in the library).
    if (!isOwned(m)) {
      const box = el("input", "select-box");
      box.type = "checkbox";
      box.checked = state.selected.has(m.id);
      box.title = "Sélectionner";
      box.onchange = () => {
        if (box.checked) state.selected.set(m.id, m); else state.selected.delete(m.id);
        card.classList.toggle("selected", box.checked);
        updateSelectionBar();
      };
      card.appendChild(box);
    }

    const body = el("div", "body");
    body.appendChild(el("div", "title", m.title || m.name));
    const meta = el("div", "meta");
    const year = (m.release_date || m.first_air_date || "").slice(0, 4);
    meta.appendChild(el("span", null, year || "—"));
    meta.appendChild(el("span", "rating", `★ ${(m.vote_average || 0).toFixed(1)}`));
    body.appendChild(meta);
    body.appendChild(el("div", "overview", m.overview || "Pas de description."));

    const detailBtn = el("button", "detail-btn", "ⓘ Détails");
    detailBtn.onclick = () => openDetails(m);
    body.appendChild(detailBtn);

    if (isOwned(m)) {
      body.appendChild(el("div", "badge-in", `✓ Déjà dans ${libName()}`));
    } else {
      const btn = el("button", "primary", "+ Ajouter");
      btn.onclick = () => openModal(m);
      body.appendChild(btn);
    }
    card.appendChild(body);
    grid.appendChild(card);
  });
  updateSelectionBar();
}

// Items on the current page that can still be selected (not in the library).
function selectableOnPage() {
  return state.currentResults.filter((m) => !isOwned(m));
}

function updateSelectionBar() {
  const bar = $("#selection-bar");
  const selectable = selectableOnPage();
  // Hide the bar entirely when there's nothing to select on this page.
  bar.classList.toggle("hidden", selectable.length === 0 && state.selected.size === 0);
  const n = state.selected.size;
  $("#selection-count").textContent = `${n} sélectionné(s)`;
  $("#add-selection").disabled = n === 0;
  $("#add-selection").textContent = n ? `+ Ajouter la sélection (${n})` : "+ Ajouter la sélection";
}

function renderPagination() {
  const box = $("#pagination");
  box.innerHTML = "";
  const hasPrev = state.cursorStack.length > 0;
  if (!hasPrev && !state.hasMore) return;
  const prev = el("button", null, "← Précédent");
  prev.disabled = !hasPrev;
  prev.onclick = () => {
    state.cursor = state.cursorStack.pop();
    state.viewPage--;
    search();
    window.scrollTo(0, 0);
  };
  const next = el("button", null, "Suivant →");
  next.disabled = !state.hasMore;
  next.onclick = () => {
    state.cursorStack.push(state.cursor);
    state.cursor = state.nextCursor;
    state.viewPage++;
    search();
    window.scrollTo(0, 0);
  };
  box.appendChild(prev);
  box.appendChild(el("span", null, `Page ${state.viewPage}`));
  box.appendChild(next);
}

// ----------------------- add to library modal -----------------------
function applyModalDefaults() {
  const d = libDefaults();
  if (d.quality_profile_id) $("#modal-profile").value = d.quality_profile_id;
  if (d.root_folder) $("#modal-folder").value = d.root_folder;
  if (d.minimum_availability) $("#modal-availability").value = d.minimum_availability;
  $("#modal-monitor").checked = d.monitor;
  $("#modal-searchnow").checked = d.search_on_add;
  // Minimum availability is a Radarr-only concept; collections are movie-only.
  $("#modal-availability-row").hidden = isTv();
  $("#modal-collection-row").hidden = true;
  $("#modal-collection").checked = false;
  $("#modal-collection-name").textContent = "";
  $("#modal-add").textContent = `Ajouter à ${libName()}`;
}

function openModal(movie) {
  state.pendingMovie = movie;
  state.bulkMovies = null;
  const title = movie.title || movie.name;
  const year = (movie.release_date || movie.first_air_date || "").slice(0, 4);
  $("#modal-title").textContent = year ? `${title} (${year})` : title;
  applyModalDefaults();
  // Collection option only makes sense for a single movie.
  if (!isTv()) detectCollection(movie.id);
  $("#modal").classList.remove("hidden");
}

function openBulkModal() {
  const movies = [...state.selected.values()];
  if (!movies.length) return;
  state.pendingMovie = null;
  state.bulkMovies = movies;
  const noun = isTv() ? "série(s)" : "film(s)";
  $("#modal-title").textContent = `Ajouter ${movies.length} ${noun} sélectionné(s)`;
  applyModalDefaults();
  $("#modal").classList.remove("hidden");
}

async function detectCollection(tmdbId) {
  try {
    const detail = await api(`/tmdb/movie/${tmdbId}`);
    const coll = detail.belongs_to_collection;
    // Ignore stale responses if the user already opened another movie.
    if (!state.pendingMovie || state.pendingMovie.id !== tmdbId) return;
    if (coll && coll.id) {
      $("#modal-collection-name").textContent = `(${coll.name})`;
      $("#modal-collection-row").hidden = false;
    }
  } catch (e) { /* collection detection is best-effort */ }
}

function modalOptions() {
  const opts = {
    quality_profile_id: Number($("#modal-profile").value) || null,
    root_folder: $("#modal-folder").value || null,
    monitor: $("#modal-monitor").checked,
    search_on_add: $("#modal-searchnow").checked,
  };
  if (!isTv()) opts.minimum_availability = $("#modal-availability").value;
  return opts;
}

async function confirmAdd() {
  if (state.bulkMovies) { await confirmBulkAdd(); return; }

  const btn = $("#modal-add");
  const lib = libName();
  btn.disabled = true; btn.textContent = "Ajout…";
  const addCollection = !isTv() && !$("#modal-collection-row").hidden && $("#modal-collection").checked;
  try {
    const res = await api(paths().add, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdb_id: state.pendingMovie.id,
        ...modalOptions(),
        add_collection: addCollection,
      }),
    });
    if (addCollection && res && Array.isArray(res.added)) {
      const n = res.added.length;
      const skipped = (res.skipped || []).length;
      let msg = `${n} film(s) de la collection ajouté(s) ✓`;
      if (skipped) msg += ` · ${skipped} déjà présent(s)`;
      if (res.errors && res.errors.length) msg += ` · ${res.errors.length} échec(s)`;
      toast(msg, !(res.errors && res.errors.length));
    } else {
      const title = state.pendingMovie.title || state.pendingMovie.name;
      toast(`"${title}" ajouté à ${lib} ✓`);
    }
    if (isTv()) state.pendingMovie.in_sonarr = true; else state.pendingMovie.in_radarr = true;
    $("#modal").classList.add("hidden");
    search();
  } catch (e) {
    toast("Échec : " + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = `Ajouter à ${lib}`;
  }
}

async function confirmBulkAdd() {
  const movies = state.bulkMovies;
  const btn = $("#modal-add");
  const lib = libName();
  btn.disabled = true;
  const opts = modalOptions();
  const ownedKey = isTv() ? "in_sonarr" : "in_radarr";
  let ok = 0, fail = 0;
  for (let i = 0; i < movies.length; i++) {
    btn.textContent = `Ajout… (${i + 1}/${movies.length})`;
    try {
      await api(paths().add, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdb_id: movies[i].id, ...opts }),
      });
      movies[i][ownedKey] = true;
      state.selected.delete(movies[i].id);
      ok++;
    } catch (e) {
      fail++;
    }
  }
  const noun = isTv() ? "série(s)" : "film(s)";
  let msg = `${ok} ${noun} ajouté(s) ✓`;
  if (fail) msg += ` · ${fail} échec(s)`;
  toast(msg, fail === 0);
  $("#modal").classList.add("hidden");
  btn.disabled = false; btn.textContent = `Ajouter à ${lib}`;
  search();
}

// ----------------------- details modal -----------------------
const IMG = (path, size) => (path ? `${state.imageBase}/${size}${path}` : null);
const fmtDate = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString("fr-FR", { day: "numeric", month: "long", year: "numeric" });
};
const fmtMoney = (n) => (n ? n.toLocaleString("fr-FR") + " $" : null);
const fmtBool = (b) => (b ? "Oui" : "Non");

function detailSection(title) {
  const s = el("div", "detail-section");
  s.appendChild(el("h3", null, title));
  return s;
}
function fact(k, v) {
  if (v == null || v === "" || (Array.isArray(v) && !v.length)) return null;
  const f = el("div", "fact");
  f.appendChild(el("span", "k", k));
  f.appendChild(el("span", "v", Array.isArray(v) ? v.join(", ") : String(v)));
  return f;
}

async function openDetails(m, mediaType) {
  const tv = mediaType ? mediaType === "tv" : isTv();
  const modal = $("#detail-modal");
  const body = $("#detail-body");
  body.innerHTML = `<div class="detail-loading">Chargement…</div>`;
  modal.classList.remove("hidden");
  modal.scrollTop = 0;
  try {
    const d = await api(`${tv ? "/tmdb/tv" : "/tmdb/movie"}/${m.id}`);
    renderDetails(d, tv);
    $(".detail-content").scrollTop = 0;
  } catch (e) {
    body.innerHTML = `<div class="detail-loading">Erreur : ${e.message}</div>`;
  }
}

function renderDetails(d, tv) {
  const region = state.config.region;
  const title = d.title || d.name;
  const orig = d.original_title || d.original_name;
  const year = (d.release_date || d.first_air_date || "").slice(0, 4);
  const wrap = el("div");

  // ---- Hero / head ----
  const backdrop = IMG(d.backdrop_path, "w1280");
  const hero = el("div", "detail-hero" + (backdrop ? "" : " no-backdrop"));
  if (backdrop) { const b = el("img", "backdrop"); b.src = backdrop; hero.appendChild(b); }
  wrap.appendChild(hero);

  const head = el("div", "detail-head");
  const poster = IMG(d.poster_path, "w342");
  const pImg = el("img", "poster");
  if (poster) pImg.src = poster;
  head.appendChild(pImg);

  const info = el("div", "head-info");
  info.appendChild(el("h2", null, year ? `${title} (${year})` : title));
  if (orig && orig !== title) info.appendChild(el("div", "orig", `Titre original : ${orig}`));
  if (d.tagline) info.appendChild(el("div", "tagline", `« ${d.tagline} »`));

  const hm = el("div", "head-meta");
  hm.appendChild(el("span", "score", `★ ${(d.vote_average || 0).toFixed(1)}`));
  hm.appendChild(el("span", null, `${d.vote_count || 0} votes`));
  if (!tv && d.runtime) hm.appendChild(el("span", null, `${d.runtime} min`));
  if (tv) {
    if (d.number_of_seasons) hm.appendChild(el("span", null, `${d.number_of_seasons} saison(s)`));
    if (d.number_of_episodes) hm.appendChild(el("span", null, `${d.number_of_episodes} épisode(s)`));
  }
  const cert = certification(d, tv, region);
  if (cert) hm.appendChild(el("span", null, `🔞 ${cert}`));
  if (d.status) hm.appendChild(el("span", null, d.status));
  info.appendChild(hm);

  if (d.genres && d.genres.length) {
    const g = el("div", "genre-chips");
    d.genres.forEach((x) => g.appendChild(el("span", "chip", x.name)));
    info.appendChild(g);
  }
  head.appendChild(info);
  wrap.appendChild(head);

  // ---- Body sections ----
  const inner = el("div", "detail-body-inner");

  // Synopsis
  if (d.overview) {
    const s = detailSection("Synopsis");
    s.appendChild(el("p", "overview-text", d.overview));
    inner.appendChild(s);
  }

  // Facts
  const facts = el("div", "facts");
  const addF = (k, v) => { const f = fact(k, v); if (f) facts.appendChild(f); };
  if (tv) {
    addF("Première diffusion", fmtDate(d.first_air_date));
    addF("Dernière diffusion", fmtDate(d.last_air_date));
    addF("En production", fmtBool(d.in_production));
    addF("Type", d.type);
    addF("Durée d'un épisode", (d.episode_run_time || []).map((x) => `${x} min`).join(", "));
    addF("Réseaux", (d.networks || []).map((n) => n.name));
    addF("Créé par", (d.created_by || []).map((c) => c.name));
    addF("Pays d'origine", d.origin_country);
  } else {
    addF("Date de sortie", fmtDate(d.release_date));
    addF("Budget", fmtMoney(d.budget));
    addF("Recettes", fmtMoney(d.revenue));
    addF("Pays de production", (d.production_countries || []).map((c) => c.name));
    if (d.belongs_to_collection) addF("Collection", d.belongs_to_collection.name);
  }
  addF("Statut", d.status);
  addF("Langue originale", (d.original_language || "").toUpperCase());
  addF("Langues parlées", (d.spoken_languages || []).map((l) => l.english_name || l.name));
  addF("Popularité", d.popularity ? Math.round(d.popularity) : null);
  addF("Note moyenne TMDB", `${(d.vote_average || 0).toFixed(2)} / 10`);
  if (facts.children.length) {
    const s = detailSection("Informations");
    s.appendChild(facts);
    inner.appendChild(s);
  }

  // Seasons (tv)
  if (tv && (d.seasons || []).length) {
    const s = detailSection("Saisons");
    const row = el("div", "poster-row");
    d.seasons.forEach((se) => {
      const mini = el("div", "mini");
      const ip = IMG(se.poster_path, "w185");
      const im = el("img"); if (ip) im.src = ip; else im.className = "ph";
      mini.appendChild(im);
      const ep = se.episode_count ? ` · ${se.episode_count} ép.` : "";
      const sy = (se.air_date || "").slice(0, 4);
      mini.appendChild(el("div", "nm", `${se.name}${sy ? ` (${sy})` : ""}${ep}`));
      mini.style.cursor = "default";
      row.appendChild(mini);
    });
    s.appendChild(row);
    inner.appendChild(s);
  }

  // Cast
  const cast = (tv ? (d.aggregate_credits?.cast || d.credits?.cast) : d.credits?.cast) || [];
  if (cast.length) {
    const s = detailSection(`Distribution (${cast.length})`);
    const row = el("div", "people-row");
    cast.slice(0, 30).forEach((c) => {
      const person = el("div", "person");
      const ip = IMG(c.profile_path, "w185");
      const im = el("img"); if (ip) im.src = ip; else im.className = "ph";
      person.appendChild(im);
      person.appendChild(el("div", "nm", c.name));
      const ch = c.character || (c.roles && c.roles[0] && c.roles[0].character);
      if (ch) person.appendChild(el("div", "ch", ch));
      row.appendChild(person);
    });
    s.appendChild(row);
    inner.appendChild(s);
  }

  // Crew (key jobs)
  const crew = (tv ? (d.aggregate_credits?.crew || d.credits?.crew) : d.credits?.crew) || [];
  if (crew.length) {
    const wanted = ["Director", "Creator", "Writer", "Screenplay", "Story",
      "Producer", "Executive Producer", "Original Music Composer", "Director of Photography"];
    const byJob = {};
    crew.forEach((c) => {
      const job = c.job || (c.jobs && c.jobs[0] && c.jobs[0].job);
      if (wanted.includes(job)) (byJob[job] = byJob[job] || []).push(c.name);
    });
    const grid = el("div", "facts");
    wanted.forEach((job) => {
      if (byJob[job]) {
        const f = fact(job, [...new Set(byJob[job])]);
        if (f) grid.appendChild(f);
      }
    });
    if (grid.children.length) {
      const s = detailSection("Équipe technique");
      s.appendChild(grid);
      inner.appendChild(s);
    }
  }

  // Videos
  const vids = (d.videos?.results || []).filter((v) => v.site === "YouTube");
  if (vids.length) {
    vids.sort((a, b) => (a.type === "Trailer" ? -1 : 0) - (b.type === "Trailer" ? -1 : 0));
    const s = detailSection("Vidéos & bandes-annonces");
    const list = el("div", "video-list");
    vids.slice(0, 12).forEach((v) => {
      const a = el("a", null, `▶ ${v.type} — ${v.name}`);
      a.href = `https://www.youtube.com/watch?v=${v.key}`;
      a.target = "_blank"; a.rel = "noopener";
      list.appendChild(a);
    });
    s.appendChild(list);
    inner.appendChild(s);
  }

  // Watch providers
  const prov = (d["watch/providers"]?.results || {})[region];
  if (prov) {
    const s = detailSection(`Où regarder (${region})`);
    const groups = [["flatrate", "Abonnement"], ["free", "Gratuit"], ["ads", "Avec pub"],
      ["rent", "Location"], ["buy", "Achat"]];
    groups.forEach(([key, label]) => {
      if ((prov[key] || []).length) {
        const g = el("div", "providers-group");
        g.appendChild(el("div", "lbl", label));
        const logos = el("div", "provider-logos");
        prov[key].forEach((p) => {
          const im = el("img"); im.title = p.provider_name;
          const lp = IMG(p.logo_path, "w92"); if (lp) im.src = lp;
          logos.appendChild(im);
        });
        g.appendChild(logos);
        s.appendChild(g);
      }
    });
    if (prov.link) {
      const a = el("a", null, "Voir sur JustWatch →");
      a.href = prov.link; a.target = "_blank"; a.rel = "noopener";
      const ll = el("div", "link-list"); ll.appendChild(a); s.appendChild(ll);
    }
    inner.appendChild(s);
  }

  // Keywords
  const kws = (tv ? d.keywords?.results : d.keywords?.keywords) || [];
  if (kws.length) {
    const s = detailSection("Mots-clés");
    const box = el("div", "genre-chips");
    kws.forEach((k) => box.appendChild(el("span", "chip", k.name)));
    s.appendChild(box);
    inner.appendChild(s);
  }

  // Production companies
  if ((d.production_companies || []).length) {
    const s = detailSection("Sociétés de production");
    s.appendChild(el("p", "overview-text",
      d.production_companies.map((c) => c.name + (c.origin_country ? ` (${c.origin_country})` : "")).join(" · ")));
    inner.appendChild(s);
  }

  // External links
  const links = externalLinks(d, tv);
  if (links.length) {
    const s = detailSection("Liens externes");
    const list = el("div", "link-list");
    links.forEach(([label, href]) => {
      const a = el("a", null, label); a.href = href; a.target = "_blank"; a.rel = "noopener";
      list.appendChild(a);
    });
    s.appendChild(list);
    inner.appendChild(s);
  }

  // Reviews
  const reviews = d.reviews?.results || [];
  if (reviews.length) {
    const s = detailSection(`Avis (${reviews.length})`);
    reviews.slice(0, 5).forEach((r) => {
      const rv = el("div", "review");
      const rating = r.author_details && r.author_details.rating ? ` — ★ ${r.author_details.rating}/10` : "";
      rv.appendChild(el("div", "author", r.author + rating));
      const txt = r.content.length > 800 ? r.content.slice(0, 800) + "…" : r.content;
      rv.appendChild(el("div", "text", txt));
      s.appendChild(rv);
    });
    inner.appendChild(s);
  }

  // Recommendations & similar
  addMiniRow(inner, "Recommandations", d.recommendations?.results, tv);
  addMiniRow(inner, "Titres similaires", d.similar?.results, tv);

  // Images
  if (d.images) {
    const b = (d.images.backdrops || []).length, p = (d.images.posters || []).length, l = (d.images.logos || []).length;
    if (b || p || l) {
      const s = detailSection("Galerie d'images");
      s.appendChild(el("p", "overview-text", `${b} arrière-plan(s), ${p} affiche(s), ${l} logo(s).`));
      const row = el("div", "poster-row");
      (d.images.backdrops || []).slice(0, 10).forEach((img) => {
        const ip = IMG(img.file_path, "w300");
        if (ip) { const im = el("img"); im.src = ip; im.style.height = "120px";
          im.style.borderRadius = "8px"; row.appendChild(im); }
      });
      if (row.children.length) s.appendChild(row);
      inner.appendChild(s);
    }
  }

  // Alternative titles (movie)
  if (!tv && (d.alternative_titles?.titles || []).length) {
    const s = detailSection("Titres alternatifs");
    s.appendChild(el("p", "overview-text",
      d.alternative_titles.titles.slice(0, 30).map((t) => `${t.title} (${t.iso_3166_1})`).join(" · ")));
    inner.appendChild(s);
  }

  wrap.appendChild(inner);
  const body = $("#detail-body");
  body.innerHTML = "";
  body.appendChild(wrap);
}

function certification(d, tv, region) {
  try {
    if (tv) {
      const r = (d.content_ratings?.results || []).find((x) => x.iso_3166_1 === region)
        || (d.content_ratings?.results || []).find((x) => x.iso_3166_1 === "US");
      return r && r.rating ? r.rating : null;
    }
    const list = (d.release_dates?.results || []).find((x) => x.iso_3166_1 === region)
      || (d.release_dates?.results || []).find((x) => x.iso_3166_1 === "US");
    const rd = list && (list.release_dates || []).find((x) => x.certification);
    return rd ? rd.certification : null;
  } catch (e) { return null; }
}

function externalLinks(d, tv) {
  const out = [];
  out.push(["TMDB", `https://www.themoviedb.org/${tv ? "tv" : "movie"}/${d.id}`]);
  const ext = d.external_ids || {};
  const imdb = d.imdb_id || ext.imdb_id;
  if (imdb) out.push(["IMDb", `https://www.imdb.com/title/${imdb}`]);
  if (ext.tvdb_id) out.push(["TheTVDB", `https://thetvdb.com/?id=${ext.tvdb_id}&tab=series`]);
  if (d.homepage) out.push(["Site officiel", d.homepage]);
  if (ext.facebook_id) out.push(["Facebook", `https://facebook.com/${ext.facebook_id}`]);
  if (ext.instagram_id) out.push(["Instagram", `https://instagram.com/${ext.instagram_id}`]);
  if (ext.twitter_id) out.push(["Twitter / X", `https://twitter.com/${ext.twitter_id}`]);
  return out;
}

function addMiniRow(inner, title, items, tv) {
  items = items || [];
  if (!items.length) return;
  const s = detailSection(title);
  const row = el("div", "poster-row");
  items.slice(0, 20).forEach((it) => {
    const mini = el("div", "mini");
    const ip = IMG(it.poster_path, "w185");
    const im = el("img"); if (ip) im.src = ip; else im.className = "ph";
    mini.appendChild(im);
    mini.appendChild(el("div", "nm", it.title || it.name));
    mini.onclick = () => openDetails(it, tv ? "tv" : "movie");
    row.appendChild(mini);
  });
  s.appendChild(row);
  inner.appendChild(s);
}

// ----------------------- voice assistant (Mistral) -----------------------
let _recognition = null;

function setOrb(cls) { $("#assistant-orb").className = "assistant-orb" + (cls ? " " + cls : ""); }
function setAssistantStatus(t) { $("#assistant-status").textContent = t || ""; }
function setReply(t, err) {
  const r = $("#assistant-reply");
  r.textContent = t || "";
  r.classList.toggle("err", !!err);
}

function openAssistant() {
  $("#assistant-overlay").classList.remove("hidden");
  setAssistantStatus("Appuyez sur le micro et parlez…");
  $("#assistant-transcript").textContent = "";
  setReply("");
  setOrb("");
}
function closeAssistant() {
  $("#assistant-overlay").classList.add("hidden");
  if (_recognition) { try { _recognition.stop(); } catch (e) {} }
  setOrb("");
  $("#assistant-fab").classList.remove("listening");
}

function speak(text) {
  try {
    if (!text || !window.speechSynthesis) return;
    const u = new SpeechSynthesisUtterance(text);
    u.lang = "fr-FR";
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  } catch (e) { /* TTS optional */ }
}

function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setAssistantStatus("Reconnaissance vocale non supportée par ce navigateur — tapez votre demande ci-dessous.");
    return;
  }
  const r = new SR();
  _recognition = r;
  r.lang = "fr-FR";
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  setOrb("listening");
  $("#assistant-fab").classList.add("listening");
  setAssistantStatus("Je vous écoute…");
  $("#assistant-transcript").textContent = "";
  r.onresult = (e) => {
    let t = "";
    for (const res of e.results) t += res[0].transcript;
    $("#assistant-transcript").textContent = t;
  };
  r.onerror = (e) => {
    setOrb(""); $("#assistant-fab").classList.remove("listening");
    setAssistantStatus(e.error === "not-allowed"
      ? "Micro refusé — autorisez le micro dans le navigateur."
      : "Erreur micro : " + e.error);
  };
  r.onend = () => {
    setOrb(""); $("#assistant-fab").classList.remove("listening");
    const t = $("#assistant-transcript").textContent.trim();
    if (t) askAssistant(t);
    else setAssistantStatus("Je n'ai rien entendu. Réessayez.");
  };
  try { r.start(); } catch (e) { /* already started */ }
}

async function askAssistant(text) {
  setOrb("thinking");
  setAssistantStatus("Je réfléchis…");
  setReply("");
  try {
    const plan = await api("/assistant", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    });
    setOrb("");
    setReply(plan.explanation || "C'est parti !");
    await applyPlan(plan);
    setAssistantStatus("Terminé ✓");
    speak(plan.spoken || plan.explanation);
    setTimeout(closeAssistant, 1100);
  } catch (e) {
    setOrb("");
    setAssistantStatus("");
    setReply("Échec : " + e.message, true);
  }
}

// Switch media without triggering an extra default search (avoids a race with
// the assistant's own rendering).
async function ensureMedia(media) {
  if (media === state.media) return;
  state.media = media;
  document.querySelectorAll(".media-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.media === media));
  resetFilters();
  applyMediaUI();
  await Promise.all([loadGenres(), loadProviders(), loadLibraryOptions()]);
}

async function applyPlan(plan) {
  await ensureMedia(plan.media === "tv" ? "tv" : "movie");
  if (plan.mode === "titles") renderAssistantTitles(plan);
  else applyAssistantDiscover(plan);
}

function setMode(m) {
  state.mode = m;
  document.querySelectorAll(".tab").forEach((t) => t.classList.toggle("active", t.dataset.mode === m));
  $("#panel-discover").classList.toggle("hidden", m !== "discover");
  $("#panel-search").classList.toggle("hidden", m !== "search");
}

function refreshGenreChips() {
  document.querySelectorAll("#f-genres .chip").forEach((c) => {
    const mode = state.genres.get(Number(c.dataset.gid));
    c.className = "chip" + (mode ? " " + mode : "");
  });
}

function ensureSelectValue(sel, value, label) {
  if (value == null || value === "") return;
  const s = $(sel);
  if (![...s.options].some((o) => o.value === String(value))) {
    const o = document.createElement("option");
    o.value = String(value); o.textContent = label || String(value);
    s.appendChild(o);
  }
  s.value = String(value);
}

function applyAssistantDiscover(plan) {
  const f = plan.filters || {};
  // A specific title -> use the text-search tab instead.
  if (f.query) {
    setMode("search");
    $("#q-text").value = f.query;
    newSearch();
    showAssistantBanner(plan.explanation);
    return;
  }
  setMode("discover");
  resetFilters();
  (f.with_genres || []).forEach((id) => state.genres.set(Number(id), "include"));
  (f.without_genres || []).forEach((id) => state.genres.set(Number(id), "exclude"));
  refreshGenreChips();
  ensureSelectValue("#f-sort", f.sort_by, f.sort_by);
  if (f.vote_average_gte != null) $("#f-vote-gte").value = f.vote_average_gte;
  if (f.vote_count_gte != null) $("#f-votecount-gte").value = f.vote_count_gte;
  if (f.runtime_gte != null) $("#f-runtime-gte").value = f.runtime_gte;
  if (f.runtime_lte != null) $("#f-runtime-lte").value = f.runtime_lte;
  if (f.with_original_language) ensureSelectValue("#f-language", f.with_original_language, f.with_original_language.toUpperCase());
  if (f.with_origin_country) $("#f-origin-country").value = f.with_origin_country;
  if (f.year_min) $("#f-date-gte").value = `${f.year_min}-01-01`;
  if (f.year_max) $("#f-date-lte").value = `${f.year_max}-12-31`;
  newSearch();
  showAssistantBanner(plan.explanation);
}

function renderAssistantTitles(plan) {
  setMode("discover");
  state.selected.clear();
  state.hasMore = false;
  state.cursorStack = [];
  const results = plan.results || [];
  renderResults(results);
  $("#pagination").innerHTML = "";
  const noun = isTv() ? "série(s)" : "film(s)";
  $("#status").textContent = `${results.length} ${noun} suggéré(s)`;
  showAssistantBanner(plan.explanation || "Suggestions de l'IA");
}

function showAssistantBanner(text) {
  const b = $("#assistant-banner");
  b.innerHTML = "";
  b.appendChild(el("span", null, "✨ " + (text || "Résultats proposés par l'IA")));
  const x = el("button", null, "✕ Effacer");
  x.onclick = () => b.classList.add("hidden");
  b.appendChild(x);
  b.classList.remove("hidden");
}

// ----------------------- auto-lists -----------------------
function genreName(id) {
  const c = document.querySelector(`#f-genres .chip[data-gid="${id}"]`);
  return c ? c.textContent : id;
}

function describeFilters(f) {
  if (!f) return "";
  const parts = [];
  if (f.sort_by) parts.push("tri " + f.sort_by);
  if (f.with_genres) parts.push("genres " + f.with_genres.split(",").map(genreName).join("/"));
  if (f.without_genres) parts.push("sauf " + f.without_genres.split(",").map(genreName).join("/"));
  const dg = f["primary_release_date.gte"] || f["first_air_date.gte"];
  const dl = f["primary_release_date.lte"] || f["first_air_date.lte"];
  if (dg) parts.push("depuis " + dg);
  if (dl) parts.push("jusqu'à " + dl);
  if (f.primary_release_year || f.first_air_date_year) parts.push("année " + (f.primary_release_year || f.first_air_date_year));
  if (f["vote_average.gte"]) parts.push("note ≥ " + f["vote_average.gte"]);
  if (f["vote_count.gte"]) parts.push("votes ≥ " + f["vote_count.gte"]);
  if (f.with_original_language) parts.push("langue " + f.with_original_language);
  if (f.with_origin_country) parts.push("pays " + f.with_origin_country);
  if (f.with_watch_providers) parts.push("plateformes");
  return parts.join(" · ");
}

// Capture the current discover filters (strip pagination-only params).
function captureFilters() {
  const p = buildDiscoverParams();
  const obj = {};
  for (const [k, v] of p.entries()) {
    if (k === "cursor" || k === "page_size" || k === "hide_owned") continue;
    obj[k] = v;
  }
  return obj;
}

async function fetchListOptions(media) {
  const pths = media === "tv"
    ? { profiles: "/sonarr/quality-profiles", folders: "/sonarr/root-folders" }
    : { profiles: "/radarr/quality-profiles", folders: "/radarr/root-folders" };
  const [profiles, folders] = await Promise.all([api(pths.profiles), api(pths.folders)]);
  return { profiles, folders };
}

// Shared modal renderer for create + edit.
function fillListModal({ media, filters, profiles, folders, values, isEdit }) {
  state.listModalMedia = media;
  state.pendingListFilters = filters;
  state.listModalProfiles = profiles;
  state.listModalFolders = folders;
  const tv = media === "tv";
  $("#list-modal-title") && ($("#list-modal-title").textContent = "");
  $("#list-summary").textContent =
    `${tv ? "Séries (Sonarr)" : "Films (Radarr)"} · ${describeFilters(filters) || "aucun filtre (tout)"}`;
  $("#list-profile").innerHTML = profiles.map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
  $("#list-folder").innerHTML = folders.map((f) => `<option value="${f.path}">${f.path}</option>`).join("");
  if (values.quality_profile_id) $("#list-profile").value = values.quality_profile_id;
  if (values.root_folder) $("#list-folder").value = values.root_folder;
  $("#list-availability-row").hidden = tv;
  if (values.minimum_availability) $("#list-availability").value = values.minimum_availability;
  $("#list-name").value = values.name || "";
  $("#list-monitor").checked = values.monitor !== false;
  $("#list-searchnow").checked = values.search_on_add !== false;
  $("#list-maxpages").value = values.max_pages || 3;
  $("#list-save").textContent = isEdit ? "Mettre à jour" : "Enregistrer la liste";
  $("#list-modal").classList.remove("hidden");
}

function openCreateList() {
  if (!state.profiles.length) {
    toast(`Options ${libName()} indisponibles`, false);
    return;
  }
  state.editingListId = null;
  const d = libDefaults();
  fillListModal({
    media: state.media,
    filters: captureFilters(),
    profiles: state.profiles,
    folders: state.folders,
    values: {
      quality_profile_id: d.quality_profile_id, root_folder: d.root_folder,
      minimum_availability: d.minimum_availability, monitor: true, search_on_add: true, max_pages: 3,
    },
    isEdit: false,
  });
}

async function openEditList(l) {
  state.editingListId = l.id;
  try {
    const { profiles, folders } = await fetchListOptions(l.media);
    fillListModal({
      media: l.media,
      filters: l.filters || {},
      profiles, folders,
      values: {
        name: l.name, quality_profile_id: l.quality_profile_id, root_folder: l.root_folder,
        minimum_availability: l.minimum_availability, monitor: l.monitor,
        search_on_add: l.search_on_add, max_pages: l.max_pages,
      },
      isEdit: true,
    });
  } catch (e) {
    toast("Impossible de charger les options : " + e.message, false);
  }
}

async function saveList() {
  const name = $("#list-name").value.trim();
  if (!name) { toast("Donnez un nom à la liste", false); return; }
  const tv = state.listModalMedia === "tv";
  const body = {
    name,
    media: state.listModalMedia,
    filters: state.pendingListFilters,
    quality_profile_id: Number($("#list-profile").value) || null,
    root_folder: $("#list-folder").value || null,
    monitor: $("#list-monitor").checked,
    search_on_add: $("#list-searchnow").checked,
    max_pages: Number($("#list-maxpages").value) || 3,
  };
  if (!tv) body.minimum_availability = $("#list-availability").value;
  const editing = state.editingListId;
  const btn = $("#list-save");
  btn.disabled = true; btn.textContent = editing ? "Mise à jour…" : "Enregistrement…";
  try {
    await api(editing ? `/lists/${editing}` : "/lists", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast(editing ? `Liste « ${name} » mise à jour ✓` : `Liste « ${name} » créée ✓`);
    $("#list-modal").classList.add("hidden");
    if (!$("#lists-modal").classList.contains("hidden")) renderLists(await api("/lists"));
  } catch (e) {
    toast("Échec : " + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = editing ? "Mettre à jour" : "Enregistrer la liste";
  }
}

async function previewList(media, filters, maxPages, label) {
  const m = $("#preview-modal");
  m.classList.remove("hidden");
  $("#preview-title").textContent = "👁 Aperçu — " + (label || "");
  $("#preview-summary").textContent = "Analyse en cours…";
  $("#preview-grid").innerHTML = "";
  try {
    const d = await api("/lists/preview", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ media, filters, max_pages: maxPages }),
    });
    const tv = media === "tv";
    $("#preview-summary").textContent =
      `${d.scanned} média(s) analysés · ${d.new} nouveau(x) à ajouter · ${d.owned} déjà présent(s)` +
      (d.total_results ? ` (≈ ${d.total_results} au total côté TMDB)` : "");
    const grid = $("#preview-grid");
    grid.innerHTML = "";
    if (!d.results.length) {
      grid.innerHTML = "<p class='muted'>Aucun média ne correspond à ces filtres.</p>";
      return;
    }
    d.results.forEach((it) => {
      const card = el("div", "card");
      const img = el("img", "poster");
      img.src = it.poster_path ? `${state.imageBase}/w342${it.poster_path}` : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
      img.loading = "lazy";
      card.appendChild(img);
      const body = el("div", "body");
      body.appendChild(el("div", "title", it.title || it.name));
      const meta = el("div", "meta");
      meta.appendChild(el("span", null, (it.release_date || it.first_air_date || "").slice(0, 4) || "—"));
      meta.appendChild(el("span", "rating", `★ ${(it.vote_average || 0).toFixed(1)}`));
      body.appendChild(meta);
      const owned = tv ? it.in_sonarr : it.in_radarr;
      body.appendChild(el("div", owned ? "badge-in" : "badge-new", owned ? "✓ Déjà présent" : "＋ Nouveau"));
      card.appendChild(body);
      grid.appendChild(card);
    });
  } catch (e) {
    $("#preview-summary").textContent = "Erreur : " + e.message;
  }
}

async function openLists() {
  $("#lists-modal").classList.remove("hidden");
  $("#lists-body").innerHTML = "<p class='muted'>Chargement…</p>";
  try {
    renderLists(await api("/lists"));
  } catch (e) {
    $("#lists-body").innerHTML = "Erreur : " + e.message;
  }
}

function renderLists(lists) {
  const box = $("#lists-body");
  box.innerHTML = "";
  if (!lists.length) {
    box.innerHTML = "<p class='muted'>Aucune liste pour le moment. Réglez des filtres puis « 💾 Créer une liste auto ».</p>";
    return;
  }
  lists.forEach((l) => {
    const card = el("div", "list-card");
    const head = el("div", "lc-head");
    head.appendChild(el("span", "lc-name", l.name));
    head.appendChild(el("span", "list-badge", l.media === "tv" ? "📺 Séries" : "🎬 Films"));
    head.appendChild(el("span", "list-badge" + (l.enabled ? "" : " off"), l.enabled ? "Active" : "En pause"));
    card.appendChild(head);

    const meta = el("div", "lc-meta");
    meta.innerHTML =
      `Filtres : <span class="lc-filters">${describeFilters(l.filters) || "aucun (tout)"}</span><br>` +
      `${l.max_pages} page(s) scannée(s) · dernier scan : ${l.last_run ? new Date(l.last_run).toLocaleString("fr-FR") : "jamais"} · total ajoutés : ${l.total_added || 0}`;
    card.appendChild(meta);

    if (l.last_result) {
      const r = l.last_result;
      const res = el("div", "lc-result");
      res.innerHTML = r.error
        ? `⚠️ ${r.error}`
        : `Dernier passage : <b>${r.added}</b> ajouté(s), ${r.skipped} déjà présent(s), ${r.errors} erreur(s)` +
          (r.added_titles && r.added_titles.length ? ` — ${r.added_titles.slice(0, 5).join(", ")}${r.added_titles.length > 5 ? "…" : ""}` : "");
      card.appendChild(res);
    }

    const actions = el("div", "lc-actions");
    const run = el("button", "primary", "▶ Lancer maintenant");
    run.onclick = () => runListNow(l.id, run);
    const prev = el("button", null, "👁 Aperçu");
    prev.onclick = () => previewList(l.media, l.filters, l.max_pages, l.name);
    const edit = el("button", null, "✏️ Modifier");
    edit.onclick = () => openEditList(l);
    const toggle = el("button", null, l.enabled ? "⏸ Mettre en pause" : "▶ Activer");
    toggle.onclick = () => toggleList(l);
    const del = el("button", null, "🗑 Supprimer");
    del.onclick = () => deleteList(l.id);
    actions.append(run, prev, edit, toggle, del);
    card.appendChild(actions);
    box.appendChild(card);
  });
}

async function runListNow(id, btn) {
  if (btn) { btn.disabled = true; btn.textContent = "Scan en cours…"; }
  try {
    const r = await api(`/lists/${id}/run`, { method: "POST" });
    toast(r.error ? "Erreur : " + r.error : `${r.added} ajouté(s), ${r.skipped} déjà présent(s)`, !r.error);
    renderLists(await api("/lists"));
  } catch (e) {
    toast("Échec : " + e.message, false);
    if (btn) { btn.disabled = false; btn.textContent = "▶ Lancer maintenant"; }
  }
}

async function toggleList(l) {
  try {
    await api(`/lists/${l.id}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...l, enabled: !l.enabled }),
    });
    renderLists(await api("/lists"));
  } catch (e) { toast("Échec : " + e.message, false); }
}

async function deleteList(id) {
  if (!confirm("Supprimer définitivement cette liste ?")) return;
  try {
    await api(`/lists/${id}`, { method: "DELETE" });
    renderLists(await api("/lists"));
  } catch (e) { toast("Échec : " + e.message, false); }
}

// ----------------------- helpers / UI binding -----------------------
function fmtBytes(b) {
  if (!b) return "0 o";
  const u = ["o", "Ko", "Mo", "Go", "To"];
  let i = 0; while (b >= 1024 && i < u.length - 1) { b /= 1024; i++; }
  return `${b.toFixed(1)} ${u[i]}`;
}

function resetFilters() {
  state.genres.clear(); state.people.clear(); state.keywords.clear();
  state.companies.clear(); state.providers.clear();
  document.querySelectorAll(".chip").forEach((c) => c.classList.remove("include", "exclude"));
  $("#panel-discover").querySelectorAll("input").forEach((i) => {
    if (i.type === "checkbox") i.checked = false; else i.value = "";
  });
  $("#f-sort").value = "popularity.desc";
  renderSelected($("#f-person-selected"), state.people);
  renderSelected($("#f-keyword-selected"), state.keywords);
  renderSelected($("#f-company-selected"), state.companies);
}

function setupMobileFilters() {
  const filters = $("#filters");
  const toggle = $("#filter-toggle");
  if (!filters || !toggle) return;
  const backdrop = el("div", "filters-backdrop");
  document.body.appendChild(backdrop);

  const open = () => { filters.classList.add("open"); backdrop.classList.add("show"); };
  const close = () => { filters.classList.remove("open"); backdrop.classList.remove("show"); };

  toggle.onclick = () => {
    if (filters.classList.contains("open")) close(); else open();
  };
  backdrop.onclick = close;
  // Expose for closing the drawer after launching a search on mobile.
  state.closeFilters = close;
}

async function switchMedia(media) {
  if (media === state.media) return;
  state.media = media;
  document.querySelectorAll(".media-btn").forEach((b) =>
    b.classList.toggle("active", b.dataset.media === media));
  // Reset filters/selection that don't carry over between media types.
  resetFilters();
  applyMediaUI();
  await Promise.all([loadGenres(), loadProviders(), loadLibraryOptions()]);
  newSearch();
}

function bindUI() {
  setupMobileFilters();

  document.querySelectorAll(".media-btn").forEach((btn) => {
    btn.onclick = () => switchMedia(btn.dataset.media);
  });

  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.mode = tab.dataset.mode;
      $("#panel-discover").classList.toggle("hidden", state.mode !== "discover");
      $("#panel-search").classList.toggle("hidden", state.mode !== "search");
    };
  });

  $("#hide-owned").onchange = (e) => {
    state.hideOwned = e.target.checked;
    newSearch();
  };

  $("#page-size").onchange = (e) => {
    state.pageSize = Number(e.target.value) || 20;
    newSearch();
  };

  $("#select-all").onclick = () => {
    selectableOnPage().forEach((m) => state.selected.set(m.id, m));
    renderResults(state.currentResults);
  };
  $("#select-none").onclick = () => {
    state.selected.clear();
    renderResults(state.currentResults);
  };
  $("#add-selection").onclick = openBulkModal;

  $("#btn-search").onclick = newSearch;
  $("#btn-reset").onclick = resetFilters;
  $("#q-text").addEventListener("keydown", (e) => { if (e.key === "Enter") newSearch(); });

  $("#modal-add").onclick = confirmAdd;
  $("#modal-cancel").onclick = () => $("#modal").classList.add("hidden");
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); });

  $("#detail-close").onclick = () => $("#detail-modal").classList.add("hidden");
  $("#detail-modal").addEventListener("click", (e) => {
    if (e.target.id === "detail-modal") $("#detail-modal").classList.add("hidden");
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      $("#detail-modal").classList.add("hidden");
      $("#modal").classList.add("hidden");
      closeAssistant();
    }
  });

  // Auto-lists
  $("#btn-create-list").onclick = openCreateList;
  $("#btn-manage-lists").onclick = openLists;
  $("#list-save").onclick = saveList;
  $("#list-preview").onclick = () =>
    previewList(state.listModalMedia, state.pendingListFilters,
      Number($("#list-maxpages").value) || 3, $("#list-name").value.trim() || "nouvelle liste");
  $("#list-cancel").onclick = () => $("#list-modal").classList.add("hidden");
  $("#preview-close").onclick = () => $("#preview-modal").classList.add("hidden");
  $("#preview-modal").addEventListener("click", (e) => {
    if (e.target.id === "preview-modal") $("#preview-modal").classList.add("hidden");
  });
  $("#list-modal").addEventListener("click", (e) => {
    if (e.target.id === "list-modal") $("#list-modal").classList.add("hidden");
  });
  $("#lists-close").onclick = () => $("#lists-modal").classList.add("hidden");
  $("#lists-modal").addEventListener("click", (e) => {
    if (e.target.id === "lists-modal") $("#lists-modal").classList.add("hidden");
  });

  // Voice assistant
  $("#assistant-fab").onclick = openAssistant;
  $("#assistant-close").onclick = closeAssistant;
  $("#assistant-overlay").addEventListener("click", (e) => {
    if (e.target.id === "assistant-overlay") closeAssistant();
  });
  $("#assistant-talk").onclick = startListening;
  $("#assistant-text").addEventListener("keydown", (e) => {
    if (e.key === "Enter") {
      const v = e.target.value.trim();
      if (v) { askAssistant(v); e.target.value = ""; }
    }
  });

  setupAutocomplete("#f-person-search", "#f-person-results", "#f-person-selected", "/tmdb/search/person", state.people, "name");
  setupAutocomplete("#f-keyword-search", "#f-keyword-results", "#f-keyword-selected", "/tmdb/search/keyword", state.keywords, "name");
  setupAutocomplete("#f-company-search", "#f-company-results", "#f-company-selected", "/tmdb/search/company", state.companies, "name");
}

init().catch((e) => { document.body.innerHTML = `<p style="padding:20px;color:#e25555">Erreur d'initialisation : ${e.message}</p>`; });
