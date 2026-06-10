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

// Escape a card id for use in a CSS attribute selector. Card ids are
// rank+suit (e.g. "10S") so they're already selector-safe, but CSS.escape
// guards against any future id shape (and old engines without it fall back to
// the raw id, which is fine for the current alphanumeric ids).
function cssEscapeId(id) {
  const s = String(id);
  return (typeof CSS !== "undefined" && CSS.escape) ? CSS.escape(s) : s;
}

// makeHandReorderable wires the hand for both intra-hand reordering AND
// drop-onto-external-targets (discard pile, melds, wildcards). The caller
// supplies:
//   onReorder(fromIndex, toIndex)
//   resolveDropTarget(clientX, clientY, cardEl) → { el, kind, data } | null
//   onDropOnTarget(target, cardEl)             — fired on release over target
// resolveDropTarget is consulted on every pointermove so the renderer can
// paint hover affordances on whichever target is currently under the pointer.
export function makeHandReorderable(handEl, onReorder, opts = {}) {
  const resolveDropTarget = opts.resolveDropTarget || (() => null);
  const onDropOnTarget = opts.onDropOnTarget || (() => {});
  const onPlaceholderMove = opts.onPlaceholderMove || (() => {});
  const onDragEnd = opts.onDragEnd || (() => {});
  let active = null;
  let currentTarget = null;
  function clearTargetHover() {
    if (currentTarget && currentTarget.el) currentTarget.el.classList.remove("is-drop-hover");
    currentTarget = null;
  }
  function setTargetHover(target) {
    if (currentTarget && currentTarget.el === (target && target.el)) return;
    clearTargetHover();
    if (target && target.el) {
      target.el.classList.add("is-drop-hover");
      currentTarget = target;
    }
  }

  function preventNative(e) { e.preventDefault(); }

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
    // `card` is the captured hand node. It's `let`, not `const`, because a
    // re-render between pointerdown and the long-press firing can detach this
    // node from the hand; startDrag re-resolves it to the live node by id.
    let card = findCard(e.target);
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
      // A re-render between pointerdown and here (e.g. a card just drawn into
      // the hand) can detach the node we captured, leaving us holding a stale
      // element that's no longer in `handEl`. Lifting it would append a
      // placeholder in the wrong slot and, on drop, re-insert the orphan
      // alongside the freshly-rendered copy — a visible duplicate that then
      // corrupts the next render. Re-resolve to the live node for this card id;
      // if the card has left the hand entirely, abort the drag cleanly.
      if (!handEl.contains(card)) {
        const id = card.dataset && card.dataset.cardId;
        const live = id ? handEl.querySelector(`.in-hand[data-card-id="${cssEscapeId(id)}"]`) : null;
        if (!live) { cleanup(false); return; }
        card = live;
        ctx.card = live;
      }
      ctx.armed = true;
      ctx.dragging = true;
      // Capture the from-index before we reparent the card to <body> below —
      // once it leaves handEl.children, an index lookup at drop time would
      // miss it and we'd skip onReorder, snapping the card back on re-render.
      ctx.fromIndex = [...handEl.children].indexOf(card);
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

      // Build placeholder occupying the original slot. We clone the card so
      // the slot stays visible as a faded ghost — easier to see where you
      // picked up from than a blank gap. Strip interactive/animated classes
      // so the clone is purely visual.
      const ph = card.cloneNode(true);
      ph.classList.add("drag-placeholder");
      ph.classList.remove("in-hand", "dragging", "selected", "just-drawn");
      ph.removeAttribute("id");
      ph.style.width = w + "px";
      ph.style.height = h + "px";
      handEl.insertBefore(ph, card.nextSibling);
      ctx.placeholder = ph;

      // Lift the card out of flow. Reparent to <body> so position:fixed is
      // relative to the viewport — .hand-section's backdrop-filter would
      // otherwise make it a containing block, pinning the card inside the
      // hand bar (well below the visible viewport edge).
      document.body.appendChild(card);
      card.style.position = "fixed";
      card.style.zIndex = "200";
      card.style.left = left + "px";
      card.style.top = top + "px";
      card.style.width = w + "px";
      card.classList.add("dragging");
      // Capture the pointer AFTER reparenting — some browsers drop capture
      // when the captured element is moved between parents, so claim it
      // once the card has reached its final position in <body>.
      try { card.setPointerCapture(ctx.pointerId); } catch (_) {}
      ctx.moveSuppressedClick = true;

      // While dragging, suppress the browser's native long-press behaviors —
      // on Android Chrome a still finger turns into a text-selection callout
      // that interrupts the drag and snaps the card back. These listeners
      // (registered globally, removed in cleanup) catch the events that the
      // per-element `user-select: none` / `touch-action: none` can't reach
      // once the finger drifts off the card.
      window.addEventListener("selectstart", preventNative, true);
      window.addEventListener("contextmenu", preventNative, true);
      document.body.classList.add("hand-dragging");
      // Let the host re-run its fan layout so the placeholder picks up the
      // right tilt for the slot it now occupies.
      onPlaceholderMove();
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
            // startDrag aborts (without lifting) if the captured card went
            // stale and couldn't be re-resolved — don't fall through to the
            // move/placeholder code, which assumes a live drag.
            if (!ctx.dragging) return;
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
      // Refresh drop-target hover so external targets (discard pile, melds)
      // can light up while the card hovers over them.
      const t = resolveDropTarget(ev.clientX, ev.clientY, card);
      setTargetHover(t);
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
      // Only re-fan when the placeholder actually changed slots — pointermove
      // fires constantly during a drag and layoutHand isn't free.
      const prevNext = ctx.placeholder.nextSibling;
      handEl.insertBefore(ctx.placeholder, ref);
      if (ctx.placeholder.nextSibling !== prevNext) onPlaceholderMove();
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
      window.removeEventListener("selectstart", preventNative, true);
      window.removeEventListener("contextmenu", preventNative, true);
      document.body.classList.remove("hand-dragging");
      if (ctx.timer) clearTimeout(ctx.timer);

      // True once a commit callback fired (reorder or external drop). When a
      // drag ends without committing, the host reconciles the hand from state
      // via onDragEnd so no lifted/placeholder node can linger in the DOM.
      let committed = false;
      if (ctx.dragging) {
        // Determine drop position. fromIndex was captured at startDrag time
        // (before reparenting); the placeholder marks the destination slot
        // in the live hand.
        const fromIndex = ctx.fromIndex;
        // The placeholder is normally still in the hand, but a render that
        // rebuilt #hand mid-drag could have discarded it. If it's gone, the
        // rebuilt hand already holds a fresh copy of this card, so we must NOT
        // re-insert the lifted node (that's the duplication bug) — just drop it.
        const placeholderLive = !!ctx.placeholder && ctx.placeholder.isConnected;
        // Belt-and-suspenders: if a node for this same card already sits in the
        // hand (e.g. a fresh copy from a mid-drag render), re-inserting the
        // lifted node would duplicate it. Detect that and drop the orphan
        // instead, leaving the hand to reconcile from state.
        const cardId = card.dataset && card.dataset.cardId;
        const dupInHand = !!cardId && [...handEl.children].some(
          ch => ch !== ctx.placeholder && ch.dataset && ch.dataset.cardId === cardId);
        const toIndex = placeholderLive
          ? [...handEl.children].indexOf(ctx.placeholder)
          : -1;

        // Was the pointer over an external drop target on release?
        const finalTarget = currentTarget;
        clearTargetHover();

        // Reset card styles and swap into placeholder position.
        card.style.position = "";
        card.style.left = "";
        card.style.top = "";
        card.style.width = "";
        card.style.zIndex = "";
        card.classList.remove("dragging");
        if (placeholderLive && !dupInHand) {
          ctx.placeholder.replaceWith(card);
        } else {
          if (ctx.placeholder && ctx.placeholder.isConnected) ctx.placeholder.remove();
          card.remove();
        }

        if (commit && finalTarget) {
          // External drop wins over an in-hand reorder. Uses card.dataset, not
          // DOM position, so it works even if the node was just removed above.
          onDropOnTarget(finalTarget, card);
          committed = true;
        } else if (commit && placeholderLive && !dupInHand && fromIndex !== -1) {
          // Always re-render the hand on drop, even when the card lands in
          // its original slot. Otherwise the dragged DOM node keeps its
          // identity and the prior `position:fixed` / .dragging cycle can
          // leave it floating above its neighbors in the fan stack until
          // the next render. A no-op splice on same-position keeps state
          // consistent.
          onReorder(fromIndex, toIndex);
          committed = true;
        }
      } else {
        clearTargetHover();
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
      // Drag is fully torn down (hand-dragging removed above) — let the host
      // flush any hand render it deferred while the card was lifted, and
      // reconcile the hand from state when a drag ended without committing.
      onDragEnd({ dragged: ctx.dragging, committed });
    }

    // Listen on `window`, not the dragged card. iOS Safari can silently drop
    // pointer capture when the captured node is reparented to <body> (the
    // workaround for transformed-ancestor position:fixed breakage); a global
    // listener keeps the pointermove stream flowing regardless.
    window.addEventListener("pointermove", onMove, { passive: false });
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onUp);
  }

  handEl.addEventListener("pointerdown", onPointerDown);
}
