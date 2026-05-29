/**
 * Фокус в #search-q на странице расширения (новая вкладка).
 * Перезагрузка с ?focus=1 — обход фокуса омнибокса на Ctrl+T.
 */
(function () {
  "use strict";

  const MARK = "focus=1";
  if (!location.search.includes(MARK)) {
    const q = location.search ? `${location.search}&${MARK}` : `?${MARK}`;
    location.replace(`${location.pathname}${q}${location.hash}`);
    return;
  }

  function focusSearch() {
    const dlg = document.getElementById("dlg-bookmark");
    if (dlg && dlg.open) return;
    const el = document.getElementById("search-q");
    if (!el) return;
    el.focus({ preventScroll: true });
    const n = el.value.length;
    try {
      el.setSelectionRange(n, n);
    } catch (_) {
      /* ignore */
    }
  }

  [0, 1, 10, 30, 80, 150, 300, 600, 1200, 2500].forEach((ms) => {
    setTimeout(focusSearch, ms);
  });

  document.addEventListener("DOMContentLoaded", focusSearch);
  window.addEventListener("pageshow", focusSearch);
  window.addEventListener("focus", () => setTimeout(focusSearch, 0));
})();
