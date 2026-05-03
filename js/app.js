"use strict";

/** @typedef {{ id: string, title: string, url: string }} Bookmark */

const CFG = {
  LS_BOOKMARKS: "sp_bookmarks_v1",
  FAVICON_IDB: "sp_favicon_v1",
  FAVICON_IDB_VER: 1,
  FAVICON_STORE: "icons",
  LS_BRAVE_STATS_URL: "sp_brave_stats_endpoint",
  LS_BRAVE_STATS_CACHE: "sp_brave_stats_cache_v1",
  BRAVE_STATS_DEFAULT_URL: "http://127.0.0.1:7777/api/brave-stats.json",
  BOOKMARKS_API_PATH: "/api/bookmarks.json",
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

  async function init() {
    const brave = await detectBrave();
    if (!brave) return;
    document.body.classList.add("is-brave");

    renderFromCacheOrDashes();

    let s = await tryWebUiStats();
    if (s) {
      saveCached(s);
      render(s);
      wireWebUiListener();
      return;
    }

    s = await tryFetchPrefsMirror();
    if (s) {
      saveCached(s);
      render(s);
    }
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

  /** @param {Bookmark[]} list */
  async function save(list) {
    const el = document.getElementById("bookmarks-initial");
    const prev = el ? el.textContent : null;
    if (el) el.textContent = JSON.stringify(list);
    if (!el) {
      try {
        localStorage.setItem(CFG.LS_BOOKMARKS, JSON.stringify(list));
      } catch {
        /* ignore */
      }
      return;
    }
    try {
      const r = await fetch(CFG.BOOKMARKS_API_PATH, {
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

  function bookmarkCtxHide() {
    ctxTargetId = null;
    if (ctxMenuEl) {
      ctxMenuEl.hidden = true;
      ctxMenuEl.setAttribute("aria-hidden", "true");
    }
  }

  function bookmarkCtxEnsure() {
    if (ctxMenuEl) return ctxMenuEl;
    const wrap = document.createElement("div");
    wrap.id = "bookmark-ctx-menu";
    wrap.className = "bookmark-ctx";
    wrap.setAttribute("role", "menu");
    wrap.hidden = true;
    wrap.setAttribute("aria-hidden", "true");
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "bookmark-ctx-item";
    btn.setAttribute("role", "menuitem");
    btn.textContent = "Удалить";
    btn.addEventListener("click", () => {
      const id = ctxTargetId;
      bookmarkCtxHide();
      if (id) {
        void save(load().filter((x) => x.id !== id))
          .then(() => render())
          .catch(() => {});
      }
    });
    wrap.appendChild(btn);
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
    const estH = 44;
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

  function openDialog() {
    const dlg = document.getElementById("dlg-bookmark");
    const title = document.getElementById("bm-title");
    const url = document.getElementById("bm-url");
    if (!dlg || !title || !url) return;
    title.value = "";
    url.value = "";
    dlg.showModal();
    queueMicrotask(() => title.focus());
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
    list.push({ id: util.randomSeed(), title: t.slice(0, 32), url: u });
    try {
      await save(list);
      render();
      dlg.close();
    } catch {
      /* ignore */
    }
  }

  function attach() {
    const ul = document.getElementById("bookmarks");
    if (!ul) return;
    bindListRootDnD(ul);
    bindBookmarksContextMenu(ul);
    const list = load();
    for (const li of ul.querySelectorAll("li.bookmark")) {
      const id = li.dataset.bookmarkId;
      if (!id) continue;
      const bm = list.find((x) => x.id === id);
      if (bm) bindBookmarkDrag(li, bm, ul);
    }
  }

  return { load, render, openDialog, submitDialog, prefetchFaviconMemFromIdb, attach };
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

const Search = (() => {
  function go(mode) {
    const input = document.getElementById("search-q");
    if (!input) return;
    const q = String(input.value || "").trim();
    if (!q) {
      input.focus();
      return;
    }
    const base = mode === "ai" ? CFG.GOOGLE_AI : CFG.GOOGLE_WEB;
    window.location.assign(base + encodeURIComponent(q));
  }

  function bind() {
    const form = document.getElementById("search-form");
    const ai = document.getElementById("btn-ai");
    const reg = document.getElementById("btn-regular");

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
  }

  return { bind, go };
})();

const App = {
  init() {
    Clock.start();
    void BraveStats.init();
    Bookmarks.attach();
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
      bmCancel.addEventListener("click", () => {
        const dlg = document.getElementById("dlg-bookmark");
        if (dlg) dlg.close();
      });
    }

    queueMicrotask(() => Background.init());
  },
};

document.addEventListener("DOMContentLoaded", () => App.init());
