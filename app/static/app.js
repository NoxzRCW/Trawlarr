"use strict";

const api = (path, opts) => fetch(`/api${path}`, opts).then(async (r) => {
  const data = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(data.detail || `HTTP ${r.status}`);
  return data;
});

const state = {
  config: null,
  imageBase: "https://image.tmdb.org/t/p",
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

// ----------------------- init -----------------------
async function init() {
  state.config = await api("/config");
  state.imageBase = state.config.image_base;
  document.title = state.config.title;

  await Promise.all([loadHealth(), loadGenres(), loadProviders(), loadRadarrOptions()]);
  bindUI();
  search();
}

async function loadHealth() {
  try {
    const h = await api("/health");
    const tmdb = `TMDB <span class="pill ${h.tmdb ? "ok" : "ko"}">${h.tmdb ? "OK" : "KO"}</span>`;
    const rad = `Radarr <span class="pill ${h.radarr ? "ok" : "ko"}">${h.radarr ? (h.radarr_version || "OK") : "KO"}</span>`;
    $("#health").innerHTML = tmdb + rad;
  } catch (e) { $("#health").textContent = "Connexion impossible"; }
}

async function loadGenres() {
  const { genres } = await api("/tmdb/genres");
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
  const { results } = await api("/tmdb/watch-providers");
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

async function loadRadarrOptions() {
  try {
    state.profiles = await api("/radarr/quality-profiles");
    state.folders = await api("/radarr/root-folders");
    $("#modal-profile").innerHTML = state.profiles
      .map((p) => `<option value="${p.id}">${p.name}</option>`).join("");
    $("#modal-folder").innerHTML = state.folders
      .map((f) => `<option value="${f.path}">${f.path} (${fmtBytes(f.freeSpace)} libres)</option>`).join("");
  } catch (e) {
    console.warn("Radarr options unavailable", e);
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

  add("primary_release_date.gte", val("#f-date-gte"));
  add("primary_release_date.lte", val("#f-date-lte"));
  add("primary_release_year", val("#f-year"));

  add("vote_average.gte", val("#f-vote-gte"));
  add("vote_average.lte", val("#f-vote-lte"));
  add("vote_count.gte", val("#f-votecount-gte"));

  add("with_runtime.gte", val("#f-runtime-gte"));
  add("with_runtime.lte", val("#f-runtime-lte"));

  add("with_original_language", val("#f-language"));
  add("with_origin_country", val("#f-origin-country"));

  const certCountry = val("#f-cert-country");
  if (certCountry) {
    add("certification_country", certCountry);
    add("certification.gte", val("#f-cert-gte"));
    add("certification.lte", val("#f-cert-lte"));
  }

  if (state.people.size) add("with_people", [...state.people.keys()].join(","));
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
      data = await api(`/search?${params}`);
    } else {
      data = await api(`/discover?${buildDiscoverParams()}`);
    }
    state.nextCursor = data.next_cursor ?? 0;
    state.hasMore = !!data.has_more;
    state.totalResults = data.total_results ?? (data.results || []).length;
    renderResults(data.results || []);
    const count = state.hideOwned
      ? `${state.totalResults} résultat(s) au total (films possédés masqués)`
      : `${state.totalResults} résultat(s)`;
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

    // Selection checkbox (only for movies not already in Radarr).
    if (!m.in_radarr) {
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
    body.appendChild(el("div", "title", m.title));
    const meta = el("div", "meta");
    const year = (m.release_date || "").slice(0, 4);
    meta.appendChild(el("span", null, year || "—"));
    meta.appendChild(el("span", "rating", `★ ${(m.vote_average || 0).toFixed(1)}`));
    body.appendChild(meta);
    body.appendChild(el("div", "overview", m.overview || "Pas de description."));

    if (m.in_radarr) {
      body.appendChild(el("div", "badge-in", "✓ Déjà dans Radarr"));
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

// Movies on the current page that can still be selected (not in Radarr).
function selectableOnPage() {
  return state.currentResults.filter((m) => !m.in_radarr);
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

// ----------------------- add to radarr modal -----------------------
function applyModalDefaults() {
  const d = state.config.defaults;
  if (d.quality_profile_id) $("#modal-profile").value = d.quality_profile_id;
  if (d.root_folder) $("#modal-folder").value = d.root_folder;
  $("#modal-availability").value = d.minimum_availability;
  $("#modal-monitor").checked = d.monitor;
  $("#modal-searchnow").checked = d.search_on_add;
  $("#modal-collection-row").hidden = true;
  $("#modal-collection").checked = false;
  $("#modal-collection-name").textContent = "";
}

function openModal(movie) {
  state.pendingMovie = movie;
  state.bulkMovies = null;
  $("#modal-title").textContent = `${movie.title} (${(movie.release_date || "").slice(0, 4)})`;
  applyModalDefaults();
  // Collection option only makes sense for a single movie.
  detectCollection(movie.id);
  $("#modal").classList.remove("hidden");
}

function openBulkModal() {
  const movies = [...state.selected.values()];
  if (!movies.length) return;
  state.pendingMovie = null;
  state.bulkMovies = movies;
  $("#modal-title").textContent = `Ajouter ${movies.length} film(s) sélectionné(s)`;
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
  return {
    quality_profile_id: Number($("#modal-profile").value) || null,
    root_folder: $("#modal-folder").value || null,
    minimum_availability: $("#modal-availability").value,
    monitor: $("#modal-monitor").checked,
    search_on_add: $("#modal-searchnow").checked,
  };
}

async function confirmAdd() {
  if (state.bulkMovies) { await confirmBulkAdd(); return; }

  const btn = $("#modal-add");
  btn.disabled = true; btn.textContent = "Ajout…";
  const addCollection = !$("#modal-collection-row").hidden && $("#modal-collection").checked;
  try {
    const res = await api("/radarr/add", {
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
      toast(`"${state.pendingMovie.title}" ajouté à Radarr ✓`);
    }
    state.pendingMovie.in_radarr = true;
    $("#modal").classList.add("hidden");
    search();
  } catch (e) {
    toast("Échec : " + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = "Ajouter à Radarr";
  }
}

async function confirmBulkAdd() {
  const movies = state.bulkMovies;
  const btn = $("#modal-add");
  btn.disabled = true;
  const opts = modalOptions();
  let ok = 0, fail = 0;
  for (let i = 0; i < movies.length; i++) {
    btn.textContent = `Ajout… (${i + 1}/${movies.length})`;
    try {
      await api("/radarr/add", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ tmdb_id: movies[i].id, ...opts }),
      });
      movies[i].in_radarr = true;
      state.selected.delete(movies[i].id);
      ok++;
    } catch (e) {
      fail++;
    }
  }
  let msg = `${ok} film(s) ajouté(s) ✓`;
  if (fail) msg += ` · ${fail} échec(s)`;
  toast(msg, fail === 0);
  $("#modal").classList.add("hidden");
  btn.disabled = false; btn.textContent = "Ajouter à Radarr";
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

function bindUI() {
  setupMobileFilters();

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
