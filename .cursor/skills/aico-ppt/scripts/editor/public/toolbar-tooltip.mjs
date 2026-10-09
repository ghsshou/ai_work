export function installToolbarTooltip(root = document) {
  const tooltip = root.querySelector('[data-topbar-tooltip]');
  if (!tooltip) return { destroy() {} };

  let activeTarget = null;
  let dismissedTarget = null;
  let hideTimer = null;

  const tooltipTarget = node => node?.closest?.('[data-toolbar-tooltip]') ?? null;

  function position() {
    if (!activeTarget || tooltip.hidden) return;
    const targetRect = activeTarget.getBoundingClientRect();
    const tooltipRect = tooltip.getBoundingClientRect();
    const viewportPadding = 8;
    const preferredLeft = targetRect.left + (targetRect.width - tooltipRect.width) / 2;
    const left = Math.max(
      viewportPadding,
      Math.min(innerWidth - tooltipRect.width - viewportPadding, preferredLeft),
    );
    const below = targetRect.bottom + 8;
    const top = below + tooltipRect.height <= innerHeight - viewportPadding
      ? below
      : Math.max(viewportPadding, targetRect.top - tooltipRect.height - 8);
    tooltip.style.left = `${Math.round(left)}px`;
    tooltip.style.top = `${Math.round(top)}px`;
  }

  function show(target) {
    if (target === dismissedTarget) return;
    const label = target?.dataset.toolbarTooltip?.trim();
    if (!label) return;
    clearTimeout(hideTimer);
    activeTarget = target;
    tooltip.textContent = label;
    tooltip.hidden = false;
    target.setAttribute('aria-describedby', tooltip.id);
    requestAnimationFrame(() => {
      if (activeTarget !== target) return;
      position();
      tooltip.dataset.visible = 'true';
    });
  }

  function hide(target = activeTarget) {
    if (!activeTarget || (target && target !== activeTarget)) return;
    if (activeTarget.matches(':hover') || activeTarget === root.activeElement) return;
    const previous = activeTarget;
    activeTarget = null;
    previous.removeAttribute('aria-describedby');
    tooltip.dataset.visible = 'false';
    hideTimer = setTimeout(() => {
      if (activeTarget) return;
      tooltip.hidden = true;
      tooltip.textContent = '';
    }, 140);
  }

  function dismiss(target = activeTarget) {
    clearTimeout(hideTimer);
    dismissedTarget = target;
    const previous = activeTarget;
    activeTarget = null;
    previous?.removeAttribute('aria-describedby');
    tooltip.dataset.visible = 'false';
    tooltip.hidden = true;
    tooltip.textContent = '';
  }

  function onPointerOver(event) {
    const target = tooltipTarget(event.target);
    if (!target || target === activeTarget) return;
    show(target);
  }

  function onPointerOut(event) {
    const target = tooltipTarget(event.target);
    if (!target || tooltipTarget(event.relatedTarget) === target) return;
    if (dismissedTarget === target) dismissedTarget = null;
    hide(target);
  }

  function onFocusIn(event) {
    const target = tooltipTarget(event.target);
    if (target) show(target);
  }

  function onFocusOut(event) {
    const target = tooltipTarget(event.target);
    if (!target || tooltipTarget(event.relatedTarget) === target) return;
    if (dismissedTarget === target) dismissedTarget = null;
    hide(target);
  }

  function onClick(event) {
    const target = tooltipTarget(event.target);
    if (target) dismiss(target);
  }

  root.addEventListener('pointerover', onPointerOver);
  root.addEventListener('pointerout', onPointerOut);
  root.addEventListener('focusin', onFocusIn);
  root.addEventListener('focusout', onFocusOut);
  root.addEventListener('click', onClick);
  window.addEventListener('resize', position);
  window.addEventListener('scroll', position, true);

  return {
    destroy() {
      clearTimeout(hideTimer);
      root.removeEventListener('pointerover', onPointerOver);
      root.removeEventListener('pointerout', onPointerOut);
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('click', onClick);
      window.removeEventListener('resize', position);
      window.removeEventListener('scroll', position, true);
    },
  };
}
