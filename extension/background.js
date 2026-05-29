function focusSearch() {
  const dlg = document.getElementById("dlg-bookmark");
  if (dlg && dlg.open) return;
  const el = document.getElementById("search-q");
  if (!el) return;
  el.focus({ preventScroll: true });
  const n = el.value.length;
  if (typeof el.setSelectionRange === "function") {
    el.setSelectionRange(n, n);
  }
}

function scheduleFocus(tabId) {
  const delays = [0, 20, 50, 100, 200, 400, 800, 1500, 3000, 5000];
  for (const ms of delays) {
    setTimeout(() => {
      chrome.scripting
        .executeScript({
          target: { tabId },
          func: focusSearch,
        })
        .catch(() => {});
    }, ms);
  }
}

function isExtensionNewTab(url) {
  if (typeof url !== "string") return false;
  const id = chrome.runtime.id;
  return url.startsWith(`chrome-extension://${id}/`) && url.includes("index.html");
}

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  const url = tab.url || info.url;
  if (!url || !isExtensionNewTab(url)) return;
  if (info.status === "complete" || info.status === "loading") {
    scheduleFocus(tabId);
  }
});

const HISTORY_MAX = 4000;
const HISTORY_MS = 120 * 24 * 60 * 60 * 1000;
/** @type {chrome.history.HistoryItem[]} */
let historyCache = [];

function loadHistoryCache() {
  return new Promise((resolve) => {
    chrome.history.search(
      {
        text: "",
        maxResults: HISTORY_MAX,
        startTime: Date.now() - HISTORY_MS,
      },
      (results) => {
        historyCache = results || [];
        resolve(historyCache);
      },
    );
  });
}

void loadHistoryCache();

chrome.history.onVisited.addListener((item) => {
  if (!item.url?.startsWith("http")) return;
  historyCache = historyCache.filter((h) => h.url !== item.url);
  historyCache.unshift({
    id: item.id,
    url: item.url,
    title: item.title,
    lastVisitTime: item.lastVisitTime || Date.now(),
    visitCount: item.visitCount,
  });
  if (historyCache.length > HISTORY_MAX) {
    historyCache.length = HISTORY_MAX;
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "history-warm") {
    if (historyCache.length) {
      sendResponse({ ok: true, results: historyCache });
      return true;
    }
    loadHistoryCache().then((results) => {
      sendResponse({ ok: true, results });
    });
    return true;
  }

  if (msg?.type === "history-search") {
    const text = String(msg.text || "").trim();
    chrome.history.search({ text, maxResults: 300 }, (results) => {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, results: [] });
        return;
      }
      sendResponse({ ok: true, results: results || [] });
    });
    return true;
  }

  if (msg?.type === "favicon-url" && msg.pageUrl) {
    try {
      const u = new URL(chrome.runtime.getURL("/_favicon/"));
      u.searchParams.set("pageUrl", String(msg.pageUrl));
      u.searchParams.set("size", "32");
      sendResponse({ ok: true, url: u.href });
    } catch {
      sendResponse({ ok: false, url: "" });
    }
    return true;
  }

  return false;
});
