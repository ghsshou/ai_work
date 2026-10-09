import { normalizeRect } from '/editor/protocol.mjs';
import {
  MAX_ATTACHMENTS,
  validateFileLike,
} from '/editor/attachment-protocol.mjs';
import { enhanceColorInput, enhanceSelect } from '/editor/native-controls.mjs';
import { applyPill, installPillNav, setPillLabel } from '/editor/pill-nav.mjs';
import { isRegionShortcutKey } from '/editor/editor-shortcuts.mjs';

const pillStyles = document.querySelector('link[href="/editor/pill-nav.css"]')
  ?? document.createElement('link');
if (!pillStyles.isConnected) {
  pillStyles.rel = 'stylesheet';
  pillStyles.href = '/editor/pill-nav.css';
  pillStyles.dataset.deckEditorUi = '';
  document.head.append(pillStyles);
}
installPillNav(document);

const FRAME_INSTANCE_ID = crypto.randomUUID();
const RUNTIME_CONTRACT = Object.freeze({
  brand:'com.huawei.deck.visual-editor.patch-runtime',
  schema:1,
  version:'1.0.0',
  api:'pageKey,makeLocator,resolve,applyAction,applyAll,applyTransaction,beginTransaction,suspendTarget,pendingTransactionCount,activeActionCount,suspendedTargetCount',
});

function runtimeError(code, message = code) {
  return Object.assign(new Error(message), { code });
}

function validatePatchRuntime(runtime) {
  const seen = runtime?.contract;
  const compatible = seen?.brand === RUNTIME_CONTRACT.brand
    && seen.schema === RUNTIME_CONTRACT.schema
    && seen.version === RUNTIME_CONTRACT.version
    && seen.api === RUNTIME_CONTRACT.api
    && RUNTIME_CONTRACT.api.split(',').every(name => typeof runtime[name] === 'function');
  if (compatible) return runtime;
  throw runtimeError(seen?.brand === RUNTIME_CONTRACT.brand
    ? 'RUNTIME_INCOMPATIBLE' : 'RUNTIME_GLOBAL_CONFLICT');
}

function abortError() {
  return new DOMException('页面已卸载', 'AbortError');
}

async function ensurePatchRuntime(signal) {
  if (signal.aborted) throw abortError();
  if (window.HuaweiDeckPatchRuntime) return validatePatchRuntime(window.HuaweiDeckPatchRuntime);
  window.__HuaweiDeckPatchRuntimeLoading ??= new Promise((resolvePromise, reject) => {
    const existing = [...document.scripts].find(script => {
      if (!script.src) return false;
      return new URL(script.src, document.baseURI).pathname === '/editor/patch-runtime.js';
    });
    const script = existing ?? Object.assign(document.createElement('script'), {
      src: '/editor/patch-runtime.js',
    });
    const finish = () => {
      try {
        if (window.HuaweiDeckPatchRuntime) resolvePromise(validatePatchRuntime(window.HuaweiDeckPatchRuntime));
        else reject(runtimeError('RUNTIME_LOAD_FAILED', '补丁运行时加载失败'));
      } catch (error) {
        reject(error);
      }
    };
    if (existing) {
      if (window.HuaweiDeckPatchRuntime) finish();
      else {
        existing.addEventListener('load', finish, { once: true });
        existing.addEventListener('error', reject, { once: true });
      }
      return;
    }
    script.addEventListener('load', finish, { once: true });
    script.addEventListener('error', reject, { once: true });
    document.head.append(script);
  });
  return Promise.race([
    window.__HuaweiDeckPatchRuntimeLoading,
    new Promise((_, reject) => signal.addEventListener('abort', () => reject(abortError()), { once:true })),
  ]);
}

const startupController = new AbortController();
const abortStartup = () => startupController.abort();
window.addEventListener('pagehide', abortStartup, { once:true });

let runtime;
try {
  runtime = await ensurePatchRuntime(startupController.signal);
} catch (error) {
  if (error.name !== 'AbortError') {
    parent.postMessage({
      type:'deck-error',
      code:error.code || 'RUNTIME_LOAD_FAILED',
      message:error.message || '补丁运行时加载失败',
    }, location.origin);
  }
  window.removeEventListener('pagehide', abortStartup);
}

if (runtime) {
let canvases = [];
let mode = 'region';
let dragging = null;
let activePopover = null;
let highlightTimer;
let tornDown = false;
let directEdit = null;
let transformDrag = null;
let transformSelection = null;
let textRangeSelection = null;
let textFormatToolbar = null;
let regionClickHint = null;
let surfacePointerActive = false;
const pendingManual = new Map();
const tentativeCommands = new Map();
let statusTimer;
let canvasMonitor;
let activePageMonitor;
let viewportGeometryFrame;
const pageActivations = new Map();
let requiresAuthoritativeReload = false;
let authoritativeReloadRequested = false;
let authoritativeReloadRequestSequence = 0;
const onPatchReplayFailure = event => {
  const detail=event?.detail ?? {};
  parent.postMessage({
    type:'action-replay-failed',
    code:String(detail.code ?? 'ACTION_REPLAY_FAILED'),
    actionId:String(detail.actionId ?? ''),
    failedActionId:String(detail.failedActionId ?? detail.actionId ?? ''),
  }, location.origin);
};
const INTERACTIVE_TRANSFORM_SELECTOR = 'svg,a,button,input,select,textarea,iframe,[role="button"],.layer-panel';
const TRANSFORM_DRAG_START_PX = 7;
const EDIT_MODE_ALIASES = new Set(['edit', 'text', 'move', 'resize']);
const INSPECTOR_STYLE_PROPERTIES = new Set([
  'color', 'background-color', 'font-family', 'font-size', 'font-style', 'font-weight',
  'text-decoration-line', 'text-align', 'line-height',
  'list-style-type', 'list-style-position', 'display', 'opacity',
  'border-color', 'border-width', 'border-style', 'fill', 'stroke', 'stroke-width',
]);
const TEXT_RANGE_STYLE_PROPERTIES = new Set([
  'color', 'font-family', 'font-size', 'font-style', 'font-weight', 'text-decoration-line',
]);

function canonicalMode(value) {
  return EDIT_MODE_ALIASES.has(value) ? 'edit' : value;
}

function structuralSignature(canvas) {
  const source = canvas.querySelector('section[data-label]') ?? canvas;
  const structure = [source, ...source.querySelectorAll('*')].map(node => (
    `${node.tagName}:${node.childElementCount}:${node.dataset.label ?? ''}:${node.dataset.idx ?? ''}`
  )).join('|');
  return `${runtime.pageKey(canvas)}\0${structure}`;
}

function embeddedPatchBaselineReady() {
  const status = window.HuaweiDeckEditorPatchStatus;
  return !status || status.state !== 'waiting';
}

function createCanvasMonitor(onPublish, signal, onObserved = () => {}) {
  const QUIET_MS = 100;
  const MAX_WAIT_MS = 1_200;
  const capture = () => {
    const nextCanvases = [...document.querySelectorAll('.stage .slide-canvas')];
    return {
      stage:nextCanvases[0]?.closest('.stage') ?? document.querySelector('.stage'),
      canvases:nextCanvases,
      signatures:nextCanvases.map(structuralSignature),
    };
  };
  const same = (left, right) => Boolean(left && right)
    && left.canvases.length === right.canvases.length
    && left.canvases.every((canvas, index) => (
      canvas === right.canvases[index]
      && canvas.isConnected
      && left.signatures[index] === right.signatures[index]
    ));
  const sameReferences = (left, right) => Boolean(left && right)
    && left.canvases.length === right.canvases.length
    && left.canvases.every((canvas, index) => canvas === right.canvases[index]);
  const mutationTouchesStage = record => record.target?.closest?.('.stage')
    || [...record.addedNodes, ...record.removedNodes].some(node => (
      node.nodeType === Node.ELEMENT_NODE
      && (node.matches?.('.stage,.slide-canvas') || node.querySelector?.('.stage,.slide-canvas'))
    ));
  let candidate;
  let published;
  let observedStage;
  let quietTimer;
  let maxTimer;
  let bootstrapTimer;
  let stopped = false;
  const stageObserver = new MutationObserver(records => {
    const relevant = records.some(record => {
      if (record.type !== 'attributes') return true;
      return !['style', 'class', 'hidden', 'contenteditable', 'spellcheck', 'data-active',
        'data-shown', 'data-direct-editing'].includes(record.attributeName)
        && !record.attributeName.startsWith('aria-');
    });
    if (relevant) consider();
  });
  const bindStage = stage => {
    if (stage === observedStage) return;
    stageObserver.disconnect();
    observedStage = stage;
    if (stage) stageObserver.observe(stage, {
      attributes:true, childList:true, characterData:true, subtree:true,
    });
  };
  const publish = () => {
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    quietTimer = undefined;
    maxTimer = undefined;
    const latest = capture();
    bindStage(latest.stage);
    const referencesChanged = Boolean(published && !sameReferences(published, latest));
    if (referencesChanged) onObserved(latest.canvases);
    candidate = latest;
    if (!latest.canvases.length || same(published, latest)) return;
    if (onPublish(latest.canvases, { referencesChanged }) === false) {
      quietTimer = setTimeout(publish, QUIET_MS);
      maxTimer ??= setTimeout(publish, MAX_WAIT_MS);
      return;
    }
    published = latest;
  };
  function consider() {
    if (stopped) return;
    bindDocument(document.documentElement);
    const latest = capture();
    bindStage(latest.stage);
    if (published && !sameReferences(published, latest)) onObserved(latest.canvases);
    if (!latest.canvases.length) {
      candidate = latest;
      clearTimeout(quietTimer);
      quietTimer = undefined;
      clearTimeout(bootstrapTimer);
      bootstrapTimer = setTimeout(consider, QUIET_MS);
      return;
    }
    clearTimeout(bootstrapTimer);
    bootstrapTimer = undefined;
    if (same(candidate, latest)) return;
    candidate = latest;
    clearTimeout(quietTimer);
    quietTimer = setTimeout(publish, QUIET_MS);
    maxTimer ??= setTimeout(publish, MAX_WAIT_MS);
  }
  const documentObserver = new MutationObserver(records => {
    if (records.some(mutationTouchesStage)) consider();
  });
  let observedDocumentElement;
  const bindDocument = root => {
    if (!root || root === observedDocumentElement) return;
    documentObserver.disconnect();
    observedDocumentElement = root;
    documentObserver.observe(root, { childList:true, subtree:true });
  };
  bindDocument(document.documentElement);
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(quietTimer);
    clearTimeout(maxTimer);
    clearTimeout(bootstrapTimer);
    documentObserver.disconnect();
    stageObserver.disconnect();
  };
  signal.addEventListener('abort', stop, { once:true });
  consider();
  return { stop };
}

function createActivePageMonitor(nextCanvases, signal) {
  const stage = nextCanvases[0]?.closest('.stage');
  if (!stage) return { stop() {} };
  let scrollTimer;
  let publishFrame;
  let pendingPreferDeclared = true;
  let stopped = false;
  let lastPageKey = '';
  const activeCanvas = preferDeclared => {
    if (preferDeclared) {
      const declared = nextCanvases.find(canvas => (
        canvas.closest('.slide-fit')?.hasAttribute('data-active')
      ));
      if (declared) return declared;
    }
    const stageRect = stage.getBoundingClientRect();
    const center = stageRect.top + stageRect.height / 2;
    return nextCanvases.reduce((best, canvas) => {
      const rect = canvas.getBoundingClientRect();
      const distance = Math.abs(rect.top + rect.height / 2 - center);
      return !best || distance < best.distance ? { canvas, distance } : best;
    }, null)?.canvas;
  };
  const publish = () => {
    publishFrame = undefined;
    if (stopped) return;
    const preferDeclared = pendingPreferDeclared;
    pendingPreferDeclared = true;
    const canvas = activeCanvas(preferDeclared);
    if (!canvas?.isConnected) return;
    const info = pageInfo(canvas);
    if (info.pageKey === lastPageKey) return;
    lastPageKey = info.pageKey;
    parent.postMessage({ type:'active-page-changed', ...info }, location.origin);
  };
  const schedulePublish = (preferDeclared = true) => {
    pendingPreferDeclared &&= preferDeclared;
    if (publishFrame !== undefined) return;
    publishFrame = requestAnimationFrame(publish);
  };
  const onScroll = () => {
    clearTimeout(scrollTimer);
    scrollTimer = setTimeout(() => {
      lastPageKey = '';
      schedulePublish(false);
    }, 140);
  };
  const observer = new MutationObserver(records => {
    if (records.some(record => record.attributeName === 'data-active')) schedulePublish(true);
  });
  observer.observe(stage, {
    attributes:true,
    attributeFilter:['data-active'],
    subtree:true,
  });
  stage.addEventListener('scroll', onScroll, { passive:true });
  const stop = () => {
    if (stopped) return;
    stopped = true;
    clearTimeout(scrollTimer);
    if (publishFrame !== undefined) cancelAnimationFrame(publishFrame);
    observer.disconnect();
    stage.removeEventListener('scroll', onScroll);
  };
  signal.addEventListener('abort', stop, { once:true });
  return { stop };
}

let sourceMutationOwner=null, sourceMutationTimer;
let previousBodyInert=false;
function releaseSourceMutation() {
  clearTimeout(sourceMutationTimer);
  if(sourceMutationOwner)document.body.inert=previousBodyInert;
  sourceMutationOwner=null;
}

function hasTransientInteraction() {
  return Boolean(directEdit || transformDrag || pendingManual.size > 0 || tentativeCommands.size > 0);
}

function noteCanvasReplacementDuringInteraction(nextCanvases) {
  const referencesChanged = canvases.length > 0
    && (canvases.length !== nextCanvases.length
      || canvases.some((canvas, index) => canvas !== nextCanvases[index]));
  if (referencesChanged && hasTransientInteraction()) requiresAuthoritativeReload = true;
}

function requestAuthoritativeReloadIfSettled() {
  if (!requiresAuthoritativeReload || authoritativeReloadRequested || hasTransientInteraction()
    || tornDown || startupController.signal.aborted) return false;
  authoritativeReloadRequested = true;
  canvasMonitor?.stop();
  parent.postMessage({
    type:'request-authoritative-reload',
    frameInstanceId:FRAME_INSTANCE_ID,
    requestSequence:++authoritativeReloadRequestSequence,
    reason:'TRANSIENT_CANVAS_REPLACED',
  }, location.origin);
  return true;
}

const style = document.createElement('style');
style.dataset.deckEditorUi = '';
style.textContent = `
  [data-region-selection],[data-task-highlight]{position:fixed;z-index:2147483638;pointer-events:none;box-sizing:border-box}
  [data-region-selection]{border:2px solid #c7000b;background:rgba(199,0,11,.08);box-shadow:0 0 0 1px rgba(255,255,255,.85) inset}
  [data-region-click-hint]{position:fixed;z-index:2147483639;display:flex;align-items:center;gap:4px;width:max-content;padding:7px 10px;border:1px solid rgba(255,255,255,.22);border-radius:999px;background:rgba(30,32,37,.82);color:rgba(255,255,255,.96);box-shadow:0 7px 20px rgba(0,0,0,.2);backdrop-filter:blur(10px);font:600 12px/1.2 "AICO-PPT UI","Noto Sans SC",sans-serif;white-space:nowrap;pointer-events:none;opacity:0;transform-origin:0 0;transition:opacity .12s ease}
  [data-region-click-hint][data-visible]{opacity:1}
  [data-region-click-hint] kbd{display:inline-grid;place-items:center;min-width:18px;height:18px;padding:0 4px;border:1px solid rgba(255,255,255,.4);border-radius:5px;background:rgba(255,255,255,.13);color:#fff;font:700 11px/1 "JetBrains Mono",monospace;box-sizing:border-box}
  [data-region-popover]{position:fixed;z-index:2147483640;width:336px;padding:16px;border:1px solid rgba(25,25,25,.16);border-radius:12px;background:#fff;color:#191919;box-shadow:0 14px 38px rgba(25,25,25,.24);box-sizing:border-box;font:14px/1.45 "AICO-PPT UI","Noto Sans SC",sans-serif;transform-origin:0 0}
  [data-region-popover] label{display:block;margin-bottom:8px;font-size:12px;font-weight:700;color:#5f6268}
  [data-region-popover] textarea{display:block;width:100%;min-height:88px;resize:vertical;padding:10px 11px;border:1px solid #c9cbd0;border-radius:8px;outline:none;color:#191919;background:#fff;font:inherit;font-size:14px;line-height:1.5;box-sizing:border-box}
  [data-region-popover] textarea:focus{border-color:#c7000b;box-shadow:0 0 0 3px rgba(199,0,11,.10)}
  [data-attachment-controls]{display:flex;align-items:center;gap:8px;margin-top:10px}
  [data-attachment-choose]:not(.pill-nav-control){min-height:32px;padding:0 11px;border:1px solid #c9cbd0;border-radius:7px;background:#fff;color:#34363a;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
  [data-attachment-hint]{color:#777b82;font-size:12px}
  [data-attachment-list]{display:grid;gap:6px;max-height:156px;margin:8px 0 0;padding:0;overflow:auto;list-style:none}
  [data-attachment-item]{display:grid;grid-template-columns:22px minmax(0,1fr) auto;align-items:center;gap:7px;padding:7px 8px;border:1px solid #e1e2e5;border-radius:7px;background:#f8f8f9}
  [data-attachment-icon]{color:#777b82;text-align:center}
  [data-attachment-detail]{min-width:0}
  [data-attachment-name]{display:block;overflow:hidden;color:#34363a;font-size:12px;font-weight:600;text-overflow:ellipsis;white-space:nowrap}
  [data-attachment-size]{display:block;color:#777b82;font-size:11px}
  [data-attachment-remove]:not(.pill-nav-control){width:26px;height:26px;padding:0;border:0;border-radius:5px;background:transparent;color:#777b82;font:700 16px/1 sans-serif;cursor:pointer}
  [data-attachment-remove]:not(.pill-nav-control):hover{background:#ececef;color:#b42318}
  [data-attachment-choose]:disabled,[data-attachment-remove]:disabled{cursor:wait;opacity:.55}
  [data-region-actions]{display:flex;align-items:center;justify-content:flex-end;gap:8px;margin-top:12px}
  [data-region-actions] button:not(.pill-nav-control){min-height:34px;padding:0 14px;border-radius:7px;border:1px solid #d7d8dc;background:#fff;color:#34363a;font:inherit;font-size:13px;font-weight:600;cursor:pointer}
  [data-region-actions] button:disabled{cursor:wait;opacity:.55}
  [data-region-status]{min-height:18px;margin:8px 0 0;color:#777b82;font-size:12px}
  [data-region-status][data-state="error"]{color:#b42318}
  [data-region-status][data-state="success"]{color:#16803b}
  [data-task-highlight]{border:3px dashed #e60012;background:rgba(230,0,18,.08);animation:deck-editor-pulse .45s ease-in-out 2 alternate}
  [data-direct-status]{position:fixed;z-index:2147483641;left:50%;bottom:24px;max-width:520px;padding:10px 16px;border-radius:8px;background:#24262b;color:#fff;box-shadow:0 10px 26px rgba(0,0,0,.24);font:600 14px/1.45 "AICO-PPT UI","Noto Sans SC",sans-serif;transform:translateX(-50%);pointer-events:none}
  [data-direct-status][data-state="error"]{background:#8f1018}
  [data-text-format-toolbar]{position:fixed;z-index:2147483642;display:flex;align-items:center;gap:5px;width:max-content;max-width:620px;padding:7px;border:1px solid rgba(25,25,25,.16);border-radius:10px;background:rgba(255,255,255,.98);box-shadow:0 10px 30px rgba(25,25,25,.24);box-sizing:border-box;transform-origin:0 0;font:600 12px/1 "AICO-PPT UI","Noto Sans SC",sans-serif}
  [data-text-format-toolbar] button:not(.pill-nav-control):not(.ui-color-trigger),[data-text-format-toolbar] select{height:28px;border:1px solid rgba(25,25,25,.13);border-radius:6px;background:#fff;color:#34363a;font:inherit;cursor:pointer}
  [data-text-format-toolbar] button:not(.pill-nav-control){min-width:28px;padding:0 7px}
  [data-text-format-toolbar] button:not(.pill-nav-control)[aria-pressed="true"],[data-text-format-toolbar] button:not(.pill-nav-control)[aria-pressed="mixed"]{border-color:rgba(199,0,11,.35);background:rgba(199,0,11,.09);color:#a10d15}
  [data-text-format-toolbar] select{width:112px;padding:0 6px}
  [data-text-format-toolbar] .ui-select{width:112px;height:28px}
  [data-text-format-toolbar] .ui-select-trigger{height:28px;padding:0 8px;border-radius:6px;font-size:11px}
  [data-text-format-toolbar] label{position:relative;width:28px;height:28px;overflow:hidden;border:1px solid rgba(25,25,25,.13);border-radius:6px;background:var(--toolbar-color,#191919);cursor:pointer}
  [data-text-format-toolbar] input[type="color"]{position:absolute;inset:-8px;width:44px;height:44px;padding:0;border:0;cursor:pointer;opacity:0}
  [data-text-format-toolbar] [data-toolbar-divider]{width:1px;height:20px;background:rgba(25,25,25,.12)}
  [data-transform-selection]{position:fixed;z-index:2147483637;box-sizing:border-box;border:2px solid #c7000b;background:rgba(199,0,11,.035);pointer-events:none}
  [data-transform-move-handle]{position:fixed;z-index:2147483639;background:transparent;cursor:grab;touch-action:none}
  [data-resize-handle]{position:fixed;z-index:2147483640;box-sizing:border-box;border:2px solid #fff;border-radius:3px;background:#c7000b;box-shadow:0 1px 5px rgba(0,0,0,.3);cursor:nwse-resize;touch-action:none}
  html[data-deck-editor-mode="edit"][data-deck-editor-move-cursor] .slide-canvas,
  html[data-deck-editor-mode="edit"][data-deck-editor-move-cursor] .slide-canvas *{cursor:grab!important}
  html[data-deck-editor-mode="edit"][data-deck-editor-text-cursor] .slide-canvas,
  html[data-deck-editor-mode="edit"][data-deck-editor-text-cursor] .slide-canvas *{cursor:text!important}
  [data-direct-editing]{cursor:text!important}
  html[data-deck-editor-dragging="translate"],html[data-deck-editor-dragging="translate"] *{cursor:grabbing!important}
  [data-transform-commit-source]{visibility:hidden!important}
  [data-transform-commit-preview]{pointer-events:none!important;user-select:none!important}
  html[data-deck-editor-dragging="resize"],html[data-deck-editor-dragging="resize"] *{cursor:nwse-resize!important}
  @keyframes deck-editor-pulse{from{box-shadow:0 0 0 0 rgba(230,0,18,.35)}to{box-shadow:0 0 0 8px rgba(230,0,18,0)}}
`;
document.head.append(style);

function pageInfo(canvas) {
  const index = canvases.indexOf(canvas) + 1;
  return {
    pageKey: runtime.pageKey(canvas),
    pageIndex: index,
    pageLabel: canvas.querySelector('section[data-label]')?.dataset.label ?? `第 ${index} 页`,
  };
}

const PAGE_STATE_SELECTOR = [
  '[data-layer-btn]', '[data-layer-panel]', '[data-active]',
  '.build', '.clayer', '[data-shown]', '[data-demo]',
  '[aria-pressed]', '[aria-expanded]', '[aria-selected]', '[aria-current]',
  'details', 'input[type="checkbox"]', 'input[type="radio"]', 'select',
].join(',');

function trackedPageActivation(event) {
  const target = event.composedPath().find(node => (
    node instanceof Element && node.hasAttribute('data-mod')
  ));
  if (!target) return null;
  const canvas = event.composedPath().find(node => (
    node instanceof Element && node.matches('.slide-canvas')
  )) ?? target.closest('.slide-canvas');
  const value = target.getAttribute('data-mod');
  if (!canvas || value === null || value.length > 128) return null;
  return { canvas, activation:{ kind:'data-mod', value } };
}

function onPageActivation(event) {
  const tracked = trackedPageActivation(event);
  if (!tracked) return;
  pageActivations.set(runtime.pageKey(tracked.canvas), tracked.activation);
}

function suppressDeckClickDuringEdit(event) {
  if (!isEditMode()) return;
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest('.slide-canvas') || target.closest('[data-deck-editor-ui]')) return;
  // 编辑态的一次点击只能属于 Editor。若继续交给 Deck 自身的 click 监听器，
  // 放映步进、layer 切换等逻辑会在选中文字/元素的同时改写页面 DOM，随后让
  // 活跃历史动作在另一套版面上重放，造成视觉跳变和 TARGET_AMBIGUOUS。
  event.preventDefault();
  event.stopImmediatePropagation();
}

function capturePageState(canvas) {
  const pageKey = runtime.pageKey(canvas);
  const layerGroups = new Set();
  for (const element of canvas.querySelectorAll('[data-layer-group]')) {
    const group = element.getAttribute('data-layer-group');
    if (group) layerGroups.add(group);
  }
  const layers = [...layerGroups].slice(0, 64).map(group => {
    const nodes = [...canvas.querySelectorAll('[data-layer-group]')]
      .filter(element => element.getAttribute('data-layer-group') === group);
    const active = nodes.find(element => (
      element.hasAttribute('data-active')
      && (element.hasAttribute('data-layer-btn') || element.hasAttribute('data-layer-panel'))
    ));
    return {
      group,
      key:active?.getAttribute('data-layer-btn')
        ?? active?.getAttribute('data-layer-panel')
        ?? null,
    };
  });
  const elements = [];
  for (const element of canvas.querySelectorAll(PAGE_STATE_SELECTOR)) {
    if (elements.length >= 256) break;
    if (element.closest('[data-deck-editor-ui]')) continue;
    let target;
    try { target = runtime.makeLocator(element); } catch { continue; }
    const state = { target };
    if (element.matches('[data-layer-btn],[data-layer-panel],[data-active]')) {
      state.dataActive = element.hasAttribute('data-active');
    }
    if (element.matches('.build,.clayer,[data-shown]')) {
      state.dataShown = element.hasAttribute('data-shown');
    }
    if (element.hasAttribute('data-demo')) state.dataDemo = element.getAttribute('data-demo');
    if (element.hasAttribute('aria-pressed')) state.ariaPressed = element.getAttribute('aria-pressed');
    if (element.hasAttribute('aria-expanded')) state.ariaExpanded = element.getAttribute('aria-expanded');
    if (element.hasAttribute('aria-selected')) state.ariaSelected = element.getAttribute('aria-selected');
    if (element.hasAttribute('aria-current')) state.ariaCurrent = element.getAttribute('aria-current');
    if (element instanceof HTMLDetailsElement) state.open = element.open;
    if (element instanceof HTMLInputElement
      && ['checkbox', 'radio'].includes(element.type)) state.checked = element.checked;
    if (element instanceof HTMLSelectElement) state.selectedIndex = element.selectedIndex;
    elements.push(state);
  }
  const rememberedActivation = pageActivations.get(pageKey);
  const activatedElement = rememberedActivation
    ? canvas.querySelector(`[data-mod="${CSS.escape(rememberedActivation.value)}"]`)
    : null;
  if (activatedElement && elements.length < 256) {
    try {
      const section = canvas.querySelector('section[data-label]') ?? canvas;
      elements.push({ target:runtime.makeLocator(section), dataMod:rememberedActivation.value });
    } catch {}
  }
  return { schema:1, layers, elements };
}

function restorePageState(canvas, pageState) {
  if (pageState?.schema !== 1) return false;
  const pageKey = runtime.pageKey(canvas);
  for (const item of Array.isArray(pageState.elements) ? pageState.elements : []) {
    if (typeof item?.dataMod !== 'string' || item.target?.pageKey !== pageKey) continue;
    canvas.querySelector(`[data-mod="${CSS.escape(item.dataMod)}"]`)?.click();
  }
  for (const layer of Array.isArray(pageState.layers) ? pageState.layers : []) {
    const nodes = [...canvas.querySelectorAll('[data-layer-group]')]
      .filter(element => element.getAttribute('data-layer-group') === layer.group);
    const button = nodes.find(element => (
      element.getAttribute('data-layer-btn') === layer.key
    ));
    if (button && !button.hasAttribute('data-active')) button.click();
    for (const element of nodes) {
      const key = element.getAttribute('data-layer-btn')
        ?? element.getAttribute('data-layer-panel');
      if (key !== null) element.toggleAttribute('data-active', key === layer.key);
    }
  }
  for (const item of Array.isArray(pageState.elements) ? pageState.elements : []) {
    if (item.target?.pageKey !== pageKey) continue;
    let element;
    try { element = runtime.resolve(item.target); } catch { continue; }
    if (!canvas.contains(element)) continue;
    if ('dataActive' in item) element.toggleAttribute('data-active', item.dataActive === true);
    if ('dataShown' in item) element.toggleAttribute('data-shown', item.dataShown === true);
    if ('dataDemo' in item) element.setAttribute('data-demo', item.dataDemo);
    if ('ariaPressed' in item) element.setAttribute('aria-pressed', item.ariaPressed);
    if ('ariaExpanded' in item) element.setAttribute('aria-expanded', item.ariaExpanded);
    if ('ariaSelected' in item) element.setAttribute('aria-selected', item.ariaSelected);
    if ('ariaCurrent' in item) element.setAttribute('aria-current', item.ariaCurrent);
    if ('open' in item && element instanceof HTMLDetailsElement) element.open = item.open === true;
    if ('checked' in item && element instanceof HTMLInputElement) element.checked = item.checked === true;
    if ('selectedIndex' in item && element instanceof HTMLSelectElement) {
      element.selectedIndex = item.selectedIndex;
    }
  }
  return true;
}

function finiteOverflow(scrollSize, clientSize) {
  const value = Math.max(0, Number(scrollSize) - Number(clientSize));
  return Number.isFinite(value) ? value : 0;
}

function diagnosesNestedClip(element) {
  if (element.matches('[data-deck-editor-ui],[data-deck-editor-ui] *')) return false;
  const computed = getComputedStyle(element);
  const clips = value => ['hidden', 'clip', 'auto', 'scroll'].includes(value);
  return clips(computed.overflowX) || clips(computed.overflowY);
}

function diagnoseCanvas(canvas) {
  const { pageKey } = pageInfo(canvas);
  const section = canvas.querySelector('section[data-label]') ?? canvas.firstElementChild ?? canvas;
  const sectionOverflow = {
    x: finiteOverflow(section.scrollWidth, section.clientWidth),
    y: finiteOverflow(section.scrollHeight, section.clientHeight),
  };
  const nestedClips = [];
  for (const element of section.querySelectorAll('*')) {
    if (!diagnosesNestedClip(element)) continue;
    const x = finiteOverflow(element.scrollWidth, element.clientWidth);
    const y = finiteOverflow(element.scrollHeight, element.clientHeight);
    if (x <= 0 && y <= 0) continue;
    nestedClips.push({ locator:runtime.makeLocator(element), x, y });
  }
  return { pageKey, sectionOverflow, nestedClips };
}

function diagnosePages(pageKeys) {
  const requested = pageKeys === undefined
    ? canvases
    : pageKeys.map(pageKey => canvases.find(canvas => runtime.pageKey(canvas) === pageKey));
  if (requested.some(canvas => !canvas)) {
    const error = new Error('诊断页面不存在');
    error.code = 'PAGE_NOT_FOUND';
    throw error;
  }
  return requested.map(diagnoseCanvas);
}

function showPage(pageKey) {
  const canvas = canvases.find(candidate => runtime.pageKey(candidate) === pageKey);
  const preserveSelection = interactionBelongsToSnapshot(transformSelection?.element, canvases)
    && transformSelection.element.closest('.slide-canvas') === canvas;
  finishDirectEdit();
  clearTextRangeSelection();
  cancelTransformDrag();
  if (!preserveSelection) removeTransformSelection();
  removePopover();
  if (!canvas) {
    parent.postMessage({ type: 'page-shown', pageKey, shown: false, reason: 'PAGE_NOT_FOUND' }, location.origin);
    return null;
  }
  const stage = canvas.closest('.stage');
  const stageStyle = stage ? getComputedStyle(stage) : null;
  const stageScrolls = stage && ['auto', 'scroll', 'overlay'].includes(stageStyle.overflowY)
    && stage.scrollHeight > stage.clientHeight;
  if (stageScrolls) {
    const scrollTarget = canvas.closest('.slide-fit') ?? canvas;
    const stageRect = stage.getBoundingClientRect();
    const targetRect = scrollTarget.getBoundingClientRect();
    stage.scrollTo({
      top:stage.scrollTop + targetRect.top - stageRect.top,
      left:stage.scrollLeft,
      behavior:'auto',
    });
  } else {
    const top = canvas.getBoundingClientRect().top + window.scrollY;
    window.scrollTo({ top, left: 0, behavior: 'auto' });
  }
  requestAnimationFrame(() => {
    parent.postMessage({ type: 'page-shown', pageKey, shown: true }, location.origin);
  });
  return canvas;
}

function regionFromPoints(start, end, bounds) {
  const clamp = (value, low, high) => Math.max(low, Math.min(high, value));
  const x1 = clamp(start.x, bounds.left, bounds.right);
  const y1 = clamp(start.y, bounds.top, bounds.bottom);
  const x2 = clamp(end.x, bounds.left, bounds.right);
  const y2 = clamp(end.y, bounds.top, bounds.bottom);
  const left = Math.min(x1, x2);
  const top = Math.min(y1, y2);
  const right = Math.max(x1, x2);
  const bottom = Math.max(y1, y2);
  return { left, top, right, bottom, width: right - left, height: bottom - top };
}

function setBox(node, rect) {
  Object.assign(node.style, {
    left: `${rect.left}px`,
    top: `${rect.top}px`,
    width: `${rect.width}px`,
    height: `${rect.height}px`,
  });
}

function frameVisualScale() {
  const frame = window.frameElement;
  if (!frame) return { x: 1, y: 1 };
  const rect = frame.getBoundingClientRect();
  const layoutWidth = frame.offsetWidth || innerWidth;
  const layoutHeight = frame.offsetHeight || innerHeight;
  const x = rect.width / layoutWidth;
  const y = rect.height / layoutHeight;
  return {
    x: Number.isFinite(x) && x > 0 ? x : 1,
    y: Number.isFinite(y) && y > 0 ? y : 1,
  };
}

function updateUiScale() {
  const scale = frameVisualScale();
  document.documentElement.style.setProperty('--deck-editor-ui-scale-x', String(scale.x));
  document.documentElement.style.setProperty('--deck-editor-ui-scale-y', String(scale.y));
  return scale;
}

function elementIsVisible(element, rect, canvas) {
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (typeof element.checkVisibility === 'function' && !element.checkVisibility({
    checkOpacity: true,
    checkVisibilityCSS: true,
  })) return false;
  for (let current = element; current && current !== canvas.parentElement; current = current.parentElement) {
    const computed = getComputedStyle(current);
    if (computed.display === 'none' || computed.visibility === 'hidden'
      || computed.contentVisibility === 'hidden' || Number(computed.opacity || 1) <= 0) {
      return false;
    }
  }
  return true;
}

function rankCandidates(canvas, region) {
  const canvasRect = canvas.getBoundingClientRect();
  const canvasArea = Math.max(1, canvasRect.width * canvasRect.height);
  const intersectionArea = rect => (
    Math.max(0, Math.min(rect.right, region.right) - Math.max(rect.left, region.left))
    * Math.max(0, Math.min(rect.bottom, region.bottom) - Math.max(rect.top, region.top))
  );
  return [...canvas.querySelectorAll('h1,h2,h3,h4,p,span,img,svg,table,[class]')]
    .filter(element => !element.closest('[data-deck-editor-ui]'))
    .filter(element => !element.matches('.stage,.slide-canvas')
      && !element.querySelector('.stage,.slide-canvas'))
    .map(element => {
      const rect = element.getBoundingClientRect();
      const contentElement = element.matches('img,svg,table');
      const layoutContainer = !contentElement && (
        (rect.width >= canvasRect.width * 0.85 && rect.height >= canvasRect.height * 0.85)
        || rect.width * rect.height >= canvasArea * 0.8
      );
      const visible = elementIsVisible(element, rect, canvas);
      return {
        element,
        rect,
        visible,
        layoutContainer,
        score: intersectionArea(rect) / Math.max(1, rect.width * rect.height),
      };
    })
    .filter(item => item.visible && !item.layoutContainer && item.score > 0.05)
    .sort((a, b) => b.score - a.score)
    .slice(0, 12)
    .map(item => {
      try {
        return runtime.makeLocator(item.element);
      } catch {
        return null;
      }
    })
    .filter(Boolean);
}

function removePopover() {
  if (!activePopover) return;
  activePopover.selection.remove();
  activePopover.popover.remove();
  activePopover = null;
}

function effectiveMode() {
  try {
    const pending = parent.document.querySelector('[data-mode][aria-pressed="true"]')?.dataset.mode;
    // confirmed mode 是主状态；父页值只覆盖消息派发尚未抵达的模式切换窗口。
    if (pending && canonicalMode(pending) !== mode) return canonicalMode(pending);
  } catch {
    // 跨源时只使用 confirmed postMessage 状态。
  }
  return mode;
}

function isRegionMode() {
  return effectiveMode() === 'region';
}

function isEditMode() {
  return effectiveMode() === 'edit';
}

function removeRegionClickHint() {
  regionClickHint?.remove();
  regionClickHint = null;
}

function ensureRegionClickHint() {
  if (regionClickHint?.isConnected) return regionClickHint;
  const hint = document.createElement('div');
  hint.dataset.deckEditorUi = '';
  hint.dataset.regionClickHint = '';
  hint.setAttribute('aria-hidden', 'true');
  hint.append(document.createTextNode('按'));
  const key = document.createElement('kbd');
  key.textContent = 'R';
  hint.append(key, document.createTextNode('键，即可点击'));
  document.body.append(hint);
  regionClickHint = hint;
  return hint;
}

function updateRegionClickHint(event) {
  const target = event.target instanceof Element ? event.target : null;
  const canvas = target?.closest?.('.slide-canvas');
  const show = event.pointerType === 'mouse' && event.buttons === 0
    && isRegionMode() && !dragging && !activePopover
    && canvas && canvases.includes(canvas)
    && !target.closest('[data-deck-editor-ui]')
    && getComputedStyle(target).cursor === 'pointer';
  if (!show) {
    removeRegionClickHint();
    return;
  }
  const hint = ensureRegionClickHint();
  const scale = frameVisualScale();
  hint.style.transform = `scale(${1 / scale.x}, ${1 / scale.y})`;
  hint.dataset.visible = '';
  const width = hint.offsetWidth / scale.x;
  const height = hint.offsetHeight / scale.y;
  const gapX = 18 / scale.x;
  const gapY = 16 / scale.y;
  const marginX = 8 / scale.x;
  const marginY = 8 / scale.y;
  let left = event.clientX + gapX;
  let top = event.clientY + gapY;
  if (left + width > innerWidth - marginX) left = event.clientX - width - gapX;
  if (top + height > innerHeight - marginY) top = event.clientY - height - gapY;
  hint.style.left = `${Math.max(marginX, left)}px`;
  hint.style.top = `${Math.max(marginY, top)}px`;
}

function setSurfacePointerPresence(active) {
  const next = active === true;
  if (surfacePointerActive === next) return;
  surfacePointerActive = next;
  parent.postMessage({ type:'editor-surface-pointer-presence', active:next }, location.origin);
}

function onPointerOut(event) {
  if (!event.relatedTarget) {
    setSurfacePointerPresence(false);
    removeRegionClickHint();
    delete document.documentElement.dataset.deckEditorMoveCursor;
    delete document.documentElement.dataset.deckEditorTextCursor;
  }
}

function positionPopover(popover, region) {
  const scale = frameVisualScale();
  const gapX = 12 / scale.x;
  const marginX = 8 / scale.x;
  const marginY = 8 / scale.y;
  const width = popover.offsetWidth / scale.x;
  const height = popover.offsetHeight / scale.y;
  popover.style.transform = `scale(${1 / scale.x}, ${1 / scale.y})`;
  popover.dataset.screenScaleX = String(scale.x);
  popover.dataset.screenScaleY = String(scale.y);
  let left;
  let top;
  let placement;
  if (region.right + gapX + width <= innerWidth - marginX) {
    left = region.right + gapX;
    top = Math.max(marginY, Math.min(innerHeight - height - marginY, region.top));
    placement = 'right';
  } else if (region.left - gapX - width >= marginX) {
    left = region.left - gapX - width;
    top = Math.max(marginY, Math.min(innerHeight - height - marginY, region.top));
    placement = 'left';
  } else {
    left = Math.max(marginX, Math.min(innerWidth - width - marginX, region.right - width));
    top = Math.max(marginY, Math.min(innerHeight - height - marginY, region.bottom - height));
    placement = 'inside';
  }
  popover.style.left = `${left}px`;
  popover.style.top = `${top}px`;
  popover.style.visibility = 'visible';
  popover.dataset.placement = placement;
}

async function captureSnapshot(canvas, rect) {
  try {
    if (typeof window.html2canvas !== 'function') throw new Error('页面截图组件不可用');
    const rendered = await window.html2canvas(canvas, {
      backgroundColor: null,
      scale: 0.5,
      logging: false,
    });
    const crop = document.createElement('canvas');
    crop.width = Math.ceil(rect.w * 0.5);
    crop.height = Math.ceil(rect.h * 0.5);
    crop.getContext('2d').drawImage(
      rendered,
      rect.x * 0.5,
      rect.y * 0.5,
      rect.w * 0.5,
      rect.h * 0.5,
      0,
      0,
      crop.width,
      crop.height,
    );
    return crop.toDataURL('image/png');
  } catch {
    return null;
  }
}

function formatAttachmentSize(size) {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(size < 10 * 1024 ? 1 : 0)} KiB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MiB`;
}

function setRegionStatus(status, message, state = 'info') {
  status.dataset.state = state;
  status.textContent = message;
}

function pastedImageName(sequence, date = new Date()) {
  const pad = value => String(value).padStart(2, '0');
  const day = `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}`;
  const time = `${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`;
  return `pasted-image-${day}-${time}-${String(sequence).padStart(3, '0')}.png`;
}

async function normalizePastedImage(file, name) {
  const bitmap = await createImageBitmap(file);
  try {
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const context = canvas.getContext('2d');
    if (!context) throw new Error('浏览器无法处理剪贴板图片');
    context.drawImage(bitmap, 0, 0);
    const blob = await new Promise((resolvePromise, reject) => {
      canvas.toBlob(value => {
        if (value) resolvePromise(value);
        else reject(new Error('浏览器无法重新编码剪贴板图片'));
      }, 'image/png');
    });
    return new File([blob], name, { type:'image/png', lastModified:Date.now() });
  } finally {
    bitmap.close();
  }
}

function openPopover(canvas, screenRect, candidates) {
  removePopover();
  const selection = document.createElement('div');
  selection.dataset.deckEditorUi = '';
  selection.dataset.regionSelection = '';
  setBox(selection, screenRect);
  const popover = document.createElement('form');
  popover.dataset.deckEditorUi = '';
  popover.dataset.regionPopover = '';
  popover.style.visibility = 'hidden';
  const label = document.createElement('label');
  label.textContent = '说明希望 Agent 如何修改这一区域';
  const textarea = document.createElement('textarea');
  textarea.placeholder = '例如：把标题缩短，并将数据卡片改成红色强调';
  textarea.required = true;
  label.append(textarea);
  const attachmentInput = document.createElement('input');
  attachmentInput.type = 'file';
  attachmentInput.multiple = true;
  attachmentInput.hidden = true;
  attachmentInput.dataset.attachmentInput = '';
  const attachmentControls = document.createElement('div');
  attachmentControls.dataset.attachmentControls = '';
  const attachmentChoose = document.createElement('button');
  attachmentChoose.type = 'button';
  attachmentChoose.dataset.attachmentChoose = '';
  attachmentChoose.textContent = '选择文件';
  applyPill(attachmentChoose, { variant:'secondary', size:'sm', kind:'action' });
  const attachmentHint = document.createElement('span');
  attachmentHint.dataset.attachmentHint = '';
  attachmentHint.textContent = '支持多选，也可直接粘贴图片';
  attachmentControls.append(attachmentChoose, attachmentHint);
  const attachmentList = document.createElement('ul');
  attachmentList.dataset.attachmentList = '';
  const status = document.createElement('p');
  status.dataset.regionStatus = '';
  status.setAttribute('role', 'status');
  const actions = document.createElement('div');
  actions.dataset.regionActions = '';
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.dataset.regionCancel = '';
  cancel.textContent = '取消';
  applyPill(cancel, { variant:'secondary', size:'md', kind:'action' });
  const submit = document.createElement('button');
  submit.type = 'submit';
  submit.dataset.regionSubmit = '';
  submit.textContent = '继续添加任务';
  applyPill(submit, { variant:'primary', size:'md', kind:'action' });
  const submitNow = document.createElement('button');
  submitNow.type = 'submit';
  submitNow.dataset.regionSubmitNow = '';
  submitNow.textContent = '直接执行';
  applyPill(submitNow, { variant:'secondary', size:'md', kind:'action' });
  actions.append(cancel, submitNow, submit);
  popover.append(label, attachmentInput, attachmentControls, attachmentList, status, actions);
  document.body.append(selection, popover);
  positionPopover(popover, screenRect);
  textarea.focus({ preventScroll: true });

  const normalized = normalizeRect(screenRect, canvas.getBoundingClientRect());
  const requestId = crypto.randomUUID();
  activePopover = {
    canvas, selection, popover, requestId, submitting:false, processing:0,
    attachments:[], pasteSequence:0, pageState:capturePageState(canvas),
  };
  const popoverState = activePopover;

  const updateAttachmentControls = () => {
    if (activePopover !== popoverState) return;
    const disabled = popoverState.submitting;
    attachmentInput.disabled = disabled;
    attachmentChoose.disabled = disabled;
    submit.disabled = disabled || popoverState.processing > 0;
    submitNow.disabled = disabled || popoverState.processing > 0;
    for (const button of attachmentList.querySelectorAll('[data-attachment-remove]')) {
      button.disabled = disabled;
    }
  };

  const renderAttachments = () => {
    if (activePopover !== popoverState) return;
    attachmentList.replaceChildren();
    for (const item of popoverState.attachments) {
      const row = document.createElement('li');
      row.dataset.attachmentItem = '';
      row.dataset.attachmentClientId = item.clientId;
      const icon = document.createElement('span');
      icon.dataset.attachmentIcon = '';
      icon.setAttribute('aria-hidden', 'true');
      icon.textContent = item.file.type.startsWith('image/') ? '▧' : '▤';
      const detail = document.createElement('span');
      detail.dataset.attachmentDetail = '';
      const name = document.createElement('span');
      name.dataset.attachmentName = '';
      name.title = item.file.name;
      name.textContent = item.file.name;
      const size = document.createElement('span');
      size.dataset.attachmentSize = '';
      size.textContent = formatAttachmentSize(item.file.size);
      detail.append(name, size);
      const remove = document.createElement('button');
      remove.type = 'button';
      remove.dataset.attachmentRemove = '';
      remove.setAttribute('aria-label', `删除附件 ${item.file.name}`);
      remove.textContent = '×';
      applyPill(remove, { variant:'danger', size:'sm', kind:'icon' });
      remove.addEventListener('click', () => {
        if (activePopover !== popoverState || popoverState.submitting) return;
        popoverState.attachments = popoverState.attachments
          .filter(candidate => candidate.clientId !== item.clientId);
        renderAttachments();
        setRegionStatus(status, `已删除附件 ${item.file.name}`);
      });
      row.append(icon, detail, remove);
      attachmentList.append(row);
    }
    updateAttachmentControls();
    positionPopover(popover, screenRect);
  };

  const appendFiles = (files, source) => {
    if (activePopover !== popoverState || popoverState.submitting) return 0;
    let added = 0;
    let errorMessage = '';
    for (const file of files) {
      if (popoverState.attachments.length >= MAX_ATTACHMENTS) {
        errorMessage = `每个任务最多 ${MAX_ATTACHMENTS} 个附件`;
        break;
      }
      try {
        validateFileLike(file);
        popoverState.attachments.push({ clientId:crypto.randomUUID(), file, source });
        added += 1;
      } catch (error) {
        errorMessage = error.message || '附件无效';
      }
    }
    renderAttachments();
    if (errorMessage) setRegionStatus(status, errorMessage, 'error');
    else if (added > 0) setRegionStatus(status, `已添加 ${added} 个附件`);
    return added;
  };

  attachmentChoose.addEventListener('click', () => {
    if (activePopover !== popoverState || popoverState.submitting) return;
    const remaining = MAX_ATTACHMENTS - popoverState.attachments.length;
    if (remaining <= 0) {
      setRegionStatus(status, `每个任务最多 ${MAX_ATTACHMENTS} 个附件`, 'error');
      return;
    }
    attachmentInput.click();
  });
  attachmentInput.addEventListener('change', () => {
    if (activePopover !== popoverState) return;
    appendFiles([...attachmentInput.files], 'selected');
    attachmentInput.value = '';
  });
  textarea.addEventListener('paste', event => {
    if (activePopover !== popoverState || popoverState.submitting) return;
    const images = [...(event.clipboardData?.items ?? [])]
      .filter(item => item.kind === 'file' && item.type.startsWith('image/'))
      .map(item => item.getAsFile())
      .filter(Boolean);
    if (images.length === 0) return;
    event.preventDefault();
    popoverState.processing += 1;
    updateAttachmentControls();
    void (async () => {
      try {
        setRegionStatus(status, '正在处理粘贴图片…', 'pending');
        let added = 0;
        let pasteError = false;
        for (const image of images) {
          if (activePopover !== popoverState || popoverState.submitting) return;
          if (popoverState.attachments.length >= MAX_ATTACHMENTS) {
            setRegionStatus(status, `每个任务最多 ${MAX_ATTACHMENTS} 个附件`, 'error');
            pasteError = true;
            break;
          }
          try {
            popoverState.pasteSequence += 1;
            const file = await normalizePastedImage(
              image,
              pastedImageName(popoverState.pasteSequence),
            );
            if (activePopover !== popoverState || popoverState.submitting) return;
            const appended = appendFiles([file], 'pasted');
            added += appended;
            if (appended === 0) pasteError = true;
          } catch (error) {
            if (activePopover === popoverState) {
              setRegionStatus(status, error.message || '粘贴图片处理失败', 'error');
            }
            pasteError = true;
          }
        }
        if (added > 0 && !pasteError && activePopover === popoverState) {
          setRegionStatus(status, `已添加 ${added} 张粘贴图片`);
        }
      } finally {
        popoverState.processing -= 1;
        if (activePopover === popoverState) updateAttachmentControls();
      }
    })();
  });

  const cancelPopover = () => {
    if (activePopover === popoverState && !popoverState.submitting) removePopover();
  };
  cancel.addEventListener('click', cancelPopover);
  popover.addEventListener('keydown', event => {
    if (activePopover !== popoverState) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      cancelPopover();
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      if (popoverState.processing > 0) {
        setRegionStatus(status, '正在处理粘贴图片，请稍候', 'pending');
        return;
      }
      popover.requestSubmit();
    }
  });
  popover.addEventListener('submit', async event => {
    event.preventDefault();
    if (activePopover !== popoverState) return;
    if (popoverState.processing > 0) {
      setRegionStatus(status, '正在处理粘贴图片，请稍候', 'pending');
      return;
    }
    const instruction = textarea.value.trim();
    if (!instruction || popoverState.submitting) {
      if (!instruction) textarea.focus();
      return;
    }
    popoverState.submitting = true;
    const processAfterCreate = event.submitter === submitNow;
    textarea.disabled = true;
    cancel.disabled = true;
    submit.disabled = true;
    submitNow.disabled = true;
    updateAttachmentControls();
    (processAfterCreate ? submitNow : submit).textContent = '正在提交…';
    status.dataset.state = 'pending';
    status.textContent = '正在生成区域快照…';
    const snapshot = await captureSnapshot(canvas, normalized);
    if (activePopover !== popoverState) return;
    if (!snapshot) status.textContent = '区域截图失败，将继续提交无快照任务。';
    else status.textContent = '正在记录任务…';
    parent.postMessage({
      type: 'create-region-task',
      requestId,
      payload: {
        ...pageInfo(canvas),
        rect: normalized,
        instruction,
        candidates,
        pageState:popoverState.pageState,
      },
      snapshot,
      processAfterCreate,
      attachments:popoverState.attachments.map(item => ({
        clientId:item.clientId,
        source:item.source,
        file:item.file,
      })),
    }, location.origin);
  });
}

function showStatus(message, state = 'info') {
  clearTimeout(statusTimer);
  document.querySelector('[data-direct-status]')?.remove();
  const status = document.createElement('div');
  status.dataset.deckEditorUi = '';
  status.dataset.directStatus = '';
  status.dataset.state = state;
  status.setAttribute('role', 'status');
  status.textContent = message;
  document.body.append(status);
  statusTimer = setTimeout(() => status.remove(), state === 'error' ? 4200 : 1800);
}

function submitManualActions(actions, onResult = () => {}, { coalesceKey = '' } = {}) {
  const requestId = crypto.randomUUID();
  pendingManual.set(requestId, {onResult,actionIds:actions.map(action=>action.id)});
  parent.postMessage({
    type:'submit-manual-actions', requestId, actions,
    ...(coalesceKey ? { coalesceKey } : {}),
  }, location.origin);
}

function manualFailureMessage(result, fallback) {
  const details = [];
  if (result.failedActionId) details.push(`动作 ${result.failedActionId}`);
  if (Array.isArray(result.candidates) && result.candidates.length) {
    details.push(`${result.candidates.length} 个候选位置`);
  }
  const suffix = details.length ? `（${details.join('，')}）` : '';
  return `${result.message || fallback}${suffix}`;
}

function manualSuccessMessage(result, fallback) {
  if (result.sessionRefreshPending) return result.message || '动作已保存、会话同步待重试';
  if (result.syncPending) return result.message || '动作已保存、同步待确认';
  if (result.commitConfirmed === false && result.recoveredBySync) return '动作已保存并恢复同步';
  return fallback;
}

function textRejection(element, { allowChildren = false } = {}) {
  if (!element || !element.closest('.slide-canvas')) return '请在页面文字上双击';
  if (element.closest('[data-deck-editor-ui],button,a,input,textarea,select,[role="button"],.layer-panel')
    || element.closest('svg,iframe')
    || element.querySelector('button,a,input,textarea,select,[role="button"],svg,iframe,.layer-panel')) {
    return '该元素包含交互或复杂组件，请改用区域标记';
  }
  if (!(element.textContent ?? '').trim()) return '请在页面文字上双击';
  if (!allowChildren && element.children.length > 0) {
    return '该文字包含复杂富文本结构，请改用区域标记';
  }
  return null;
}

function textNodePath(root, textNode) {
  const path = [];
  for (let node = textNode; node && node !== root; node = node.parentNode) {
    const parent = node.parentNode;
    if (!parent) return null;
    const index = [...parent.childNodes].indexOf(node);
    if (index < 0 || index > 9_999) return null;
    path.unshift(index);
  }
  return path.length > 0 && path.length <= 32 ? path.join('/') : null;
}

function directTextRuns(element) {
  let offset = 0;
  const runs = [];
  for (const node of textNodesWithin(element)) {
    const start = offset;
    offset += node.data.length;
    const path = textNodePath(element, node);
    if (!path) continue;
    runs.push({
      path, text:node.data, sourceRange:{ start, end:offset },
    });
  }
  return runs;
}

function locateTextCandidates(query, requestedPageKey = null) {
  if (typeof query !== 'string' || !query || query.length > 500) {
    throw Object.assign(new Error('文字查询必须为 1 到 500 个字符'), {
      code:'INVALID_TEXT_QUERY',
    });
  }
  const results = [];
  for (const canvas of canvases) {
    const info = pageInfo(canvas);
    if (requestedPageKey && info.pageKey !== requestedPageKey) continue;
    const section = canvas.querySelector('section[data-label]');
    if (!section) continue;
    const walker = document.createTreeWalker(section, NodeFilter.SHOW_TEXT);
    while (walker.nextNode() && results.length < 100) {
      const node = walker.currentNode;
      if (!node.data.includes(query) || !node.parentElement) continue;
      const element = editableTransformTarget({ target:node.parentElement });
      if (textRejection(element, { allowChildren:true })) continue;
      const textPath = textNodePath(element, node);
      if (!textPath) continue;
      let target;
      try { target = { ...runtime.makeLocator(element), textPath }; }
      catch { continue; }
      const occurrences = node.data.split(query).length - 1;
      results.push({
        pageKey:info.pageKey, pageIndex:info.pageIndex, pageLabel:info.pageLabel,
        target, text:node.data, occurrences,
      });
    }
  }
  return results;
}

function directTextTarget(event) {
  const selected = transformSelection?.element;
  // 调整表格行高后 selection 暂时指向 TR。下一次点击行内文字时
  // 必须重新定位到单元格内的文字框，不能把整行设为 contenteditable。
  const reusableSelection = selected?.isConnected
    && !selected.matches('table,thead,tbody,tfoot,tr,colgroup,col');
  const element = reusableSelection && selected.contains(event.target)
    ? selected : editableTransformTarget(event);
  const rejection = textRejection(element, { allowChildren:true });
  if (rejection) return { rejection };
  return { element };
}

function finishDirectEdit({ restore = true } = {}) {
  if (!directEdit) return;
  const state = directEdit;
  directEdit = null;
  state.element.removeEventListener('blur', onDirectEditBlur);
  state.element.removeEventListener('input', onDirectEditInput);
  if (restore) state.element.innerHTML = state.originalHTML;
  state.element.removeAttribute('contenteditable');
  delete state.element.dataset.directEditing;
  if (state.originalSpellcheck === null) state.element.removeAttribute('spellcheck');
  else state.element.setAttribute('spellcheck', state.originalSpellcheck);
  state.resumeReplay?.();
  requestAuthoritativeReloadIfSettled();
}

function onDirectEditBlur(event) {
  if (directEdit?.element !== event.currentTarget || directEdit.committing) return;
  if (textRangeSelection?.element === directEdit.formatRoot) return;
  commitDirectEdit();
}

function onDirectEditInput(event) {
  if (directEdit?.element !== event.currentTarget) return;
  // 原生输入已改变文字/光标；selectionchange 可能晚于跨 iframe 的失焦。
  // 立即丢弃旧格式选区，不能让它把本次文字提交误当作工具栏格式操作。
  clearTextRangeSelection();
}

function placeDirectEditCaret(element, event) {
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  let range = element.ownerDocument.caretRangeFromPoint?.(event.clientX, event.clientY) ?? null;
  if (!range || !element.contains(range.startContainer)) {
    range = element.ownerDocument.createRange();
    range.selectNodeContents(element);
    range.collapse(false);
  } else {
    range.collapse(true);
  }
  selection.removeAllRanges();
  selection.addRange(range);
}

function minimalTextReplacement(before, after) {
  let start = 0;
  const sharedLength = Math.min(before.length, after.length);
  while (start < sharedLength && before[start] === after[start]) start += 1;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > start && afterEnd > start
    && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd -= 1;
    afterEnd -= 1;
  }
  return {
    text:after.slice(start, afterEnd),
    sourceRange:{ start, end:beforeEnd },
  };
}

function richTextRunChanges(state, nextText) {
  const replacement = minimalTextReplacement(state.originalText, nextText);
  const { start, end } = replacement.sourceRange;
  let affected = state.originalRuns.filter(run => (
    start === end
      ? run.sourceRange.start <= start && run.sourceRange.end >= start
      : run.sourceRange.end > start && run.sourceRange.start < end
  ));
  if (affected.length === 0 && start === end && state.originalRuns.length > 0) {
    affected = [state.originalRuns.at(-1)];
  }
  return affected.flatMap((run, index) => {
    const localStart = Math.max(0, Math.min(run.text.length, start - run.sourceRange.start));
    const localEnd = Math.max(localStart, Math.min(run.text.length, end - run.sourceRange.start));
    const first = index === 0;
    const last = index === affected.length - 1;
    const text = `${first ? run.text.slice(0, localStart) : ''}`
      + `${first ? replacement.text : ''}`
      + `${last ? run.text.slice(localEnd) : ''}`;
    if (text === run.text) return [];
    return [{
      target:{ ...state.target, textPath:run.path }, text,
      sourceRange:run.sourceRange,
    }];
  });
}

function commitDirectEdit() {
  if (!directEdit || directEdit.committing) return;
  directEdit.committing = true;
  const state = directEdit;
  const nextText = state.element.textContent ?? '';
  const nextRuns = directTextRuns(state.element);
  const sameStructure = nextRuns.length === state.originalRuns.length
    && nextRuns.every((run, index) => run.path === state.originalRuns[index].path);
  let changes = [];
  if (!state.hadRichText) {
    if (nextText !== state.originalText) changes = [{ target:state.target, text:nextText }];
  } else if (sameStructure) {
    changes = nextRuns.flatMap((run, index) => (
      run.text === state.originalRuns[index].text ? [] : [{
        target:{ ...state.target, textPath:run.path }, text:run.text,
        sourceRange:state.originalRuns[index].sourceRange,
      }]
    ));
  } else if (nextText !== state.originalText) {
    // 富文本内部结构被浏览器重新组织时，只提交实际变化的文字范围。
    // 整容器 setText 会抹掉全部子节点，并使既有样式动作的稳定目标失效。
    changes = richTextRunChanges(state, nextText);
  }
  finishDirectEdit({ restore: true });
  if (requiresAuthoritativeReload) return;
  // 空字符串代表用户明确全选删除，必须作为有效 setText 提交；只有仍含字符但
  // 全为空白的误输入沿用取消语义，避免把文本框变成不可见空白占位。
  if (changes.length === 0 || (nextText.length > 0 && !nextText.trim())) return;
  const actions = changes.map(change => ({
    id:crypto.randomUUID(), taskId:null, target:change.target,
    kind:'setText', payload:{
      text:change.text,
      ...(change.sourceRange ? { sourceRange:change.sourceRange } : {}),
    },
  }));
  showStatus('正在应用文字修改…');
  submitManualActions(actions, result => {
    if (result.ok) showStatus(manualSuccessMessage(result, '文字修改已记录'));
    else showStatus(manualFailureMessage(result, '文字修改失败，原文已恢复'), 'error');
  });
}

function beginDirectTextEdit(event, { useNativePointer = false } = {}) {
  if (!isEditMode()) return false;
  if (directEdit?.element?.contains(event.target)) return true;
  const directTarget = directTextTarget(event);
  const rejection = directTarget.rejection;
  if (rejection) {
    showStatus(rejection, 'error');
    if (!useNativePointer) event.preventDefault();
    return false;
  }
  if (directEdit) commitDirectEdit();
  cancelTransformDrag();
  clearTextRangeSelection({ notify:false });
  const { element } = directTarget;
  let target;
  try {
    target = runtime.makeLocator(element);
  }
  catch { showStatus('无法定位该文字，请改用区域标记', 'error'); return false; }
  if (transformSelection?.element !== element) selectTransformElement(element, true, target);
  directEdit = {
    element, target, originalText: element.textContent ?? '',
    originalHTML:element.innerHTML, originalRuns:directTextRuns(element),
    hadRichText:element.children.length > 0,
    originalSpellcheck: element.getAttribute('spellcheck'), committing: false,
    formatRoot:element, formatTarget:target,
    resumeReplay: runtime.suspendTarget?.(target),
  };
  delete document.documentElement.dataset.deckEditorMoveCursor;
  document.documentElement.dataset.deckEditorTextCursor = '';
  element.setAttribute('contenteditable', 'plaintext-only');
  element.dataset.directEditing = '';
  element.spellcheck = false;
  element.addEventListener('blur', onDirectEditBlur);
  element.addEventListener('input', onDirectEditInput);
  updateUiScale();
  element.focus({ preventScroll: true });
  if (!useNativePointer) placeDirectEditCaret(element, event);
  showStatus('点击别处或 Cmd/Ctrl+Enter 提交 · Escape 取消');
  if (!useNativePointer) event.preventDefault();
  return true;
}

function onDoubleClick(event) {
  if (directEdit?.element?.contains(event.target)) return;
  beginDirectTextEdit(event);
}

function editableTransformTarget(event) {
  const canvas = event.target.closest?.('.slide-canvas');
  if (!canvas || !canvases.includes(canvas) || event.target.closest?.('[data-deck-editor-ui]')) return null;
  const interactive = event.target.closest?.(INTERACTIVE_TRANSFORM_SELECTOR);
  if (interactive && interactive.closest('.slide-canvas') === canvas) return interactive;
  for (let element = event.target; element && element !== canvas; element = element.parentElement) {
    if (element.matches('html,body,section,.stage,.slide-fit,.slide-canvas')) continue;
    if (element.closest('.slide-canvas') !== canvas) return null;
    const style = getComputedStyle(element);
    const independentBox = style.position !== 'static'
      || ['block','inline-block','flex','inline-flex','grid','inline-grid','table','table-cell',
        'table-caption','list-item']
        .includes(style.display);
    if (independentBox || element.matches('img,video,canvas,svg,table')) return element;
  }
  return null;
}

function currentTranslate(element) {
  const computed = getComputedStyle(element).translate;
  const [x = '0', y = '0'] = (computed && computed !== 'none' ? computed : '0px 0px').split(/\s+/);
  return { x: Number.parseFloat(x) || 0, y: Number.parseFloat(y) || 0 };
}

function inspectorKind(element) {
  if (element instanceof SVGElement) return 'svg';
  if (element.matches('img,video,canvas,iframe')) return 'image';
  return (element.textContent ?? '').trim() ? 'text' : 'shape';
}

function textNodesWithin(element) {
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const nodes = [];
  while (walker.nextNode()) {
    if (walker.currentNode.data.length > 0) nodes.push(walker.currentNode);
  }
  return nodes;
}

function textOffsetWithin(root, node, offset) {
  let total = 0;
  for (const textNode of textNodesWithin(root)) {
    if (textNode === node) {
      return Number.isSafeInteger(offset) && offset >= 0 && offset <= textNode.data.length
        ? total + offset : null;
    }
    total += textNode.data.length;
  }
  return null;
}

function textNodeAtOffset(root, offset) {
  let total = 0;
  const nodes = textNodesWithin(root);
  for (const node of nodes) {
    if (offset < total + node.data.length) return node;
    total += node.data.length;
  }
  return offset === total ? nodes.at(-1) ?? null : null;
}

function textPointAtOffset(root, offset, affinity) {
  const nodes = textNodesWithin(root);
  let total = 0;
  for (let index = 0; index < nodes.length; index += 1) {
    const node = nodes[index];
    const end = total + node.data.length;
    if (offset < end) return { node, offset:offset - total };
    if (offset === end) {
      if (affinity === 'start' && nodes[index + 1]) return { node:nodes[index + 1], offset:0 };
      return { node, offset:node.data.length };
    }
    total = end;
  }
  return null;
}

function restoreTextRangeSelection(state = textRangeSelection) {
  if (!state?.element?.isConnected || directEdit?.formatRoot !== state.element) return false;
  const start = textPointAtOffset(state.element, state.start, 'start');
  const end = textPointAtOffset(state.element, state.end, 'end');
  const selection = state.element.ownerDocument.getSelection();
  if (!start || !end || !selection) return false;
  const range = state.element.ownerDocument.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  state.element.focus({ preventScroll:true });
  selection.removeAllRanges();
  selection.addRange(range);
  textRangeSelection = state;
  renderTextFormatToolbar(state);
  return true;
}

function clearTextRangeSelection({ notify = true } = {}) {
  textFormatToolbar?.remove();
  textFormatToolbar = null;
  if (!textRangeSelection) return;
  textRangeSelection = null;
  if (notify) publishInspectorSelection();
}

function textFormatToolbarOwnsFocus() {
  return Boolean(document.activeElement?.closest?.(
    '[data-text-format-toolbar], [data-text-format-toolbar-owner]',
  ));
}

function updateTextRangeSelection() {
  if (!directEdit?.formatRoot?.isConnected) return;
  const selection = document.getSelection();
  if (!selection || selection.rangeCount !== 1 || selection.isCollapsed) {
    if (textFormatToolbarOwnsFocus()) return;
    if (document.hasFocus()) clearTextRangeSelection();
    return;
  }
  const range = selection.getRangeAt(0);
  const root = directEdit.formatRoot;
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) {
    if (textFormatToolbarOwnsFocus()) return;
    if (document.hasFocus()) clearTextRangeSelection();
    return;
  }
  const start = textOffsetWithin(root, range.startContainer, range.startOffset);
  const end = textOffsetWithin(root, range.endContainer, range.endOffset);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || end <= start) {
    clearTextRangeSelection();
    return;
  }
  const sameRange = textRangeSelection?.element === root
    && textRangeSelection.start === start && textRangeSelection.end === end;
  if (sameRange && textFormatToolbar?.isConnected) {
    positionTextFormatToolbar(textRangeSelection);
    publishInspectorSelection();
    return;
  }
  textRangeSelection = {
    element:root,
    target:directEdit.formatTarget,
    start,
    end,
    selectionId:sameRange ? textRangeSelection.selectionId : crypto.randomUUID(),
  };
  renderTextFormatToolbar(textRangeSelection);
  publishInspectorSelection();
}

function inspectorLabel(element) {
  return element.getAttribute('aria-label')
    || element.dataset.label
    || element.getAttribute('title')
    || element.id
    || '';
}

function textRangeStyleSnapshot(element, start, end) {
  const values = new Map([...INSPECTOR_STYLE_PROPERTIES].map(property => [property, new Set()]));
  let offset = 0;
  for (const node of textNodesWithin(element)) {
    const nextOffset = offset + node.data.length;
    if (nextOffset > start && offset < end) {
      for (const property of INSPECTOR_STYLE_PROPERTIES) {
        values.get(property).add(textNodeStyleValue(node, element, property));
      }
    }
    offset = nextOffset;
  }
  const computed = {};
  const mixedProperties = [];
  for (const [property, propertyValues] of values) {
    computed[property] = propertyValues.values().next().value ?? '';
    if (propertyValues.size > 1) mixedProperties.push(property);
  }
  return { computed, mixedProperties };
}

function textNodeStyleValue(node, element, property) {
  const owner = node.parentElement ?? element;
  if (property !== 'text-decoration-line') {
    return getComputedStyle(owner).getPropertyValue(property).trim();
  }
  // text-decoration 不继承，但祖先的装饰线会绘制到后代。局部格式 span 可能
  // 因其他属性继续嵌套，必须沿祖先链读取，不能只看最内层 span。
  for (let current = owner; current; current = current.parentElement) {
    const value = getComputedStyle(current).getPropertyValue(property).trim();
    if (value.split(/\s+/).includes('underline')) return 'underline';
    if (current === element) return value;
  }
  return 'none';
}

function wholeTextStyleRange(element) {
  if (inspectorKind(element) !== 'text') return null;
  const nodes = textNodesWithin(element);
  const end = nodes.reduce((length, node) => length + node.data.length, 0);
  if (end === 0) return null;
  return {
    start:0,
    end,
    // 一旦局部格式或源 Deck 的 span 形成文字运行段，继续只改外层元素就无法
    // 覆盖子节点的内联样式。此时整框字形必须按完整文字范围提交。
    usesRange:nodes.some(node => node.parentElement !== element),
  };
}

function inspectorSelectionSnapshot() {
  const state = textRangeSelection ?? transformSelection;
  if (!state?.element?.isConnected || !state.target) return null;
  const { element } = state;
  const canvas = element.closest('.slide-canvas');
  if (!canvas) return null;
  const isTextRange = state === textRangeSelection;
  const kind = isTextRange ? 'text' : inspectorKind(element);
  const wholeTextRange = !isTextRange && kind === 'text' ? wholeTextStyleRange(element) : null;
  const rangeStyles = isTextRange
    ? textRangeStyleSnapshot(element, state.start, state.end)
    : (wholeTextRange ? textRangeStyleSnapshot(element, wholeTextRange.start, wholeTextRange.end) : null);
  const computedStyle = getComputedStyle(element);
  const elementComputedStyle = computedStyle;
  const computed = {};
  const inline = {};
  const elementComputed = {};
  const elementInline = {};
  for (const property of INSPECTOR_STYLE_PROPERTIES) {
    computed[property] = rangeStyles
      ? rangeStyles.computed[property] : computedStyle.getPropertyValue(property).trim();
    inline[property] = isTextRange
      ? computed[property] : element.style.getPropertyValue(property);
    elementComputed[property] = elementComputedStyle.getPropertyValue(property).trim();
    elementInline[property] = element.style.getPropertyValue(property);
  }
  const selectedText = isTextRange
    ? (element.textContent ?? '').slice(state.start, state.end) : '';
  return {
    selectionId:state.selectionId,
    target:state.target,
    ...pageInfo(canvas),
    kind,
    tag:element.tagName,
    label:isTextRange ? `已选 ${state.end - state.start} 个字` : inspectorLabel(element),
    textPreview:(isTextRange ? selectedText : (element.textContent ?? ''))
      .replace(/\s+/g, ' ').trim().slice(0, 72),
    ...(isTextRange ? {
      scope:'text-range', textRange:{ start:state.start, end:state.end },
      mixedProperties:rangeStyles.mixedProperties,
      elementComputed,
      elementInline,
    } : {
      scope:'element',
      ...(wholeTextRange ? {
        mixedProperties:rangeStyles.mixedProperties,
        elementComputed,
        elementInline,
        ...(wholeTextRange.usesRange ? {
          textStyleRange:{ start:wholeTextRange.start, end:wholeTextRange.end },
        } : {}),
      } : {}),
    }),
    computed,
    inline,
    capabilities:{
      typography:kind === 'text',
      fill:!isTextRange && kind !== 'image',
      border:!isTextRange && kind !== 'svg',
      svgStyle:kind === 'svg',
      opacity:!isTextRange,
    },
  };
}

function publishInspectorSelection() {
  parent.postMessage({
    type:'inspector-selection-changed',
    selection:inspectorSelectionSnapshot(),
  }, location.origin);
}

function removeTransformSelection({ notify = true } = {}) {
  transformSelection?.overlay.remove();
  for (const moveHandle of transformSelection?.moveHandles ?? []) moveHandle.remove();
  transformSelection?.handle?.remove();
  transformSelection = null;
  if (notify) publishInspectorSelection();
}

function interactionBelongsToSnapshot(element, nextCanvases) {
  const canvas = element?.closest?.('.slide-canvas');
  return Boolean(element?.isConnected && canvas && nextCanvases.includes(canvas));
}

function pruneDisconnectedInteractionState(nextCanvases) {
  if (directEdit && !interactionBelongsToSnapshot(directEdit.element, nextCanvases)) {
    finishDirectEdit();
    showStatus('页面已更新，未提交的文字修改已取消');
  }
  if (transformSelection && !transformDrag
    && !interactionBelongsToSnapshot(transformSelection.element, nextCanvases)) {
    removeTransformSelection();
  }
}

function positionTransformSelection() {
  if (!transformSelection?.element.isConnected) return removeTransformSelection();
  const rect = transformSelection.element.getBoundingClientRect();
  setBox(transformSelection.overlay, rect);
  const scale = frameVisualScale();
  const hitWidth = 10 / scale.x;
  const hitHeight = 10 / scale.y;
  // 缩小画布中的小文字可能比 10px 热区更矮。保持手柄屏幕尺寸，
  // 但最多侵入元素四分之一，将剩余热区外移，给文字中心留下输入空间。
  const insetX = Math.min(hitWidth / 2, rect.width / 4);
  const insetY = Math.min(hitHeight / 2, rect.height / 4);
  const moveBoxes = {
    top:{ left:rect.left, top:rect.top - hitHeight + insetY, width:rect.width, height:hitHeight },
    right:{ left:rect.right - insetX, top:rect.top, width:hitWidth, height:rect.height },
    bottom:{ left:rect.left, top:rect.bottom - insetY, width:rect.width, height:hitHeight },
    left:{ left:rect.left - hitWidth + insetX, top:rect.top, width:hitWidth, height:rect.height },
  };
  for (const moveHandle of transformSelection.moveHandles) {
    setBox(moveHandle, moveBoxes[moveHandle.dataset.transformMoveHandle]);
  }
  if (!transformSelection.handle) return;
  const width = 14 / scale.x;
  const height = 14 / scale.y;
  setBox(transformSelection.handle, {
    left: rect.right - Math.min(width / 2, rect.width / 4),
    top: rect.bottom - Math.min(height / 2, rect.height / 4),
    width,
    height,
  });
  transformSelection.handle.dataset.screenSize = '14';
}

function scheduleViewportGeometrySync() {
  if (viewportGeometryFrame !== undefined) return;
  viewportGeometryFrame = requestAnimationFrame(() => {
    viewportGeometryFrame = undefined;
    if (transformSelection) positionTransformSelection();
    if (textRangeSelection && textFormatToolbar?.isConnected) {
      positionTextFormatToolbar(textRangeSelection);
    }
  });
}

function onViewportGeometryChange() {
  scheduleViewportGeometrySync();
}

function selectTransformElement(element, withHandle, target) {
  clearTextRangeSelection({ notify:false });
  removeTransformSelection({ notify:false });
  const overlay = document.createElement('div');
  overlay.dataset.deckEditorUi = '';
  overlay.dataset.transformSelection = '';
  const moveHandles = ['top', 'right', 'bottom', 'left'].map(side => {
    const moveHandle = document.createElement('div');
    moveHandle.dataset.deckEditorUi = '';
    moveHandle.dataset.transformMoveHandle = side;
    moveHandle.setAttribute('aria-hidden', 'true');
    return moveHandle;
  });
  let handle = null;
  if (withHandle) {
    handle = document.createElement('div');
    handle.dataset.deckEditorUi = '';
    handle.dataset.resizeHandle = '';
    handle.setAttribute('role', 'button');
    handle.setAttribute('aria-label', '拖动缩放元素');
  }
  document.body.append(overlay, ...moveHandles);
  if (handle) document.body.append(handle);
  transformSelection = {
    element, overlay, moveHandles, handle, target:target ?? runtime.makeLocator(element),
    selectionId:crypto.randomUUID(),
  };
  positionTransformSelection();
  publishInspectorSelection();
}

function restoreTransformPreview(state, { position = true } = {}) {
  if (state.kind === 'translate') {
    if (state.originalTranslate) state.element.style.translate = state.originalTranslate;
    else state.element.style.removeProperty('translate');
  } else if (state.scaleTarget) {
    if (state.originalScale) state.element.style.scale = state.originalScale;
    else state.element.style.removeProperty('scale');
  } else {
    if (state.originalWidth) state.element.style.width = state.originalWidth;
    else state.element.style.removeProperty('width');
    if (state.originalHeight) state.element.style.height = state.originalHeight;
    else state.element.style.removeProperty('height');
  }
  if (position) positionTransformSelection();
}

function retainTransformCommitPreview(state) {
  const preview = state.element.cloneNode(true);
  const sourceNodes = [state.element, ...state.element.querySelectorAll('*')];
  const previewNodes = [preview, ...preview.querySelectorAll('*')];
  for (const [index, node] of previewNodes.entries()) {
    node.removeAttribute('id');
    node.removeAttribute('data-editor-id');
    node.removeAttribute('contenteditable');
    const computed = getComputedStyle(sourceNodes[index]);
    for (let propertyIndex = 0; propertyIndex < computed.length; propertyIndex += 1) {
      const property = computed[propertyIndex];
      node.style.setProperty(property, computed.getPropertyValue(property), 'important');
    }
  }
  const rect = state.element.getBoundingClientRect();
  Object.entries({
    position:'fixed', left:`${rect.left}px`, top:`${rect.top}px`, right:'auto', bottom:'auto',
    margin:'0', width:`${rect.width}px`, height:`${rect.height}px`, 'box-sizing':'border-box',
    transform:'none', translate:'none', scale:'none', rotate:'none', 'z-index':'2147483639',
  }).forEach(([property, value]) => preview.style.setProperty(property, value, 'important'));
  preview.dataset.deckEditorUi = '';
  preview.dataset.transformCommitPreview = '';
  preview.setAttribute('aria-hidden', 'true');
  state.element.dataset.transformCommitSource = '';
  document.body.append(preview);
  let removed = false;
  return () => {
    if (removed) return;
    removed = true;
    delete state.element.dataset.transformCommitSource;
    preview.remove();
  };
}

function cancelTransformDrag() {
  if (!transformDrag) return;
  const state = transformDrag;
  transformDrag = null;
  delete document.documentElement.dataset.deckEditorDragging;
  state.capture?.releasePointerCapture?.(state.pointerId);
  restoreTransformPreview(state);
  requestAuthoritativeReloadIfSettled();
}

function beginMove(event, element) {
  let target;
  try { target = runtime.makeLocator(element); } catch { return; }
  const canvas = element.closest('.slide-canvas');
  clearTextRangeSelection({ notify:false });
  if (transformSelection?.element !== element) selectTransformElement(element, true, target);
  else positionTransformSelection();
  const capture = event.target.closest?.('[data-transform-move-handle]') ?? element;
  transformDrag = {
    kind: 'translate', pointerId: event.pointerId, capture, element, target, canvas,
    start: { x: event.clientX, y: event.clientY }, base: currentTranslate(element),
    current: currentTranslate(element), originalTranslate: element.style.translate, changed: false,
  };
  capture.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function updateEditPointerCursor(event) {
  const moving = transformDrag?.kind === 'translate';
  const directText = directEdit?.element?.contains(event.target);
  const element = mode === 'edit' && !directText && !moving
    ? editableTransformTarget(event) : null;
  const textTarget = Boolean(directText || (element && inspectorKind(element) === 'text'
    && !textRejection(element, { allowChildren:true })));
  const moveTarget = Boolean(moving || (element && !textTarget));
  if (mode === 'edit' && moveTarget) {
    document.documentElement.dataset.deckEditorMoveCursor = '';
  } else {
    delete document.documentElement.dataset.deckEditorMoveCursor;
  }
  if (mode === 'edit' && textTarget) {
    document.documentElement.dataset.deckEditorTextCursor = '';
  } else {
    delete document.documentElement.dataset.deckEditorTextCursor;
  }
}

function isScaleTarget(element) {
  return element.matches(INTERACTIVE_TRANSFORM_SELECTOR)
    || Boolean(element.querySelector(INTERACTIVE_TRANSFORM_SELECTOR));
}

function beginResize(event) {
  if (!transformSelection?.element) return;
  const selectedElement = transformSelection.element;
  // HTML 表格单元格的宽高由整列/整行联动计算，直接给 TD/TH
  // 同时写 width/height 会让其他行的计算尺寸漂移，并破坏历史重放。
  // 用户从单元格右下控制点拖动时，改为调整该表格行的高度。
  const tableRow = selectedElement.matches('td,th') ? selectedElement.closest('tr') : null;
  const element = tableRow ?? selectedElement;
  let target;
  try { target = runtime.makeLocator(element); } catch { return; }
  const rect = element.getBoundingClientRect();
  const scaleTarget = !tableRow && isScaleTarget(element);
  if (tableRow) {
    transformSelection.element = tableRow;
    transformSelection.target = target;
    positionTransformSelection();
  }
  transformDrag = {
    kind: 'resize', pointerId: event.pointerId, capture: event.target, element, target,
    canvas: element.closest('.slide-canvas'), start: { x: event.clientX, y: event.clientY },
    scaleTarget, lockWidth:Boolean(tableRow), changed: false,
    baseScale: Number.parseFloat(getComputedStyle(element).scale) || 1,
    baseSize: { width: rect.width, height: rect.height },
    current: scaleTarget ? { scale: Number.parseFloat(getComputedStyle(element).scale) || 1 }
      : { width: rect.width, height: rect.height },
    originalScale: element.style.scale, originalWidth: element.style.width,
    originalHeight: element.style.height,
  };
  event.target.setPointerCapture?.(event.pointerId);
  event.preventDefault();
  event.stopPropagation();
}

function onTransformPointerMove(event) {
  if (!transformDrag || event.pointerId !== transformDrag.pointerId) return false;
  const state = transformDrag;
  const bounds = state.canvas.getBoundingClientRect();
  const visualScale = frameVisualScale();
  const screenDx = (event.clientX - state.start.x) * visualScale.x;
  const screenDy = (event.clientY - state.start.y) * visualScale.y;
  if (!state.changed && Math.hypot(screenDx, screenDy) <= TRANSFORM_DRAG_START_PX) {
    event.preventDefault();
    return true;
  }
  state.changed = true;
  document.documentElement.dataset.deckEditorDragging = state.kind;
  const dx = (event.clientX - state.start.x) * 1920 / bounds.width;
  const dy = (event.clientY - state.start.y) * 1080 / bounds.height;
  if (state.kind === 'translate') {
    state.current = { x: Math.round(state.base.x + dx), y: Math.round(state.base.y + dy) };
    state.element.style.translate = `${state.current.x}px ${state.current.y}px`;
  } else if (state.scaleTarget) {
    const delta = Math.max(dx / Math.max(1, state.baseSize.width), dy / Math.max(1, state.baseSize.height));
    state.current = { scale: Math.max(.1, Math.round(state.baseScale * (1 + delta) * 1000) / 1000) };
    state.element.style.scale = String(state.current.scale);
  } else {
    state.current = {
      width: state.lockWidth
        ? Math.max(1, Math.round(state.baseSize.width))
        : Math.max(1, Math.round(state.baseSize.width + dx)),
      height: Math.max(1, Math.round(state.baseSize.height + dy)),
    };
    state.element.style.width = `${state.current.width}px`;
    state.element.style.height = `${state.current.height}px`;
  }
  positionTransformSelection();
  event.preventDefault();
  return true;
}

function finishTransformPointer(event) {
  if (!transformDrag || event.pointerId !== transformDrag.pointerId) return false;
  const state = transformDrag;
  transformDrag = null;
  delete document.documentElement.dataset.deckEditorDragging;
  state.capture?.releasePointerCapture?.(state.pointerId);
  if (requiresAuthoritativeReload) {
    restoreTransformPreview(state);
    requestAuthoritativeReloadIfSettled();
    event.preventDefault();
    return true;
  }
  if (!state.changed && state.kind === 'resize') {
    restoreTransformPreview(state);
    return true;
  }
  if (state.kind === 'translate'
    && state.current.x === state.base.x && state.current.y === state.base.y) {
    restoreTransformPreview(state);
    return true;
  }
  // 真实元素必须先回到权威基线，让 runtime 读到正确 before；
  // 同时保留一份最终位置的纯视觉副本，避免服务端确认期间闪回。
  const releaseCommitPreview = retainTransformCommitPreview(state);
  restoreTransformPreview(state, { position:false });
  const action = {
    id: crypto.randomUUID(), taskId: null, target: state.target,
    kind: state.kind, payload: state.current,
  };
  submitManualActions([action], result => {
    releaseCommitPreview();
    if (result.ok && (result.sessionRefreshPending || result.syncPending || result.recoveredBySync)) {
      showStatus(manualSuccessMessage(result, '变换已记录'));
    } else if (!result.ok) showStatus(manualFailureMessage(result, '变换失败，已恢复原状态'), 'error');
    positionTransformSelection();
    publishInspectorSelection();
  });
  event.preventDefault();
  return true;
}

function onPointerDown(event) {
  parent.postMessage({ type:'editor-surface-pointerdown' }, location.origin);
  removeRegionClickHint();
  const currentMode = effectiveMode();
  const moveHandle = event.target.closest?.('[data-transform-move-handle]');
  if (currentMode === 'edit' && event.button === 0 && moveHandle && transformSelection?.element) {
    if (directEdit) commitDirectEdit();
    beginMove(event, transformSelection.element);
    return;
  }
  if (currentMode === 'edit' && event.button === 0
    && event.target.closest?.('[data-resize-handle]')) {
    if (directEdit) commitDirectEdit();
    beginResize(event);
    return;
  }
  if (event.target.closest?.('[data-deck-editor-ui],[data-text-format-toolbar-owner]')) return;
  if (directEdit?.element?.contains(event.target)) return;
  if (directEdit) commitDirectEdit();
  if (currentMode === 'edit' && event.button === 0) {
    const element = editableTransformTarget(event);
    if (element && inspectorKind(element) === 'text'
      && !textRejection(element, { allowChildren:true })) {
      beginDirectTextEdit(event, { useNativePointer:true });
    } else if (element) beginMove(event, element);
    else removeTransformSelection();
    return;
  }
  if (!isRegionMode() || activePopover?.submitting
    || event.button !== 0 || event.target.closest?.('[data-deck-editor-ui]')) return;
  const canvas = event.target.closest?.('.slide-canvas');
  if (!canvas || !canvases.includes(canvas)) return;
  removePopover();
  const bounds = canvas.getBoundingClientRect();
  dragging = {
    pointerId: event.pointerId,
    canvas,
    bounds,
    start: { x: event.clientX, y: event.clientY },
    current: { x: event.clientX, y: event.clientY },
    selection: document.createElement('div'),
  };
  dragging.selection.dataset.deckEditorUi = '';
  dragging.selection.dataset.regionSelection = '';
  document.body.append(dragging.selection);
  setBox(dragging.selection, regionFromPoints(dragging.start, dragging.current, bounds));
  canvas.setPointerCapture?.(event.pointerId);
  event.preventDefault();
}

function onPointerMove(event) {
  setSurfacePointerPresence(true);
  updateEditPointerCursor(event);
  updateRegionClickHint(event);
  if (onTransformPointerMove(event)) return;
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  dragging.current = { x: event.clientX, y: event.clientY };
  setBox(dragging.selection, regionFromPoints(dragging.start, dragging.current, dragging.bounds));
  event.preventDefault();
}

function finishPointer(event) {
  if (finishTransformPointer(event)) return;
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  const state = dragging;
  dragging = null;
  state.current = { x: event.clientX, y: event.clientY };
  state.canvas.releasePointerCapture?.(event.pointerId);
  const region = regionFromPoints(state.start, state.current, state.bounds);
  state.selection.remove();
  const visualScale = frameVisualScale();
  if (region.width * visualScale.x + 0.01 < 6 || region.height * visualScale.y + 0.01 < 6) return;
  const candidates = rankCandidates(state.canvas, region);
  openPopover(state.canvas, region, candidates);
  event.preventDefault();
}

function cancelPointer(event) {
  if (transformDrag && event.pointerId === transformDrag.pointerId) {
    cancelTransformDrag();
    return;
  }
  if (!dragging || event.pointerId !== dragging.pointerId) return;
  const state = dragging;
  dragging = null;
  state.canvas.releasePointerCapture?.(event.pointerId);
  state.selection.remove();
}

function locateTask(pageKey, rect, pageState) {
  const canvas = showPage(pageKey);
  if (!canvas || !rect || ![rect.x, rect.y, rect.w, rect.h].every(Number.isFinite)) return;
  requestAnimationFrame(() => requestAnimationFrame(() => {
    restorePageState(canvas, pageState);
    clearTimeout(highlightTimer);
    document.querySelector('[data-task-highlight]')?.remove();
    const bounds = canvas.getBoundingClientRect();
    const highlight = document.createElement('div');
    highlight.dataset.deckEditorUi = '';
    highlight.dataset.taskHighlight = '';
    setBox(highlight, {
      left: bounds.left + rect.x * bounds.width / 1920,
      top: bounds.top + rect.y * bounds.height / 1080,
      width: rect.w * bounds.width / 1920,
      height: rect.h * bounds.height / 1080,
    });
    document.body.append(highlight);
    highlightTimer = setTimeout(() => highlight.remove(), 1500);
  }));
}

function styleStateForShortcut(state, property) {
  const element = state?.element;
  if (!element?.isConnected) return '';
  const owner = Number.isSafeInteger(state.start) && Number.isSafeInteger(state.end)
    ? (textNodeAtOffset(element, state.start)?.parentElement ?? element)
    : element;
  return getComputedStyle(owner).getPropertyValue(property).trim();
}

function textRangeStyleRuns(element, start, end, property) {
  const runs = [];
  let offset = 0;
  for (const node of textNodesWithin(element)) {
    const nextOffset = offset + node.data.length;
    const runStart = Math.max(start, offset);
    const runEnd = Math.min(end, nextOffset);
    if (runEnd > runStart) {
      const value = textNodeStyleValue(node, element, property);
      const previous = runs.at(-1);
      if (previous?.value === value && previous.end === runStart) previous.end = runEnd;
      else runs.push({ start:runStart, end:runEnd, value });
    }
    offset = nextOffset;
  }
  return runs;
}

function styleActionsForState(state, changes) {
  const selectedTextRange = Number.isSafeInteger(state.start) && Number.isSafeInteger(state.end)
    ? { start:state.start, end:state.end } : null;
  return changes.flatMap(change => {
    const wholeRange = !selectedTextRange && TEXT_RANGE_STYLE_PROPERTIES.has(change.property)
      ? wholeTextStyleRange(state.element) : null;
    const textRange = selectedTextRange ?? (wholeRange?.usesRange ? wholeRange : null);
    const ranges = textRange
      ? textRangeStyleRuns(state.element, textRange.start, textRange.end, change.property)
        .filter(run => run.value !== change.value)
      : [null];
    return ranges.map(range => ({
      id:crypto.randomUUID(), taskId:null, target:state.target, kind:'setStyle',
      payload:{
        property:change.property, value:change.value,
        ...(range ? { textRange:{ start:range.start, end:range.end } } : {}),
      },
    }));
  });
}

function styleValuesForState(state, property) {
  const selectedTextRange = Number.isSafeInteger(state?.start) && Number.isSafeInteger(state?.end)
    ? { start:state.start, end:state.end } : null;
  const wholeRange = !selectedTextRange && TEXT_RANGE_STYLE_PROPERTIES.has(property)
    ? wholeTextStyleRange(state?.element) : null;
  const textRange = selectedTextRange ?? (wholeRange?.usesRange ? wholeRange : null);
  if (textRange) {
    return [...new Set(textRangeStyleRuns(
      state.element, textRange.start, textRange.end, property,
    ).map(run => run.value))];
  }
  return [styleStateForShortcut(state, property)];
}

function shortcutStyleChange(state, key) {
  if (key === 'b') {
    const values = styleValuesForState(state, 'font-weight');
    const active = values.length === 1 && Number.parseInt(values[0], 10) >= 600;
    return { property:'font-weight', value:active ? '400' : '700' };
  }
  if (key === 'i') {
    const values = styleValuesForState(state, 'font-style');
    const active = values.length === 1 && values[0] === 'italic';
    return { property:'font-style', value:active ? 'normal' : 'italic' };
  }
  const values = styleValuesForState(state, 'text-decoration-line');
  const active = values.length === 1 && values[0].split(/\s+/).includes('underline');
  return { property:'text-decoration-line', value:active ? 'none' : 'underline' };
}

function toolbarColor(value) {
  const match = String(value).match(/^rgba?\(\s*(\d+)\D+(\d+)\D+(\d+)/);
  if (!match) return '#191919';
  return `#${match.slice(1, 4).map(part => Number(part).toString(16).padStart(2, '0')).join('')}`;
}

function submitToolbarStyles(state, changes, {
  elementScope = false, coalesceKey = '',
} = {}) {
  const actionState = elementScope
    ? { element:state.element, target:state.target } : state;
  const actions = styleActionsForState(actionState, changes);
  if (actions.length === 0) {
    restoreTextRangeSelection(state);
    publishInspectorSelection();
    return;
  }
  submitManualActions(actions, result => {
    restoreTextRangeSelection(state);
    publishInspectorSelection();
    if (!result.ok) showStatus(manualFailureMessage(result, '文字格式修改失败'), 'error');
  }, { coalesceKey });
}

function positionTextFormatToolbar(state) {
  if (!textFormatToolbar?.isConnected) return;
  const start = textPointAtOffset(state.element, state.start, 'start');
  const end = textPointAtOffset(state.element, state.end, 'end');
  if (!start || !end) return;
  const range = document.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  const rect = range.getBoundingClientRect();
  const scale = frameVisualScale();
  const width = textFormatToolbar.offsetWidth / scale.x;
  const height = textFormatToolbar.offsetHeight / scale.y;
  const marginX = 8 / scale.x;
  const gapY = 8 / scale.y;
  const left = Math.max(marginX, Math.min(innerWidth - width - marginX, rect.left));
  const above = rect.top - height - gapY;
  const top = above >= 8 / scale.y ? above : rect.bottom + gapY;
  Object.assign(textFormatToolbar.style, {
    left:`${left}px`, top:`${Math.max(8 / scale.y, top)}px`,
    transform:`scale(${1 / scale.x}, ${1 / scale.y})`,
  });
}

function renderTextFormatToolbar(state) {
  textFormatToolbar?.remove();
  textFormatToolbar = null;
  if (!state?.element?.isConnected || directEdit?.formatRoot !== state.element) return;
  const toolbar = document.createElement('div');
  toolbar.dataset.deckEditorUi = '';
  toolbar.dataset.textFormatToolbar = '';
  toolbar.setAttribute('role', 'toolbar');
  toolbar.setAttribute('aria-label', '文字快捷格式');
  const button = (label, text, onClick, pressed = null) => {
    const control = document.createElement('button');
    control.type = 'button';
    control.textContent = text;
    control.setAttribute('aria-label', label);
    control.title = label;
    if (pressed !== null) control.setAttribute('aria-pressed', pressed);
    applyPill(control, {
      variant:'neutral', size:'sm', kind:pressed === null ? 'action' : 'segment',
    });
    control.addEventListener('pointerdown', event => event.preventDefault());
    control.addEventListener('click', onClick);
    return control;
  };
  const toggle = (key, label, text) => {
    const change = shortcutStyleChange(state, key);
    const values = styleValuesForState(state, change.property);
    const activeValue = { b:'700', i:'italic', u:'underline' }[key];
    const active = key === 'b'
      ? values.length === 1 && Number.parseInt(values[0], 10) >= 600
      : (key === 'u'
        ? values.length === 1 && values[0].split(/\s+/).includes(activeValue)
        : values.length === 1 && values[0] === activeValue);
    const pressed = values.length > 1 ? 'mixed' : String(active);
    return button(label, text, () => submitToolbarStyles(state, [shortcutStyleChange(state, key)]), pressed);
  };
  const fonts = [
    'Huawei Sans', 'HarmonyOS Sans SC', 'Noto Sans SC', 'Microsoft YaHei',
    'Arial', 'Times New Roman', 'JetBrains Mono',
  ];
  const currentFont = styleStateForShortcut(state, 'font-family')
    .split(',')[0].trim().replace(/^(["'])(.*)\1$/, '$2');
  const fontSelect = document.createElement('select');
  fontSelect.setAttribute('aria-label', '字体');
  for (const font of [...new Set([...fonts, currentFont])]) {
    if (!font) continue;
    const option = document.createElement('option');
    option.value = font;
    option.textContent = font;
    fontSelect.append(option);
  }
  fontSelect.value = currentFont;
  fontSelect.addEventListener('change', () => submitToolbarStyles(state, [{
    property:'font-family', value:fontSelect.value,
  }]));
  const enhancedFontSelect = enhanceSelect(fontSelect, { minimumMenuWidth:180 });
  enhancedFontSelect.menu.dataset.textFormatToolbarOwner = '';
  const fontSelectControl = enhancedFontSelect.root;
  const divider = () => {
    const node = document.createElement('span');
    node.dataset.toolbarDivider = '';
    return node;
  };
  // 工具条在请求完成前仍可继续点按。字号必须在每次点击时先更新本地步进值，
  // 不能捕获一次旧字号后反复提交同一个值。
  let steppedFontSize = Number.parseFloat(styleStateForShortcut(state, 'font-size')) || 24;
  const adjustFontSize = delta => {
    steppedFontSize = Math.max(6, Math.min(240, Math.round(steppedFontSize + delta)));
    submitToolbarStyles(state, [{
      property:'font-size', value:`${steppedFontSize}px`,
    }], { coalesceKey:`文字选区:${state.selectionId}:font-size` });
  };
  const colorLabel = document.createElement('label');
  const colorInput = document.createElement('input');
  colorInput.type = 'color';
  colorInput.value = toolbarColor(styleStateForShortcut(state, 'color'));
  colorInput.setAttribute('aria-label', '文字颜色');
  colorLabel.style.setProperty('--toolbar-color', colorInput.value);
  colorLabel.append(colorInput);
  colorInput.addEventListener('change', () => {
    colorLabel.style.setProperty('--toolbar-color', colorInput.value);
    submitToolbarStyles(state, [{ property:'color', value:colorInput.value }]);
  });
  const enhancedColorInput = enhanceColorInput(colorInput);
  enhancedColorInput.popover.dataset.textFormatToolbarOwner = '';
  const align = (value, label, text) => button(label, text, () => submitToolbarStyles(state, [{
    property:'text-align', value,
  }], { elementScope:true }), String(getComputedStyle(state.element).textAlign === value));
  toolbar.append(
    fontSelectControl,
    toggle('b', '加粗', 'B'), toggle('i', '斜体', 'I'), toggle('u', '下划线', 'U'),
    button('字号减小', 'A−', () => adjustFontSize(-1)),
    button('字号增大', 'A+', () => adjustFontSize(1)),
    divider(),
    colorLabel, divider(),
    align('left', '左对齐', '≡←'), align('center', '居中', '≡'), align('right', '右对齐', '→≡'),
  );
  document.body.append(toolbar);
  textFormatToolbar = toolbar;
  positionTextFormatToolbar(state);
}

function applyFormattingShortcut(event) {
  const key = event.key.toLowerCase();
  if (event.altKey || event.shiftKey || (!event.metaKey && !event.ctrlKey)
    || !['b', 'i', 'u'].includes(key)) return false;
  const state = textRangeSelection ?? (directEdit ? {
    element:directEdit.formatRoot, target:directEdit.formatTarget,
  } : transformSelection);
  if (!state?.element?.isConnected || !state.target || inspectorKind(state.element) !== 'text') {
    return false;
  }
  const change = shortcutStyleChange(state, key);
  const textRange = state === textRangeSelection
    ? { start:state.start, end:state.end } : null;
  const actions = styleActionsForState(state, [change]);
  event.preventDefault();
  if (actions.length === 0) return true;
  submitManualActions(actions, result => {
    if (textRange) restoreTextRangeSelection(state);
    if (state === transformSelection) positionTransformSelection();
    publishInspectorSelection();
    if (!result.ok) showStatus(manualFailureMessage(result, '文字格式修改失败'), 'error');
  });
  return true;
}

function deleteSelectedTransform(selectionId) {
  if (!isEditMode() || directEdit || transformDrag
    || pendingManual.size > 0 || tentativeCommands.size > 0
    || !transformSelection?.element?.isConnected || !transformSelection.target
    || transformSelection.selectionId !== selectionId) return false;
  const selected = transformSelection;
  showStatus('正在删除所选元素…');
  submitManualActions([{
    id:crypto.randomUUID(), taskId:null, target:selected.target,
    kind:'hide', payload:{},
  }], result => {
    if (result.ok) {
      if (transformSelection?.selectionId === selected.selectionId) {
        removeTransformSelection();
      }
      showStatus(manualSuccessMessage(result, '元素已删除，可用 Cmd/Ctrl+Z 撤销'));
      return;
    }
    if (transformSelection?.selectionId === selected.selectionId) {
      positionTransformSelection();
      publishInspectorSelection();
    }
    showStatus(manualFailureMessage(result, '元素删除失败'), 'error');
  });
  return true;
}

function deleteTransformSelection(event, acceptsNativeShortcut) {
  if (acceptsNativeShortcut || !['Delete', 'Backspace'].includes(event.key)
    || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return false;
  if (event.repeat) {
    if (!transformSelection) return false;
    event.preventDefault();
    return true;
  }
  if (!deleteSelectedTransform(transformSelection?.selectionId)) return false;
  event.preventDefault();
  return true;
}

function onKeyDown(event) {
  if (applyFormattingShortcut(event)) return;
  const shortcutKey = event.key.toLowerCase();
  const shortcutMethod = !event.altKey && (event.metaKey || event.ctrlKey)
    ? (shortcutKey === 'z' ? (event.shiftKey ? 'redo' : 'undo')
      : (shortcutKey === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey
        ? 'redo' : null))
    : null;
  if (directEdit) {
    if (shortcutMethod) {
      event.preventDefault();
      // contenteditable 的原生 undo 栈也会记录 runtime 插入的文字范围样式节点，
      // 让浏览器自行撤销可能把选中文字或富文本结构一起删掉。尚未提交的键入
      // 先恢复进入编辑时的内容；纯格式操作则交给 Editor 的统一历史队列。
      if ((directEdit.element.textContent ?? '') !== directEdit.originalText) {
        clearTextRangeSelection();
        finishDirectEdit();
        showStatus('已撤销尚未提交的文字输入');
      } else {
        parent.postMessage({ type:'history-shortcut', method:shortcutMethod }, location.origin);
      }
    } else if (event.key === 'Escape') {
      event.preventDefault();
      clearTextRangeSelection();
      finishDirectEdit();
      showStatus('已取消文字修改');
    } else if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      commitDirectEdit();
    }
    return;
  }
  const shortcutElement = event.target instanceof Element ? event.target : event.target?.parentElement;
  const acceptsNativeShortcut = shortcutElement?.closest(
    'input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"])',
  );
  if (deleteTransformSelection(event, acceptsNativeShortcut)) return;
  if (isRegionShortcutKey(event) && (isEditMode() || mode === 'region')
    && !event.metaKey && !event.ctrlKey && !event.altKey && !event.shiftKey
    && !acceptsNativeShortcut) {
    event.preventDefault();
    if (!event.repeat) {
      parent.postMessage({ type:'temporary-region-shortcut', active:true }, location.origin);
    }
    return;
  }
  if (shortcutMethod && !acceptsNativeShortcut) {
    event.preventDefault();
    parent.postMessage({ type:'history-shortcut', method:shortcutMethod }, location.origin);
    return;
  }
  if (event.key === 'Escape' && (transformDrag || transformSelection)) {
    event.preventDefault();
    cancelTransformDrag();
    removeTransformSelection();
  }
}

function onKeyUp(event) {
  if (!isRegionShortcutKey(event)) return;
  parent.postMessage({ type:'temporary-region-shortcut', active:false }, location.origin);
}

function rollbackAllTentative() {
  for (const pending of tentativeCommands.values()) pending.transaction.rollback();
  tentativeCommands.clear();
  if (transformSelection) {
    positionTransformSelection();
    publishInspectorSelection();
  }
  requestAuthoritativeReloadIfSettled();
}

function onParentMessage(event) {
  if (event.origin !== location.origin || event.source !== parent) return;
  if (event.data?.type === 'delete-transform-selection'
    && typeof event.data.selectionId === 'string') {
    deleteSelectedTransform(event.data.selectionId);
    return;
  }
  if (event.data?.type === 'show-authoritative-reload-notice') {
    showStatus('页面重建，未提交编辑已取消');
    return;
  }
  if (event.data?.type === 'show-page' && typeof event.data.pageKey === 'string') {
    showPage(event.data.pageKey);
    return;
  }
  if (event.data?.type === 'set-editor-mode'
    && ['preview', 'edit', 'region', 'text', 'move', 'resize'].includes(event.data.mode)) {
    const nextMode = canonicalMode(event.data.mode);
    if (nextMode !== mode) {
      finishDirectEdit();
      clearTextRangeSelection();
      cancelTransformDrag();
      removeTransformSelection();
    }
    mode = nextMode;
    document.documentElement.dataset.deckEditorMode = mode;
    document.documentElement.style.cursor = mode === 'region' ? 'crosshair' : '';
    delete document.documentElement.dataset.deckEditorMoveCursor;
    delete document.documentElement.dataset.deckEditorTextCursor;
    if (mode !== 'region') removeRegionClickHint();
    if (mode !== 'region' && event.data.preserveRegionPopover !== true) removePopover();
    return;
  }
  if (event.data?.type === 'apply-inspector-styles'
    && typeof event.data.requestId === 'string'
    && typeof event.data.selectionId === 'string') {
    const requestId = event.data.requestId;
    const selectionId = event.data.selectionId;
    const changes = event.data.changes;
    const coalesceKey = typeof event.data.coalesceKey === 'string'
      && event.data.coalesceKey.length <= 256 ? event.data.coalesceKey : '';
    const elementScope = event.data.scope === 'element';
    const reject = message => parent.postMessage({
      type:'inspector-style-result', requestId, selectionId, ok:false, message,
    }, location.origin);
    const rangeState = textRangeSelection?.selectionId === selectionId
      ? textRangeSelection : null;
    const baseState = rangeState ?? transformSelection;
    const selectedState = elementScope && rangeState ? {
      element:rangeState.element, target:rangeState.target, selectionId:rangeState.selectionId,
    } : baseState;
    if (!selectedState?.element?.isConnected || selectedState.selectionId !== selectionId) {
      reject('选中对象已经变化，请重新选择');
      return;
    }
    if (!Array.isArray(changes) || changes.length === 0 || changes.length > 12
      || changes.some(change => !change || typeof change.value !== 'string'
        || !INSPECTOR_STYLE_PROPERTIES.has(change.property))
      || new Set(changes.map(change => change.property)).size !== changes.length) {
      reject('样式参数无效');
      return;
    }
    const textRange = selectedState === textRangeSelection
      ? { start:selectedState.start, end:selectedState.end } : null;
    if (textRange && changes.some(change => !TEXT_RANGE_STYLE_PROPERTIES.has(change.property))) {
      reject('局部文字仅支持字体、字重、斜体、下划线、字号和文字颜色');
      return;
    }
    const actions = styleActionsForState(selectedState, changes);
    if (actions.length === 0) {
      if (rangeState) restoreTextRangeSelection(rangeState);
      publishInspectorSelection();
      parent.postMessage({
        type:'inspector-style-result', requestId, selectionId, ok:true,
      }, location.origin);
      return;
    }
    submitManualActions(actions, result => {
      if (rangeState) restoreTextRangeSelection(rangeState);
      if (transformSelection?.selectionId === selectionId) {
        positionTransformSelection();
      }
      publishInspectorSelection();
      parent.postMessage({
        type:'inspector-style-result', requestId, selectionId,
        ok:result.ok === true,
        message:result.message,
        sessionRefreshPending:result.sessionRefreshPending === true,
        failedActionId:result.failedActionId,
      }, location.origin);
    }, { coalesceKey });
    return;
  }
  if(event.data?.type==='restart-status' && typeof event.data.commandId==='string') {
    parent.postMessage({type:'restart-status-result',commandId:event.data.commandId,
      busy:Boolean(hasTransientInteraction()||dragging||activePopover||sourceMutationOwner)},location.origin);
    return;
  }
  if(event.data?.type==='editor-lock' && typeof event.data.commandId==='string') {
    const {owner,release}=event.data;
    let accepted=false;
    const styles={};
    if(release){if(sourceMutationOwner===owner)releaseSourceMutation();accepted=true;}
    else if(typeof owner==='string' && !hasTransientInteraction() && (!sourceMutationOwner||sourceMutationOwner===owner)) {
      if(!sourceMutationOwner)previousBodyInert=document.body.inert;
      sourceMutationOwner=owner;document.body.inert=true;accepted=true;
      clearTimeout(sourceMutationTimer);
      sourceMutationTimer=setTimeout(releaseSourceMutation,180_000);
      for(const target of (event.data.targets??[]).slice(0,32)) {
        try {
          const element=runtime.resolve(target),css=getComputedStyle(element);
          styles[target.editorId]={position:css.position,display:css.display,flexDirection:css.flexDirection,
            boxSizing:css.boxSizing,height:css.height,paddingBottom:css.paddingBottom};
        } catch { /* 不猜测失效目标的样式，由结构校验拒绝。 */ }
      }
    }
    parent.postMessage({type:'editor-lock-result',commandId:event.data.commandId,accepted,styles},location.origin);
    return;
  }
  if (event.data?.type === 'apply-actions' && typeof event.data.commandId === 'string') {
    const existing = tentativeCommands.get(event.data.commandId);
    if (existing) {
      parent.postMessage(existing.reply, location.origin);
      return;
    }
    try {
      if (event.data.tentative === true) {
        const ownManual=[...pendingManual.values()].some(pending=>pending.actionIds.length===event.data.actions?.length
          && pending.actionIds.every((id,index)=>id===event.data.actions[index].id));
        // 用户撤销已提交格式时可保留文字选区；输入草稿仍须阻止历史覆盖。
        const cleanHistory=event.data.replace===true && directEdit
          && (directEdit.element.textContent??'')===directEdit.originalText;
        if(sourceMutationOwner || ((transformDrag || (directEdit && !cleanHistory)) && !ownManual))throw Object.assign(new Error('右侧正在编辑'),{code:'EDITOR_INTERACTION_ACTIVE'});
        const transaction = runtime.beginTransaction(event.data.actions, {
          replace:event.data.replace === true,
          rebaseActionIds:event.data.rebaseActionIds,
        });
        if (transformSelection) {
          positionTransformSelection();
          publishInspectorSelection();
        }
        const reply = {
          type: 'actions-prepared', commandId: event.data.commandId,
          applied: transaction.results.length, results: transaction.results,
        };
        tentativeCommands.set(event.data.commandId, { transaction, reply });
        parent.postMessage(reply, location.origin);
      } else {
        const results = runtime.applyTransaction(event.data.actions);
        if (transformSelection) {
          positionTransformSelection();
          publishInspectorSelection();
        }
        parent.postMessage({
          type: 'actions-applied', commandId: event.data.commandId,
          applied: results.length, results,
        }, location.origin);
      }
    } catch (error) {
      parent.postMessage({
        type: 'actions-rejected', commandId: event.data.commandId,
        code: error.code || error.message || 'ACTION_REJECTED',
        failedActionId: error.failedActionId,
        candidates: Array.isArray(error.candidates) ? error.candidates.slice(0, 5) : [],
      }, location.origin);
    }
    return;
  }
  if (event.data?.type === 'locate-text' && typeof event.data.commandId === 'string') {
    try {
      parent.postMessage({
        type:'text-locations', commandId:event.data.commandId,
        results:locateTextCandidates(event.data.text, event.data.pageKey ?? null),
      }, location.origin);
    } catch (error) {
      parent.postMessage({
        type:'text-locations-rejected', commandId:event.data.commandId,
        code:error.code ?? 'INVALID_TEXT_QUERY', message:error.message,
      }, location.origin);
    }
    return;
  }
  if (event.data?.type === 'commit-actions' && typeof event.data.commandId === 'string') {
    const pending = tentativeCommands.get(event.data.commandId);
    const committed = pending?.transaction.commit() ?? false;
    tentativeCommands.delete(event.data.commandId);
    parent.postMessage({ type:'actions-committed', commandId:event.data.commandId, committed }, location.origin);
    requestAuthoritativeReloadIfSettled();
    return;
  }
  if (event.data?.type === 'rollback-actions' && typeof event.data.commandId === 'string') {
    const pending = tentativeCommands.get(event.data.commandId);
    const rolledBack = pending?.transaction.rollback() ?? false;
    tentativeCommands.delete(event.data.commandId);
    if (transformSelection) {
      positionTransformSelection();
      publishInspectorSelection();
    }
    parent.postMessage({ type:'actions-rolled-back', commandId:event.data.commandId, rolledBack }, location.origin);
    requestAuthoritativeReloadIfSettled();
    return;
  }
  if (event.data?.type === 'rollback-all-tentative') {
    rollbackAllTentative();
    return;
  }
  if (event.data?.type === 'sync-actions' && Array.isArray(event.data.actions)) {
    try {
      rollbackAllTentative();
      // 父页面的无 commandId 会话恢复不是一次新事务。后续 SourceMutation 已经
      // 删除的旧目标允许按 rebaseActionIds 批量跳过，避免整批恢复被第一条
      // TARGET_NOT_FOUND 中断；带 commandId 的事务性强制同步仍保持严格失败。
      if (typeof event.data.commandId === 'string') {
        runtime.applyAll(event.data.actions, { rebaseActionIds:event.data.rebaseActionIds });
      } else {
        runtime.applyAllDroppingMissing(event.data.actions, {
          rebaseActionIds:event.data.rebaseActionIds,
        });
      }
      if (transformSelection) {
        positionTransformSelection();
        publishInspectorSelection();
      }
      if (typeof event.data.commandId === 'string') {
        parent.postMessage({ type:'actions-synced', commandId:event.data.commandId }, location.origin);
      }
    }
    catch (error) { showStatus(`会话动作恢复失败：${error.code || error.message}`, 'error'); }
    return;
  }
  if (event.data?.type === 'diagnose-pages'
    && typeof event.data.commandId === 'string'
    && Number.isSafeInteger(event.data.revision)
    && Array.isArray(event.data.pageKeys)) {
    try {
      parent.postMessage({
        type:'diagnostics-result',
        commandId:event.data.commandId,
        revision:event.data.revision,
        pages:diagnosePages(event.data.pageKeys),
      }, location.origin);
    } catch (error) {
      parent.postMessage({
        type:'diagnostics-rejected',
        commandId:event.data.commandId,
        revision:event.data.revision,
        code:error.code || 'DIAGNOSTICS_UNAVAILABLE',
      }, location.origin);
    }
    return;
  }
  if (event.data?.type === 'manual-actions-result'
    && typeof event.data.requestId === 'string') {
    const pending = pendingManual.get(event.data.requestId);
    if (!pending) return;
    pendingManual.delete(event.data.requestId);
    pending.onResult(event.data);
    requestAuthoritativeReloadIfSettled();
    return;
  }
  if (event.data?.type === 'locate-task' && typeof event.data.pageKey === 'string') {
    locateTask(event.data.pageKey, event.data.rect, event.data.pageState);
    return;
  }
  if (event.data?.type === 'region-task-result'
    && activePopover?.requestId === event.data.requestId) {
    const { popover } = activePopover;
    const status = popover.querySelector('[data-region-status]');
    const submit = popover.querySelector('[data-region-submit]');
    const submitNow = popover.querySelector('[data-region-submit-now]');
    const textarea = popover.querySelector('textarea');
    const cancel = popover.querySelector('[data-region-cancel]');
    const attachmentInput = popover.querySelector('[data-attachment-input]');
    const attachmentChoose = popover.querySelector('[data-attachment-choose]');
    if (event.data.ok) {
      const completedPopover = activePopover;
      activePopover.submitting = false;
      const processRequested = event.data.processRequested === true;
      const processStarted = event.data.processStarted === true;
      status.dataset.state = processRequested && !processStarted ? 'error' : 'success';
      status.textContent = processRequested
        ? (processStarted
          ? '任务已开始执行'
          : `任务已保存，但未能启动 Agent：${event.data.processError || '请稍后在任务列表重试'}`)
        : (event.data.snapshotDropped ? '快照过大，已无图添加任务' : '任务已添加');
      if (processRequested) setPillLabel(submitNow, processStarted ? '执行中' : '已保存');
      else setPillLabel(submit, '已添加');
      setTimeout(() => {
        if (activePopover === completedPopover) removePopover();
      }, processRequested && !processStarted ? 1_200 : 420);
    } else {
      activePopover.submitting = false;
      status.dataset.state = 'error';
      status.textContent = event.data.message || '提交失败，请重试';
      textarea.disabled = false;
      cancel.disabled = false;
      submit.disabled = false;
      submitNow.disabled = false;
      attachmentInput.disabled = false;
      attachmentChoose.disabled = false;
      for (const button of popover.querySelectorAll('[data-attachment-remove]')) {
        button.disabled = false;
      }
      setPillLabel(submit, '继续添加任务');
      setPillLabel(submitNow, '直接执行');
      textarea.focus({ preventScroll: true });
    }
    return;
  }
  if (event.data?.type === 'editor-teardown') teardown();
}

function teardown() {
  if (tornDown) return;
  tornDown = true;
  setSurfacePointerPresence(false);
  startupController.abort();
  canvasMonitor?.stop();
  clearTimeout(highlightTimer);
  clearTimeout(statusTimer);
  finishDirectEdit();
  cancelTransformDrag();
  removeTransformSelection();
  clearTextRangeSelection();
  pendingManual.clear();
  rollbackAllTentative();
  dragging?.selection.remove();
  dragging = null;
  removePopover();
  removeRegionClickHint();
  document.querySelector('[data-task-highlight]')?.remove();
  document.querySelector('[data-direct-status]')?.remove();
  activePageMonitor?.stop();
  activePageMonitor = undefined;
  if (viewportGeometryFrame !== undefined) cancelAnimationFrame(viewportGeometryFrame);
  viewportGeometryFrame = undefined;
  style.remove();
  pillStyles.remove();
  document.documentElement.style.cursor = '';
  delete document.documentElement.dataset.deckEditorDragging;
  delete document.documentElement.dataset.deckEditorMoveCursor;
  delete document.documentElement.dataset.deckEditorTextCursor;
  delete document.documentElement.dataset.deckEditorMode;
  document.documentElement.style.removeProperty('--deck-editor-ui-scale-x');
  document.documentElement.style.removeProperty('--deck-editor-ui-scale-y');
  window.removeEventListener('message', onParentMessage);
  window.removeEventListener('click', suppressDeckClickDuringEdit, true);
  window.removeEventListener('dblclick', onDoubleClick, true);
  window.removeEventListener('keydown', onKeyDown, true);
  window.removeEventListener('keyup', onKeyUp, true);
  window.removeEventListener('click', onPageActivation);
  document.removeEventListener('selectionchange', updateTextRangeSelection);
  document.removeEventListener('huawei-deck-patch-replay-error', onPatchReplayFailure);
  window.removeEventListener('pointerdown', onPointerDown, true);
  window.removeEventListener('pointermove', onPointerMove, true);
  window.removeEventListener('pointerup', finishPointer, true);
  window.removeEventListener('pointercancel', cancelPointer, true);
  window.removeEventListener('pointerout', onPointerOut, true);
  window.removeEventListener('scroll', onViewportGeometryChange, true);
  window.removeEventListener('resize', onViewportGeometryChange);
  window.removeEventListener('pagehide', teardown);
  window.removeEventListener('pagehide', abortStartup);
}

if (parent !== window) {
  window.addEventListener('message', onParentMessage);
  window.addEventListener('click', suppressDeckClickDuringEdit, true);
  window.addEventListener('dblclick', onDoubleClick, true);
  window.addEventListener('keydown', onKeyDown, true);
  window.addEventListener('keyup', onKeyUp, true);
  window.addEventListener('click', onPageActivation);
  document.addEventListener('selectionchange', updateTextRangeSelection);
  document.addEventListener('huawei-deck-patch-replay-error', onPatchReplayFailure);
  window.addEventListener('pointerdown', onPointerDown, true);
  window.addEventListener('pointermove', onPointerMove, true);
  window.addEventListener('pointerup', finishPointer, true);
  window.addEventListener('pointercancel', cancelPointer, true);
  window.addEventListener('pointerout', onPointerOut, true);
  // 选框和缩放手柄使用视口坐标绘制；任意祖先滚动容器移动时都必须按帧重算。
  // 捕获阶段同时覆盖 window 滚动和模板内部 `.stage` 滚动。
  window.addEventListener('scroll', onViewportGeometryChange, true);
  window.addEventListener('resize', onViewportGeometryChange);
  window.addEventListener('pagehide', teardown);
  canvasMonitor = createCanvasMonitor((nextCanvases, { referencesChanged = false } = {}) => {
    if (!style.isConnected) document.head?.append(style);
    if (!pillStyles.isConnected) document.head?.append(pillStyles);
    document.documentElement.dataset.deckEditorMode = mode;
    // 固化补丁块会先等待 Deck DOM 稳定，再把动作收养为本轮基线。若此时提前
    // 宣布 ready，父页会在未固化基线之上恢复会话动作，产生伪 TARGET_AMBIGUOUS。
    if (!embeddedPatchBaselineReady()) return false;
    pruneDisconnectedInteractionState(nextCanvases);
    if (requiresAuthoritativeReload) {
      requestAuthoritativeReloadIfSettled();
      return false;
    }
    if (dragging || directEdit || transformDrag
      || activePopover || pendingManual.size > 0 || tentativeCommands.size > 0) return false;
    finishDirectEdit();
    cancelTransformDrag();
    removePopover();
    canvases = nextCanvases;
    activePageMonitor?.stop();
    activePageMonitor = createActivePageMonitor(canvases, startupController.signal);
    if (transformSelection) positionTransformSelection();
    parent.postMessage({
      type: 'deck-ready',
      frameInstanceId:FRAME_INSTANCE_ID,
      canvasReferencesChanged:referencesChanged,
      pages: canvases.map((canvas, index) => ({
        index: index + 1,
        label: canvas.querySelector('section[data-label]')?.dataset.label ?? `第 ${index + 1} 页`,
        pageKey: runtime.pageKey(canvas),
      })),
      diagnostics: diagnosePages(),
    }, location.origin);
    return true;
  }, startupController.signal, noteCanvasReplacementDuringInteraction);
}
}
