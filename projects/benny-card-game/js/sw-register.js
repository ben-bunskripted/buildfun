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

      // A reload mid-game discards uncommitted UI state (an in-progress card
      // arrangement, a live drag, half-typed scores). On these screens we
      // defer to the banner so the user picks the moment. Everywhere else
      // (start, lobby, round/match end, profile) a reload is safe — local
      // matches are persisted on every action and online state is
      // server-authoritative — so we take the update silently.
      function isBusy() {
        const active = document.querySelector(".screen.active");
        const id = active && active.id;
        return id === "screen-play" || id === "screen-scoring"
          || id === "screen-pass" || id === "screen-reveal";
      }

      // Tell the waiting SW to take over. The controllerchange listener below
      // picks it up and reloads the page once it activates.
      function applyUpdate(worker) {
        worker.postMessage("SKIP_WAITING");
      }

      function promptUpdate(worker) {
        if (!isBusy()) {
          applyUpdate(worker);
          return;
        }
        const banner = document.getElementById("update-banner");
        const refresh = document.getElementById("update-refresh-btn");
        const dismiss = document.getElementById("update-dismiss-btn");
        if (!banner || !refresh) return;
        banner.classList.remove("hidden");
        refresh.onclick = () => applyUpdate(worker);
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
