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
  page: 1,
  totalPages: 1,
  // selections
  genres: new Map(),       // id -> "include" | "exclude"
  people: new Map(),       // id -> name
  keywords: new Map(),     // id -> name
  companies: new Map(),    // id -> name
  providers: new Map(),    // id -> name
  profiles: [],
  folders: [],
  pendingMovie: null,
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
  add("page", state.page);
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
async function search() {
  $("#status").textContent = "Recherche…";
  $("#results").innerHTML = "";
  try {
    let data;
    if (state.mode === "search") {
      const q = val("#q-text");
      if (!q) { $("#status").textContent = "Saisissez un titre."; return; }
      const params = new URLSearchParams({ query: q, page: state.page });
      if (val("#q-year")) params.set("year", val("#q-year"));
      if ($("#q-adult-search").checked) params.set("include_adult", "true");
      data = await api(`/search?${params}`);
    } else {
      data = await api(`/discover?${buildDiscoverParams()}`);
    }
    state.totalPages = Math.min(data.total_pages || 1, 500);
    renderResults(data.results || []);
    $("#status").textContent = `${data.total_results ?? data.results.length} résultat(s) · page ${data.page}/${state.totalPages}`;
    renderPagination();
  } catch (e) {
    $("#status").textContent = "Erreur : " + e.message;
  }
}

function renderResults(movies) {
  const grid = $("#results");
  grid.innerHTML = "";
  if (!movies.length) { grid.innerHTML = "<p style='color:var(--muted)'>Aucun résultat.</p>"; return; }
  movies.forEach((m) => {
    const card = el("div", "card");
    const img = el("img", "poster");
    img.src = m.poster_path ? `${state.imageBase}/w342${m.poster_path}` : "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg'/%3E";
    img.loading = "lazy";
    card.appendChild(img);

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
}

function renderPagination() {
  const box = $("#pagination");
  box.innerHTML = "";
  if (state.totalPages <= 1) return;
  const prev = el("button", null, "← Précédent");
  prev.disabled = state.page <= 1;
  prev.onclick = () => { state.page--; search(); window.scrollTo(0, 0); };
  const next = el("button", null, "Suivant →");
  next.disabled = state.page >= state.totalPages;
  next.onclick = () => { state.page++; search(); window.scrollTo(0, 0); };
  box.appendChild(prev);
  box.appendChild(el("span", null, `${state.page} / ${state.totalPages}`));
  box.appendChild(next);
}

// ----------------------- add to radarr modal -----------------------
function openModal(movie) {
  state.pendingMovie = movie;
  $("#modal-title").textContent = `${movie.title} (${(movie.release_date || "").slice(0, 4)})`;
  const d = state.config.defaults;
  if (d.quality_profile_id) $("#modal-profile").value = d.quality_profile_id;
  if (d.root_folder) $("#modal-folder").value = d.root_folder;
  $("#modal-availability").value = d.minimum_availability;
  $("#modal-monitor").checked = d.monitor;
  $("#modal-searchnow").checked = d.search_on_add;
  // Reset the collection option; reveal it only if the movie belongs to one.
  $("#modal-collection-row").hidden = true;
  $("#modal-collection").checked = false;
  $("#modal-collection-name").textContent = "";
  detectCollection(movie.id);
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

async function confirmAdd() {
  const btn = $("#modal-add");
  btn.disabled = true; btn.textContent = "Ajout…";
  const addCollection = !$("#modal-collection-row").hidden && $("#modal-collection").checked;
  try {
    const res = await api("/radarr/add", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        tmdb_id: state.pendingMovie.id,
        quality_profile_id: Number($("#modal-profile").value) || null,
        root_folder: $("#modal-folder").value || null,
        minimum_availability: $("#modal-availability").value,
        monitor: $("#modal-monitor").checked,
        search_on_add: $("#modal-searchnow").checked,
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

function bindUI() {
  document.querySelectorAll(".tab").forEach((tab) => {
    tab.onclick = () => {
      document.querySelectorAll(".tab").forEach((t) => t.classList.remove("active"));
      tab.classList.add("active");
      state.mode = tab.dataset.mode;
      $("#panel-discover").classList.toggle("hidden", state.mode !== "discover");
      $("#panel-search").classList.toggle("hidden", state.mode !== "search");
    };
  });

  $("#btn-search").onclick = () => { state.page = 1; search(); };
  $("#btn-reset").onclick = resetFilters;
  $("#q-text").addEventListener("keydown", (e) => { if (e.key === "Enter") { state.page = 1; search(); } });

  $("#modal-add").onclick = confirmAdd;
  $("#modal-cancel").onclick = () => $("#modal").classList.add("hidden");
  $("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") $("#modal").classList.add("hidden"); });

  setupAutocomplete("#f-person-search", "#f-person-results", "#f-person-selected", "/tmdb/search/person", state.people, "name");
  setupAutocomplete("#f-keyword-search", "#f-keyword-results", "#f-keyword-selected", "/tmdb/search/keyword", state.keywords, "name");
  setupAutocomplete("#f-company-search", "#f-company-results", "#f-company-selected", "/tmdb/search/company", state.companies, "name");
}

init().catch((e) => { document.body.innerHTML = `<p style="padding:20px;color:#e25555">Erreur d'initialisation : ${e.message}</p>`; });
