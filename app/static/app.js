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
  cursorStack: [],    // history of start cursors, for the "Previous" button
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
  // Preferences persisted between sessions.
  hideOwned: (typeof localStorage !== "undefined" && localStorage.getItem("hideOwned") === "1"),
  ttsVoiceURI: (typeof localStorage !== "undefined" && localStorage.getItem("ttsVoice")) || null,
  pageSize: (typeof localStorage !== "undefined" && Number(localStorage.getItem("pageSize"))) || 20,
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
  // Animate out before removing from the DOM.
  setTimeout(() => {
    t.classList.add("out");
    setTimeout(() => t.remove(), 450);
  }, 3200);
}

// Carte d'affiche : image avec fondu au chargement, ou monogramme serif
// elegant fallback when the poster is missing.
function posterEl(m) {
  if (m.poster_path) {
    const img = el("img", "poster");
    img.loading = "lazy";
    img.onload = () => img.classList.add("loaded");
    img.src = `${state.imageBase}/w342${m.poster_path}`;
    if (img.complete) img.classList.add("loaded");
    return img;
  }
  const ph = el("div", "poster poster-ph", (m.title || m.name || "?").trim().charAt(0).toUpperCase());
  return ph;
}

// Shimmering skeletons while results load.
function renderSkeletons(n) {
  const grid = $("#results");
  grid.innerHTML = "";
  for (let i = 0; i < n; i++) {
    const c = el("div", "skel-card");
    c.style.setProperty("--i", Math.min(i, 12));
    c.appendChild(el("div", "skel sk-poster"));
    const b = el("div", "sk-body");
    b.appendChild(el("div", "skel sk-line w70"));
    b.appendChild(el("div", "skel sk-line w40"));
    c.appendChild(b);
    grid.appendChild(c);
  }
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
  $("#fs-dates-legend").textContent = isTv() ? tr("First air date") : tr("Release dates");
  const sort = $("#f-sort");
  const movieSort = [
    ["popularity.desc", tr("Popularity ↓")], ["popularity.asc", tr("Popularity ↑")],
    ["primary_release_date.desc", tr("Release date ↓")], ["primary_release_date.asc", tr("Release date ↑")],
    ["vote_average.desc", tr("Rating ↓")], ["vote_average.asc", tr("Rating ↑")],
    ["vote_count.desc", tr("Vote count ↓")], ["revenue.desc", tr("Revenue ↓")],
    ["original_title.asc", tr("Title A→Z")],
  ];
  const tvSort = [
    ["popularity.desc", tr("Popularity ↓")], ["popularity.asc", tr("Popularity ↑")],
    ["first_air_date.desc", tr("First air date ↓")], ["first_air_date.asc", tr("First air date ↑")],
    ["vote_average.desc", tr("Rating ↓")], ["vote_average.asc", tr("Rating ↑")],
    ["vote_count.desc", tr("Vote count ↓")], ["name.asc", tr("Title A→Z")],
  ];
  sort.innerHTML = (isTv() ? tvSort : movieSort)
    .map(([v, t]) => `<option value="${v}">${t}</option>`).join("");
  $("#hide-owned-label").textContent = isTv()
    ? tr("Hide TV shows already in Sonarr")
    : tr("Hide movies already in Radarr");
  $("#q-text-label") && ($("#q-text-label").textContent = isTv() ? tr("TV show title") : tr("Movie title"));
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
  // Voices load asynchronously in most browsers.
  if (window.speechSynthesis) {
    populateVoiceSelect();
    window.speechSynthesis.onvoiceschanged = populateVoiceSelect;
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
  renderSkeletons(Math.min(state.pageSize, 10));
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
    const noun = isTv() ? tr("TV shows") : tr("movies");
    const owned = isTv() ? tr("owned shows") : tr("owned movies");
    const count = state.hideOwned
      ? `${state.totalResults.toLocaleString(uiLocale())} ${noun} total (${owned} hidden)`
      : `${state.totalResults} ${noun}`;
    $("#status").textContent = `${count} · page ${state.viewPage}`;
    renderPagination();
  } catch (e) {
    $("#status").textContent = tr("Error") + ": " + e.message;
  }
}

function renderResults(movies) {
  state.currentResults = movies;
  const grid = $("#results");
  grid.innerHTML = "";
  if (!movies.length) {
    grid.innerHTML = `<p style='color:var(--muted)'>${tr("No results.")}</p>`;
    updateSelectionBar();
    return;
  }
  movies.forEach((m, i) => {
    const card = el("div", "card");
    // Staggered reveal, capped so the bottom of the page is not held back.
    card.style.setProperty("--i", Math.min(i, 14));
    if (state.selected.has(m.id)) card.classList.add("selected");

    // The poster and the actions that appear over it on hover share one box,
    // so the actions can be pinned to the artwork rather than to the card.
    const art = el("div", "poster-wrap");
    art.appendChild(posterEl(m));
    card.appendChild(art);

    // Selection checkbox (only for items not already in the library).
    if (!isOwned(m)) {
      const box = el("input", "select-box");
      box.type = "checkbox";
      box.checked = state.selected.has(m.id);
      box.title = tr("Select");
      box.onchange = () => {
        if (box.checked) state.selected.set(m.id, m); else state.selected.delete(m.id);
        card.classList.toggle("selected", box.checked);
        updateSelectionBar();
      };
      card.appendChild(box);
    }
    const acts = el("div", "card-actions");
    art.appendChild(acts);

    const body = el("div", "body");
    body.appendChild(el("div", "title", m.title || m.name));
    const meta = el("div", "meta");
    const year = (m.release_date || m.first_air_date || "").slice(0, 4);
    meta.appendChild(el("span", null, year || "—"));
    meta.appendChild(el("span", "rating", `★ ${(m.vote_average || 0).toFixed(1)}`));
    body.appendChild(meta);
    body.appendChild(el("div", "overview", m.overview || tr("No description.")));

    const detailBtn = el("button", "detail-btn", tr("Details"));
    detailBtn.onclick = () => openDetails(m);
    acts.appendChild(detailBtn);

    if (state.config.integrations && state.config.integrations.mistral) {
      const sumBtn = el("button", "summary-btn", tr("Audio summary"));
      sumBtn.onclick = () => summarizeMedia(m);
      acts.appendChild(sumBtn);
    }

    if (isOwned(m)) {
      body.appendChild(el("div", "badge-in", `✓ ${tr("Already in")} ${libName()}`));
    } else {
      const btn = el("button", "primary", "+ " + tr("Add"));
      btn.onclick = () => openModal(m);
      acts.appendChild(btn);
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
  $("#selection-count").textContent = `${n} ${tr("selected")}`;
  $("#add-selection").disabled = n === 0;
  $("#add-selection").textContent = n ? `+ ${tr("Add selection")} (${n})` : "+ " + tr("Add selection");
}

function renderPagination() {
  const box = $("#pagination");
  box.innerHTML = "";
  const hasPrev = state.cursorStack.length > 0;
  if (!hasPrev && !state.hasMore) return;
  const prev = el("button", null, "← " + tr("Previous"));
  prev.disabled = !hasPrev;
  prev.onclick = () => {
    state.cursor = state.cursorStack.pop();
    state.viewPage--;
    search();
    window.scrollTo(0, 0);
  };
  const next = el("button", null, tr("Next") + " →");
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
  $("#modal-add").textContent = `${tr("Add to")} ${libName()}`;
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
  const noun = isTv() ? tr("TV shows") : tr("movies");
  $("#modal-title").textContent = `${tr("Add")} ${movies.length} ${noun} (${tr("selected")})`;
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
      let msg = `${n} ${tr("titles from the collection added")} ✓`;
      if (skipped) msg += ` · ${skipped} ${tr("already there")}`;
      if (res.errors && res.errors.length) msg += ` · ${res.errors.length} ${tr("failed")}`;
      toast(msg, !(res.errors && res.errors.length));
    } else {
      const title = state.pendingMovie.title || state.pendingMovie.name;
      toast(`"${title}" → ${lib} ✓`);
    }
    if (isTv()) state.pendingMovie.in_sonarr = true; else state.pendingMovie.in_radarr = true;
    $("#modal").classList.add("hidden");
    search();
  } catch (e) {
    toast(tr("Failed") + ": " + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = `${tr("Add to")} ${lib}`;
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
  const noun = isTv() ? tr("TV shows") : tr("movies");
  let msg = `${ok} ${noun} ${tr("added")} ✓`;
  if (fail) msg += ` · ${fail} ${tr("failed")}`;
  toast(msg, fail === 0);
  $("#modal").classList.add("hidden");
  btn.disabled = false; btn.textContent = `${tr("Add to")} ${lib}`;
  search();
}

// ----------------------- details modal -----------------------
const IMG = (path, size) => (path ? `${state.imageBase}/${size}${path}` : null);
const fmtDate = (s) => {
  if (!s) return null;
  const d = new Date(s);
  return isNaN(d) ? s : d.toLocaleDateString(uiLocale(), { day: "numeric", month: "long", year: "numeric" });
};
const fmtMoney = (n) => (n ? "$" + n.toLocaleString(uiLocale()) : null);
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
    body.innerHTML = `<div class="detail-loading">${tr("Error")}: ${e.message}</div>`;
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
  if (orig && orig !== title) info.appendChild(el("div", "orig", `${tr("Original title")}: ${orig}`));
  if (d.tagline) info.appendChild(el("div", "tagline", `« ${d.tagline} »`));

  const hm = el("div", "head-meta");
  hm.appendChild(el("span", "score", `★ ${(d.vote_average || 0).toFixed(1)}`));
  hm.appendChild(el("span", null, `${d.vote_count || 0} votes`));
  if (!tv && d.runtime) hm.appendChild(el("span", null, `${d.runtime} min`));
  if (tv) {
    if (d.number_of_seasons) hm.appendChild(el("span", null, `${d.number_of_seasons} ${tr("seasons")}`));
    if (d.number_of_episodes) hm.appendChild(el("span", null, `${d.number_of_episodes} ${tr("episodes")}`));
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
    const s = detailSection(tr("Overview"));
    s.appendChild(el("p", "overview-text", d.overview));
    inner.appendChild(s);
  }

  // Facts
  const facts = el("div", "facts");
  const addF = (k, v) => { const f = fact(k, v); if (f) facts.appendChild(f); };
  if (tv) {
    addF(tr("First air date"), fmtDate(d.first_air_date));
    addF(tr("Last air date"), fmtDate(d.last_air_date));
    addF(tr("In production"), fmtBool(d.in_production));
    addF(tr("Type"), d.type);
    addF(tr("Episode runtime"), (d.episode_run_time || []).map((x) => `${x} min`).join(", "));
    addF(tr("Networks"), (d.networks || []).map((n) => n.name));
    addF(tr("Created by"), (d.created_by || []).map((c) => c.name));
    addF(tr("Origin country"), d.origin_country);
  } else {
    addF(tr("Release date"), fmtDate(d.release_date));
    addF(tr("Budget"), fmtMoney(d.budget));
    addF(tr("Revenue"), fmtMoney(d.revenue));
    addF(tr("Production countries"), (d.production_countries || []).map((c) => c.name));
    if (d.belongs_to_collection) addF(tr("Collection"), d.belongs_to_collection.name);
  }
  addF(tr("Status"), d.status);
  addF(tr("Original language"), (d.original_language || "").toUpperCase());
  addF(tr("Spoken languages"), (d.spoken_languages || []).map((l) => l.english_name || l.name));
  addF(tr("Popularity"), d.popularity ? Math.round(d.popularity) : null);
  addF(tr("TMDB rating"), `${(d.vote_average || 0).toFixed(2)} / 10`);
  if (facts.children.length) {
    const s = detailSection(tr("Details"));
    s.appendChild(facts);
    inner.appendChild(s);
  }

  // Seasons (tv)
  if (tv && (d.seasons || []).length) {
    const s = detailSection(tr("Seasons"));
    const row = el("div", "poster-row");
    d.seasons.forEach((se) => {
      const mini = el("div", "mini");
      const ip = IMG(se.poster_path, "w185");
      const im = el("img"); if (ip) im.src = ip; else im.className = "ph";
      mini.appendChild(im);
      const ep = se.episode_count ? ` · ${se.episode_count} ${tr("ep.")}` : "";
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
    const s = detailSection(`${tr("Cast")} (${cast.length})`);
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
      const s = detailSection(tr("Crew"));
      s.appendChild(grid);
      inner.appendChild(s);
    }
  }

  // Videos
  const vids = (d.videos?.results || []).filter((v) => v.site === "YouTube");
  if (vids.length) {
    vids.sort((a, b) => (a.type === "Trailer" ? -1 : 0) - (b.type === "Trailer" ? -1 : 0));
    const s = detailSection(tr("Videos & trailers"));
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
    const s = detailSection(`${tr("Where to watch")} (${region})`);
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
      const a = el("a", null, tr("View on JustWatch") + " →");
      a.href = prov.link; a.target = "_blank"; a.rel = "noopener";
      const ll = el("div", "link-list"); ll.appendChild(a); s.appendChild(ll);
    }
    inner.appendChild(s);
  }

  // Keywords
  const kws = (tv ? d.keywords?.results : d.keywords?.keywords) || [];
  if (kws.length) {
    const s = detailSection(tr("Keywords"));
    const box = el("div", "genre-chips");
    kws.forEach((k) => box.appendChild(el("span", "chip", k.name)));
    s.appendChild(box);
    inner.appendChild(s);
  }

  // Production companies
  if ((d.production_companies || []).length) {
    const s = detailSection(tr("Production companies"));
    s.appendChild(el("p", "overview-text",
      d.production_companies.map((c) => c.name + (c.origin_country ? ` (${c.origin_country})` : "")).join(" · ")));
    inner.appendChild(s);
  }

  // External links
  const links = externalLinks(d, tv);
  if (links.length) {
    const s = detailSection(tr("External links"));
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
    const s = detailSection(`${tr("Reviews")} (${reviews.length})`);
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
  addMiniRow(inner, tr("Similar titles"), d.similar?.results, tv);

  // Images
  if (d.images) {
    const b = (d.images.backdrops || []).length, p = (d.images.posters || []).length, l = (d.images.logos || []).length;
    if (b || p || l) {
      const s = detailSection(tr("Gallery"));
      s.appendChild(el("p", "overview-text", `${b} ${tr("backdrops")}, ${p} ${tr("posters")}, ${l} ${tr("logos")}.`));
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
    const s = detailSection(tr("Alternative titles"));
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

// ---- Voice selection for the spoken summary ----
// Prefer voices matching the interface language; fall back to whatever exists.
function ttsVoices() {
  if (!window.speechSynthesis) return [];
  const all = window.speechSynthesis.getVoices();
  const lang = (document.documentElement.lang || "en").slice(0, 2);
  const re = new RegExp("^" + lang + "(\\b|-|_)", "i");
  const matching = all.filter((v) => re.test(v.lang));
  return matching.length ? matching : all;
}
// Rank voices: cloud/“natural”/named voices sound better than default robotic ones.
function rankVoice(v) {
  const n = (v.name || "").toLowerCase();
  let s = 0;
  if (n.includes("google")) s += 6;
  if (n.includes("natural") || n.includes("naturel")) s += 6;
  if (/(amelie|thomas|audrey|marie|denise|henri|charlotte|paul|samantha|daniel|karen)/.test(n)) s += 3;
  if (v.localService === false) s += 2;  // online voices are usually higher quality
  return s;
}
function pickDefaultVoice(voices) {
  return voices.slice().sort((a, b) => rankVoice(b) - rankVoice(a))[0] || null;
}
function selectedVoice() {
  const voices = ttsVoices();
  return voices.find((v) => v.voiceURI === state.ttsVoiceURI) || pickDefaultVoice(voices);
}
function populateVoiceSelect() {
  const sel = $("#summary-voice");
  if (!sel) return;
  const voices = ttsVoices();
  sel.innerHTML = voices.length
    ? voices.map((v) => `<option value="${v.voiceURI}">${v.name}</option>`).join("")
    : `<option value="">(${tr("system default voice")})</option>`;
  const cur = selectedVoice();
  if (cur) { sel.value = cur.voiceURI; state.ttsVoiceURI = cur.voiceURI; }
}

const stripTtsTags = (s) => (s || "").replace(/\[\[\/?\w+\]\]/g, "");

// Browser (Web Speech) fallback voice.
function browserSpeak(text, orb) {
  try {
    if (!text || !window.speechSynthesis) { if (orb) orb.className = "summary-orb"; return; }
    window.speechSynthesis.cancel();
    const u = new SpeechSynthesisUtterance(stripTtsTags(text));
    u.lang = speechLocale();
    const v = selectedVoice();
    if (v) u.voice = v;
    u.rate = 1.0;
    u.pitch = 1.05;
    if (orb) {
      u.onstart = () => { orb.className = "summary-orb speaking"; };
      u.onend = () => { orb.className = "summary-orb"; };
      u.onerror = () => { orb.className = "summary-orb"; };
    }
    window.speechSynthesis.speak(u);
  } catch (e) { if (orb) orb.className = "summary-orb"; }
}

function stopSpeech() {
  try { if (window.speechSynthesis) window.speechSynthesis.cancel(); } catch (e) {}
}

function speakText(text, orb) { browserSpeak(text, orb); }
function speak(text) { speakText(text); }

function startListening() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) {
    setAssistantStatus(tr("Speech recognition is not supported by this browser — type your request below."));
    return;
  }
  const r = new SR();
  _recognition = r;
  r.lang = speechLocale();
  r.interimResults = true;
  r.continuous = false;
  r.maxAlternatives = 1;
  setOrb("listening");
  $("#assistant-fab").classList.add("listening");
  setAssistantStatus(tr("Listening…"));
  $("#assistant-transcript").textContent = "";
  r.onresult = (e) => {
    let t = "";
    for (const res of e.results) t += res[0].transcript;
    $("#assistant-transcript").textContent = t;
  };
  r.onerror = (e) => {
    setOrb(""); $("#assistant-fab").classList.remove("listening");
    setAssistantStatus(e.error === "not-allowed"
      ? tr("Microphone denied — allow it in your browser.")
      : tr("Microphone error") + ": " + e.error);
  };
  r.onend = () => {
    setOrb(""); $("#assistant-fab").classList.remove("listening");
    const t = $("#assistant-transcript").textContent.trim();
    if (t) askAssistant(t);
    else setAssistantStatus(tr("I did not catch that. Try again."));
  };
  try { r.start(); } catch (e) { /* already started */ }
}

async function askAssistant(text) {
  setOrb("thinking");
  setAssistantStatus(tr("Thinking…"));
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
    setAssistantStatus(tr("Done") + " ✓");
    speak(plan.spoken || plan.explanation);
    setTimeout(closeAssistant, 1100);
  } catch (e) {
    setOrb("");
    setAssistantStatus("");
    setReply(tr("Failed") + ": " + e.message, true);
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
  const noun = isTv() ? tr("TV shows") : tr("movies");
  $("#status").textContent = `${results.length} ${noun} ${tr("suggested")}`;
  showAssistantBanner(plan.explanation || "Suggestions de l'IA");
}

function showAssistantBanner(text) {
  const b = $("#assistant-banner");
  b.innerHTML = "";
  b.appendChild(el("span", null, "✦ " + (text || tr("Suggested by AI"))));
  const x = el("button", null, "✕ " + tr("Clear"));
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
  if (dl) parts.push(tr("until") + " " + dl);
  if (f.primary_release_year || f.first_air_date_year) parts.push(tr("year") + " " + (f.primary_release_year || f.first_air_date_year));
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
    `${tv ? tr("TV shows (Sonarr)") : tr("Movies (Radarr)")} · ${describeFilters(filters) || tr("no filter (everything)")}`;
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
  $("#list-save").textContent = isEdit ? tr("Update") : tr("Save list");
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
    toast(tr("Could not load the options") + ": " + e.message, false);
  }
}

async function saveList() {
  const name = $("#list-name").value.trim();
  if (!name) { toast(tr("Give the list a name"), false); return; }
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
  btn.disabled = true; btn.textContent = editing ? tr("Updating…") : tr("Saving…");
  try {
    await api(editing ? `/lists/${editing}` : "/lists", {
      method: editing ? "PUT" : "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    toast(editing ? `${tr("List")} “${name}” ${tr("updated")} ✓` : `${tr("List")} “${name}” ${tr("created")} ✓`);
    $("#list-modal").classList.add("hidden");
    if (!$("#lists-modal").classList.contains("hidden")) renderLists(await api("/lists"));
  } catch (e) {
    toast(tr("Failed") + ": " + e.message, false);
  } finally {
    btn.disabled = false; btn.textContent = editing ? tr("Update") : tr("Save list");
  }
}

async function previewList(media, filters, maxPages, label) {
  const m = $("#preview-modal");
  m.classList.remove("hidden");
  $("#preview-title").textContent = tr("Preview") + " — " + (label || "");
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
      `${d.scanned} ${tr("scanned")} · ${d.new} ${tr("new to add")} · ${d.owned} ${tr("already there")}` +
      (d.total_results ? ` (≈ ${d.total_results} ${tr("total on TMDB")})` : "");
    const grid = $("#preview-grid");
    grid.innerHTML = "";
    if (!d.results.length) {
      grid.innerHTML = `<p class='muted'>${tr("Nothing matches these filters.")}</p>`;
      return;
    }
    d.results.forEach((it, i) => {
      const card = el("div", "card");
      card.style.setProperty("--i", Math.min(i, 14));
      card.appendChild(posterEl(it));
      const body = el("div", "body");
      body.appendChild(el("div", "title", it.title || it.name));
      const meta = el("div", "meta");
      meta.appendChild(el("span", null, (it.release_date || it.first_air_date || "").slice(0, 4) || "—"));
      meta.appendChild(el("span", "rating", `★ ${(it.vote_average || 0).toFixed(1)}`));
      body.appendChild(meta);
      const owned = tv ? it.in_sonarr : it.in_radarr;
      body.appendChild(el("div", owned ? "badge-in" : "badge-new", owned ? "✓ " + tr("Already there") : tr("New")));
      card.appendChild(body);
      grid.appendChild(card);
    });
  } catch (e) {
    $("#preview-summary").textContent = tr("Error") + ": " + e.message;
  }
}

async function openLists() {
  $("#lists-modal").classList.remove("hidden");
  $("#lists-body").innerHTML = "<p class='muted'>Chargement…</p>";
  try {
    renderLists(await api("/lists"));
  } catch (e) {
    $("#lists-body").innerHTML = tr("Error") + ": " + e.message;
  }
}

function renderLists(lists) {
  const box = $("#lists-body");
  box.innerHTML = "";
  if (!lists.length) {
    box.innerHTML = `<p class='muted'>${tr("No lists yet. Set some filters, then hit “Create auto-list”.")}</p>`;
    return;
  }
  lists.forEach((l) => {
    const card = el("div", "list-card");
    const head = el("div", "lc-head");
    head.appendChild(el("span", "lc-name", l.name));
    head.appendChild(el("span", "list-badge", l.media === "tv" ? tr("TV shows") : tr("Movies")));
    head.appendChild(el("span", "list-badge" + (l.enabled ? "" : " off"), l.enabled ? "Active" : "En pause"));
    card.appendChild(head);

    const meta = el("div", "lc-meta");
    meta.innerHTML =
      `Filtres : <span class="lc-filters">${describeFilters(l.filters) || "aucun (tout)"}</span><br>` +
      `${l.max_pages} ${tr("pages scanned")} · ${tr("last run")}: ${l.last_run ? new Date(l.last_run).toLocaleString() : tr("never")} · ${tr("total added")}: ${l.total_added || 0}`;
    card.appendChild(meta);

    if (l.last_result) {
      const r = l.last_result;
      const res = el("div", "lc-result");
      res.innerHTML = r.error
        ? `⚠️ ${r.error}`
        : `${tr("Last run")}: <b>${r.added}</b> ${tr("added")}, ${r.skipped} ${tr("already there")}, ${r.errors} ${tr("errors")}` +
          (r.added_titles && r.added_titles.length ? ` — ${r.added_titles.slice(0, 5).join(", ")}${r.added_titles.length > 5 ? "…" : ""}` : "");
      card.appendChild(res);
    }

    const actions = el("div", "lc-actions");
    const run = el("button", "primary", "Lancer maintenant");
    run.onclick = () => runListNow(l.id, run);
    const prev = el("button", null, tr("Preview"));
    prev.onclick = () => previewList(l.media, l.filters, l.max_pages, l.name);
    const edit = el("button", null, "Modifier");
    edit.onclick = () => openEditList(l);
    const toggle = el("button", null, l.enabled ? "Mettre en pause" : "Activer");
    toggle.onclick = () => toggleList(l);
    const del = el("button", null, "Supprimer");
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
    toast(r.error ? tr("Error") + ": " + r.error : `${r.added} ${tr("added")}, ${r.skipped} ${tr("already there")}`, !r.error);
    renderLists(await api("/lists"));
  } catch (e) {
    toast(tr("Failed") + ": " + e.message, false);
    if (btn) { btn.disabled = false; btn.textContent = "Lancer maintenant"; }
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
  } catch (e) { toast(tr("Failed") + ": " + e.message, false); }
}

async function deleteList(id) {
  if (!confirm(tr("Delete this list permanently?"))) return;
  try {
    await api(`/lists/${id}`, { method: "DELETE" });
    renderLists(await api("/lists"));
  } catch (e) { toast(tr("Failed") + ": " + e.message, false); }
}

// ----------------------- spoken summary -----------------------
function closeSummary() {
  $("#summary-modal").classList.add("hidden");
  stopSpeech();
  $("#summary-orb").className = "summary-orb";
}

async function summarizeMedia(m) {
  const modal = $("#summary-modal");
  modal.classList.remove("hidden");
  $("#summary-title").textContent = m.title || m.name;
  $("#summary-text").textContent = "";
  $("#summary-orb").className = "summary-orb thinking";
  document.getElementById("summary-text").textContent = tr("Generating the AI summary…");
  try {
    const r = await api("/summarize", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tmdb_id: m.id, media: isTv() ? "tv" : "movie" }),
    });
    state.lastSummary = r.summary;
    $("#summary-text").textContent = r.summary;
    speakSummary(r.summary);
  } catch (e) {
    $("#summary-orb").className = "summary-orb";
    $("#summary-text").textContent = tr("Failed") + ": " + e.message;
  }
}

function speakSummary(text) {
  speakText(text, $("#summary-orb"));
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

  // Restore persisted preferences into the controls.
  $("#hide-owned").checked = state.hideOwned;
  if ([...$("#page-size").options].some((o) => o.value === String(state.pageSize))) {
    $("#page-size").value = String(state.pageSize);
  }

  $("#hide-owned").onchange = (e) => {
    state.hideOwned = e.target.checked;
    try { localStorage.setItem("hideOwned", state.hideOwned ? "1" : "0"); } catch (err) {}
    newSearch();
  };

  $("#page-size").onchange = (e) => {
    state.pageSize = Number(e.target.value) || 20;
    try { localStorage.setItem("pageSize", String(state.pageSize)); } catch (err) {}
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
  $("#q-year").addEventListener("keydown", (e) => { if (e.key === "Enter") newSearch(); });

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
      closeSummary();
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

  // Spoken summary
  $("#summary-close").onclick = closeSummary;
  $("#summary-modal").addEventListener("click", (e) => {
    if (e.target.id === "summary-modal") closeSummary();
  });
  $("#summary-replay").onclick = () => { if (state.lastSummary) speakSummary(state.lastSummary); };
  $("#summary-voice").onchange = (e) => {
    state.ttsVoiceURI = e.target.value;
    try { localStorage.setItem("ttsVoice", e.target.value); } catch (err) {}
    if (state.lastSummary) speakSummary(state.lastSummary);
  };
  $("#summary-stop").onclick = () => { stopSpeech(); $("#summary-orb").className = "summary-orb"; };

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

init().catch((e) => { document.body.innerHTML = `<p style="padding:20px;color:#e25555">${tr("Startup error")}: ${e.message}</p>`; });
