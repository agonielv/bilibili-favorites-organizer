// Pointer selection stays local. Freeze the rendered rows and the initial
// selection for one gesture, so filtering and reverse drags cannot toggle IDs
// repeatedly or lose selections outside the current filter.
export function attachFolderSelection(list, { enabled, getSelected, onPreview, onFinish }) {
  let gesture = null, frame = 0, suppressClick = false;
  const viewport = () => {
    const rect = list.getBoundingClientRect();
    return { left: rect.left + list.clientLeft, top: rect.top + list.clientTop,
      width: list.clientWidth, height: list.clientHeight };
  };
  const clamp = (value, min, max) => Math.max(min, Math.min(max, value));
  const equal = (a, b) => a.size === b.size && [...a].every(id => b.has(id));
  function paint() {
    const g = gesture, view = viewport();
    const x = clamp(g.x - view.left, 0, view.width) + list.scrollLeft;
    const y = clamp(g.y - view.top, 0, view.height) + list.scrollTop;
    const rect = { left: Math.min(g.startX, x), top: Math.min(g.startY, y),
      right: Math.max(g.startX + 1, x), bottom: Math.max(g.startY + 1, y) };
    Object.assign(g.box.style, { left: rect.left + 'px', top: rect.top + 'px',
      width: (rect.right - rect.left) + 'px', height: (rect.bottom - rect.top) + 'px' });
    const next = new Set(g.initial);
    for (const row of g.rows) {
      if (row.right <= rect.left || row.left >= rect.right || row.bottom <= rect.top || row.top >= rect.bottom) continue;
      if (g.toggle && g.initial.has(row.id)) next.delete(row.id);
      else next.add(row.id);
    }
    if (!equal(next, getSelected())) onPreview(next);
  }
  function finish(commit) {
    const g = gesture;
    if (!g) return;
    if (g.dragging && commit) paint();
    gesture = null; cancelAnimationFrame(frame); frame = 0;
    if (list.hasPointerCapture(g.id)) list.releasePointerCapture(g.id);
    if (!g.dragging) return;
    g.box.remove(); list.classList.remove('is-selecting'); suppressClick = true;
    if (!commit) onPreview(new Set(g.initial));
    onFinish({ changed: commit && !equal(g.initial, getSelected()), cancelled: !commit });
  }
  function tick(at) {
    if (!gesture?.dragging) return;
    if (!enabled()) { finish(false); return; }
    const g = gesture, view = viewport();
    if (!view.height || !view.width) { finish(false); return; }
    const elapsed = Math.min(40, Math.max(0, at - (g.at ?? at))); g.at = at;
    const edge = Math.min(48, view.height / 3);
    let speed = 0;
    if (g.x >= view.left - 24 && g.x <= view.left + view.width + 24) {
      if (g.y < view.top + edge) speed = -700 * clamp((view.top + edge - g.y) / edge, 0, 1);
      else if (g.y > view.top + view.height - edge) speed = 700 * clamp((g.y - view.top - view.height + edge) / edge, 0, 1);
    }
    list.scrollTop += speed * elapsed / 1000;
    paint(); frame = requestAnimationFrame(tick);
  }
  list.addEventListener('pointerdown', event => {
    suppressClick = false;
    if (gesture || !enabled() || !event.isPrimary || event.button !== 0 || event.pointerType === 'touch') return;
    const view = viewport();
    // Classic scrollbars sit outside clientWidth. Overlay scrollbars sit inside
    // it, so also reserve their narrow right edge instead of capturing a thumb drag.
    const overlayGutter = list.offsetWidth === list.clientWidth ? 12 : 0;
    if (event.clientX < view.left || event.clientX >= view.left + view.width - overlayGutter || event.clientY < view.top || event.clientY >= view.top + view.height) return;
    if (!list.querySelector('.folder-row')) return;
    gesture = { id: event.pointerId, x: event.clientX, y: event.clientY,
      clientX: event.clientX, clientY: event.clientY,
      startX: event.clientX - view.left + list.scrollLeft,
      startY: event.clientY - view.top + list.scrollTop,
      initial: new Set(getSelected()), toggle: event.ctrlKey || event.metaKey, dragging: false };
  });
  window.addEventListener('pointermove', event => {
    const g = gesture;
    if (!g || event.pointerId !== g.id) return;
    if (!enabled()) { finish(false); return; }
    g.x = event.clientX; g.y = event.clientY;
    if (!g.dragging) {
      if (Math.hypot(g.x - g.clientX, g.y - g.clientY) < 6) return;
      const view = viewport();
      g.rows = [...list.querySelectorAll('.folder-row')].map(row => {
        const rect = row.getBoundingClientRect();
        return { id: row.dataset.folderId, left: rect.left - view.left + list.scrollLeft,
          right: rect.right - view.left + list.scrollLeft, top: rect.top - view.top + list.scrollTop,
          bottom: rect.bottom - view.top + list.scrollTop };
      });
      g.box = document.createElement('div'); g.box.className = 'folder-selection-box'; g.box.setAttribute('aria-hidden', 'true');
      g.dragging = true; list.append(g.box); list.classList.add('is-selecting');
      list.setPointerCapture(g.id); frame = requestAnimationFrame(tick);
    }
    event.preventDefault(); paint();
  }, { passive: false });
  window.addEventListener('pointerup', event => {
    if (event.pointerId !== gesture?.id) return;
    gesture.x = event.clientX; gesture.y = event.clientY; finish(enabled());
  });
  window.addEventListener('pointercancel', event => { if (event.pointerId === gesture?.id) finish(false); });
  list.addEventListener('lostpointercapture', event => { if (event.pointerId === gesture?.id) finish(false); });
  list.addEventListener('click', event => {
    if (suppressClick && event.detail !== 0) { event.preventDefault(); event.stopImmediatePropagation(); suppressClick = false; }
  }, true);
  list.addEventListener('dragstart', event => event.preventDefault());
  window.addEventListener('keydown', event => {
    if (event.key === 'Escape' && gesture?.dragging) { event.preventDefault(); event.stopImmediatePropagation(); finish(false); }
  }, true);
  window.addEventListener('blur', () => finish(false));
  window.addEventListener('resize', () => finish(false));
  document.addEventListener('visibilitychange', () => { if (document.hidden) finish(false); });
  return { cancel: () => finish(false) };
}
