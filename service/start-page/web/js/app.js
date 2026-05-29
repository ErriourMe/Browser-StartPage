"use strict";

/** @typedef {{ id: string, title: string, url: string }} Bookmark */

const API_ORIGIN =
  location.protocol === "chrome-extension:" || location.protocol === "moz-extension:"
    ? "http://127.0.0.1:7777"
    : location.origin;

const CFG = {
  LS_BOOKMARKS: "sp_bookmarks_v1",
  FAVICON_IDB: "sp_favicon_v1",
  FAVICON_IDB_VER: 1,
  FAVICON_STORE: "icons",
  LS_BRAVE_STATS_URL: "sp_brave_stats_endpoint",
  LS_BRAVE_STATS_CACHE: "sp_brave_stats_cache_v1",
  BRAVE_STATS_DEFAULT_URL: `${API_ORIGIN}/api/brave-stats.json`,
  bookmarksURL() {
    return `${API_ORIGIN}/api/bookmarks.json`;
  },
  IDB_NAME: "sp_background_v1",
  IDB_VER: 2,
  IDB_STORE: "images",
  GOOGLE_AI: "https://www.google.com/search?udm=50&q=",
  GOOGLE_WEB: "https://www.google.com/search?q=",
  picsumUrl(seed) {
    return `https://picsum.photos/seed/${seed}/2560/1440`;
  },
};

const util = {
  randomSeed() {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return `${a[0].toString(16)}${a[1].toString(16)}`;
  },
  normalizeUrl(raw) {
    const t = String(raw).trim();
    if (!t) return "";
    if (/^https?:\/\//i.test(t)) return t;
    return `https://${t}`;
  },
  letterFromTitle(title) {
    const t = String(title).trim();
    if (!t) return "?";
    const cp = t.codePointAt(0);
    if (cp === undefined) return "?";
    return String.fromCodePoint(cp).toUpperCase();
  },
  hostFromUrl(raw) {
    try {
      return new URL(String(raw)).hostname.toLowerCase();
    } catch {
      return "";
    }
  },
};

const FaviconCache = (() => {
  function hostKey(host) {
    return String(host).toLowerCase();
  }

  function serviceURL(host) {
    return `https://www.google.com/s2/favicons?sz=64&domain=${encodeURIComponent(hostKey(host))}`;
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(CFG.FAVICON_IDB, CFG.FAVICON_IDB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(CFG.FAVICON_STORE)) {
          db.createObjectStore(CFG.FAVICON_STORE);
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  /** @param {IDBDatabase} db */
  function idbGet(db, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CFG.FAVICON_STORE, "readonly");
      const g = tx.objectStore(CFG.FAVICON_STORE).get(key);
      g.onsuccess = () => resolve(g.result);
      g.onerror = () => reject(g.error);
    });
  }

  /** @param {IDBDatabase} db */
  function idbPut(db, key, blob) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CFG.FAVICON_STORE, "readwrite");
      tx.objectStore(CFG.FAVICON_STORE).put(blob, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** @returns {Promise<Blob | null>} */
  async function get(host) {
    if (!host) return null;
    try {
      const db = await idbOpen();
      const b = await idbGet(db, hostKey(host));
      return b instanceof Blob && b.size > 32 ? b : null;
    } catch {
      return null;
    }
  }

  /** @returns {Promise<Blob | null>} */
  async function fetchIcon(host) {
    if (!host) return null;
    try {
      const res = await fetch(serviceURL(host), {
        mode: "cors",
        credentials: "omit",
        cache: "default",
      });
      if (!res.ok) return null;
      const b = await res.blob();
      return b instanceof Blob && b.size > 32 ? b : null;
    } catch {
      return null;
    }
  }

  async function ensureBlob(host) {
    let b = await get(host);
    if (b) return b;
    b = await fetchIcon(host);
    if (!b) return null;
    try {
      const db = await idbOpen();
      await idbPut(db, hostKey(host), b);
    } catch {
      /* ignore */
    }
    return b;
  }

  return { serviceURL, ensureBlob, get };
})();


const Clock = (() => {
  let timer = 0;
  function tick() {
    const el = document.getElementById("clock");
    if (!el) return;
    const d = new Date();
    const h = String(d.getHours()).padStart(2, "0");
    const m = String(d.getMinutes()).padStart(2, "0");
    const text = `${h}:${m}`;
    if (el.textContent === text) return;
    el.textContent = text;
    el.setAttribute("datetime", d.toISOString());
  }
  return {
    start() {
      tick();
      timer = window.setInterval(tick, 1000);
    },
    stop() {
      if (timer) window.clearInterval(timer);
      timer = 0;
    },
  };
})();

/**
 * Статистика как на NTP Brave
 */
const BraveStats = (() => {
  const MS_PER_BLOCKED = 50;

  /** @param {unknown} x */
  function num(x) {
    const n = typeof x === "string" ? Number(x) : Number(x);
    return Number.isFinite(n) ? n : 0;
  }

  /** @param {unknown} raw */
  function normalize(raw) {
    if (!raw || typeof raw !== "object") return null;
    const o = /** @type {Record<string, unknown>} */ (raw);
    return {
      adsBlockedStat: num(o.adsBlockedStat ?? o.ads_blocked),
      bandwidthSavedStat: num(o.bandwidthSavedStat ?? o.bandwidth_saved_bytes),
    };
  }

  /** @param {{ adsBlockedStat: number }} s */
  function formatAds(s) {
    return Math.max(0, Math.floor(s.adsBlockedStat)).toLocaleString("ru-RU");
  }

  function formatBandwidth(bytes) {
    const b = Math.max(0, Math.floor(bytes));
    if (b < 1024) return `${b} Б`;
    if (b < 1024 * 1024) return `${(b / 1024).toFixed(0)} КБ`.replace(".", ",");
    if (b < 1024 * 1024 * 1024) {
      return `${(b / 1024 / 1024).toFixed(1)} МБ`.replace(".", ",");
    }
    return `${(b / 1024 / 1024 / 1024).toFixed(2)} ГБ`.replace(".", ",");
  }

  function formatTimeSaved(adsBlocked) {
    const ms = Math.max(0, adsBlocked * MS_PER_BLOCKED);
    if (ms < 1000 * 60) {
      const c = Math.ceil(ms / 1000);
      return `${c} сек`;
    }
    if (ms < 1000 * 60 * 60) {
      const c = Math.ceil(ms / 1000 / 60);
      return `${c} мин`;
    }
    if (ms < 1000 * 60 * 60 * 24) {
      const c = +((ms / 1000 / 60 / 60).toFixed(1));
      return `${String(c).replace(".", ",")} ч`;
    }
    const c = +((ms / 1000 / 60 / 60 / 24).toFixed(2));
    return `${String(c).replace(".", ",")} дн`;
  }

  /** @param {{ adsBlockedStat: number, bandwidthSavedStat: number }} s */
  function render(s) {
    const a = document.getElementById("stat-a");
    const b = document.getElementById("stat-b");
    const c = document.getElementById("stat-c");
    if (a) a.textContent = formatAds(s);
    if (b) b.textContent = formatBandwidth(s.bandwidthSavedStat);
    if (c) c.textContent = formatTimeSaved(s.adsBlockedStat);
  }

  function renderDashes() {
    const a = document.getElementById("stat-a");
    const b = document.getElementById("stat-b");
    const c = document.getElementById("stat-c");
    if (a) a.textContent = "—";
    if (b) b.textContent = "—";
    if (c) c.textContent = "—";
  }

  /** @returns {{ adsBlockedStat: number, bandwidthSavedStat: number } | null} */
  function loadCached() {
    try {
      const raw = localStorage.getItem(CFG.LS_BRAVE_STATS_CACHE);
      if (!raw) return null;
      return normalize(JSON.parse(raw));
    } catch {
      return null;
    }
  }

  /** @param {{ adsBlockedStat: number, bandwidthSavedStat: number }} s */
  function saveCached(s) {
    try {
      localStorage.setItem(
        CFG.LS_BRAVE_STATS_CACHE,
        JSON.stringify({
          adsBlockedStat: s.adsBlockedStat,
          bandwidthSavedStat: s.bandwidthSavedStat,
        }),
      );
    } catch {
      /* ignore */
    }
  }

  function renderFromCacheOrDashes() {
    const c = loadCached();
    if (c) render(c);
    else renderDashes();
  }

  async function detectBrave() {
    try {
      const nb = navigator.brave;
      if (nb && typeof nb.isBrave === "function" && (await nb.isBrave())) return true;
    } catch {
      /* ignore */
    }
    try {
      const ua = navigator.userAgentData;
      if (ua && Array.isArray(ua.brands)) {
        return ua.brands.some((x) => String(x.brand).includes("Brave"));
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  async function tryWebUiStats() {
    const Cr = globalThis.Cr || globalThis.cr;
    if (!Cr || typeof Cr.sendWithPromise !== "function") return null;
    try {
      const raw = await Cr.sendWithPromise("getNewTabPageStats");
      return normalize(raw);
    } catch {
      return null;
    }
  }

  function wireWebUiListener() {
    const Cr = globalThis.Cr || globalThis.cr;
    if (!Cr || typeof Cr.addWebUiListener !== "function") return;
    Cr.addWebUiListener("stats-updated", (raw) => {
      const s = normalize(raw);
      if (s) {
        saveCached(s);
        render(s);
      }
    });
  }

  function statsUrlCandidates() {
    const out = [];
    try {
      const u = localStorage.getItem(CFG.LS_BRAVE_STATS_URL);
      if (u && String(u).trim()) out.push(String(u).trim());
    } catch {
      /* ignore */
    }
    out.push(CFG.BRAVE_STATS_DEFAULT_URL);
    return out;
  }

  async function tryFetchPrefsMirror() {
    for (const url of statsUrlCandidates()) {
      try {
        const res = await fetch(url, { cache: "no-store", credentials: "omit" });
        if (!res.ok) continue;
        const s = normalize(await res.json());
        if (s) return s;
      } catch {
        /* next */
      }
    }
    return null;
  }

  async function refresh() {
    let s = await tryWebUiStats();
    if (!s) s = await tryFetchPrefsMirror();
    if (s) {
      saveCached(s);
      render(s);
    }
  }

  let refreshBound = false;

  function bindRefresh() {
    if (refreshBound) return;
    refreshBound = true;
    window.addEventListener("pageshow", () => {
      if (!document.body.classList.contains("is-brave")) return;
      void refresh();
    });
  }

  async function init() {
    const brave = await detectBrave();
    if (!brave) return;
    document.body.classList.add("is-brave");

    renderFromCacheOrDashes();
    wireWebUiListener();
    bindRefresh();
  }

  return { init };
})();

const Bookmarks = (() => {
  /** @type {string | null} */
  let dragBookmarkId = null;

  const faviconBlobUrlByHost = /** @type {Map<string, string>} */ (new Map());

  /** @param {string} host @param {Blob} blob @returns {string} */
  function blobUrlForHost(host, blob) {
    const h = String(host).toLowerCase();
    const prev = faviconBlobUrlByHost.get(h);
    if (prev) return prev;
    const u = URL.createObjectURL(blob);
    faviconBlobUrlByHost.set(h, u);
    return u;
  }

  async function prefetchFaviconMemFromIdb() {
    const list = load();
    const hosts = [
      ...new Set(
        list
          .map((bm) => util.hostFromUrl(bm.url))
          .filter((h) => Boolean(h)),
      ),
    ];
    await Promise.all(
      hosts.map(async (h) => {
        try {
          const b = await FaviconCache.get(h);
          if (b) blobUrlForHost(h, b);
        } catch {
          /* ignore */
        }
      }),
    );
  }

  /** @param {HTMLAnchorElement} anchor */
  function hydrateBookmarkIcon(anchor, pageUrl) {
    const img = anchor.querySelector(".bookmark-icon");
    if (!img) return;
    const host = util.hostFromUrl(pageUrl);
    if (!host) return;

    if (img.getAttribute("src")) {
      anchor.classList.add("has-icon");
      void FaviconCache.ensureBlob(host).catch(() => {});
      return;
    }

    img.decoding = "sync";
    img.referrerPolicy = "no-referrer";

    let failed = false;
    const markFail = () => {
      if (failed) return;
      failed = true;
      anchor.classList.remove("has-icon");
      img.removeAttribute("src");
    };

    img.onerror = markFail;

    const mem = faviconBlobUrlByHost.get(host.toLowerCase());
    if (mem) {
      anchor.classList.add("has-icon");
      img.src = mem;
      void FaviconCache.ensureBlob(host).catch(() => {});
      return;
    }

    const url = FaviconCache.serviceURL(host);
    anchor.classList.add("has-icon");
    img.src = url;

    void FaviconCache.ensureBlob(host)
      .then((b) => {
        if (!b || failed) return;
        blobUrlForHost(host, b);
      })
      .catch(() => {});
  }

  /** @returns {Bookmark[]} */
  function load() {
    const el = document.getElementById("bookmarks-initial");
    if (el && el.textContent.trim()) {
      try {
        const arr = JSON.parse(el.textContent);
        if (Array.isArray(arr)) {
          return arr
            .filter((x) => x && typeof x.url === "string" && x.id)
            .map((x) => ({
              id: String(x.id),
              title: String(x.title || x.url).slice(0, 32),
              url: util.normalizeUrl(x.url),
            }));
        }
      } catch {
        /* fall through */
      }
    }
    try {
      const raw = localStorage.getItem(CFG.LS_BOOKMARKS);
      if (!raw) return [];
      const arr = JSON.parse(raw);
      if (!Array.isArray(arr)) return [];
      return arr
        .filter((x) => x && typeof x.url === "string")
        .map((x) => ({
          id: String(x.id || util.randomSeed()),
          title: String(x.title || x.url).slice(0, 32),
          url: util.normalizeUrl(x.url),
        }));
    } catch {
      return [];
    }
  }

  function usesRemoteBookmarks() {
    return (
      location.protocol === "chrome-extension:" ||
      location.protocol === "moz-extension:" ||
      !!document.getElementById("bookmarks-initial")
    );
  }

  /** @param {Bookmark[]} list */
  async function save(list) {
    const el = document.getElementById("bookmarks-initial");
    const prev = el ? el.textContent : null;
    if (el) el.textContent = JSON.stringify(list);

    if (usesRemoteBookmarks()) {
      try {
        const r = await fetch(CFG.bookmarksURL(), {
          method: "PUT",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(list),
        });
        if (!r.ok) {
          const t = await r.text();
          throw new Error(t || String(r.status));
        }
      } catch (e) {
        if (el && prev != null) el.textContent = prev;
        window.alert(e instanceof Error ? e.message : String(e));
        throw e;
      }
    }

    try {
      localStorage.setItem(CFG.LS_BOOKMARKS, JSON.stringify(list));
    } catch {
      /* ignore */
    }
  }

  /** @param {Bookmark[]} list @param {string} draggedId @param {string} targetId @param {boolean} insertAfter */
  function reorderBookmarks(list, draggedId, targetId, insertAfter) {
    if (draggedId === targetId) return list;
    const fromIdx = list.findIndex((x) => x.id === draggedId);
    if (fromIdx < 0) return list;
    const toIdx = list.findIndex((x) => x.id === targetId);
    if (toIdx < 0) return list;
    const item = list[fromIdx];
    const rest = list.filter((x) => x.id !== draggedId);
    let insertAt = rest.findIndex((x) => x.id === targetId);
    if (insertAt < 0) return list;
    if (insertAfter) insertAt += 1;
    rest.splice(insertAt, 0, item);
    return rest;
  }

  function clearDndVisuals() {
    document.querySelectorAll(".bookmark--dragging, .bookmark--drop-before, .bookmark--drop-after").forEach((el) => {
      el.classList.remove("bookmark--dragging", "bookmark--drop-before", "bookmark--drop-after");
    });
  }

  /** @param {HTMLUListElement} ul */
  function bindListRootDnD(ul) {
    if (ul.dataset.bookmarkDndRoot === "1") return;
    ul.dataset.bookmarkDndRoot = "1";
    ul.addEventListener("dragover", (e) => {
      if (!dragBookmarkId) return;
      if (e.target === ul) {
        e.preventDefault();
        e.dataTransfer.dropEffect = "move";
      }
    });
    ul.addEventListener("drop", (e) => {
      if (!dragBookmarkId) return;
      if (e.target !== ul) return;
      e.preventDefault();
      const list = load();
      const id = dragBookmarkId;
      const fromIdx = list.findIndex((x) => x.id === id);
      if (fromIdx < 0) return;
      const item = list[fromIdx];
      const rest = list.filter((x) => x.id !== id);
      rest.push(item);
      void save(rest)
        .then(() => render())
        .catch(() => {});
      bookmarkCtxHide();
      clearDndVisuals();
      dragBookmarkId = null;
    });
  }

  /** @param {HTMLLIElement} li @param {Bookmark} bm @param {HTMLUListElement} ul */
  function bindBookmarkDrag(li, bm, ul) {
    if (li.dataset.bookmarkDragBound === "1") return;
    li.dataset.bookmarkDragBound = "1";
    li.draggable = true;
    li.dataset.bookmarkId = bm.id;

    li.addEventListener("dragstart", (e) => {
      dragBookmarkId = bm.id;
      e.dataTransfer.setData("text/plain", bm.id);
      e.dataTransfer.effectAllowed = "move";
      try {
        e.dataTransfer.setDragImage(li, Math.floor(li.offsetWidth / 2), Math.floor(li.offsetHeight / 2));
      } catch {
        /* ignore */
      }
      li.classList.add("bookmark--dragging");
    });

    li.addEventListener("dragend", () => {
      dragBookmarkId = null;
      clearDndVisuals();
    });

    li.addEventListener("dragover", (e) => {
      if (!dragBookmarkId || dragBookmarkId === bm.id) return;
      e.preventDefault();
      e.stopPropagation();
      e.dataTransfer.dropEffect = "move";
      ul.querySelectorAll(".bookmark--drop-before, .bookmark--drop-after").forEach((n) => {
        if (n !== li) n.classList.remove("bookmark--drop-before", "bookmark--drop-after");
      });
      const rect = li.getBoundingClientRect();
      const after = e.clientX - rect.left > rect.width / 2;
      li.classList.toggle("bookmark--drop-after", after);
      li.classList.toggle("bookmark--drop-before", !after);
    });

    li.addEventListener("drop", (e) => {
      if (!dragBookmarkId) return;
      e.preventDefault();
      e.stopPropagation();
      const draggedId = e.dataTransfer.getData("text/plain") || dragBookmarkId;
      const insertAfter = li.classList.contains("bookmark--drop-after");
      const next = reorderBookmarks(load(), draggedId, bm.id, insertAfter);
      void save(next)
        .then(() => render())
        .catch(() => {});
      bookmarkCtxHide();
      clearDndVisuals();
      dragBookmarkId = null;
    });
  }

  /** @param {HTMLUListElement} ul */
  function bindBookmarksContextMenu(ul) {
    if (ul.dataset.bookmarkCtxBound === "1") return;
    ul.dataset.bookmarkCtxBound = "1";
    ul.addEventListener(
      "contextmenu",
      (e) => {
        const t = /** @type {HTMLElement | null} */ (e.target);
        const li = t && "closest" in t ? /** @type {HTMLLIElement | null} */ (t.closest("li.bookmark")) : null;
        if (!li || !ul.contains(li)) return;
        const id = li.dataset.bookmarkId;
        if (!id) return;
        e.preventDefault();
        bookmarkCtxShow(e.clientX, e.clientY, id);
      },
      true,
    );
  }

  /** @param {Bookmark} bm */
  function createBookmarkLi(bm) {
    const li = document.createElement("li");
    li.className = "bookmark";
    li.dataset.bookmarkId = bm.id;
    const a = document.createElement("a");
    a.className = "bookmark-link";
    a.href = bm.url;
    a.rel = "noopener noreferrer";
    a.title = bm.title;
    a.draggable = false;
    const fb = document.createElement("span");
    fb.className = "bookmark-fallback";
    fb.setAttribute("aria-hidden", "true");
    fb.textContent = util.letterFromTitle(bm.title);
    const img = document.createElement("img");
    img.className = "bookmark-icon";
    img.alt = "";
    img.draggable = false;
    a.appendChild(fb);
    a.appendChild(img);
    hydrateBookmarkIcon(a, bm.url);
    const host = util.hostFromUrl(bm.url);
    if (host) a.dataset.bookmarkHost = host;
    const lab = document.createElement("span");
    lab.className = "bookmark-label";
    lab.textContent = bm.title;
    li.appendChild(a);
    li.appendChild(lab);
    return li;
  }

  /** @param {HTMLLIElement} li @param {Bookmark} bm */
  function syncBookmarkLi(li, bm) {
    li.dataset.bookmarkId = bm.id;
    const a = /** @type {HTMLAnchorElement | null} */ (li.querySelector("a.bookmark-link"));
    if (!a) return;
    const host = util.hostFromUrl(bm.url);
    const prevHost = a.dataset.bookmarkHost || "";
    a.href = bm.url;
    a.title = bm.title;
    const lab = li.querySelector(".bookmark-label");
    if (lab) lab.textContent = bm.title;
    const fb = li.querySelector(".bookmark-fallback");
    if (fb) fb.textContent = util.letterFromTitle(bm.title);
    if (host !== prevHost) {
      hydrateBookmarkIcon(a, bm.url);
      if (host) a.dataset.bookmarkHost = host;
      else delete a.dataset.bookmarkHost;
    }
  }

  function render() {
    const ul = document.getElementById("bookmarks");
    if (!ul) return;
    bindListRootDnD(ul);
    bindBookmarksContextMenu(ul);
    const list = load();
    /** @type {Map<string, HTMLLIElement>} */
    const pool = new Map();
    for (const el of ul.querySelectorAll("li.bookmark")) {
      const li = /** @type {HTMLLIElement} */ (el);
      const id = li.dataset.bookmarkId;
      if (id) pool.set(id, li);
    }
    for (const bm of list) {
      let li = pool.get(bm.id);
      if (li) {
        pool.delete(bm.id);
        if (li.querySelector(".bookmark-close, .bookmark-icon-wrap")) {
          li.remove();
          li = createBookmarkLi(bm);
          bindBookmarkDrag(li, bm, ul);
        } else {
          syncBookmarkLi(li, bm);
        }
      } else {
        li = createBookmarkLi(bm);
        bindBookmarkDrag(li, bm, ul);
      }
      ul.appendChild(li);
    }
    for (const li of pool.values()) li.remove();
  }

  let ctxMenuEl = /** @type {HTMLDivElement | null} */ (null);
  let ctxMenuBound = false;
  let ctxTargetId = /** @type {string | null} */ (null);
  let dialogEditId = /** @type {string | null} */ (null);

  function bookmarkCtxHide() {
    ctxTargetId = null;
    if (ctxMenuEl) {
      ctxMenuEl.hidden = true;
      ctxMenuEl.setAttribute("aria-hidden", "true");
    }
  }

  const CTX_MENU_VER = "2";

  function bookmarkCtxEnsure() {
    const existing = document.getElementById("bookmark-ctx-menu");
    if (existing?.dataset.menuVer === CTX_MENU_VER) {
      ctxMenuEl = /** @type {HTMLDivElement} */ (existing);
      return ctxMenuEl;
    }
    if (existing) existing.remove();
    ctxMenuEl = null;

    const wrap = document.createElement("div");
    wrap.id = "bookmark-ctx-menu";
    wrap.className = "bookmark-ctx";
    wrap.dataset.menuVer = CTX_MENU_VER;
    wrap.setAttribute("role", "menu");
    wrap.hidden = true;
    wrap.setAttribute("aria-hidden", "true");
    const editBtn = document.createElement("button");
    editBtn.type = "button";
    editBtn.className = "bookmark-ctx-item";
    editBtn.setAttribute("role", "menuitem");
    editBtn.dataset.action = "edit";
    editBtn.textContent = "Редактировать";
    editBtn.addEventListener("click", () => {
      const id = ctxTargetId;
      bookmarkCtxHide();
      if (id) openDialog(id);
    });
    const delBtn = document.createElement("button");
    delBtn.type = "button";
    delBtn.className = "bookmark-ctx-item";
    delBtn.setAttribute("role", "menuitem");
    delBtn.dataset.action = "delete";
    delBtn.textContent = "Удалить";
    delBtn.addEventListener("click", () => {
      const id = ctxTargetId;
      bookmarkCtxHide();
      if (id) {
        void save(load().filter((x) => x.id !== id))
          .then(() => render())
          .catch(() => {});
      }
    });
    wrap.appendChild(editBtn);
    wrap.appendChild(delBtn);
    wrap.addEventListener("contextmenu", (e) => {
      e.preventDefault();
    });
    document.body.appendChild(wrap);
    ctxMenuEl = wrap;
    if (!ctxMenuBound) {
      ctxMenuBound = true;
      document.addEventListener("click", (e) => {
        if (!ctxMenuEl || ctxMenuEl.hidden) return;
        if (!ctxMenuEl.contains(/** @type {Node} */ (e.target))) bookmarkCtxHide();
      });
      document.addEventListener("keydown", (e) => {
        if (e.key === "Escape") bookmarkCtxHide();
      });
      window.addEventListener("scroll", bookmarkCtxHide, true);
      window.addEventListener("blur", bookmarkCtxHide);
    }
    return wrap;
  }

  /** @param {number} x @param {number} y @param {string} bookmarkId */
  function bookmarkCtxShow(x, y, bookmarkId) {
    ctxTargetId = bookmarkId;
    const el = bookmarkCtxEnsure();
    el.hidden = false;
    el.setAttribute("aria-hidden", "false");
    const estW = 168;
    const estH = 88;
    const pad = 8;
    const left = Math.max(pad, Math.min(x, window.innerWidth - estW - pad));
    const top = Math.max(pad, Math.min(y, window.innerHeight - estH - pad));
    el.style.left = `${left}px`;
    el.style.top = `${top}px`;
    queueMicrotask(() => {
      const r = el.getBoundingClientRect();
      let nx = left;
      let ny = top;
      if (r.right > window.innerWidth - pad) nx = window.innerWidth - r.width - pad;
      if (r.bottom > window.innerHeight - pad) ny = window.innerHeight - r.height - pad;
      if (nx < pad) nx = pad;
      if (ny < pad) ny = pad;
      el.style.left = `${nx}px`;
      el.style.top = `${ny}px`;
    });
  }

  /** @param {string} [editId] */
  function openDialog(editId) {
    const dlg = document.getElementById("dlg-bookmark");
    const title = document.getElementById("bm-title");
    const url = document.getElementById("bm-url");
    const heading = dlg ? dlg.querySelector("h3") : null;
    if (!dlg || !title || !url) return;

    if (editId) {
      const bm = load().find((x) => x.id === editId);
      if (!bm) return;
      dialogEditId = editId;
      title.value = bm.title;
      url.value = bm.url;
      if (heading) heading.textContent = "Редактировать закладку";
    } else {
      dialogEditId = null;
      title.value = "";
      url.value = "";
      if (heading) heading.textContent = "Новая закладка";
    }

    dlg.showModal();
    queueMicrotask(() => title.focus());
  }

  function closeDialog() {
    const dlg = document.getElementById("dlg-bookmark");
    dialogEditId = null;
    const heading = dlg ? dlg.querySelector("h3") : null;
    if (heading) heading.textContent = "Новая закладка";
    if (dlg) dlg.close();
  }

  async function submitDialog() {
    const dlg = document.getElementById("dlg-bookmark");
    const title = document.getElementById("bm-title");
    const url = document.getElementById("bm-url");
    if (!dlg || !title || !url) return;
    const t = title.value.trim();
    const u = util.normalizeUrl(url.value.trim());
    if (!t || !u) return;
    const list = load();
    const editId = dialogEditId;
    if (editId) {
      const ix = list.findIndex((x) => x.id === editId);
      if (ix < 0) return;
      list[ix] = { id: editId, title: t.slice(0, 32), url: u };
    } else {
      list.push({ id: util.randomSeed(), title: t.slice(0, 32), url: u });
    }
    try {
      await save(list);
      render();
      closeDialog();
    } catch {
      /* ignore */
    }
  }

  async function syncFromServer() {
    if (location.protocol !== "chrome-extension:" && location.protocol !== "moz-extension:") {
      return;
    }
    try {
      const r = await fetch(CFG.bookmarksURL(), { cache: "no-store" });
      if (!r.ok) return;
      const arr = await r.json();
      if (!Array.isArray(arr)) return;
      const list = arr
        .filter((x) => x && typeof x.url === "string")
        .map((x) => ({
          id: String(x.id || util.randomSeed()),
          title: String(x.title || x.url).slice(0, 32),
          url: util.normalizeUrl(x.url),
        }));
      localStorage.setItem(CFG.LS_BOOKMARKS, JSON.stringify(list));
    } catch {
      /* сервер не запущен */
    }
  }

  function attach() {
    const dlg = document.getElementById("dlg-bookmark");
    if (dlg && dlg.dataset.bookmarkDlgBound !== "1") {
      dlg.dataset.bookmarkDlgBound = "1";
      dlg.addEventListener("close", () => {
        dialogEditId = null;
        const heading = dlg.querySelector("h3");
        if (heading) heading.textContent = "Новая закладка";
      });
    }

    const ul = document.getElementById("bookmarks");
    if (!ul) return;
    bindListRootDnD(ul);
    bindBookmarksContextMenu(ul);
    render();
  }

  async function init() {
    await syncFromServer();
    attach();
  }

  return {
    load,
    render,
    openDialog,
    closeDialog,
    submitDialog,
    prefetchFaviconMemFromIdb,
    attach,
    init,
  };
})();

const Background = (() => {
  const BG = {
    META: "__bg_meta__",
    blobKey(id) {
      return `b:${id}`;
    },
    PREFETCH: 3,
    PRUNE: 3,
  };

  /** @type {{ active: number, urls: (string|null)[], displayedId: string | null, prefetching: boolean }} */
  const state = {
    active: 0,
    urls: [null, null],
    displayedId: null,
    prefetching: false,
  };

  function layers() {
    return [document.getElementById("bg-0"), document.getElementById("bg-1")];
  }

  function revokeIfBlob(u) {
    if (u && u.startsWith("blob:")) URL.revokeObjectURL(u);
  }

  function setLayerBg(idx, url) {
    const L = layers()[idx];
    if (!L) return;
    revokeIfBlob(state.urls[idx]);
    state.urls[idx] = url || null;
    L.style.backgroundImage = url ? `url(${JSON.stringify(url)})` : "none";
  }

  function showLayer(idx) {
    const [a, b] = layers();
    const on = idx === 0 ? a : b;
    const off = idx === 0 ? b : a;
    if (on) on.classList.add("is-visible");
    if (off) off.classList.remove("is-visible");
    state.active = idx;
  }

  function idbOpen() {
    return new Promise((resolve, reject) => {
      const r = indexedDB.open(CFG.IDB_NAME, CFG.IDB_VER);
      r.onupgradeneeded = () => {
        const db = r.result;
        if (!db.objectStoreNames.contains(CFG.IDB_STORE)) {
          db.createObjectStore(CFG.IDB_STORE);
        }
      };
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
  }

  /** @param {IDBDatabase} db */
  function idbGet(db, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CFG.IDB_STORE, "readonly");
      const g = tx.objectStore(CFG.IDB_STORE).get(key);
      g.onsuccess = () => resolve(g.result);
      g.onerror = () => reject(g.error);
    });
  }

  /** @param {IDBDatabase} db */
  function idbPut(db, key, val) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CFG.IDB_STORE, "readwrite");
      tx.objectStore(CFG.IDB_STORE).put(val, key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** @param {IDBDatabase} db */
  function idbDel(db, key) {
    return new Promise((resolve, reject) => {
      const tx = db.transaction(CFG.IDB_STORE, "readwrite");
      tx.objectStore(CFG.IDB_STORE).delete(key);
      tx.oncomplete = () => resolve();
      tx.onerror = () => reject(tx.error);
    });
  }

  /** @returns {Promise<{ ids: string[], cursor: number }>} */
  async function readMeta(db) {
    const raw = await idbGet(db, BG.META);
    if (raw && Array.isArray(raw.ids)) {
      return {
        ids: raw.ids.map(String),
        cursor: Number.isFinite(raw.cursor) ? raw.cursor : 0,
      };
    }
    return { ids: [], cursor: 0 };
  }

  /** @param {IDBDatabase} db @param {{ ids: string[], cursor: number }} meta */
  async function writeMeta(db, meta) {
    const ids = meta.ids.map(String);
    let c = meta.cursor | 0;
    if (ids.length === 0) c = 0;
    else if (c < 0 || c >= ids.length) c = 0;
    await idbPut(db, BG.META, { ids, cursor: c });
  }

  async function fetchWallpaperBlob() {
    const seed = util.randomSeed();
    const url = CFG.picsumUrl(seed);
    const res = await fetch(url, { mode: "cors", credentials: "omit", cache: "default" });
    if (!res.ok) throw new Error(String(res.status));
    return await res.blob();
  }

  /** @param {IDBDatabase} db */
  async function prefetchAndPrune(db) {
    if (state.prefetching) return;
    state.prefetching = true;
    const keepId = state.displayedId;
    try {
      const meta0 = await readMeta(db);
      const preIds = [...meta0.ids];

      const blobs = await Promise.all(
        Array.from({ length: BG.PREFETCH }, () => fetchWallpaperBlob()),
      );
      const newIds = [];
      for (const blob of blobs) {
        const id = util.randomSeed();
        await idbPut(db, BG.blobKey(id), blob);
        newIds.push(id);
      }

      let combined = preIds.concat(newIds);
      const toRemove = [];
      if (keepId) {
        for (const id of preIds) {
          if (toRemove.length >= BG.PRUNE) break;
          if (id === keepId) continue;
          toRemove.push(id);
        }
        for (const id of toRemove) {
          try {
            await idbDel(db, BG.blobKey(id));
          } catch {
            /* ignore */
          }
        }
        combined = combined.filter((id) => !toRemove.includes(id));
      }

      const ix = keepId ? combined.indexOf(keepId) : -1;
      const cursor = ix >= 0 ? ix : Math.min(meta0.cursor, Math.max(0, combined.length - 1));
      await writeMeta(db, { ids: combined, cursor });
    } catch {
      /* сеть недоступна — кеш без изменений */
    } finally {
      state.prefetching = false;
    }
  }

  async function bootstrapEmpty(db) {
    try {
      const blobs = await Promise.all(
        Array.from({ length: BG.PREFETCH }, () => fetchWallpaperBlob()),
      );
      const ids = [];
      for (const blob of blobs) {
        const id = util.randomSeed();
        await idbPut(db, BG.blobKey(id), blob);
        ids.push(id);
      }
      await writeMeta(db, { ids, cursor: 0 });
      const url = URL.createObjectURL(await idbGet(db, BG.blobKey(ids[0])));
      state.displayedId = ids[0];
      setLayerBg(0, url);
      requestAnimationFrame(() => showLayer(0));
    } catch {
      const seed = util.randomSeed();
      setLayerBg(0, CFG.picsumUrl(seed));
      requestAnimationFrame(() => showLayer(0));
    }
  }

  async function run() {
    const [L0, L1] = layers();
    if (!L0 || !L1) return;

    let db;
    try {
      db = await idbOpen();
    } catch {
      db = null;
    }

    if (!db) {
      const seed = util.randomSeed();
      setLayerBg(0, CFG.picsumUrl(seed));
      requestAnimationFrame(() => showLayer(0));
      return;
    }

    let meta = await readMeta(db);

    if (meta.ids.length === 0) {
      await bootstrapEmpty(db);
      return;
    }

    const nextCursor = (meta.cursor + 1) % meta.ids.length;
    const showId = meta.ids[nextCursor];
    meta.cursor = nextCursor;
    await writeMeta(db, meta);

    let blob;
    try {
      blob = await idbGet(db, BG.blobKey(showId));
    } catch {
      blob = null;
    }
    if (!(blob instanceof Blob)) {
      await bootstrapEmpty(db);
      void prefetchAndPrune(db);
      return;
    }

    const url = URL.createObjectURL(blob);
    state.displayedId = showId;
    setLayerBg(0, url);
    requestAnimationFrame(() => showLayer(0));

    void prefetchAndPrune(db);
  }

  return { init: run };
})();

/** ЙЦУКЕН ↔ QWERTY (та же клавиша) — только для поиска, не для поля ввода. */
const KeyboardLayout = (() => {
  const pairs = [
    ["й", "q"],
    ["ц", "w"],
    ["у", "e"],
    ["к", "r"],
    ["е", "t"],
    ["н", "y"],
    ["г", "u"],
    ["ш", "i"],
    ["щ", "o"],
    ["з", "p"],
    ["х", "["],
    ["ъ", "]"],
    ["ф", "a"],
    ["ы", "s"],
    ["в", "d"],
    ["а", "f"],
    ["п", "g"],
    ["р", "h"],
    ["о", "j"],
    ["л", "k"],
    ["д", "l"],
    ["ж", ";"],
    ["э", "'"],
    ["я", "z"],
    ["ч", "x"],
    ["с", "c"],
    ["м", "v"],
    ["и", "b"],
    ["т", "n"],
    ["ь", "m"],
    ["б", ","],
    ["ю", "."],
    [".", "ю"],
    ["/", "."],
    ["ё", "`"],
    ["Ё", "`"],
  ];

  /** @type {Record<string, string>} */
  const ruToEn = {};
  /** @type {Record<string, string>} */
  const enToRu = {};

  for (const [ru, en] of pairs) {
    ruToEn[ru] = en;
    enToRu[en] = ru;
    const ruU = ru.toUpperCase();
    const enU = en.toUpperCase();
    if (ruU !== ru) ruToEn[ruU] = enU;
    if (enU !== en) enToRu[enU] = ruU;
  }

  /** @param {string} s @param {Record<string, string>} table */
  function mapChars(s, table) {
    let out = "";
    let changed = false;
    for (const c of s) {
      const m = table[c];
      if (m !== undefined) {
        out += m;
        changed = true;
      } else {
        out += c;
      }
    }
    return changed ? out : "";
  }

  /** @param {string} text */
  function searchVariants(text) {
    const variants = new Set([text]);
    const toEn = mapChars(text, ruToEn);
    const toRu = mapChars(text, enToRu);
    if (toEn) variants.add(toEn);
    if (toRu) variants.add(toRu);
    return [...variants];
  }

  return { searchVariants };
})();

/** Подсказки из истории браузера (chrome.history через background расширения). */
const SearchHistory = (() => {
  /** @type {HTMLUListElement | null} */
  let listEl = null;
  /** @type {HTMLTextAreaElement | null} */
  let input = null;
  /** @type {HTMLElement | null} */
  let ghostEl = null;
  /** @type {{ kind: string, url: string, label: string, hint: string }[]} */
  let items = [];
  let activeIndex = -1;
  let reqId = 0;
  let lastInputLen = 0;
  /** @type {chrome.history.HistoryItem[] | null} */
  let localHistory = null;

  /** @param {string} s */
  function esc(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function available() {
    return typeof chrome !== "undefined" && !!chrome.runtime?.id;
  }

  function isOpen() {
    return !!listEl && !listEl.hidden && items.length > 0;
  }

  function warmHistory() {
    if (localHistory) return Promise.resolve(localHistory);
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: "history-warm" }, (r) => {
        localHistory = r?.ok && Array.isArray(r.results) ? r.results : [];
        resolve(localHistory);
      });
    });
  }

  function applyQuery(text) {
    const cache = localHistory || [];
    items = buildSuggestions(cache, text);
    activeIndex = items.length ? 0 : -1;
    render();
  }

  /** @param {string} url */
  function hostKey(url) {
    return util.hostFromUrl(url).replace(/^www\./, "");
  }

  /** @param {string} query */
  function queryVariants(query) {
    return KeyboardLayout.searchVariants(query.trim())
      .map((v) => v.toLowerCase())
      .filter((v) => v.length > 0);
  }

  /** @param {string} host @param {string[]} variants */
  function hostMatchesMask(host, variants) {
    const h = host.toLowerCase().replace(/^www\./, "");
    if (!h) return false;
    const labels = h.split(".");
    for (const q of variants) {
      if (h.startsWith(q)) return true;
      for (const label of labels) {
        if (label.startsWith(q)) return true;
      }
    }
    return false;
  }

  /** @param {string} url @param {string[]} variants */
  function urlMatchesMask(url, variants) {
    if (!variants.length) return false;
    const host = hostKey(url);
    if (hostMatchesMask(host, variants)) return true;
    try {
      const u = new URL(url);
      const segments = (u.pathname + u.search).toLowerCase().split("/").filter(Boolean);
      for (const q of variants) {
        for (const seg of segments) {
          if (seg.startsWith(q)) return true;
        }
      }
    } catch {
      /* ignore */
    }
    return false;
  }

  /** @param {string} url */
  function isRootUrl(url) {
    try {
      const p = new URL(url).pathname;
      return p === "/" || p === "";
    } catch {
      return false;
    }
  }

  /** @param {chrome.history.HistoryItem[]} raw @param {string} query */
  function buildSuggestions(raw, query) {
    const variants = queryVariants(query);
    if (!variants.length) return [];

    /** @type {Map<string, { url: string, title: string, score: number }>} */
    const domains = new Map();
    /** @type {{ url: string, title: string, score: number, host: string }[]} */
    const paths = [];
    const seenPath = new Set();

    for (const h of raw) {
      if (!h.url?.startsWith("http")) continue;
      const host = hostKey(h.url);
      if (!host) continue;
      if (!urlMatchesMask(h.url, variants)) continue;

      const score = (h.visitCount || 1) + (h.lastVisitTime || 0) / 1e15;
      const hostHit = hostMatchesMask(host, variants);

      if (isRootUrl(h.url) && hostHit) {
        const prev = domains.get(host);
        if (!prev || score > prev.score) {
          domains.set(host, { url: h.url, title: h.title || host, score });
        }
      } else if (!seenPath.has(h.url)) {
        seenPath.add(h.url);
        paths.push({
          url: h.url,
          title: h.title || h.url,
          score,
          host,
        });
        if (hostHit && !domains.has(host)) {
          domains.set(host, {
            url: `https://${host}/`,
            title: host,
            score,
          });
        }
      }
    }

    const domainRows = [...domains.entries()]
      .sort((a, b) => b[1].score - a[1].score)
      .map(([host, d]) => ({
        kind: "domain",
        url: d.url,
        label: host,
        hint: d.url.replace(/^https?:\/\//i, ""),
      }));

    const pathRows = paths
      .sort((a, b) => b.score - a.score)
      .map((p) => {
        let hint = p.url;
        try {
          const u = new URL(p.url);
          hint = u.pathname + u.search + u.hash;
          if (!hint || hint === "/") hint = p.url.replace(/^https?:\/\/[^/]+/i, "") || "/";
        } catch {
          /* ignore */
        }
        return {
          kind: "url",
          url: p.url,
          label: p.title,
          hint,
        };
      });

    const rootUrls = new Set(domainRows.map((d) => d.url));
    const filteredPaths = pathRows.filter((p) => !rootUrls.has(p.url));

    return [...domainRows, ...filteredPaths].slice(0, 12);
  }

  /** @param {string} query @param {{ label: string, url: string, hint: string } | undefined} item */
  function completionSuffix(query, item) {
    if (!item || !query) return "";
    const host = hostKey(item.url);
    for (const q of queryVariants(query)) {
      if (host.toLowerCase().startsWith(q) && host.length > query.length) {
        return host.slice(query.length);
      }
      const labels = host.split(".");
      for (const label of labels) {
        if (label.toLowerCase().startsWith(q) && label.length > q.length) {
          return label.slice(q.length);
        }
      }
    }
    return "";
  }

  function updateGhost() {
    if (!ghostEl || !input) return;
    const q = input.value;
    if (!q) {
      ghostEl.innerHTML = "";
      return;
    }
    const item = items[activeIndex >= 0 ? activeIndex : 0];
    const rest = completionSuffix(q, item);
    if (!rest) {
      ghostEl.innerHTML = "";
      return;
    }
    ghostEl.innerHTML =
      `<span class="search-ghost-prefix">${esc(q)}</span>` +
      `<span class="search-ghost-rest">${esc(rest)}</span>`;
  }

  function applyGhostCompletion() {
    if (!input) return false;
    const item = items[activeIndex >= 0 ? activeIndex : 0];
    const rest = completionSuffix(input.value, item);
    if (!rest) return false;
    input.value += rest;
    input.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  }

  /** Favicon API MV3: chrome-extension://…/_favicon/?pageUrl=… */
  /** @param {string} pageUrl */
  function extensionFaviconUrl(pageUrl) {
    if (typeof chrome === "undefined" || !chrome.runtime?.getURL) return "";
    try {
      const u = new URL(chrome.runtime.getURL("/_favicon/"));
      u.searchParams.set("pageUrl", pageUrl);
      u.searchParams.set("size", "32");
      return u.href;
    } catch {
      return "";
    }
  }

  /** @param {string} host */
  function ddgFaviconUrl(host) {
    if (!host) return "";
    return `https://icons.duckduckgo.com/ip3/${encodeURIComponent(host)}.ico`;
  }

  /** @param {HTMLElement} slot @param {string} pageUrl */
  function setSuggestionIcon(slot, pageUrl) {
    const host = util.hostFromUrl(pageUrl);
    const urls = [
      extensionFaviconUrl(pageUrl),
      ddgFaviconUrl(host),
      FaviconCache.serviceURL(host),
    ].filter(Boolean);
    let i = 0;

    const useLetter = () => {
      slot.replaceChildren();
      const el = document.createElement("span");
      el.className = "search-suggestion-icon search-suggestion-icon--letter";
      el.textContent = util.letterFromTitle(host || "?");
      slot.append(el);
    };

    const tryNext = () => {
      if (i >= urls.length) {
        useLetter();
        return;
      }
      const url = urls[i++];
      const img = document.createElement("img");
      img.className = "search-suggestion-icon";
      img.alt = "";
      img.width = 20;
      img.height = 20;
      img.referrerPolicy = "no-referrer";
      img.decoding = "async";
      img.onload = () => slot.replaceChildren(img);
      img.onerror = () => tryNext();
      img.src = url;
      if (img.complete && img.naturalWidth > 0) {
        slot.replaceChildren(img);
      }
    };

    tryNext();
  }

  /** @param {{ url: string, label: string, hint: string }} it */
  function openItem(it) {
    close();
    window.location.assign(it.url);
  }

  /** @param {string} raw */
  function urlForDomainQuery(raw) {
    const t = String(raw || "").trim();
    if (!t || /\s/.test(t)) return null;

    const tLow = t.toLowerCase();
    for (const it of items) {
      if (hostKey(it.url).toLowerCase() === tLow) return it.url;
    }

    const href = util.normalizeUrl(t);
    try {
      const u = new URL(href);
      const host = u.hostname.toLowerCase();
      if (!host) return null;
      if (/^https?:\/\//i.test(t) || host.includes(".")) {
        return u.href;
      }
    } catch {
      return null;
    }
    return null;
  }

  function close() {
    items = [];
    activeIndex = -1;
    reqId += 1;
    if (listEl) {
      listEl.innerHTML = "";
      listEl.hidden = true;
    }
    if (input) input.setAttribute("aria-expanded", "false");
    if (ghostEl) ghostEl.innerHTML = "";
  }

  function closeIfOpen() {
    if (!isOpen()) return false;
    close();
    return true;
  }

  function scrollActiveIntoView() {
    if (!listEl || activeIndex < 0) return;
    const el = document.getElementById(`search-sug-${activeIndex}`);
    if (!el) return;
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  /** @param {number} next */
  function setActiveIndex(next) {
    if (!listEl || !items.length) return;
    const prev = activeIndex;
    activeIndex = Math.max(0, Math.min(next, items.length - 1));
    if (prev >= 0 && prev !== activeIndex) {
      document.getElementById(`search-sug-${prev}`)?.classList.remove("is-active");
    }
    document.getElementById(`search-sug-${activeIndex}`)?.classList.add("is-active");
    if (input) {
      input.setAttribute("aria-activedescendant", `search-sug-${activeIndex}`);
    }
    updateGhost();
    scrollActiveIntoView();
  }

  function render() {
    if (!listEl) return;
    listEl.innerHTML = "";
    if (!items.length) {
      close();
      return;
    }

    items.forEach((it, i) => {
      const li = document.createElement("li");
      li.className = "search-suggestion" + (i === activeIndex ? " is-active" : "");
      li.setAttribute("role", "option");
      li.id = `search-sug-${i}`;

      const iconSlot = document.createElement("span");
      iconSlot.className = "search-suggestion-icon-slot";
      setSuggestionIcon(iconSlot, it.url);

      const body = document.createElement("div");
      body.className = "search-suggestion-body";
      const label = document.createElement("span");
      label.className = "search-suggestion-label";
      label.textContent = it.label;
      const hint = document.createElement("span");
      hint.className = "search-suggestion-hint";
      hint.textContent = it.hint;

      body.append(label, hint);
      li.append(iconSlot, body);
      li.addEventListener("mousedown", (e) => {
        e.preventDefault();
        openItem(it);
      });
      listEl.appendChild(li);
    });

    listEl.hidden = false;
    if (input) {
      input.setAttribute("aria-expanded", "true");
      if (activeIndex >= 0) {
        input.setAttribute("aria-activedescendant", `search-sug-${activeIndex}`);
      } else {
        input.removeAttribute("aria-activedescendant");
      }
    }
    updateGhost();
    requestAnimationFrame(scrollActiveIntoView);
  }

  function onInput() {
    if (!input || !available()) return;
    const text = input.value;
    const len = text.length;

    if (!len) {
      lastInputLen = 0;
      close();
      return;
    }

    if (len < lastInputLen) {
      if (ghostEl) ghostEl.innerHTML = "";
    } else {
      updateGhost();
    }
    lastInputLen = len;
    runQuery();
  }

  function runQuery() {
    if (!input || !available()) return;
    const text = input.value;
    if (!text.length) {
      close();
      return;
    }

    if (localHistory?.length) {
      applyQuery(text);
      return;
    }

    const myReq = ++reqId;
    void warmHistory().then(() => {
      if (myReq !== reqId) return;
      applyQuery(text);
    });
  }

  /** @param {KeyboardEvent} e */
  function handleKeydown(e) {
    const completeKey =
      (e.key === "Tab" || e.key === "ArrowRight") && !e.ctrlKey && !e.metaKey && !e.altKey;
    if (completeKey && input?.value && completionSuffix(input.value, items[activeIndex >= 0 ? activeIndex : 0])) {
      e.preventDefault();
      applyGhostCompletion();
      return true;
    }

    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey && input?.value) {
      const direct = urlForDomainQuery(input.value);
      if (direct) {
        e.preventDefault();
        close();
        window.location.assign(direct);
        return true;
      }
    }

    if (!isOpen()) return false;

    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex(activeIndex + 1);
      return true;
    }
    if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex(activeIndex - 1);
      return true;
    }
    if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
      if (activeIndex >= 0 && items[activeIndex]) {
        e.preventDefault();
        openItem(items[activeIndex]);
        return true;
      }
    }
    if (e.key === "Escape") {
      e.preventDefault();
      close();
      return true;
    }
    return false;
  }

  function bind() {
    listEl = /** @type {HTMLUListElement | null} */ (document.getElementById("search-suggestions"));
    input = /** @type {HTMLTextAreaElement | null} */ (document.getElementById("search-q"));
    ghostEl = document.getElementById("search-ghost");
    if (!listEl || !input || !ghostEl || !available()) return;

    input.addEventListener("input", onInput);
    void warmHistory();
    input.addEventListener("focus", () => {
      void warmHistory();
      if (input.value.length >= 1) runQuery();
    });
    input.addEventListener("blur", () => {
      setTimeout(() => {
        if (!listEl?.matches(":hover")) close();
      }, 150);
    });

    document.addEventListener("mousedown", (e) => {
      const t = e.target;
      if (t instanceof Node && listEl?.contains(t)) return;
      if (t === input || (input && t instanceof Node && input.parentElement?.contains(t))) return;
      close();
    });
  }

  return { bind, handleKeydown, closeIfOpen, close, urlForDomainQuery };
})();

const Search = (() => {
  /** @returns {HTMLTextAreaElement | null} */
  function inputEl() {
    return /** @type {HTMLTextAreaElement | null} */ (document.getElementById("search-q"));
  }

  /** @param {HTMLTextAreaElement} el */
  function resizeInput(el) {
    el.style.height = "auto";
    el.style.height = `${el.scrollHeight}px`;
  }

  function go(mode) {
    const input = inputEl();
    if (!input) return;
    const q = String(input.value || "").trim();
    if (!q) {
      input.focus();
      return;
    }
    SearchHistory.close();
    const direct = SearchHistory.urlForDomainQuery(q);
    if (direct) {
      window.location.assign(direct);
      return;
    }
    const base = mode === "ai" ? CFG.GOOGLE_AI : CFG.GOOGLE_WEB;
    window.location.assign(base + encodeURIComponent(q));
  }

  function focusQuery() {
    const dlg = document.getElementById("dlg-bookmark");
    if (dlg && dlg.open) return;
    const input = inputEl();
    if (!input) return;
    input.focus({ preventScroll: true });
    const end = input.value.length;
    input.setSelectionRange(end, end);
  }

  function skipTabOrderOutsideSearch() {
    document.querySelectorAll(".dock a, .dock button, .bookmark-add").forEach((el) => {
      el.tabIndex = -1;
    });
  }

  let focusHelpersBound = false;

  function bindFocusHelpers() {
    if (focusHelpersBound) return;
    focusHelpersBound = true;

    const refocus = () => setTimeout(focusQuery, 0);
    window.addEventListener("pageshow", refocus);
    window.addEventListener("focus", refocus);

    // После Esc Brave часто отдаёт фокус странице — тогда переводим в поиск.
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.key === "Escape") {
          if (SearchHistory.closeIfOpen()) return;
          refocus();
        }
      },
      true,
    );
  }

  function bindTypeToSearch() {
    document.addEventListener(
      "keydown",
      (e) => {
        if (e.defaultPrevented || e.ctrlKey || e.metaKey || e.altKey) return;
        if (e.key === "Tab" || e.key === "Escape" || e.key.startsWith("F")) return;
        const dlg = document.getElementById("dlg-bookmark");
        if (dlg && dlg.open) return;
        const input = inputEl();
        if (!input || document.activeElement === input) return;
        const t = e.target;
        if (
          t instanceof HTMLElement &&
          (t.closest("input, textarea, select, button, a") || t.closest(".bookmark-ctx"))
        ) {
          return;
        }
        if (e.key.length !== 1) return;
        e.preventDefault();
        focusQuery();
        const start = input.selectionStart ?? input.value.length;
        const end = input.selectionEnd ?? input.value.length;
        const next = input.value.slice(0, start) + e.key + input.value.slice(end);
        input.value = next;
        const pos = start + e.key.length;
        input.setSelectionRange(pos, pos);
        resizeInput(input);
        input.dispatchEvent(new Event("input", { bubbles: true }));
      },
      true,
    );
  }

  function bind() {
    const form = document.getElementById("search-form");
    const input = inputEl();
    const ai = document.getElementById("btn-ai");
    const reg = document.getElementById("btn-regular");

    skipTabOrderOutsideSearch();

    if (input) {
      resizeInput(input);
      input.addEventListener("input", () => resizeInput(input));
      input.addEventListener("keydown", (e) => {
        if (SearchHistory.handleKeydown(e)) return;
        if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
          e.preventDefault();
          SearchHistory.close();
          go(e.shiftKey ? "web" : "ai");
          return;
        }
        if (e.key === "Enter" && !e.ctrlKey && !e.metaKey && !e.shiftKey) {
          const direct = SearchHistory.urlForDomainQuery(input.value);
          if (direct) {
            e.preventDefault();
            SearchHistory.close();
            window.location.assign(direct);
          }
        }
      });
    }

    if (form) {
      form.addEventListener("submit", (e) => {
        e.preventDefault();
        go("ai");
      });
    }
    if (ai) {
      ai.addEventListener("click", (e) => {
        e.preventDefault();
        go("ai");
      });
    }
    if (reg) {
      reg.addEventListener("click", () => go("web"));
    }

    bindFocusHelpers();
    bindTypeToSearch();
    SearchHistory.bind();
    focusQuery();

    if (location.protocol === "chrome-extension:" || location.protocol === "moz-extension:") {
      [50, 150, 400, 1000, 2000, 4000].forEach((ms) => setTimeout(focusQuery, ms));
    }
  }

  return { bind, go, focusQuery };
})();

const App = {
  init() {
    Clock.start();
    void BraveStats.init();
    void Bookmarks.init();
    void Bookmarks.prefetchFaviconMemFromIdb().catch(() => {});
    Search.bind();

    const addBtn = document.getElementById("btn-add-bookmark");
    if (addBtn) addBtn.addEventListener("click", () => Bookmarks.openDialog());

    const bmForm = document.getElementById("form-bookmark");
    const bmCancel = document.getElementById("bm-cancel");
    if (bmForm) {
      bmForm.addEventListener("submit", (e) => {
        e.preventDefault();
        void Bookmarks.submitDialog();
      });
    }
    if (bmCancel) {
      bmCancel.addEventListener("click", () => Bookmarks.closeDialog());
    }

    queueMicrotask(() => Background.init());
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
