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
  await Promise.all([loadHealth(), loadGenres(), loadProviders(), loadLibraryOptions()]);
  bindUI();
  search();
}

async function loadHealth() {
  try {
    const h = await api("/health");
    const tmdb = `TMDB <span class="pill ${h.tmdb ? "ok" : "ko"}">${h.tmdb ? "OK" : "KO"}</span>`;
    const rad = `Radarr <span class="pill ${h.radarr ? "ok" : "ko"}">${h.radarr ? (h.radarr_version || "OK") : "KO"}</span>`;
    const son = `Sonarr <span class="pill ${h.sonarr ? "ok" : "ko"}">${h.sonarr ? (h.sonarr_version || "OK") : "KO"}</span>`;
    $("#health").innerHTML = tmdb + rad + son;
  } catch (e) { $("#health").textContent = "Connexion impossible"; }
}

async function loadGenres() {
  state.genres.clear();
  const { genres } = await api(paths().genres);
  const box = $("#f-genres");
  box.innerHTML = "";
  genres.forEach((g) => {
    const chip = el("span", "chip", g.name);
    chip.onclick = (ev) => {
      const cur = state.genres.get(g.id);
      if (ev.shiftKey) {
        state.genres.set(g.id, cur === "exclude" ? undefined : "exclude");
      } else {
        state.genres.set(g.id, cur === "include" ? undefined : "include");
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

  setupAutocomplete("#f-person-search", "#f-person-results", "#f-person-selected", "/tmdb/search/person", state.people, "name");
  setupAutocomplete("#f-keyword-search", "#f-keyword-results", "#f-keyword-selected", "/tmdb/search/keyword", state.keywords, "name");
  setupAutocomplete("#f-company-search", "#f-company-results", "#f-company-selected", "/tmdb/search/company", state.companies, "name");
}

init().catch((e) => { document.body.innerHTML = `<p style="padding:20px;color:#e25555">Erreur d'initialisation : ${e.message}</p>`; });
