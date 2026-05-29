(function () {
  var el = document.getElementById("clock");
  if (!el) return;
  var d = new Date();
  el.textContent =
    String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  try {
    el.setAttribute("datetime", d.toISOString());
  } catch (e) {
    /* ignore */
  }
})();
