// Service-worker registration + update-banner wiring.
//
// Lives in its own file (rather than an inline <script> in index.html) so the
// site-wide CSP can keep `script-src 'self'` without an `'unsafe-inline'`
// carve-out — see netlify.toml. The banner DOM is in index.html
// (#update-banner); we just attach the SW lifecycle behavior to it here.

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then((reg) => {
      if (!reg) return;

      function promptUpdate(worker) {
        const banner = document.getElementById("update-banner");
        const refresh = document.getElementById("update-refresh-btn");
        const dismiss = document.getElementById("update-dismiss-btn");
        if (!banner || !refresh) return;
        banner.classList.remove("hidden");
        refresh.onclick = () => {
          // Tell the waiting SW to take over. The controllerchange listener
          // below picks it up and reloads the page.
          worker.postMessage("SKIP_WAITING");
        };
        if (dismiss) dismiss.onclick = () => banner.classList.add("hidden");
      }

      // If a previous tab already installed the new SW and we're loading
      // fresh, the worker is sitting in `waiting` from the start.
      if (reg.waiting && navigator.serviceWorker.controller) {
        promptUpdate(reg.waiting);
      }

      // Watch for a new SW being installed during this session.
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) {
            promptUpdate(w);
          }
        });
      });

      // When the user accepts the update, the new SW activates and takes
      // control — reload once so the page picks up the fresh shell.
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return;
        reloaded = true;
        window.location.reload();
      });
    }).catch(() => {});
  });
}
