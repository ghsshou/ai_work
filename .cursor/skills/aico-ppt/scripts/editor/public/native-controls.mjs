import { applyPill } from './pill-nav.mjs';

const STYLE_ID = 'aico-ppt-native-controls';
const monitoredControls = new Set();
let disconnectionObserver = null;

const CONTROL_STYLES = `
  .ui-select{position:relative;display:inline-flex;min-width:0;vertical-align:middle}
  .ui-select-source{display:none!important}
  .ui-select-trigger{width:100%;min-width:0;height:100%;display:flex;align-items:center;justify-content:space-between;gap:12px;padding:0 11px;border:1px solid rgba(20,22,28,.12);border-radius:8px;color:var(--ink-secondary,#34363a);background:rgba(255,255,255,.9);box-shadow:0 1px 2px rgba(20,22,28,.05);font:inherit;text-align:left;cursor:pointer;transition:border-color .16s ease,background .16s ease,box-shadow .16s ease}
  .ui-select-trigger:hover:not(:disabled){border-color:rgba(20,22,28,.23);background:#fff}
  .ui-select-trigger:focus-visible,.ui-select[data-open="true"] .ui-select-trigger{outline:none;border-color:#df6c73;box-shadow:0 0 0 3px rgba(199,0,11,.09)}
  .ui-select-trigger:disabled{cursor:not-allowed;opacity:.52}
  .ui-select-value{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .ui-select-chevron{width:7px;height:7px;flex:0 0 7px;border-right:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-2px) rotate(45deg);transition:transform .16s ease}
  .ui-select[data-open="true"] .ui-select-chevron{transform:translateY(2px) rotate(225deg)}
  .ui-select-menu{position:fixed;z-index:2147483646;max-height:min(280px,calc(100vh - 24px));padding:5px;overflow:auto;border:1px solid rgba(20,22,28,.13);border-radius:12px;background:rgba(255,255,255,.985);box-shadow:0 18px 48px rgba(20,22,28,.2),0 2px 8px rgba(20,22,28,.08);backdrop-filter:blur(18px);-webkit-backdrop-filter:blur(18px)}
  .ui-select-menu[hidden]{display:none!important}
  .ui-select-option{width:100%;min-height:34px;display:flex;align-items:center;justify-content:space-between;gap:14px;padding:0 10px;border:0;border-radius:8px;color:#34383e;background:transparent;font:600 12px/1.25 "AICO-PPT UI","Noto Sans SC",sans-serif;text-align:left;cursor:pointer}
  .ui-select-option:hover,.ui-select-option:focus-visible{outline:none;background:rgba(199,0,11,.065);color:#9f0009}
  .ui-select-option[aria-selected="true"]{background:#fff0f1;color:#a80009}
  .ui-select-option[aria-selected="true"]::after{content:"";width:7px;height:4px;border-left:1.5px solid currentColor;border-bottom:1.5px solid currentColor;transform:translateY(-1px) rotate(-45deg)}
  .ui-select-option:disabled{cursor:not-allowed;opacity:.42}
  .ui-modal{position:fixed;z-index:2147483645;inset:0;display:grid;place-items:center;padding:20px}
  .ui-modal[hidden]{display:none!important}
  .ui-modal-backdrop{position:absolute;inset:0;background:rgba(31,34,40,.42);backdrop-filter:blur(6px);-webkit-backdrop-filter:blur(6px);animation:ui-modal-fade .18s ease both}
  .ui-modal-panel{position:relative;z-index:1;animation:ui-modal-enter .22s cubic-bezier(.22,1,.36,1) both}
  .ui-color-trigger{width:100%;height:100%;min-width:24px;min-height:24px;padding:0;border:0;border-radius:inherit;background:var(--ui-color,#191919);box-shadow:inset 0 0 0 1px rgba(20,22,28,.14);cursor:pointer}
  .ui-color-trigger:focus-visible{outline:2px solid rgba(199,0,11,.48);outline-offset:2px}
  .ui-color-popover{position:fixed;z-index:2147483646;width:232px;padding:12px;border:1px solid rgba(20,22,28,.13);border-radius:12px;background:rgba(255,255,255,.99);box-shadow:0 18px 48px rgba(20,22,28,.2),0 2px 8px rgba(20,22,28,.08);font:600 12px/1.3 "AICO-PPT UI","Noto Sans SC",sans-serif}
  .ui-color-popover[hidden]{display:none!important}
  .ui-color-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:7px;margin-bottom:11px}
  .ui-color-swatch{aspect-ratio:1;border:1px solid rgba(20,22,28,.13);border-radius:7px;background:var(--swatch);box-shadow:inset 0 0 0 1px rgba(255,255,255,.35);cursor:pointer}
  .ui-color-swatch:hover,.ui-color-swatch:focus-visible{outline:2px solid rgba(199,0,11,.38);outline-offset:1px;transform:scale(1.06)}
  .ui-color-entry{display:flex;align-items:center;gap:7px}
  .ui-color-entry input{min-width:0;height:34px;flex:1;padding:0 9px;border:1px solid rgba(20,22,28,.14);border-radius:8px;outline:0;color:#30343a;background:#fff;font:600 12px/1 ui-monospace,SFMono-Regular,Menlo,monospace;text-transform:uppercase}
  .ui-color-entry input:focus{border-color:#df6c73;box-shadow:0 0 0 3px rgba(199,0,11,.08)}
  .ui-color-apply{height:34px;flex:none;font:700 12px/1 "AICO-PPT UI","Noto Sans SC",sans-serif}
  @keyframes ui-modal-fade{from{opacity:0}to{opacity:1}}
  @keyframes ui-modal-enter{from{opacity:0;transform:translateY(10px) scale(.985)}to{opacity:1;transform:none}}
  @media(prefers-reduced-motion:reduce){.ui-select-trigger,.ui-select-chevron,.ui-modal-backdrop,.ui-modal-panel{transition:none;animation:none}}
`;

export function installNativeControlStyles(target = document) {
  if (target.getElementById(STYLE_ID)) return;
  const style = target.createElement('style');
  style.id = STYLE_ID;
  style.textContent = CONTROL_STYLES;
  target.head.append(style);
}

function monitorDisconnection(node, cleanup) {
  const record = { node, cleanup };
  monitoredControls.add(record);
  if (!disconnectionObserver) {
    disconnectionObserver = new MutationObserver(() => {
      for (const candidate of [...monitoredControls]) {
        if (candidate.node.isConnected) continue;
        monitoredControls.delete(candidate);
        candidate.cleanup();
      }
    });
    disconnectionObserver.observe(document.documentElement, { childList:true, subtree:true });
  }
  return () => monitoredControls.delete(record);
}

function positionPopover(anchor, popover, { minimumWidth = 0, gap = 6 } = {}) {
  const rect = anchor.getBoundingClientRect();
  const width = Math.max(rect.width, minimumWidth);
  popover.style.width = `${Math.min(width, innerWidth - 24)}px`;
  popover.style.left = `${Math.max(12, Math.min(rect.left, innerWidth - width - 12))}px`;
  const measured = popover.getBoundingClientRect();
  const below = rect.bottom + gap;
  const top = below + measured.height <= innerHeight - 12
    ? below : Math.max(12, rect.top - measured.height - gap);
  popover.style.top = `${top}px`;
}

function optionLabel(select) {
  const option = select.selectedOptions?.[0];
  return option?.textContent?.trim() || '请选择';
}

function selectAccessibleLabel(select) {
  if (select.getAttribute('aria-label')) return select.getAttribute('aria-label');
  const labelledBy = select.getAttribute('aria-labelledby');
  if (labelledBy) return document.getElementById(labelledBy)?.textContent?.trim() || '选择';
  const label = select.closest('label');
  return label?.querySelector('.agent-picker-label')?.textContent?.trim()
    || label?.firstChild?.textContent?.trim() || '选择';
}

export function enhanceSelect(select, { minimumMenuWidth = 160 } = {}) {
  if (!(select instanceof HTMLSelectElement)) throw new TypeError('自定义下拉框需要 select 元素');
  if (select.__nativeControl) return select.__nativeControl;
  installNativeControlStyles(select.ownerDocument);
  const root = document.createElement('span');
  root.className = 'ui-select';
  root.dataset.nativeSelect = '';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ui-select-trigger';
  trigger.setAttribute('role', 'combobox');
  trigger.setAttribute('aria-haspopup', 'listbox');
  trigger.setAttribute('aria-expanded', 'false');
  trigger.setAttribute('aria-label', selectAccessibleLabel(select));
  const value = document.createElement('span');
  value.className = 'ui-select-value';
  const chevron = document.createElement('span');
  chevron.className = 'ui-select-chevron';
  chevron.setAttribute('aria-hidden', 'true');
  trigger.append(value, chevron);
  const menu = document.createElement('div');
  menu.className = 'ui-select-menu';
  menu.dataset.nativeSelectMenu = '';
  menu.setAttribute('role', 'listbox');
  menu.hidden = true;
  select.before(root);
  root.append(trigger, select);
  document.body.append(menu);
  select.classList.add('ui-select-source');
  select.tabIndex = -1;
  select.setAttribute('aria-hidden', 'true');

  let open = false;
  let previousFocus = null;
  const close = ({ restoreFocus = false } = {}) => {
    if (!open) return;
    open = false;
    root.dataset.open = 'false';
    trigger.setAttribute('aria-expanded', 'false');
    menu.hidden = true;
    document.removeEventListener('pointerdown', onOutsidePointer, true);
    document.removeEventListener('keydown', onDocumentKeydown, true);
    window.removeEventListener('resize', onViewportChange);
    window.removeEventListener('scroll', onViewportChange, true);
    if (restoreFocus) (previousFocus?.isConnected ? previousFocus : trigger).focus();
  };
  const sync = () => {
    value.textContent = optionLabel(select);
    trigger.disabled = select.disabled;
    trigger.setAttribute('aria-disabled', String(select.disabled));
    for (const optionButton of menu.querySelectorAll('[data-value]')) {
      optionButton.setAttribute('aria-selected', String(optionButton.dataset.value === select.value));
    }
  };
  const rebuild = () => {
    menu.replaceChildren();
    for (const option of select.options) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'ui-select-option';
      button.dataset.value = option.value;
      button.setAttribute('role', 'option');
      button.setAttribute('aria-selected', String(option.selected));
      button.disabled = option.disabled;
      button.textContent = option.textContent;
      button.addEventListener('click', () => {
        if (option.disabled) return;
        select.value = option.value;
        select.dispatchEvent(new Event('change', { bubbles:true }));
        sync();
        close();
        trigger.focus();
      });
      menu.append(button);
    }
    sync();
  };
  const onOutsidePointer = event => {
    if (!root.contains(event.target) && !menu.contains(event.target)) close();
  };
  const onViewportChange = () => close();
  const focusOption = delta => {
    const enabled = [...menu.querySelectorAll('.ui-select-option:not(:disabled)')];
    if (!enabled.length) return;
    const activeIndex = enabled.indexOf(document.activeElement);
    const selectedIndex = enabled.findIndex(node => node.getAttribute('aria-selected') === 'true');
    const start = activeIndex >= 0 ? activeIndex : Math.max(0, selectedIndex);
    enabled[(start + delta + enabled.length) % enabled.length].focus();
  };
  const onDocumentKeydown = event => {
    if (!open) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      close({ restoreFocus:true });
    } else if (event.key === 'ArrowDown') {
      event.preventDefault(); focusOption(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault(); focusOption(-1);
    } else if (event.key === 'Tab') close();
  };
  const openMenu = () => {
    if (open || select.disabled) return;
    rebuild();
    open = true;
    previousFocus = document.activeElement;
    root.dataset.open = 'true';
    trigger.setAttribute('aria-expanded', 'true');
    menu.hidden = false;
    positionPopover(trigger, menu, { minimumWidth:minimumMenuWidth });
    document.addEventListener('pointerdown', onOutsidePointer, true);
    document.addEventListener('keydown', onDocumentKeydown, true);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    requestAnimationFrame(() => {
      (menu.querySelector('[aria-selected="true"]:not(:disabled)')
        || menu.querySelector('.ui-select-option:not(:disabled)'))?.focus();
    });
  };
  trigger.addEventListener('click', () => open ? close() : openMenu());
  trigger.addEventListener('keydown', event => {
    if (['ArrowDown', 'ArrowUp', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      openMenu();
    }
  });
  select.addEventListener('change', sync);
  const observer = new MutationObserver(() => rebuild());
  observer.observe(select, { attributes:true, childList:true, subtree:true });
  rebuild();
  let stopMonitoring = () => {};
  const control = { root, trigger, menu, select, open:openMenu, close, sync, destroy:() => {
    stopMonitoring(); close(); observer.disconnect(); menu.remove(); root.replaceWith(select);
    select.classList.remove('ui-select-source'); select.removeAttribute('aria-hidden'); select.tabIndex = 0;
  } };
  stopMonitoring = monitorDisconnection(root, control.destroy);
  select.__nativeControl = control;
  return control;
}

const DEFAULT_COLORS = Object.freeze([
  '#000000', '#333333', '#666666', '#999999', '#CCCCCC', '#FFFFFF',
  '#C7000B', '#E60012', '#A80009', '#FF8A8F', '#F3C7CA', '#FFF1F2',
]);

function normalizeHex(value) {
  const source = String(value ?? '').trim();
  const short = source.match(/^#?([0-9a-f]{3})$/i);
  if (short) return `#${[...short[1]].map(char => char.repeat(2)).join('')}`.toUpperCase();
  const full = source.match(/^#?([0-9a-f]{6})$/i);
  return full ? `#${full[1].toUpperCase()}` : null;
}

export function enhanceColorInput(input, { colors = DEFAULT_COLORS } = {}) {
  if (!(input instanceof HTMLInputElement)) throw new TypeError('自定义颜色控件需要 input 元素');
  if (input.__nativeColorControl) return input.__nativeColorControl;
  installNativeControlStyles(input.ownerDocument);
  const label = input.getAttribute('aria-label') || input.title || '选择颜色';
  const trigger = document.createElement('button');
  trigger.type = 'button';
  trigger.className = 'ui-color-trigger';
  trigger.setAttribute('aria-label', label);
  trigger.setAttribute('aria-haspopup', 'dialog');
  trigger.setAttribute('aria-expanded', 'false');
  const popover = document.createElement('section');
  popover.className = 'ui-color-popover';
  popover.setAttribute('role', 'dialog');
  popover.setAttribute('aria-label', label);
  popover.hidden = true;
  const grid = document.createElement('div');
  grid.className = 'ui-color-grid';
  const entry = document.createElement('div');
  entry.className = 'ui-color-entry';
  const text = document.createElement('input');
  text.type = 'text';
  text.inputMode = 'text';
  text.maxLength = 7;
  text.setAttribute('aria-label', `${label} HEX 值`);
  const apply = document.createElement('button');
  apply.type = 'button';
  apply.className = 'ui-color-apply';
  apply.textContent = '应用';
  applyPill(apply, { variant:'primary', size:'sm', kind:'action' });
  entry.append(text, apply);
  popover.append(grid, entry);
  input.before(trigger);
  input.type = 'hidden';
  document.body.append(popover);
  let open = false;
  const sync = value => {
    const normalized = normalizeHex(value) || '#000000';
    trigger.style.setProperty('--ui-color', normalized);
    text.value = normalized;
  };
  const commit = value => {
    const normalized = normalizeHex(value);
    if (!normalized) {
      text.setAttribute('aria-invalid', 'true');
      text.focus();
      return;
    }
    text.removeAttribute('aria-invalid');
    input.value = normalized;
    sync(normalized);
    input.dispatchEvent(new Event('change', { bubbles:true }));
    close();
    trigger.focus();
  };
  for (const color of colors) {
    const swatch = document.createElement('button');
    swatch.type = 'button';
    swatch.className = 'ui-color-swatch';
    swatch.style.setProperty('--swatch', color);
    swatch.setAttribute('aria-label', color);
    swatch.addEventListener('click', () => commit(color));
    grid.append(swatch);
  }
  const onOutside = event => {
    if (!trigger.contains(event.target) && !popover.contains(event.target)) close();
  };
  const onKeydown = event => {
    if (event.key === 'Escape') { event.preventDefault(); close(); trigger.focus(); }
  };
  const close = () => {
    if (!open) return;
    open = false;
    popover.hidden = true;
    trigger.setAttribute('aria-expanded', 'false');
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('keydown', onKeydown, true);
  };
  const openPopover = () => {
    if (open || input.disabled) return;
    open = true;
    sync(input.value);
    popover.hidden = false;
    trigger.setAttribute('aria-expanded', 'true');
    positionPopover(trigger, popover, { minimumWidth:232 });
    document.addEventListener('pointerdown', onOutside, true);
    document.addEventListener('keydown', onKeydown, true);
    requestAnimationFrame(() => text.focus());
  };
  trigger.addEventListener('click', () => open ? close() : openPopover());
  apply.addEventListener('click', () => commit(text.value));
  text.addEventListener('keydown', event => {
    if (event.key === 'Enter') { event.preventDefault(); commit(text.value); }
  });
  const observer = new MutationObserver(() => { trigger.disabled = input.disabled; sync(input.value); });
  observer.observe(input, { attributes:true });
  trigger.disabled = input.disabled;
  sync(input.value);
  let stopMonitoring = () => {};
  const control = { trigger, popover, input, open:openPopover, close, sync, destroy:() => {
    stopMonitoring(); close(); observer.disconnect(); popover.remove(); trigger.remove();
  } };
  stopMonitoring = monitorDisconnection(input, control.destroy);
  input.__nativeColorControl = control;
  return control;
}

export class AppModal {
  constructor(root, { panel = root.querySelector('[role="dialog"]'), onRequestClose = () => true } = {}) {
    if (!(root instanceof HTMLElement) || !(panel instanceof HTMLElement)) {
      throw new TypeError('应用弹窗缺少有效节点');
    }
    installNativeControlStyles(root.ownerDocument);
    this.root = root;
    this.panel = panel;
    this.onRequestClose = onRequestClose;
    this.previousFocus = null;
    this.open = false;
    this.root.classList.add('ui-modal');
    this.panel.classList.add('ui-modal-panel');
    this.onKeydown = event => {
      if (!this.open) return;
      if (event.key === 'Escape') {
        event.preventDefault();
        if (this.onRequestClose() !== false) this.close();
        return;
      }
      if (event.key !== 'Tab') return;
      const focusable = [...this.panel.querySelectorAll(
        'button:not(:disabled),input:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])',
      )].filter(node => !node.hidden);
      if (!focusable.length) { event.preventDefault(); this.panel.focus(); return; }
      const first = focusable[0];
      const last = focusable.at(-1);
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first.focus(); }
    };
    this.root.addEventListener('pointerdown', event => {
      if (event.target === this.root || event.target.matches('.ui-modal-backdrop')) {
        if (this.onRequestClose() !== false) this.close();
      }
    });
  }

  show(initialFocus = null) {
    if (this.open) return;
    this.open = true;
    this.previousFocus = document.activeElement;
    this.root.hidden = false;
    this.root.dataset.open = 'true';
    document.addEventListener('keydown', this.onKeydown, true);
    requestAnimationFrame(() => (initialFocus || this.panel).focus());
  }

  close({ restoreFocus = true } = {}) {
    if (!this.open) return;
    this.open = false;
    this.root.hidden = true;
    this.root.dataset.open = 'false';
    document.removeEventListener('keydown', this.onKeydown, true);
    if (restoreFocus && this.previousFocus?.isConnected) this.previousFocus.focus();
  }

  destroy() {
    this.close({ restoreFocus:false });
  }
}
