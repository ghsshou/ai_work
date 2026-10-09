const enhanced = new Map();
let observer = null;

function stripCloneIdentity(root) {
  for (const node of [root, ...root.querySelectorAll('*')]) {
    node.removeAttribute('id');
    for (const name of [...node.getAttributeNames()]) {
      if (name.startsWith('data-') || name === 'title' || name === 'aria-label') {
        node.removeAttribute(name);
      }
    }
  }
}

function cloneLabel(source, target) {
  const clone = source.cloneNode(true);
  stripCloneIdentity(clone);
  target.replaceChildren(...clone.childNodes);
}

function layoutPill(button, fill) {
  const rect = button.getBoundingClientRect();
  const width = rect.width;
  const height = rect.height;
  if (!(width > 0 && height > 0)) return;
  const radius = ((width * width) / 4 + height * height) / (2 * height);
  const diameter = Math.ceil(2 * radius) + 2;
  const delta = Math.ceil(
    radius - Math.sqrt(Math.max(0, radius * radius - (width * width) / 4)),
  ) + 1;
  button.style.setProperty('--pill-nav-diameter', `${diameter}px`);
  button.style.setProperty('--pill-nav-delta', `${delta}px`);
  button.style.setProperty('--pill-nav-origin-y', `${diameter - delta}px`);
  button.style.setProperty('--pill-nav-label-shift', `${Math.ceil(height + 12)}px`);
}

function isPillTarget(node) {
  return node?.nodeType === 1 && node.matches('[data-pill-nav]');
}

export function enhancePill(button) {
  if (!isPillTarget(button)) throw new TypeError('PillNav 需要带 data-pill-nav 的 HTML 元素');
  if (enhanced.has(button)) return enhanced.get(button).api;

  const targetDocument = button.ownerDocument;
  const source = targetDocument.createElement('span');
  source.className = 'pill-nav-label pill-nav-label-default';
  source.append(...button.childNodes);
  const hover = targetDocument.createElement('span');
  hover.className = 'pill-nav-label pill-nav-label-hover';
  hover.setAttribute('aria-hidden', 'true');
  cloneLabel(source, hover);
  const stack = targetDocument.createElement('span');
  stack.className = 'pill-nav-label-stack';
  stack.append(source, hover);
  const fill = targetDocument.createElement('span');
  fill.className = 'pill-nav-fill';
  fill.setAttribute('aria-hidden', 'true');
  button.replaceChildren(fill, stack);
  button.classList.add('pill-nav-control');
  button.dataset.pillNavReady = 'true';

  const resize = new ResizeObserver(() => layoutPill(button, fill));
  resize.observe(button);
  const labelObserver = new MutationObserver(() => cloneLabel(source, hover));
  labelObserver.observe(source, { childList:true, subtree:true, characterData:true });
  const structureObserver = new MutationObserver(() => {
    if (button.contains(fill) && button.contains(stack)) return;
    const replacement = [...button.childNodes];
    source.replaceChildren(...replacement);
    cloneLabel(source, hover);
    button.replaceChildren(fill, stack);
    layoutPill(button, fill);
  });
  structureObserver.observe(button, { childList:true });
  const enter = () => { button.dataset.pillNavHovered = 'true'; };
  const leave = () => { button.dataset.pillNavHovered = 'false'; };
  button.addEventListener('pointerenter', enter);
  button.addEventListener('pointerleave', leave);
  button.addEventListener('pointercancel', leave);
  layoutPill(button, fill);

  const api = {
    button,
    source,
    hover,
    relayout:() => layoutPill(button, fill),
    destroy() {
      resize.disconnect();
      labelObserver.disconnect();
      structureObserver.disconnect();
      button.removeEventListener('pointerenter', enter);
      button.removeEventListener('pointerleave', leave);
      button.removeEventListener('pointercancel', leave);
      button.replaceChildren(...source.childNodes);
      button.classList.remove('pill-nav-control');
      delete button.dataset.pillNavReady;
      delete button.dataset.pillNavHovered;
      enhanced.delete(button);
    },
  };
  enhanced.set(button, { api });
  return api;
}

function enhanceTree(root) {
  if (isPillTarget(root)) enhancePill(root);
  for (const button of root.querySelectorAll?.('[data-pill-nav]') ?? []) enhancePill(button);
}

function cleanupTree(root) {
  if (!(root instanceof HTMLElement)) return;
  if (enhanced.has(root)) enhanced.get(root).api.destroy();
  for (const button of root.querySelectorAll?.('[data-pill-nav-ready="true"]') ?? []) {
    enhanced.get(button)?.api.destroy();
  }
}

export function installPillNav(root = document) {
  enhanceTree(root);
  if (root !== document || observer) return { enhance:enhancePill };
  observer = new MutationObserver(records => {
    for (const record of records) {
      for (const node of record.addedNodes) enhanceTree(node);
      for (const node of record.removedNodes) cleanupTree(node);
    }
  });
  observer.observe(document.documentElement, { childList:true, subtree:true });
  document.fonts?.ready.then(() => {
    for (const { api } of enhanced.values()) api.relayout();
  }).catch(() => {});
  return { enhance:enhancePill };
}

export function applyPill(button, {
  variant = 'neutral', size = 'md', kind = 'action',
} = {}) {
  button.dataset.pillNav = '';
  button.dataset.pillVariant = variant;
  button.dataset.pillSize = size;
  button.dataset.pillKind = kind;
  return enhancePill(button);
}

export function setPillLabel(button, text) {
  const state = enhanced.get(button);
  if (!state) {
    button.textContent = text;
    return;
  }
  state.api.source.textContent = text;
}
