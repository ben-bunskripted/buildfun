// Hand reorder via pointer events. Designed to work on:
//  - Desktop mouse: click-and-drag immediately
//  - Touch (iOS Safari, Android): long-press (~220ms) then drag.
//    Before the long press fires, normal horizontal scroll behavior of the hand
//    container is preserved.
//
// A simple tap (no movement, short hold) is left alone so a separate 'click'
// listener can handle card selection.

const LONG_PRESS_MS = 220;
const DRAG_THRESHOLD_PX = 6;

export function makeHandReorderable(handEl, onReorder) {
  let active = null;

  function findCard(target) {
    let el = target;
    while (el && el !== handEl) {
      if (el.classList && el.classList.contains("in-hand")) return el;
      el = el.parentElement;
    }
    return null;
  }

  function onPointerDown(e) {
    // Ignore right-click / middle-click.
    if (e.button !== undefined && e.button !== 0) return;
    const card = findCard(e.target);
    if (!card) return;
    if (card.classList.contains("disabled")) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const isTouch = e.pointerType === "touch";

    const ctx = {
      card,
      startX, startY,
      pointerId: e.pointerId,
      isTouch,
      armed: false,
      dragging: false,
      placeholder: null,
      offsetX: 0, offsetY: 0,
      rect: null,
      timer: null,
      moveSuppressedClick: false,
    };
    active = ctx;

    const startDrag = (ev) => {
      ctx.armed = true;
      ctx.dragging = true;
      // getBoundingClientRect returns the screen-aligned bbox, which for a
      // fan-rotated card is *wider* than the card itself and offset from its
      // top-left. To keep the dragged card's intrinsic size (and to not warp
      // the placeholder), derive an unrotated rect by re-centering the bbox
      // on the card's offsetWidth/offsetHeight.
      const bbox = card.getBoundingClientRect();
      const w = card.offsetWidth;
      const h = card.offsetHeight;
      const left = bbox.left + bbox.width / 2 - w / 2;
      const top = bbox.top + bbox.height / 2 - h / 2;
      ctx.rect = { left, top, width: w, height: h };
      ctx.offsetX = startX - left;
      ctx.offsetY = startY - top;
      try { card.setPointerCapture(ctx.pointerId); } catch (_) {}

      // Build placeholder occupying the original slot.
      const ph = document.createElement("div");
      ph.className = "drag-placeholder card";
      ph.style.width = w + "px";
      ph.style.height = h + "px";
      handEl.insertBefore(ph, card.nextSibling);
      ctx.placeholder = ph;

      // Lift the card out of flow.
      card.style.position = "fixed";
      card.style.zIndex = "200";
      card.style.left = left + "px";
      card.style.top = top + "px";
      card.style.width = w + "px";
      card.classList.add("dragging");
      ctx.moveSuppressedClick = true;
    };

    if (isTouch) {
      // Wait for long-press before claiming the gesture. If the user starts
      // scrolling the hand horizontally we bail.
      ctx.timer = setTimeout(() => {
        if (!active || active !== ctx) return;
        startDrag();
      }, LONG_PRESS_MS);
    } else {
      // Mouse: arm immediately, but don't switch to drag until movement.
      ctx.armed = true;
    }

    function onMove(ev) {
      if (!active || active !== ctx) return;
      const dx = ev.clientX - startX;
      const dy = ev.clientY - startY;

      if (!ctx.dragging) {
        if (ctx.isTouch) {
          // Movement before long-press → cancel and let scrolling proceed.
          if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
            cleanup(false);
          }
          return;
        } else {
          // Mouse: start drag once movement exceeds threshold.
          if (Math.hypot(dx, dy) > DRAG_THRESHOLD_PX) {
            startDrag(ev);
          } else {
            return;
          }
        }
      }

      ev.preventDefault();
      // Move card to follow pointer.
      card.style.left = (ev.clientX - ctx.offsetX) + "px";
      card.style.top = (ev.clientY - ctx.offsetY) + "px";
      updatePlaceholderPosition(ev.clientX);
    }

    function updatePlaceholderPosition(clientX) {
      const siblings = [...handEl.children].filter(c => c !== card);
      let targetIdx = siblings.length;
      for (let i = 0; i < siblings.length; i++) {
        const s = siblings[i];
        if (s === ctx.placeholder) continue;
        const r = s.getBoundingClientRect();
        if (clientX < r.left + r.width / 2) {
          targetIdx = i;
          break;
        }
      }
      const ref = siblings[targetIdx] || null;
      handEl.insertBefore(ctx.placeholder, ref);
    }

    function onUp(ev) {
      if (!active || active !== ctx) return;
      if (ev.pointerId !== undefined && ev.pointerId !== ctx.pointerId) return;
      cleanup(true);
    }

    function cleanup(commit) {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onUp);
      if (ctx.timer) clearTimeout(ctx.timer);

      if (ctx.dragging) {
        // Determine drop position.
        const slotEls = [...handEl.children];
        const placeholderIdx = slotEls.indexOf(ctx.placeholder);
        const originalIdx = slotEls.indexOf(card);
        let fromIndex = -1;
        // The card is still in DOM with position:fixed; its DOM index pre-existed.
        // Recompute "from" by ignoring placeholder.
        let visualIdx = 0;
        for (const el of slotEls) {
          if (el === ctx.placeholder) continue;
          if (el === card) { fromIndex = visualIdx; break; }
          visualIdx++;
        }
        const visualPlaceholderIdx = (function () {
          let i = 0;
          for (const el of slotEls) {
            if (el === card) continue;
            if (el === ctx.placeholder) return i;
            i++;
          }
          return i;
        })();
        const toIndex = visualPlaceholderIdx;

        // Reset card styles and swap into placeholder position.
        card.style.position = "";
        card.style.left = "";
        card.style.top = "";
        card.style.width = "";
        card.style.zIndex = "";
        card.classList.remove("dragging");
        ctx.placeholder.replaceWith(card);

        if (commit && fromIndex !== -1 && fromIndex !== toIndex) {
          onReorder(fromIndex, toIndex);
        }
      }

      // After a drag, suppress the upcoming click so it doesn't toggle selection.
      if (ctx.moveSuppressedClick) {
        const stopClick = (ce) => {
          ce.stopPropagation();
          ce.preventDefault();
          window.removeEventListener("click", stopClick, true);
        };
        window.addEventListener("click", stopClick, true);
        setTimeout(() => window.removeEventListener("click", stopClick, true), 80);
      }
      active = null;
    }

    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  handEl.addEventListener("pointerdown", onPointerDown);
}
