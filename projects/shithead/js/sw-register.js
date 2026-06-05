// Service-worker registration. Local matches persist on every action, so a
// reload is safe outside an active turn — we take updates silently and just
// reload once the new worker takes control.

if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("./sw.js").then((reg) => {
      if (!reg) return;
      function isBusy() {
        const active = document.querySelector(".screen.active");
        return active && active.id === "screen-play";
      }
      function apply(worker) { if (worker) worker.postMessage("SKIP_WAITING"); }
      function onWaiting(worker) {
        if (!isBusy()) apply(worker);
        else document.addEventListener("visibilitychange", function once() {
          if (!isBusy()) { apply(worker); document.removeEventListener("visibilitychange", once); }
        });
      }
      if (reg.waiting && navigator.serviceWorker.controller) onWaiting(reg.waiting);
      reg.addEventListener("updatefound", () => {
        const w = reg.installing;
        if (!w) return;
        w.addEventListener("statechange", () => {
          if (w.state === "installed" && navigator.serviceWorker.controller) onWaiting(w);
        });
      });
      let reloaded = false;
      navigator.serviceWorker.addEventListener("controllerchange", () => {
        if (reloaded) return; reloaded = true; window.location.reload();
      });
    }).catch(() => {});
  });
}
