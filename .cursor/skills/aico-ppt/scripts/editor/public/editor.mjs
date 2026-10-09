import { confirmProjectSession, linkedProjectSession } from './dsh-project-choice.mjs';
import {
  renderTaskDrawer, setTaskDrawerOpen, taskHistoryControl,
} from './task-drawer.mjs';
import { WorkspaceSwitcher } from './workspace-switcher.mjs';
import { renderInspectorPanel } from './inspector-panel.mjs';
import { AppModal } from './native-controls.mjs';
import { installPillNav, setPillLabel } from './pill-nav.mjs';
import { installToolbarTooltip } from './toolbar-tooltip.mjs';
import { connectEvents } from './ws-client.mjs';
import { createLauncherLeaseClient } from './launcher-lease-client.mjs';
import { compileActionGroups, sourceRebaseActionIds } from './action-compiler.mjs';
import { historyCandidates, historyLabel } from '/editor/history-state.mjs';
import { isRegionShortcutKey } from '/editor/editor-shortcuts.mjs';
import { createGuidedTour } from '/editor/guided-tour.mjs';
import {
  createDshWorkBridge,
  describeDshWorkSessionTarget,
  listDshWorkSessionTargets,
} from '/editor/dsh-work-bridge.mjs';
import { createDeckTaskCoordinator } from '/editor/deck-task-coordinator.mjs';

const params = new URLSearchParams(location.search);
installPillNav(document);
const token = params.get('token') ?? '';
const editorToken = params.get('editorToken') ?? '';
const embeddedCreation = params.get('embedded') === 'creation';
const embeddedDsh = params.get('embedded') === 'dsh';
// 创建画布的对话由外层宿主管理，不能重复初始化开发终端。
const ownsAgentTerminal = !embeddedDsh && !embeddedCreation;
const dshWorkItemCoordinatorEnabled = document.documentElement.dataset
  .dshWorkItemCoordinator === 'true';
const dshParentOrigin = (() => {
  if (!embeddedDsh) return null;
  try { return new URL(params.get('parentOrigin')).origin; }
  catch { return null; }
})();
const guidedTourButton = document.querySelector('[data-guided-tour="editing"]');
const workspaceNavigation = document.querySelector('[data-workspace-navigation]');
const switchWorkspaceButton = document.querySelector('[data-workspace-switch]');
const workspaceHomeButton = document.querySelector('[data-workspace-home]');
const exitEditorButton = document.querySelector('[data-exit-editor]');
const workspaceKind = params.get('workspaceKind') === 'creation' ? 'creation' : 'editing';
if (embeddedCreation) document.documentElement.dataset.embedded = 'creation';
if (embeddedDsh) document.documentElement.dataset.embedded = 'dsh';
document.documentElement.dataset.runtimeProfile = ownsAgentTerminal ? 'standalone-dev' : 'dsh-product';
if (embeddedDsh && exitEditorButton) {
  exitEditorButton.setAttribute('aria-label', '关闭 AICO-PPT 工作台');
  exitEditorButton.title = '关闭 AICO-PPT 工作台';
  exitEditorButton.dataset.toolbarTooltip = '关闭工作台';
}
installToolbarTooltip(document);
const deckFrame = document.querySelector('#deck-frame');
const pageList = document.querySelector('[data-page-list]');
const pageCount = document.querySelector('[data-page-count]');
const currentPage = document.querySelector('[data-current-page]');
const currentKey = document.querySelector('[data-current-key]');
const wsState = document.querySelector('[data-ws-state]');
const wsLabel = document.querySelector('[data-ws-label]');
const agentStatus = document.querySelector('[data-agent-status]');
const dshSessionControl = document.querySelector('[data-dsh-session-control]');
const dshSessionSelect = document.querySelector('[data-dsh-session-select]');
const currentProjectContext = document.querySelector('[data-current-project]');
const currentProjectName = document.querySelector('[data-current-project-name]');
const agentLabels = [document.querySelector('[data-agent-label]')].filter(Boolean);
if (embeddedDsh) agentStatus.closest('.agent-status-anchor')?.remove();
const agentTerminalRoot = document.querySelector('[data-agent-terminal-panel]');
const editorShell = document.querySelector('.editor-shell');
if (embeddedCreation) editorShell.dataset.embedded = 'creation';
if (embeddedDsh) editorShell.dataset.embedded = 'dsh';
const frameViewport = document.querySelector('[data-frame-viewport]');
const frameScene = document.querySelector('[data-frame-scene]');
const zoomValue = document.querySelector('[data-zoom]');
const revisionValue = document.querySelector('[data-revision]');
const canvasPresentationButton = document.querySelector('[data-canvas-present]');
const exportPptxButton = document.querySelector('[data-export-pptx]');
const pptxExportControl = document.querySelector('[data-pptx-export-control]');
const pptxExportStatus = document.querySelector('[data-pptx-export-status]');
const pptxExportDialog = document.querySelector('[data-pptx-export-dialog]');
const pptxExportCancel = document.querySelector('[data-pptx-export-cancel]');
const pptxExportConfirm = document.querySelector('[data-pptx-export-confirm]');
const pptxExportModal = new AppModal(pptxExportDialog);
const modeTools = document.querySelector('.mode-tools');
const modeButtons = [...document.querySelectorAll('[data-mode]')];
const pagePanelToggle = document.querySelector('[data-page-panel-toggle]');
const taskDrawer = document.querySelector('[data-task-drawer]');
const historyControls = document.querySelector('.history-controls');
const undoButton = document.querySelector('[data-history-undo]');
const redoButton = document.querySelector('[data-history-redo]');
const solidifyButton = document.querySelector('[data-solidify]');
const solidifyReminder = document.querySelector('[data-solidify-reminder]');
const solidifyReminderCount = document.querySelector('[data-solidify-reminder-count]');
const solidifyReminderAction = document.querySelector('[data-solidify-reminder-action]');
const solidifyReminderClose = document.querySelector('[data-solidify-reminder-close]');
const solidifyDialog = document.querySelector('[data-solidify-dialog]');
const solidifyCancel = document.querySelector('[data-solidify-cancel]');
const solidifyExitWithout = document.querySelector('[data-solidify-exit-without]');
const solidifyConfirm = document.querySelector('[data-solidify-confirm]');
const solidifyCount = document.querySelector('[data-solidify-count]');
const solidifyMark = document.querySelector('[data-solidify-mark]');
const solidifyEyebrow = document.querySelector('[data-solidify-eyebrow]');
const solidifyTitle = document.querySelector('[data-solidify-title]');
const solidifyDescription = document.querySelector('[data-solidify-description]');
const solidifyTaskSummary = document.querySelector('[data-solidify-task-summary]');
const solidifyTaskCount = document.querySelector('[data-solidify-task-count]');
const solidifyTaskList = document.querySelector('[data-solidify-task-list]');
const solidifyOtherCount = document.querySelector('[data-solidify-other-count]');
const solidifyProgress = document.querySelector('[data-solidify-progress]');
const solidifyProgressBar = document.querySelector('[data-solidify-progressbar]');
const solidifyProgressLabel = document.querySelector('[data-solidify-progress-label]');
const solidifyProgressValue = document.querySelector('[data-solidify-progress-value]');
const deckBindingBanner = document.querySelector('[data-deck-binding-banner]');
const deckBindingTitle = document.querySelector('[data-deck-binding-title]');
const deckBindingDetail = document.querySelector('[data-deck-binding-detail]');
const deckBindingRecheck = document.querySelector('[data-deck-binding-recheck]');
const deckBindingChoose = document.querySelector('[data-deck-binding-choose]');
const solidifyModal = new AppModal(solidifyDialog, {
  panel:solidifyDialog.querySelector('[role="dialog"]'),
  onRequestClose:() => !solidifyBusy,
});
Object.defineProperty(solidifyDialog, 'open', { get:() => solidifyModal.open });
const inspectorPanel = document.querySelector('.inspector-panel');
const inspectorContent = document.querySelector('[data-inspector-content]');
const selectionState = document.querySelector('[data-selection-state]');
const inspectorCollapseButton = document.querySelector('[data-inspector-collapse]');
const inspectorReopenButton = document.querySelector('[data-inspector-reopen]');
const guidedTour = createGuidedTour({
  storageKeyPrefix:'aico-ppt-editor-guided-tour',
  canStart:() => !embeddedCreation,
  sequences:{
    editing:[
      {
        target:'.page-panel', placement:'right',
        title:'从页面列表掌握整份 Deck',
        copy:'左侧显示全部页面和任务状态。展开后可快速切页；页面身份不会因为改名或调整顺序而丢失。',
      },
      {
        target:'.mode-tools', placement:'bottom',
        title:'三种模式各司其职',
        copy:'预览用于检查效果；编辑可直接改字、移动和缩放；区域标记适合把复杂修改交给 Agent。',
      },
      {
        target:'[data-frame-viewport]', placement:'top',
        title:'所有修改都先在画布预览',
        copy:'画布展示托管工作副本和动作投影。修改会自动保存到会话，但不会直接覆盖正式 Deck。',
      },
      {
        target:['.inspector-panel:not([hidden])', '[data-inspector-reopen]:not([hidden])', '.canvas-toolbar'],
        placement:'left',
        title:'选中元素后调整属性',
        copy:'双击文字可直接输入；选中对象后，属性面板提供字体、段落、颜色与外观设置。',
      },
      {
        target:'.agent-status-anchor', placement:'bottom',
        title:'复杂任务交给右侧 Agent',
        copy:'区域标记会进入任务列表；点击 Agent 状态可打开真实终端，查看处理过程或补充说明。',
      },
      {
        target:'[data-solidify]', placement:'bottom',
        title:'最后一步才固化到正式文件',
        copy:'确认画布和任务结果后再点击“固化修改”。系统会完成冲突、诊断和补丁重放检查后原子发布。',
      },
    ],
  },
});
guidedTourButton?.addEventListener('click', () => guidedTour.start('editing'));
let pendingPageKey;
let tornDown = false;
let fitFrameRequest;
let eventsClient;
let pages = [];
let tasks = [];
let agentRun = { status:'idle' };
let agentTerminal;
let agentTerminalOpen = false;
let agentTerminalState = embeddedDsh
  ? { provider:'dsh', state:'running', promptReady:true, turnState:'idle' }
  : { provider:'codex', state:'stopped' };
let revision = 0;
let editorMode = ['preview', 'edit', 'region'].includes(params.get('mode'))
  ? params.get('mode') : 'region';
let temporaryRegionShortcut = false;
let deckSurfacePointerActive = false;
let inspectorExpanded = false;
let deckReady = false;
let deckReadyPayload;
let activeFrameInstanceId;
let authoritativeReloadPending;
let shownStartupRecovery = null;
const handledAuthoritativeReloads = new Set();
let sessionGroups = [];
let sessionRedo = [];
let historyBusy = false;
let solidifyBusy = false;
let solidifyDialogReason = 'toolbar';
let solidifyReminderShownForCycle = false;
let deckBinding = { state:'locating', reason:'none', revision:0, canPublish:false };
let deckBindingBusy = false;
let lastSolidifiedReloadRevision = -1;
let lastWorkingReloadRevision = -1;
let loadedSessionRevision = -1;
let historyRefreshTargetRevision = 0;
let historySnapshotRequirement = 0;
let historySnapshotFulfilled = 0;
let pendingHistoryShortcut = null;
let sessionRefreshTargetRevision = 0;
let sessionRefreshPromise;
let seenOnline = false;
let inspectorSelection = null;
let inspectorBusy = false;
let inspectorNotice = '';
let pendingInspectorRequest = null;
let historyNoticeTimer;
let pptxExportBusy = false;
let pptxExportTimer = null;
let pptxExportRequest = 0;
let pptxExportStarting = false;
let pptxExportAnnouncement = '';
const createRequests = new Set();
const manualRequests = new Set();
const restartDraftInputs=new WeakSet();
// 只记录用户输入；属性面板程序赋值不能误判为未保存草稿。
document.addEventListener('input',event=>{
  if(event.target instanceof HTMLInputElement||event.target instanceof HTMLTextAreaElement)restartDraftInputs.add(event.target);
});
const commandReplies = new Map();
const pendingFrameCommands = new Map();
const MAX_SNAPSHOT_BYTES = 512 * 1024;
const SOLIDIFY_REMINDER_THRESHOLD = 10;

function trustedWorkspaceUrl(value) {
  try {
    const url = new URL(value);
    const loopback = url.hostname === 'localhost' || url.hostname === '::1'
      || url.hostname.startsWith('127.');
    return url.protocol === 'http:' && loopback ? url : null;
  } catch { return null; }
}

const workspaceUrl = trustedWorkspaceUrl(params.get('workspaceUrl'));
let navigateToWorkspaceHome;
let navigateToWorkspaceTask;
let terminateEditorProcess;
let dshWorkBridge = null;
let dshTaskCoordinator = null;
let dshWorkItem = null;
let dshWorkHistory = null;
let dshWorkHistoryRequest = null;
let dshCurrentSession = null;
let unsubscribeDshSession = null;
let dshSessionBusy = false;
let dshSessionRenderVersion = 0;

function requestProcessShutdown(url) {
  document.documentElement.dataset.processExiting = 'true';
  exitEditorButton.disabled = true;
  switchWorkspaceButton.disabled = true;
  workspaceHomeButton.disabled = true;
  setPillLabel(exitEditorButton, '正在退出…');
  let beaconSent = false;
  try { beaconSent = navigator.sendBeacon(url); }
  catch { beaconSent = false; }
  if (!beaconSent) {
    void fetch(url, {
      method:'POST', keepalive:true,
      ...(url.origin === location.origin ? {} : { mode:'no-cors' }),
    }).catch(() => {});
  }
  setTimeout(() => window.close(), 80);
}

const closeStandaloneEditor = () => {
  const url = endpoint('/api/shutdown');
  url.searchParams.set('editorToken', editorToken);
  requestProcessShutdown(url);
};
if (workspaceUrl && !embeddedCreation) {
  workspaceNavigation.hidden = false;
  const workspaceClientId = workspaceUrl.searchParams.get('clientId');
  const workspaceClientSequence = Number(workspaceUrl.searchParams.get('sequence'));
  const workspaceLeaseUrl = pathname => {
    const url = new URL(pathname, workspaceUrl);
    url.searchParams.set('token', workspaceUrl.searchParams.get('token') ?? '');
    if (workspaceClientId && Number.isSafeInteger(workspaceClientSequence)) {
      url.searchParams.set('clientId', workspaceClientId);
      url.searchParams.set('sequence', String(workspaceClientSequence));
    }
    return url;
  };
  terminateEditorProcess = () => requestProcessShutdown(workspaceLeaseUrl('/api/shutdown'));
  if (workspaceClientId && Number.isSafeInteger(workspaceClientSequence)) {
    navigator.sendBeacon(workspaceLeaseUrl('/api/client-connected'));
    const workspaceLeaseClient = createLauncherLeaseClient({
      workspaceUrl,
      clientId:workspaceClientId,
      sequence:workspaceClientSequence,
    });
    workspaceLeaseClient.start();
    window.addEventListener('pagehide', () => {
      workspaceLeaseClient.close();
      navigator.sendBeacon(workspaceLeaseUrl('/api/close'));
    }, { once:true });
  }
  const navigate = destination => {
    switchWorkspaceButton.disabled = true;
    workspaceHomeButton.disabled = true;
    exitEditorButton.disabled = true;
    workspaceUrl.searchParams.set('view', destination);
    workspaceUrl.searchParams.set('leaveWorkspace', '1');
    if (embeddedDsh) {
      workspaceUrl.searchParams.set('embedded', 'dsh');
      if (dshParentOrigin) workspaceUrl.searchParams.set('parentOrigin', dshParentOrigin);
    }
    location.replace(workspaceUrl.href);
  };
  navigateToWorkspaceHome = () => navigate('home');
  new WorkspaceSwitcher({
    root:workspaceNavigation,
    trigger:switchWorkspaceButton,
    loadHistory:() => requestJson('/api/workspace-history'),
    isCurrent:(kind, entry) => kind === workspaceKind
      && entry.runtimeState === 'foreground',
    onRename:input => requestJson('/api/work-items/rename', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify(input),
    }),
    onSelect:async (kind, entry) => {
      switchWorkspaceButton.disabled = true;
      workspaceHomeButton.disabled = true;
      exitEditorButton.disabled = true;
      let createProjectSession = false;
      if (embeddedDsh) {
        const sessionId = linkedProjectSession(entry);
        dshSessionBusy = true;
        try {
          if (sessionId) await activateDshWorkItem(entry, sessionId);
          else {
            createProjectSession = await confirmProjectSession(entry);
            if (!createProjectSession) return false;
          }
        } catch (error) {
          showHistoryNotice(`无法切换任务会话：${error.message}`, 'error');
          return false;
        } finally {
          dshSessionBusy = false;
          switchWorkspaceButton.disabled = false;
          workspaceHomeButton.disabled = false;
          exitEditorButton.disabled = false;
        }
      }
      const target = new URL(workspaceUrl);
      if (createProjectSession) target.searchParams.set('createProjectSession', '1');
      target.searchParams.set('view', kind);
      target.searchParams.set('leaveWorkspace', '1');
      if (embeddedDsh) {
        target.searchParams.set('embedded', 'dsh');
        if (dshParentOrigin) target.searchParams.set('parentOrigin', dshParentOrigin);
      }
      target.searchParams.set('switchKind', kind);
      if (kind === 'creation') {
        target.searchParams.set('projectRoot', entry.projectRoot);
        target.searchParams.set('draftId', entry.draftId);
      } else {
        target.searchParams.set('deckPath', entry.deckPath);
      }
      if (typeof entry.workId === 'string') target.searchParams.set('workId', entry.workId);
      location.replace(target.href);
    },
  });
  navigateToWorkspaceTask = (kind, entry) => {
    const target = new URL(workspaceUrl);
    target.searchParams.set('view', kind);
    target.searchParams.set('leaveWorkspace', '1');
    if (embeddedDsh) {
      target.searchParams.set('embedded', 'dsh');
      if (dshParentOrigin) target.searchParams.set('parentOrigin', dshParentOrigin);
    }
    target.searchParams.set('switchKind', kind);
    if (kind === 'creation') {
      target.searchParams.set('projectRoot', entry.projectRoot);
      target.searchParams.set('draftId', entry.draftId);
    } else {
      target.searchParams.set('deckPath', entry.deckPath);
    }
    if (typeof entry.workId === 'string') target.searchParams.set('workId', entry.workId);
    location.replace(target.href);
  };
  workspaceHomeButton.addEventListener('click', navigateToWorkspaceHome);
}
if (embeddedDsh && dshParentOrigin) {
  // DSH Host 持有 Editor Runtime；嵌入页的“退出”只负责收起父级工作台。
  // 未固化确认仍由 requestWorkspaceExit 统一处理，不能在这里关闭 App/Editor 服务。
  terminateEditorProcess = () => {
    window.parent.postMessage({ type:'aico-ppt:close-workbench' }, dshParentOrigin);
  };
}
if (!embeddedCreation) {
  navigateToWorkspaceHome ??= closeStandaloneEditor;
  terminateEditorProcess ??= closeStandaloneEditor;
  exitEditorButton.hidden = false;
  exitEditorButton.addEventListener('click', requestWorkspaceExit);
}

function onDeckFrameLoad() {
  // document load 早于 frame bridge 的稳定 canvas 发现；此窗口内的 Agent 命令必须排队。
  deckReady = false;
  deckReadyPayload = undefined;
  activeFrameInstanceId = undefined;
  deckSurfacePointerActive = false;
  inspectorSelection = null;
  inspectorBusy = false;
  pendingInspectorRequest = null;
  inspectorNotice = '';
  renderInspector();
  renderHistory();
}

deckFrame.addEventListener('load', onDeckFrameLoad);
deckFrame.src = `/preview?token=${encodeURIComponent(token)}`;

function endpoint(pathname) {
  const url = new URL(pathname, location.href);
  url.searchParams.set('token', token);
  return url;
}

async function requestJson(pathname, options) {
  const response = await fetch(endpoint(pathname), options);
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(body.message || `HTTP ${response.status}`);
    error.status = response.status;
    error.code = body.error;
    error.failedActionId = body.failedActionId;
    error.targetSummary = body.targetSummary;
    error.replayCode = body.replayCode;
    error.candidates = body.candidates;
    error.committed = body.committed;
    error.commitConfirmed = body.commitConfirmed;
    error.recoveredBySync = body.recoveredBySync;
    error.revision = body.revision;
    error.groupId = body.groupId;
    error.binding = body.binding;
    error.candidate = body.candidate;
    error.stage = body.stage;
    error.recovery = body.recovery;
    error.diagnostic = body.diagnostic;
    throw error;
  }
  return body;
}

function dshCatalogCommand(command, payload) {
  return requestJson('/api/dsh-work-item/commands', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ command, ...payload }),
  });
}

function publishDshWorkContext({ refreshHistory = true } = {}) {
  if (!dshWorkBridge) return;
  const context = describeDshWorkSessionTarget(dshWorkItem);
  const historyTargets = listDshWorkSessionTargets(dshWorkHistory, dshWorkItem?.workId);
  const targets = context === null ? [] : [
    context,
    ...historyTargets.filter(target => target.workId !== context.workId),
  ];
  dshWorkBridge.publishWorkContext(context, targets);
  if (!refreshHistory || dshWorkHistoryRequest) return;
  dshWorkHistoryRequest = requestJson('/api/workspace-history?bindings=metadata').then(history => {
    dshWorkHistory = history;
    publishDshWorkContext({ refreshHistory:false });
  }).catch(error => {
    console.warn('无法刷新 AICO-PPT 任务会话目标列表。', error);
  }).finally(() => {
    dshWorkHistoryRequest = null;
  });
}

async function navigateToDshWorkSessionTarget({ workId, contextKey }) {
  const history = await requestJson('/api/workspace-history');
  dshWorkHistory = history;
  const entry = [...(history.creation ?? []), ...(history.editing ?? [])]
    .find(candidate => candidate.workId === workId);
  const target = describeDshWorkSessionTarget(entry);
  if (!entry || target?.contextKey !== contextKey) {
    throw new Error('所选 Deck 任务已变化，请重新打开“新会话”菜单选择');
  }
  if (dshWorkItem?.workId === workId) {
    publishDshWorkContext({ refreshHistory:false });
    return;
  }
  if (typeof navigateToWorkspaceTask !== 'function') {
    throw new Error('AICO-PPT 项目导航尚未就绪');
  }
  navigateToWorkspaceTask(entry.kind, entry);
}

function renderDshSessionControl() {
  if (!embeddedDsh || !dshSessionControl) return;
  const deckLabel = dshWorkItem?.deckName
    || dshWorkItem?.deckPath?.split(/[\\/]+/).filter(Boolean).at(-1)
    || dshWorkItem?.displayName
    || '';
  if (currentProjectContext && currentProjectName) {
    currentProjectContext.hidden = !deckLabel;
    currentProjectContext.title = dshWorkItem?.deckPath ? `当前 Deck：${dshWorkItem.deckPath}` : '';
    currentProjectName.textContent = deckLabel;
  }
  publishDshWorkContext();
  const renderVersion = ++dshSessionRenderVersion;
  dshSessionControl.hidden = false;
  const links = dshWorkItem?.dshBinding?.sessions?.filter(link => (
    link.state === 'available'
    && link.workspaceId === dshWorkItem.dshBinding.workspaceId
  )) ?? [];
  const render = (rows = []) => {
    if (renderVersion !== dshSessionRenderVersion) return;
    const rowById = new Map(rows.filter(Boolean).map(row => [row.sessionId, row]));
    const archivedIds = new Set(rows.filter(row => row?.archived === true)
      .map(row => row.sessionId));
    const visibleLinks = links.filter(link => !archivedIds.has(link.sessionId));
    if (archivedIds.size > 0 && dshTaskCoordinator && dshWorkItem) {
      void dshTaskCoordinator.reconcileArchivedSessions({
        workItem:dshWorkItem,
        sessionIds:[...archivedIds],
      }).then(result => {
        if (renderVersion !== dshSessionRenderVersion) return;
        dshWorkItem = result.workItem;
        renderDshSessionControl();
      }).catch(error => {
        console.warn('无法持久化修改任务的 DSH 会话归档状态。', error);
      });
    }
    dshSessionSelect.replaceChildren();
    if (visibleLinks.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '尚未创建任务会话';
      dshSessionSelect.append(option);
      dshSessionSelect.disabled = true;
      dshSessionControl.dataset.state = 'missing';
      dshSessionControl.title = '请从左侧“新会话”创建此 Deck 的任务会话';
      return;
    }
    for (const link of visibleLinks) {
      const row = rowById.get(link.sessionId);
      const describedTitle = typeof row?.title === 'string'
        && row.title
        && row.title !== link.sessionId
        ? row.title
        : null;
      const option = document.createElement('option');
      option.value = link.sessionId;
      option.textContent = describedTitle || dshTaskCoordinator.sessionTitle({
        workItem:dshWorkItem,
        sessionId:link.sessionId,
      });
      dshSessionSelect.append(option);
    }
    dshSessionSelect.disabled = dshSessionBusy;
    const activeSessionId = visibleLinks.some(link => (
      link.sessionId === dshWorkItem.dshBinding.activeSessionId
    )) ? dshWorkItem.dshBinding.activeSessionId : null;
    dshSessionSelect.value = activeSessionId ?? visibleLinks[0].sessionId;
    const matchesCurrent = dshCurrentSession?.sessionId === activeSessionId;
    dshSessionControl.dataset.state = matchesCurrent ? 'active' : 'detached';
    dshSessionControl.title = matchesCurrent
      ? '当前 DSH 会话已关联此 Deck'
      : '当前 DSH 会话未关联此 Deck；提交任务时会切回活动任务会话';
  };
  render();
  if (dshWorkBridge && links.length) {
    void dshWorkBridge.request('describe-sessions', {
      sessionIds:links.map(link => link.sessionId),
    }).then(render).catch(() => {});
  }
}

async function activateDshWorkItem(workItem, sessionId = workItem?.dshBinding?.activeSessionId) {
  if (!dshTaskCoordinator || !workItem || !sessionId) return workItem;
  let result;
  if (dshCurrentSession?.sessionId === sessionId) {
    if (workItem.dshBinding.activeSessionId === sessionId) {
      result = { workItem };
    } else {
      result = await dshCatalogCommand('activate-session', {
        sessionId,
        expectedBindingRevision:workItem.dshBinding.revision,
      });
    }
  } else {
    result = await dshTaskCoordinator.activate({ workItem, sessionId });
  }
  if (dshWorkItem?.workId === result.workItem.workId) {
    dshWorkItem = result.workItem;
    await renderDshSessionControl();
  }
  return result.workItem;
}

async function initializeDshWorkItem() {
  if (!embeddedDsh || !dshParentOrigin || !dshWorkItemCoordinatorEnabled) return;
  dshWorkBridge = createDshWorkBridge({ targetOrigin:dshParentOrigin });
  dshTaskCoordinator = createDeckTaskCoordinator({
    bridge:dshWorkBridge,
    catalogCommand:dshCatalogCommand,
  });
  dshSessionControl.hidden = false;
  let loaded;
  try {
    loaded = await requestJson('/api/dsh-work-item');
  } catch (error) {
    // `embedded=dsh` 也被独立的跨源容器/测试用于纯 UI 嵌入。只有由 DSH
    // 工作台启动且服务端显式启用 bridge 时，才要求存在工作项协调后端。
    if (error.code !== 'DSH_AGENT_BRIDGE_UNAVAILABLE') throw error;
    dshSessionControl.hidden = true;
    dshWorkBridge.close();
    dshWorkBridge = null;
    dshTaskCoordinator = null;
    return;
  }
  dshWorkItem = loaded.workItem;
  dshWorkBridge.registerWorkSessionCreator(createCurrentDshWorkSession);
  dshWorkBridge.registerWorkSessionTargetNavigator(navigateToDshWorkSessionTarget);
  unsubscribeDshSession = dshWorkBridge.subscribeCurrentSession(session => {
    dshCurrentSession = session;
    void renderDshSessionControl();
    if (!session?.sessionId || dshSessionBusy) return;
    dshSessionBusy = true;
    void dshTaskCoordinator.resolveBySession(session.sessionId).then(async result => {
      const linked = result?.workItem ?? null;
      if (!linked) return;
      if (linked.workId !== dshWorkItem?.workId) {
        navigateToWorkspaceTask?.(linked.kind, linked);
        return;
      }
      if (dshWorkItem.dshBinding.activeSessionId !== session.sessionId) {
        const activated = await dshCatalogCommand('activate-session', {
          sessionId:session.sessionId,
          expectedBindingRevision:dshWorkItem.dshBinding.revision,
        });
        dshWorkItem = activated.workItem;
      }
    }).catch(error => {
      showHistoryNotice(`DSH 会话同步失败：${error.message}`, 'error');
    }).finally(() => {
      dshSessionBusy = false;
      void renderDshSessionControl();
    });
  });
  renderDshSessionControl();
}

dshSessionSelect?.addEventListener('change', async () => {
  if (!dshWorkItem || !dshSessionSelect.value || dshSessionBusy) return;
  dshSessionBusy = true;
  try {
    dshWorkItem = await activateDshWorkItem(dshWorkItem, dshSessionSelect.value);
    showHistoryNotice('已切换此 Deck 的活动任务会话', 'success');
  } catch (error) {
    showHistoryNotice(`无法切换任务会话：${error.message}`, 'error');
  } finally {
    dshSessionBusy = false;
    void renderDshSessionControl();
  }
});

async function createCurrentDshWorkSession({ workId, contextKey } = {}) {
  if (!dshWorkItem || !dshTaskCoordinator) throw new Error('当前 Deck 任务尚未就绪');
  const currentKey = `${dshWorkItem.workId}:${dshWorkItem.dshBinding?.revision ?? dshWorkItem.revision}`;
  if (workId !== dshWorkItem.workId || contextKey !== currentKey) {
    throw new Error('当前 Deck 已切换，请从左侧“新会话”重新选择');
  }
  if (dshSessionBusy) throw new Error('任务会话正在处理中，请稍候');
  dshSessionBusy = true;
  showHistoryNotice('正在为此 Deck 创建独立 DSH 会话…', 'working');
  try {
    const result = await dshTaskCoordinator.createSession({ workItem:dshWorkItem });
    dshWorkItem = result.workItem;
    await dshTaskCoordinator.send(dshWorkItem.dshBinding.activeSessionId, [
      '/aico-ppt', '',
      '这是用户从 AICO-PPT Editor 明确创建的独立任务会话。',
      `Work Item：${dshWorkItem.workId}`,
      `Deck：${dshWorkItem.deckPath}`,
      `项目目录：${dshWorkItem.projectRoot}`,
      '后续只处理右侧 Editor 中这份 Deck 的需求。当前工作区连接由 Host 按会话关联动态提供；用户可直接用自然语言讨论或要求修改，无需先提交区域任务。',
    ].join('\n'));
    showHistoryNotice('新的 DSH 任务会话已创建并设为活动会话', 'success');
    return {
      workId:dshWorkItem.workId,
      sessionId:dshWorkItem.dshBinding.activeSessionId,
    };
  } catch (error) {
    showHistoryNotice(`创建任务会话失败：${error.message}`, 'error');
    throw error;
  } finally {
    dshSessionBusy = false;
    void renderDshSessionControl();
  }
}

function renderPptxExport(state) {
  const labels = { preparing:'准备导出…', choosing:'选择保存位置…',
    exporting:'正在生成 PPTX…', saving:'正在保存…', completed:'PPTX 已保存',
    failed:'导出失败，可重试', cancelled:'已取消导出' };
  pptxExportBusy = ['preparing', 'choosing', 'exporting', 'saving'].includes(state.status);
  exportPptxButton.disabled = pptxExportBusy;
  exportPptxButton.dataset.exportState = pptxExportBusy ? 'busy' : state.status;
  pptxExportControl.dataset.exportState = exportPptxButton.dataset.exportState;
  exportPptxButton.setAttribute('aria-busy', String(pptxExportBusy));
  const label = pptxExportBusy ? labels[state.status] : '导出为 PPTX';
  exportPptxButton.setAttribute('aria-label', label);
  exportPptxButton.title = label;
  exportPptxButton.dataset.toolbarTooltip = label;
  pptxExportStatus.textContent = labels[state.status] ?? '';
  pptxExportStatus.hidden = state.status === 'idle';
  pptxExportStatus.title = state.path ?? state.message ?? '';
  const announcement = `${state.id}:${state.status}`;
  if (announcement !== pptxExportAnnouncement) {
    pptxExportAnnouncement = announcement;
    if (state.status === 'completed') showHistoryNotice(`PPTX 已保存：${state.path}`, 'success');
    if (state.status === 'failed') showHistoryNotice(`PPTX 导出失败：${state.message}`, 'error');
  }
}

const pptxExportEndpoint = `/api/export/pptx/job?editorToken=${encodeURIComponent(editorToken)}`;
async function refreshPptxExport() {
  if (pptxExportStarting) return;
  clearTimeout(pptxExportTimer);
  const request = ++pptxExportRequest;
  try {
    const state = await requestJson(pptxExportEndpoint);
    if (tornDown || request !== pptxExportRequest) return;
    renderPptxExport(state);
    if (!pptxExportBusy) return;
  } catch {
    // 页面恢复或网络重连时继续查询原任务，不重发导出请求。
    if (tornDown || request !== pptxExportRequest) return;
    pptxExportStatus.hidden = false;
    pptxExportStatus.textContent = '正在恢复导出状态…';
  }
  pptxExportTimer = setTimeout(() => void refreshPptxExport(), 1000);
}

function openPptxExportDialog() {
  if (pptxExportBusy) return;
  const recommended = pptxExportDialog.querySelector('[value="editable"]');
  recommended.checked = true;
  pptxExportModal.show(recommended);
}

function closePptxExportDialog() {
  pptxExportModal.close();
}

async function onExportPptx() {
  if (pptxExportBusy) return;
  const mode = pptxExportDialog.querySelector('[name="pptx-export-mode"]:checked').value;
  closePptxExportDialog();
  clearTimeout(pptxExportTimer);
  const request = ++pptxExportRequest;
  pptxExportStarting = true;
  renderPptxExport({ status:'preparing' });
  try {
    const state = await requestJson(pptxExportEndpoint, {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:revision, mode }),
    });
    if (!tornDown && request === pptxExportRequest) renderPptxExport(state);
  } catch (error) {
    const message = error.code === 'REVISION_CONFLICT'
      ? '编辑内容刚刚更新，请再次点击导出'
      : error.code === 'PPTX_EXPORT_BUSY'
        ? '已有一个 PPTX 正在导出，请稍候'
        : error.message;
    if (!tornDown) showHistoryNotice(`PPTX 导出未启动：${message}`, 'error');
  } finally {
    pptxExportStarting = false;
    if (!tornDown && request === pptxExportRequest) void refreshPptxExport();
  }
}

function enterCanvasPresentation() {
  setEditorMode('preview');
  try {
    const previewDocument = deckFrame.contentDocument;
    const presentButton = previewDocument?.querySelector('[data-mode="present"]');
    if (!previewDocument || !presentButton) {
      throw new Error('当前 Deck 没有可用的放映入口');
    }
    if (previewDocument.fullscreenEnabled !== true) {
      throw new Error('浏览器没有向 Deck 授予全屏权限');
    }
    const onFullscreenError = () => {
      showHistoryNotice('无法全屏播放：浏览器拒绝了全屏请求', 'error');
    };
    previewDocument.addEventListener('fullscreenerror', onFullscreenError, { once:true });
    setTimeout(() => previewDocument.removeEventListener('fullscreenerror', onFullscreenError), 1_000);
    presentButton.click();
  } catch (error) {
    showHistoryNotice(`无法全屏播放：${error.message || '浏览器拒绝了全屏请求'}`, 'error');
  }
}

function uniqueTasks(values) {
  const byId = new Map();
  for (const task of values) {
    if (task?.id) byId.set(task.id, task);
  }
  return [...byId.values()].sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
}

function updateRevision(value) {
  if (Number.isSafeInteger(value)) revision = Math.max(revision, value);
  revisionValue.textContent = String(revision);
}

function adoptAgentRun(nextRun) {
  if (!nextRun?.status) return false;
  if (agentRun.id && !nextRun.id) {
    // 后端重启后，进程内的 active run 会消失，但已经捕获的不可变批次仍会从
    // SessionStore 恢复。只要服务端快照携带批次且 revision 不倒退，就应接受
    // 这个 idle/residual 权威状态，不能让浏览器永远停留在旧的“正在处理”。
    const currentRevision = Number(agentRun.sessionRevision ?? 0);
    const nextRevision = Number(nextRun.sessionRevision ?? 0);
    if (!Array.isArray(nextRun.batches) || nextRevision < currentRevision) return false;
  }
  if (nextRun.id && agentRun.id && nextRun.id !== agentRun.id
    && Number(nextRun.generation ?? 0) <= Number(agentRun.generation ?? 0)) {
    return false;
  }
  if (nextRun.id && nextRun.id === agentRun.id
    && Number(nextRun.sequence ?? 0) < Number(agentRun.sequence ?? 0)) {
    return false;
  }
  agentRun = nextRun;
  return true;
}

function agentSubmissionGate(state = agentTerminalState) {
  if (state.interactionRequired?.kind) {
    return {
      key:'interaction', blocked:true,
      message:state.interactionRequired.message || '请先完成 Agent 终端中的确认。',
    };
  }
  if (state.resumePending === true) {
    return {
      key:'resuming', blocked:true,
      message:'正在恢复 Codex 会话，等待 Codex 输入界面后才能提交任务。',
    };
  }
  if (state.initialInputPending === true
    || ['pending', 'submitting', 'awaiting-confirmation'].includes(state.startupPromptState)) {
    return {
      key:'initializing', blocked:true,
      message:'Agent 终端正在启动，等待输入界面后才能提交任务。',
    };
  }
  if (['active', 'submitting'].includes(state.turnState)) {
    return {
      key:'busy', blocked:true,
      message:'Agent 当前回合仍在处理；输入框可能只是 steer 输入框，等待真正空闲后再提交下一批。',
    };
  }
  return { key:'ready', blocked:false, message:'' };
}

function renderAgentStatus() {
  const runtime = agentTerminalState;
  const workspaceProvider = runtime.provider ?? 'codex';
  const workspaceProviderName = {
    codex:'Codex', 'claude-code':'Claude Code', dsh:'DSH Agent',
  }[workspaceProvider] ?? workspaceProvider;
  const interactionRequired = runtime.interactionRequired?.kind
    ? runtime.interactionRequired
    : null;
  const startupLocked = ['pending', 'submitting'].includes(runtime.startupPromptState);
  const promptReady = runtime.promptReady !== false && runtime.turnState !== 'active';
  const initializing = runtime.state === 'starting'
    || (runtime.state === 'running' && !promptReady)
    || startupLocked;
  const busy = !interactionRequired && (initializing
    || ['queued', 'running'].includes(agentRun.status));
  const ready = runtime.state === 'running' && promptReady
    && (runtime.turnState === undefined || runtime.turnState === 'idle')
    && !startupLocked && !interactionRequired;
  const failed = ['failed', 'exited'].includes(runtime.state);
  agentStatus.dataset.agentStatus = interactionRequired
    ? 'attention'
    : (busy ? 'busy' : (ready ? 'online' : 'standby'));
  let label = `${workspaceProviderName} 未启动`;
  if (interactionRequired) label = `${workspaceProviderName} 等待确认`;
  else if (agentRun.status === 'queued') label = `${workspaceProviderName} 正在提交`;
  else if (initializing) label = `${workspaceProviderName} 准备中`;
  else if (busy) label = `${workspaceProviderName} 处理中`;
  else if (ready) label = `${workspaceProviderName} 空闲`;
  else if (failed) label = `${workspaceProviderName} 启动失败`;
  for (const agentLabel of agentLabels) agentLabel.textContent = label;
  const detail = embeddedDsh
    ? '任务由左侧 DSH 原生会话处理'
    : (interactionRequired?.message ?? (ready
      ? `打开 ${workspaceProviderName} 交互终端`
      : `打开 ${workspaceProviderName} 终端并启动 bypass 会话`));
  const tooltip = embeddedDsh ? `${label} · ${detail}` : detail;
  agentStatus.title = tooltip;
  agentStatus.dataset.toolbarTooltip = tooltip;
  agentStatus.setAttribute('aria-label', tooltip);
  agentStatus.setAttribute('aria-expanded', String(agentTerminalOpen));
}

function renderAgentTerminal() {
  if (!ownsAgentTerminal) {
    agentTerminalOpen = false;
    editorShell.dataset.agentTerminalOpen = 'false';
    agentTerminalRoot.hidden = true;
    renderInspectorLayout();
    return;
  }
  editorShell.dataset.agentTerminalOpen = String(agentTerminalOpen);
  renderInspectorLayout();
  if (agentTerminalOpen) agentTerminal?.open(agentTerminalState.provider);
  else agentTerminal?.hide();
}

function openAgentTerminal() {
  agentTerminalOpen = !agentTerminalOpen;
  renderAgentTerminal();
  renderAgentStatus();
}

function ensureAgentTerminalOpen() {
  if (!ownsAgentTerminal) return false;
  if (agentTerminalOpen) return false;
  agentTerminalOpen = true;
  renderAgentTerminal();
  renderAgentStatus();
  return true;
}

function adoptAgentTerminalState(state) {
  if (!state?.provider || !state?.state) return false;
  const previousGate = agentSubmissionGate(agentTerminalState);
  agentTerminalState = state;
  if (state.interactionRequired?.kind) ensureAgentTerminalOpen();
  const nextGate = agentSubmissionGate(state);
  if (previousGate.key !== nextGate.key) renderTasks();
  else renderAgentStatus();
  return true;
}

function compiledSessionActions() {
  return compileActionGroups(sessionGroups);
}

const INSPECTOR_KIND_LABELS = Object.freeze({
  text:'文字', shape:'图形', svg:'SVG', image:'图片',
});

function sameInspectorTarget(left, right) {
  return Boolean(left && right)
    && left.pageKey === right.pageKey
    && left.path === right.path
    && String(left.tag ?? '') === String(right.tag ?? '');
}

function sameInspectorScope(action, selection) {
  const actionRange = action.payload?.textRange;
  const selectionRange = selection.textRange;
  if (selectionRange) {
    return actionRange?.start === selectionRange.start && actionRange?.end === selectionRange.end;
  }
  const textStyleRange = selection.textStyleRange;
  if (textStyleRange && actionRange) {
    return actionRange.start >= textStyleRange.start && actionRange.end <= textStyleRange.end;
  }
  return actionRange === undefined;
}

function enrichInspectorSelection(selection) {
  if (!selection?.target || !selection.computed || !selection.inline) return selection;
  const resetValues = { ...selection.inline };
  const historyBaselines = new Set();
  for (const group of sessionGroups) {
    for (const action of group.actions ?? []) {
      if (action.kind !== 'setStyle' || !sameInspectorTarget(action.target, selection.target)
        || !sameInspectorScope(action, selection)) continue;
      const property = action.payload?.property;
      if (typeof property === 'string' && typeof action.before === 'string'
        && !historyBaselines.has(property)) {
        resetValues[property] = action.before;
        historyBaselines.add(property);
      }
    }
  }
  const modifiedProperties = compiledSessionActions()
    .filter(action => action.kind === 'setStyle'
      && sameInspectorTarget(action.target, selection.target)
      && sameInspectorScope(action, selection)
      && action.payload?.value !== resetValues[action.payload?.property])
    .map(action => action.payload.property);
  return { ...selection, resetValues, modifiedProperties:[...new Set(modifiedProperties)] };
}

function applyInspectorChanges(changes, { coalesceKey = '', scope = 'selection' } = {}) {
  if (!inspectorSelection || inspectorBusy || !Array.isArray(changes) || changes.length === 0) return;
  const requestId = crypto.randomUUID();
  pendingInspectorRequest = { requestId, selectionId:inspectorSelection.selectionId };
  inspectorBusy = true;
  inspectorNotice = '正在保存样式…';
  renderInspector();
  deckFrame.contentWindow?.postMessage({
    type:'apply-inspector-styles', requestId,
    selectionId:inspectorSelection.selectionId, changes,
    ...(scope === 'element' ? { scope:'element' } : {}),
    ...(coalesceKey ? { coalesceKey:`${inspectorSelection.selectionId}:${coalesceKey}` } : {}),
  }, location.origin);
}

function resetAllInspectorStyles() {
  if (!inspectorSelection) return;
  const changes = inspectorSelection.modifiedProperties.map(property => ({
    property, value:inspectorSelection.resetValues?.[property] ?? '',
  }));
  applyInspectorChanges(changes);
}

function renderInspector() {
  inspectorSelection = enrichInspectorSelection(inspectorSelection);
  selectionState.textContent = inspectorSelection?.scope === 'text-range'
    ? '选中文字'
    : (inspectorSelection
      ? (INSPECTOR_KIND_LABELS[inspectorSelection.kind] ?? '已选中') : '未选中');
  selectionState.dataset.selected = String(Boolean(inspectorSelection));
  renderInspectorPanel(inspectorContent, {
    selection:inspectorSelection,
    busy:inspectorBusy,
    notice:inspectorNotice,
    onApply:applyInspectorChanges,
    onResetAll:resetAllInspectorStyles,
  });
}

function renderInspectorLayout() {
  const editMode = editorMode === 'edit';
  const expanded = editMode && inspectorExpanded;
  const dock = embeddedDsh || agentTerminalOpen ? 'top' : 'right';
  const state = !editMode ? 'hidden' : (expanded ? 'expanded' : 'collapsed');
  editorShell.dataset.inspectorDock = dock;
  editorShell.dataset.inspectorState = state;
  inspectorContent.querySelector(':scope > .inspector-body')?.dispatchEvent(new CustomEvent(
    'inspector-dock-change', { detail:{ dock } },
  ));
  inspectorPanel.hidden = !expanded;
  inspectorReopenButton.hidden = state !== 'collapsed';

  const collapseDirection = dock === 'top' ? 'up' : 'right';
  const reopenDirection = dock === 'top' ? 'down' : 'left';
  inspectorCollapseButton.dataset.pillArrowDirection = collapseDirection;
  inspectorReopenButton.dataset.pillArrowDirection = reopenDirection;
  inspectorCollapseButton.setAttribute('aria-label', `向${dock === 'top' ? '上' : '右'}收起属性面板`);
  inspectorCollapseButton.title = inspectorCollapseButton.getAttribute('aria-label');
  inspectorReopenButton.setAttribute('aria-label', `展开${dock === 'top' ? '顶部' : '右侧'}属性面板`);
  inspectorReopenButton.title = inspectorReopenButton.getAttribute('aria-label');
}

function setInspectorExpanded(expanded) {
  if (editorMode !== 'edit') return;
  inspectorExpanded = expanded === true;
  renderInspectorLayout();
}

function syncSessionActions() {
  if (!deckReady) return;
  const actions = compiledSessionActions();
  deckFrame.contentWindow?.postMessage({
    type:'sync-actions', actions,
    rebaseActionIds:sourceRebaseActionIds(sessionGroups, actions),
  }, location.origin);
}

function announceDeckReady() {
  if (!deckReadyPayload) return false;
  return eventsClient?.send({ ...deckReadyPayload, revision }) ?? false;
}

function snapshotByteLength(snapshot) {
  if (typeof snapshot !== 'string') return 0;
  const match = snapshot.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) return 0;
  const padding = match[1].endsWith('==') ? 2 : (match[1].endsWith('=') ? 1 : 0);
  return Math.floor(match[1].length * 3 / 4) - padding;
}

function dataUrlToBlob(snapshot) {
  if (snapshot === null) return null;
  if (typeof snapshot !== 'string') throw new TypeError('区域快照格式无效');
  const match = snapshot.match(/^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/);
  if (!match) throw new TypeError('区域快照格式无效');
  const binary = atob(match[1]);
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return new Blob([bytes], { type:'image/png' });
}

function taskFormData(payload, snapshot, attachments, expectedRevision) {
  const form = new FormData();
  form.append('task', new Blob([JSON.stringify({
    ...payload,
    expectedRevision,
    attachmentSources:attachments.map(item => item.source),
  })], { type:'application/json' }), 'task.json');
  if (snapshot !== null) form.append('snapshot', dataUrlToBlob(snapshot), 'region.png');
  for (const item of attachments) form.append('attachment', item.file, item.file.name);
  return form;
}

function updatePageBadges() {
  const counts = new Map();
  for (const task of tasks) {
    if (task.targetMissing === true) continue;
    if (!['pending', 'processing', 'failed', 'needs-confirmation'].includes(task.status)) continue;
    counts.set(task.pageKey, (counts.get(task.pageKey) ?? 0) + 1);
  }
  for (const button of pageList.querySelectorAll('[data-page-key]')) {
    button.querySelector('[data-page-badge]')?.remove();
    const count = counts.get(button.dataset.pageKey) ?? 0;
    if (!count) continue;
    const badge = document.createElement('span');
    badge.className = 'page-badge';
    badge.dataset.pageBadge = '';
    badge.textContent = String(count);
    badge.setAttribute('aria-label', `${count} 条任务`);
    button.append(badge);
  }
}

async function processAllTasks(selectedTasks) {
  if (!embeddedDsh) ensureAgentTerminalOpen();
  try {
    if (embeddedDsh) {
      if (!dshWorkItem?.dshBinding?.activeSessionId) {
        throw Object.assign(new Error('请先点击顶部“＋”为此 Deck 创建任务会话'), {
          code:'DSH_SESSION_REQUIRED',
        });
      }
      dshWorkItem = await activateDshWorkItem(dshWorkItem);
    }
    const startedRun = await requestJson('/api/agent-runs', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:revision,
        taskIds:selectedTasks.map(task => task.id),
      }),
    });
    updateRevision(startedRun.sessionRevision);
    adoptAgentRun(startedRun);
    renderTasks();
    return agentRun.message;
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') {
      updateRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      showTaskNotice('任务列表已经变化，请检查后再次点击“交给 Agent”');
      return '';
    }
    if (error.code === 'AGENT_RUN_ACTIVE') {
      adoptAgentRun(await requestJson('/api/agent-runs/current').catch(() => agentRun));
      renderTasks();
      return '';
    }
    throw new Error(`无法交给 Agent：${error.message}`);
  }
}

function locateTask(task) {
  if (task?.targetMissing === true) {
    showTaskNotice('这个任务的原目标当前不可定位；请撤销相关结构修改或删除任务后重新标记。');
    return;
  }
  pendingPageKey = task.pageKey;
  deckFrame.contentWindow?.postMessage({
    type: 'locate-task',
    pageKey: task.pageKey,
    rect: task.rect,
    pageState: task.pageState,
  }, location.origin);
}

function showTaskNotice(message) {
  taskDrawer.dataset.open = 'true';
  const note = taskDrawer.querySelector('[data-process-note]');
  if (note) note.textContent = message;
}

function showHistoryNotice(message, state = 'warning') {
  clearTimeout(historyNoticeTimer);
  let notice = document.querySelector('[data-history-notice]');
  if (!notice) {
    notice = document.createElement('div');
    notice.className = 'history-notice';
    notice.dataset.historyNotice = '';
    notice.setAttribute('role', 'status');
    document.body.append(notice);
  }
  notice.dataset.state = state;
  notice.textContent = message;
  notice.hidden = false;
  historyNoticeTimer = setTimeout(() => { notice.hidden = true; }, state === 'error' ? 5200 : 3200);
}

function hideSolidifyReminder() {
  solidifyReminder.hidden = true;
}

function renderSolidifyReminder(unsolidifiedCount, { controlsBusy, bindingBlocked }) {
  solidifyReminderCount.textContent = String(unsolidifiedCount);
  solidifyReminderAction.disabled = controlsBusy || bindingBlocked;
  if (unsolidifiedCount <= SOLIDIFY_REMINDER_THRESHOLD) {
    solidifyReminderShownForCycle = false;
    hideSolidifyReminder();
    return;
  }
  if (!solidifyReminderShownForCycle && !controlsBusy && !bindingBlocked) {
    solidifyReminderShownForCycle = true;
    solidifyReminder.hidden = false;
  }
}

function renderHistory() {
  const { undoGroup, redoGroup } = historyCandidates(sessionGroups, sessionRedo);
  const unsolidifiedCount = sessionGroups.length;
  const refreshPending = loadedSessionRevision < historyRefreshTargetRevision
    || historySnapshotFulfilled < historySnapshotRequirement;
  const controlsBusy = historyBusy || solidifyBusy || refreshPending;
  for (const button of taskDrawer.querySelectorAll('[data-history-method]')) {
    button.disabled = controlsBusy || button.dataset.taskHistoryLocked === 'true';
    button.setAttribute('aria-busy', String(controlsBusy));
  }
  historyControls.dataset.busy = String(controlsBusy);
  historyControls.setAttribute('aria-busy', String(controlsBusy));
  undoButton.disabled = controlsBusy || !undoGroup;
  redoButton.disabled = controlsBusy || !redoGroup;
  undoButton.title = `${historyLabel(undoGroup, tasks, 'undo')} · Cmd/Ctrl+Z`;
  redoButton.title = `${historyLabel(redoGroup, tasks, 'redo')} · Cmd/Ctrl+Shift+Z`;
  undoButton.dataset.toolbarTooltip = undoButton.title;
  redoButton.dataset.toolbarTooltip = redoButton.title;
  undoButton.setAttribute('aria-label', undoButton.title);
  redoButton.setAttribute('aria-label', redoButton.title);
  undoButton.dataset.groupId = controlsBusy ? '' : (undoGroup?.id ?? '');
  redoButton.dataset.groupId = controlsBusy ? '' : (redoGroup?.id ?? '');
  solidifyButton.dataset.busy = String(solidifyBusy);
  solidifyButton.dataset.unsolidified = String(unsolidifiedCount > 0);
  const bindingBlocked = deckBinding.state !== 'bound';
  solidifyButton.disabled = controlsBusy || bindingBlocked || unsolidifiedCount === 0;
  solidifyButton.title = bindingBlocked
    ? '源文件需要重新绑定，工作副本仍会继续保存'
    : unsolidifiedCount > 0
      ? `固化 ${unsolidifiedCount} 组修改并清空撤销记录`
      : '当前没有可固化的修改';
  solidifyButton.dataset.toolbarTooltip = solidifyButton.title;
  solidifyCount.textContent = `将固化 ${unsolidifiedCount} 组修改`;
  renderSolidifyReminder(unsolidifiedCount, { controlsBusy, bindingBlocked });
  if (solidifyDialog.open) renderSolidifyDialogContent(solidifyDialogReason);
}

function renderDeckBinding(next, { announce = false } = {}) {
  if (!next || !Number.isSafeInteger(next.revision)) return;
  if (next.revision < deckBinding.revision) return;
  const previous = deckBinding;
  deckBinding = next;
  editorShell.dataset.deckBindingState = next.state;
  const blocked = !embeddedCreation && next.state !== 'bound';
  deckBindingBanner.hidden = !blocked;
  if (blocked) {
    const replaced = next.reason === 'replaced';
    deckBindingTitle.textContent = replaced
      ? '原路径现在是另一份文件，已停止固化'
      : '源文件位置已变化，需要重新绑定';
    deckBindingDetail.textContent = replaced
      ? 'Editor 不会覆盖这份新文件；当前修改仍安全保存在工作副本中。'
      : '编辑内容仍会安全保存在工作副本中，重新绑定前无法固化。';
  } else if (announce && next.reason === 'renamed'
    && previous.currentPath !== next.currentPath) {
    showHistoryNotice(
      `已检测到文件改名，已更新为「${next.currentPath.split(/[\\/]/).at(-1)}」`,
      'success',
    );
  }
  deckBindingRecheck.disabled = deckBindingBusy;
  deckBindingChoose.disabled = deckBindingBusy;
  renderHistory();
}

async function reconcileDeckBinding() {
  if (deckBindingBusy) return;
  deckBindingBusy = true;
  deckBindingRecheck.disabled = true;
  deckBindingChoose.disabled = true;
  try {
    renderDeckBinding(await requestJson('/api/deck-binding/reconcile', {
      method:'POST', headers:{ 'content-type':'application/json' }, body:'{}',
    }), { announce:true });
  } catch (error) {
    showHistoryNotice(`重新检查失败：${error.message}`, 'error');
  } finally {
    deckBindingBusy = false;
    deckBindingRecheck.disabled = false;
    deckBindingChoose.disabled = false;
  }
}

async function chooseDeckBinding() {
  if (deckBindingBusy) return;
  deckBindingBusy = true;
  deckBindingRecheck.disabled = true;
  deckBindingChoose.disabled = true;
  try {
    let result;
    try {
      result = await requestJson('/api/deck-binding/choose-file', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({ expectedBindingRevision:deckBinding.revision }),
      });
    } catch (error) {
      if (error.code !== 'DECK_BINDING_VERIFIED_COPY_CONFIRMATION_REQUIRED'
        || typeof error.candidate !== 'string') throw error;
      if (error.binding) renderDeckBinding(error.binding);
      const confirmed = window.confirm(
        '所选文件不是原来的物理文件，但内容与最后源版本完全一致。确认把这个内容一致的副本作为当前 Deck 源文件吗？',
      );
      if (!confirmed) {
        showHistoryNotice('已取消绑定内容一致的副本', 'working');
        return;
      }
      result = await requestJson('/api/deck-binding/choose-file', {
        method:'POST',
        headers:{ 'content-type':'application/json' },
        body:JSON.stringify({
          expectedBindingRevision:deckBinding.revision,
          confirmation:'verified-copy',
          candidatePath:error.candidate,
        }),
      });
    }
    renderDeckBinding(result.binding, { announce:result.status === 'rebound' });
    if (result.status === 'rebound') {
      showHistoryNotice('源文件已重新绑定，可以继续固化', 'success');
    }
  } catch (error) {
    if (error.binding) renderDeckBinding(error.binding);
    showHistoryNotice(`重新绑定失败：${error.message}`, 'error');
  } finally {
    deckBindingBusy = false;
    deckBindingRecheck.disabled = false;
    deckBindingChoose.disabled = false;
  }
}

deckBindingRecheck.addEventListener('click', reconcileDeckBinding);
deckBindingChoose.addEventListener('click', chooseDeckBinding);

function hasUnsolidifiedChanges() {
  return sessionGroups.length > 0 || sessionRedo.length > 0;
}

function taskTimestamp(task) {
  for (const value of [task?.updatedAt, task?.createdAt]) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }
  return Number.NEGATIVE_INFINITY;
}

function unsolidifiedDialogState() {
  const activeGroups = sessionGroups.filter(group => group?.active === true);
  const taskById = new Map(tasks.map(task => [task?.id, task]));
  const sectionsByKey = new Map();
  activeGroups.forEach((group, groupIndex) => {
    const taskId = typeof group?.taskId === 'string' ? group.taskId : null;
    const task = taskId ? taskById.get(taskId) ?? null : null;
    const key = taskId ? `task:${taskId}` : 'direct';
    let section = sectionsByKey.get(key);
    if (!section) {
      section = { key, taskId, task, groups:[], latestIndex:groupIndex };
      sectionsByKey.set(key, section);
    }
    section.groups.push(group);
    section.latestIndex = groupIndex;
  });
  const taskSections = [...sectionsByKey.values()].sort((left, right) => (
    taskTimestamp(right.task) - taskTimestamp(left.task)
    || right.latestIndex - left.latestIndex
  ));
  return {
    activeGroupCount:activeGroups.length,
    taskSections,
    linkedTaskCount:taskSections.filter(section => section.taskId).length,
    redoCount:sessionRedo.length,
  };
}

const ACTION_LABELS = {
  setText:'文字修改',
  translate:'位置移动',
  resize:'尺寸调整',
  setStyle:'样式修改',
  hide:'隐藏元素',
  show:'显示元素',
};

function unsolidifiedGroupSummary(group) {
  if (group?.compensation) return '任务撤销补偿';
  if (group?.mutationType === 'source') {
    const detail = typeof group.source?.summary === 'string'
      ? group.source.summary.trim() : '';
    return detail ? `结构修改：${detail}` : '结构修改';
  }
  const counts = new Map();
  for (const action of group?.actions ?? []) {
    const label = ACTION_LABELS[action?.kind] ?? '其他修改';
    counts.set(label, (counts.get(label) ?? 0) + 1);
  }
  const labels = [...counts].map(([label, count]) => count > 1 ? `${label} ${count} 项` : label);
  return labels.join('、') || '一组修改';
}

function renderSolidifyDialogContent(reason = 'toolbar') {
  const {
    activeGroupCount, taskSections, linkedTaskCount, redoCount,
  } = unsolidifiedDialogState();
  const closing = reason === 'exit';
  const hasPendingChanges = activeGroupCount > 0 || redoCount > 0;
  const activeAgent = ['queued', 'running'].includes(agentRun.status);
  solidifyDialog.dataset.reason = closing ? 'exit' : 'toolbar';
  solidifyMark.textContent = closing ? '!' : '✓';
  solidifyEyebrow.textContent = closing ? 'EXIT EDITOR' : 'PERMANENT SAVE';
  solidifyTitle.textContent = closing
    ? linkedTaskCount > 0
      ? `退出前还有 ${linkedTaskCount} 个任务存在未固化修改`
      : hasPendingChanges
        ? '退出前还有修改没有固化'
        : 'Agent 正在处理当前任务'
    : '固化当前修改？';
  solidifyDescription.textContent = closing
    ? hasPendingChanges
      ? `这些修改仍安全保存在工作副本中，但还没有写入原 Deck。${activeAgent ? '退出还会中断当前 Agent 执行。' : ''}`
      : '退出会中断当前 Agent 执行；已经保存的工作副本不会丢失。'
    : '这会把当前修改永久写入这个 Deck，并清空全部撤销和重做记录。固化完成后无法恢复到之前的状态。';
  solidifyCount.textContent = redoCount > 0
    ? `将固化当前生效的 ${activeGroupCount} 组修改，并清空 ${redoCount} 组重做记录`
    : `将固化 ${activeGroupCount} 组修改`;
  solidifyCount.hidden = closing && !hasPendingChanges;

  solidifyTaskList.replaceChildren();
  for (const section of taskSections) {
    const { taskId, task, groups } = section;
    const item = document.createElement('details');
    item.className = 'solidify-task';
    item.dataset.solidifyTask = taskId ?? 'direct';
    const summary = document.createElement('summary');
    summary.className = 'solidify-task-summary-row';
    const taskName = document.createElement('p');
    taskName.className = 'solidify-task-name';
    taskName.textContent = task?.instruction
      ?? (taskId ? `任务 ${taskId.slice(0, 8)}` : '直接编辑与结构调整');
    const chevron = document.createElement('span');
    chevron.className = 'solidify-task-chevron';
    chevron.setAttribute('aria-hidden', 'true');
    summary.append(taskName, chevron);
    item.append(summary);
    item.addEventListener('toggle', () => {
      if (!item.open || item.dataset.detailsLoaded === 'true') return;
      item.dataset.detailsLoaded = 'true';
      const details = document.createElement('div');
      details.className = 'solidify-task-details';
      const meta = document.createElement('div');
      meta.className = 'solidify-task-meta';
      const page = document.createElement('span');
      page.className = 'solidify-task-page';
      page.textContent = task
        ? `${String(task.pageIndex).padStart(2, '0')} · ${task.pageLabel}`
        : taskId ? '任务记录 · 页面信息不可用' : '当前 Deck · 直接编辑';
      const status = document.createElement('span');
      status.className = 'solidify-task-status';
      status.textContent = `${groups.length} 组未固化`;
      meta.append(page, status);
      const changes = document.createElement('ul');
      changes.className = 'solidify-change-list';
      for (const group of groups) {
        const change = document.createElement('li');
        change.className = 'solidify-change-item';
        change.textContent = unsolidifiedGroupSummary(group);
        changes.append(change);
      }
      details.append(meta, changes);
      item.append(details);
    });
    solidifyTaskList.append(item);
  }
  solidifyTaskSummary.hidden = taskSections.length === 0;
  solidifyTaskCount.textContent = linkedTaskCount > 0
    ? `${linkedTaskCount} 个任务 · ${activeGroupCount} 组`
    : `${activeGroupCount} 组直接编辑`;

  const otherChanges = [];
  if (redoCount > 0) otherChanges.push(`${redoCount} 组已撤销历史`);
  solidifyOtherCount.hidden = otherChanges.length === 0;
  solidifyOtherCount.textContent = otherChanges.length > 0
    ? `另有 ${otherChanges.join('、')}尚未固化。`
    : '';

  setPillLabel(solidifyCancel, closing ? '继续编辑' : '取消');
  setPillLabel(solidifyExitWithout, hasPendingChanges ? '暂不固化，退出' : '中断并退出');
  setPillLabel(solidifyConfirm, closing ? '固化并退出' : '永久固化');
  solidifyExitWithout.hidden = !closing;
  solidifyConfirm.hidden = closing && !hasPendingChanges;
  solidifyCancel.disabled = solidifyBusy;
  solidifyExitWithout.disabled = solidifyBusy;
  solidifyConfirm.disabled = solidifyBusy || solidifyButton.disabled;
  solidifyConfirm.title = deckBinding.state !== 'bound'
    ? '源文件需要重新绑定后才能固化'
    : solidifyConfirm.disabled && !solidifyBusy
      ? '正在同步修改历史，请稍后重试'
      : '';
}

function requestWorkspaceExit() {
  if (!terminateEditorProcess || solidifyBusy) return;
  const activeAgent = ['queued', 'running'].includes(agentRun.status);
  if (!hasUnsolidifiedChanges() && !activeAgent) {
    terminateEditorProcess();
    return;
  }
  openSolidifyDialog('exit');
}

function openSolidifyDialog(reason = 'toolbar') {
  const closing = reason === 'exit';
  if ((!closing && solidifyButton.disabled) || solidifyBusy) return;
  hideSolidifyReminder();
  solidifyDialogReason = closing ? 'exit' : 'toolbar';
  renderSolidifyDialogContent(solidifyDialogReason);
  if (solidifyDialog.open) return;
  resetSolidifyProgress();
  solidifyModal.show();
}

function closeSolidifyDialog() {
  if (!solidifyBusy && solidifyDialog.open) solidifyModal.close();
}

function exitWorkspaceWithoutSolidifying() {
  if (solidifyBusy || !terminateEditorProcess) return;
  closeSolidifyDialog();
  terminateEditorProcess();
}

function resetSolidifyProgress() {
  solidifyProgress.hidden = true;
  solidifyProgress.dataset.state = 'idle';
  solidifyProgress.style.removeProperty('--solidify-progress');
  solidifyProgressLabel.textContent = '准备固化…';
  solidifyProgressValue.textContent = '';
  solidifyProgressBar.removeAttribute('aria-valuenow');
  solidifyProgressBar.setAttribute('aria-valuetext', '准备固化');
}

function setSolidifyProgress({ state, label, value }) {
  solidifyProgress.hidden = false;
  solidifyProgress.dataset.state = state;
  solidifyProgressLabel.textContent = label;
  if (Number.isFinite(value)) {
    const boundedValue = Math.max(0, Math.min(100, Math.round(value)));
    solidifyProgress.style.setProperty('--solidify-progress', `${boundedValue}%`);
    solidifyProgressValue.textContent = `${boundedValue}%`;
    solidifyProgressBar.setAttribute('aria-valuenow', String(boundedValue));
  } else {
    solidifyProgress.style.removeProperty('--solidify-progress');
    solidifyProgressValue.textContent = '';
    solidifyProgressBar.removeAttribute('aria-valuenow');
  }
  solidifyProgressBar.setAttribute('aria-valuetext', label);
}

function reloadSolidifiedDeck(targetRevision) {
  if (!Number.isSafeInteger(targetRevision) || targetRevision <= lastSolidifiedReloadRevision) return;
  lastSolidifiedReloadRevision = targetRevision;
  const pagePreference = capturePagePreference();
  authoritativeReloadPending = {
    frameInstanceId:`solidify:${targetRevision}`,
    requestSequence:targetRevision,
    pageKey:pagePreference.pageKey || currentKey.textContent,
    pageIndex:pagePreference.pageIndex,
  };
  deckReady = false;
  deckReadyPayload = undefined;
  pendingPageKey = undefined;
  const previewUrl = endpoint('/preview');
  previewUrl.searchParams.set('solidifiedRevision', String(targetRevision));
  deckFrame.src = previewUrl;
}

function reloadWorkingDeck(targetRevision, reason = 'source') {
  if (!Number.isSafeInteger(targetRevision) || targetRevision <= lastWorkingReloadRevision) return;
  lastWorkingReloadRevision = targetRevision;
  const pagePreference = capturePagePreference();
  authoritativeReloadPending = {
    frameInstanceId:`${reason}:${targetRevision}`,
    requestSequence:targetRevision,
    pageKey:pagePreference.pageKey || currentKey.textContent,
    pageIndex:pagePreference.pageIndex,
  };
  deckReady = false;
  deckReadyPayload = undefined;
  pendingPageKey = undefined;
  const previewUrl = endpoint('/preview');
  previewUrl.searchParams.set('workingRevision', String(targetRevision));
  deckFrame.src = previewUrl;
}

async function solidifyChanges() {
  if (solidifyBusy || !hasUnsolidifiedChanges()) return false;
  const exitAfterSolidify = solidifyDialogReason === 'exit';
  solidifyBusy = true;
  solidifyConfirm.disabled = true;
  solidifyCancel.disabled = true;
  solidifyExitWithout.disabled = true;
  setPillLabel(solidifyConfirm, '正在固化…');
  setSolidifyProgress({
    state:'indeterminate',
    label:'正在校验并写入 Deck…',
  });
  renderHistory();
  try {
    setSolidifyProgress({
      state:'indeterminate',
      label:'正在检查历史、页面与文件状态…',
    });
    const preflight = await requestJson('/api/solidify-preflight', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:revision,
        expectedBindingRevision:deckBinding.revision,
      }),
    });
    setSolidifyProgress({
      state:'indeterminate',
      label:'检查通过，正在清理历史并原子写入 Deck…',
    });
    const result = await requestJson('/api/solidify-deck', {
      method:'POST',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({
        expectedRevision:revision,
        expectedBindingRevision:deckBinding.revision,
        preflightToken:preflight.preflightToken,
      }),
    });
    setSolidifyProgress({
      state:'determinate',
      label:'写入完成，正在刷新编辑器…',
      value:78,
    });
    updateRevision(result.revision);
    requireHistoryRefresh(result.revision);
    reloadSolidifiedDeck(result.revision);
    await ensureSessionRevision(result.revision);
    setSolidifyProgress({ state:'complete', label:'固化完成', value:100 });
    await new Promise(resolve => setTimeout(resolve, 220));
    if (solidifyDialog.open) solidifyModal.close();
    if (exitAfterSolidify) {
      terminateEditorProcess?.();
      return true;
    }
    showHistoryNotice(`已固化修改，并清空 ${result.clearedGroupCount ?? 0} 组撤销记录`, 'success');
    return true;
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') requireHistoryRefresh(error.revision);
    else expectHistoryRevision(error.revision);
    await loadSession(error.revision).catch(() => {});
    const failureMessage = error.code === 'REVISION_CONFLICT'
      ? '修改历史已经变化，请重新确认固化'
      : error.code === 'PATCH_REPLAY_FAILED'
        ? `历史${({resize:'缩放',setText:'文字',setStyle:'样式',hide:'隐藏',translate:'移动'})[error.targetSummary?.kind] ?? '修改'}无法安全重放${error.failedActionId ? `（动作 ${error.failedActionId.slice(0,8)}）` : ''}，原 Deck 未被改动`
        : error.code === 'NEW_OVERFLOW'
          ? '检测到新的页面溢出，已停止固化且原 Deck 未被改动'
          : error.code === 'DECK_CHANGED'
            ? '原 Deck 已被外部修改，为避免覆盖已停止固化'
            : error.message?.trim().startsWith('{')
              ? `固化验证失败（${error.code ?? 'UNKNOWN'}），原 Deck 未被改动`
              : error.message === '服务内部错误'
                ? `固化失败：服务内部错误（${/^[A-Z][A-Z0-9_]{0,79}$/.test(error.code ?? '') ? error.code : 'UNKNOWN'}）`
                : `固化失败：${error.message}`;
    showHistoryNotice(failureMessage, 'error');
    setSolidifyProgress({
      state:'error',
      label:failureMessage,
      value:0,
    });
    return false;
  } finally {
    solidifyBusy = false;
    solidifyConfirm.disabled = false;
    solidifyCancel.disabled = false;
    solidifyExitWithout.disabled = false;
    setPillLabel(
      solidifyConfirm,
      solidifyDialogReason === 'exit' ? '固化并退出' : '永久固化',
    );
    renderHistory();
  }
}

function expectHistoryRevision(targetRevision) {
  if (Number.isSafeInteger(targetRevision)) {
    historyRefreshTargetRevision = Math.max(historyRefreshTargetRevision, targetRevision);
  }
  renderHistory();
}

function requireHistoryRefresh(targetRevision) {
  if (Number.isSafeInteger(targetRevision)) {
    historyRefreshTargetRevision = Math.max(historyRefreshTargetRevision, targetRevision);
  } else {
    historySnapshotRequirement += 1;
  }
  renderHistory();
}

// 等权威快照更新后再定位，避免会话刷新用旧的当前页覆盖跳转。
function locateHistoryGroup(group, task) {
  task ??= tasks.find(candidate => candidate.id === (group?.taskId ?? group?.compensation?.taskId));
  const pageKeys = [task?.pageKey, ...(group?.actions ?? []).map(action => action.target?.pageKey),
    ...(group?.source?.impact?.pageKeys ?? [])];
  const buttons = [...pageList.querySelectorAll('[data-page-key]')];
  const button = pageKeys.map(key => buttons.find(item => item.dataset.pageKey === key)).find(Boolean);
  if (button) {
    requestPage(button);
    button.scrollIntoView({ block:'nearest' });
  }
}

async function changeHistory(method, button) {
  if (historyBusy || solidifyBusy || button.disabled || !button.dataset.groupId) return;
  const groupId = button.dataset.groupId;
  const group = sessionGroups.find(candidate => candidate.id === groupId);
  historyBusy = true;
  renderHistory();
  try {
    let result;
    try {
      result = await requestJson(
        `/api/groups/${encodeURIComponent(groupId)}/${method}`,
        {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ expectedRevision:revision }),
        },
      );
    } catch (error) {
      if (error.committed === true) {
        updateRevision(error.revision);
        requireHistoryRefresh(error.revision);
        await loadSession(error.revision).catch(() => {});
        showHistoryNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、同步待确认`);
        return;
      }
      if (error.code === 'REVISION_CONFLICT') requireHistoryRefresh(error.revision);
      else expectHistoryRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      showHistoryNotice(error.code === 'REVISION_CONFLICT'
        ? '历史已更新，请重试'
        : `${method === 'undo' ? '撤销' : '重做'}失败：${error.message}`, 'error');
      return;
    }
    updateRevision(result.revision);
    requireHistoryRefresh(result.revision);
    try {
      await ensureSessionRevision(result.revision);
    } catch {
      showHistoryNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、会话同步待重试`);
      return;
    }
    locateHistoryGroup(group);
    if (result.syncPending) {
      showHistoryNotice(`${method === 'undo' ? '撤销' : '重做'}已保存、浏览器同步待重试`);
    }
  } finally {
    historyBusy = false;
    renderHistory();
  }
}

function historyMethodForShortcut(event) {
  if (event.altKey || (!event.metaKey && !event.ctrlKey)) return null;
  const key = event.key.toLowerCase();
  if (key === 'z') return event.shiftKey ? 'redo' : 'undo';
  if (key === 'y' && event.ctrlKey && !event.metaKey && !event.shiftKey) return 'redo';
  return null;
}

function acceptsNativeHistoryShortcut(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  return Boolean(element?.closest(
    'input,textarea,select,[role="textbox"],[contenteditable]:not([contenteditable="false"])',
  ));
}

function triggerHistoryShortcut(method) {
  const button = method === 'undo' ? undoButton : redoButton;
  if (historyBusy) return false;
  if (!button.disabled && button.dataset.groupId) {
    void changeHistory(method, button);
    return true;
  }
  const refreshPending = Boolean(sessionRefreshPromise)
    || loadedSessionRevision < historyRefreshTargetRevision
    || historySnapshotFulfilled < historySnapshotRequirement;
  if (!refreshPending) return false;
  if (pendingHistoryShortcut) return true;
  pendingHistoryShortcut = method;
  const refresh = sessionRefreshPromise ?? loadSession(historyRefreshTargetRevision);
  void refresh.then(() => {
    if (tornDown) return;
    const queuedMethod = pendingHistoryShortcut;
    pendingHistoryShortcut = null;
    if (queuedMethod) triggerHistoryShortcut(queuedMethod);
  }).catch(error => {
    pendingHistoryShortcut = null;
    if (!tornDown) showHistoryNotice(`撤销历史加载失败：${error.message}`, 'error');
  });
  return true;
}

function onHistoryKeydown(event) {
  const method = historyMethodForShortcut(event);
  if (!method || acceptsNativeHistoryShortcut(event.target)) return;
  event.preventDefault();
  triggerHistoryShortcut(method);
}

function onSelectionDeleteKeydown(event) {
  if (editorMode !== 'edit' || inspectorSelection?.scope !== 'element'
    || !['Delete', 'Backspace'].includes(event.key)
    || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    || acceptsNativeHistoryShortcut(event.target)) return;
  event.preventDefault();
  if (event.repeat) return;
  deckFrame.contentWindow?.postMessage({
    type:'delete-transform-selection',
    selectionId:inspectorSelection.selectionId,
  }, location.origin);
}

async function changeTaskHistory(task, control) {
  if (historyBusy || solidifyBusy
    || loadedSessionRevision < historyRefreshTargetRevision
    || historySnapshotFulfilled < historySnapshotRequirement
    || !task?.groupId || !control?.groupId || !['undo', 'redo'].includes(control.method)) return;
  historyBusy = true;
  renderHistory();
  let { groupId, method } = control;
  const verb = () => method === 'undo' ? '撤销' : '重做';
  let retried = false;
  try {
    let result;
    while (!result) {
      try {
        result = await requestJson(`/api/groups/${encodeURIComponent(groupId)}/${method}`, {
          method:'POST',
          headers:{ 'content-type':'application/json' },
          body:JSON.stringify({ expectedRevision:revision }),
        });
      } catch (error) {
        if (error.status === 409 && error.code === 'REVISION_CONFLICT' && !retried) {
          retried = true;
          requireHistoryRefresh(error.revision);
          await loadSession();
          const refreshed = tasks.find(candidate => candidate.id === task.id);
          const refreshedControl = taskHistoryControl(refreshed, sessionGroups);
          // 同一用户操作不能在刷新后变成相反操作或作用于另一历史组。
          if (!refreshedControl || refreshedControl.method !== method
            || refreshedControl.groupId !== groupId) return;
          task = refreshed;
          ({ groupId, method } = refreshedControl);
          continue;
        }
        if (error.committed === true) {
          updateRevision(error.revision);
          requireHistoryRefresh(error.revision);
          await loadSession(error.revision).catch(() => {});
          showTaskNotice(`${verb()}已保存、会话同步待确认`);
          return;
        }
        throw error;
      }
    }
    updateRevision(result.revision);
    requireHistoryRefresh(result.revision);
    try {
      await ensureSessionRevision(result.revision);
    } catch {
      showTaskNotice(`${verb()}已保存、会话同步待重试`);
      return;
    }
    locateHistoryGroup(sessionGroups.find(candidate => candidate.id === groupId), task);
    if (result.syncPending) showTaskNotice(`${verb()}已保存、浏览器同步待重试`);
  } catch (error) {
    await loadSession(error.revision).catch(() => {});
    showTaskNotice(`${verb()}失败：${error.message || error.code || '未知错误'}`);
  } finally {
    historyBusy = false;
    renderHistory();
  }
}

async function editTask(task, instruction) {
  try {
    const result = await requestJson(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method:'PATCH',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:revision, instruction }),
    });
    updateRevision(result.revision);
    upsertTask(result.task);
    return result.task;
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') {
      updateRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      throw new Error('任务列表已经变化，请重新编辑');
    }
    throw error;
  }
}

async function deleteTask(task) {
  try {
    const result = await requestJson(`/api/tasks/${encodeURIComponent(task.id)}`, {
      method:'DELETE',
      headers:{ 'content-type':'application/json' },
      body:JSON.stringify({ expectedRevision:revision, cancelActiveBatch:true }),
    });
    updateRevision(result.revision);
    tasks = tasks.filter(candidate => candidate.id !== task.id);
    renderTasks();
    return result;
  } catch (error) {
    if (error.code === 'REVISION_CONFLICT') {
      updateRevision(error.revision);
      await loadSession(error.revision).catch(() => {});
      throw new Error('任务列表已经变化，请重新确认删除');
    }
    throw error;
  }
}

function renderTasks() {
  const submissionGate = agentSubmissionGate();
  renderTaskDrawer(taskDrawer, {
    tasks,
    groups:sessionGroups,
    agentRun,
    submissionBlocked:submissionGate.blocked,
    submissionBlockedMessage:submissionGate.message,
    onLocate: locateTask,
    onProcessAll: processAllTasks,
    onHistory: (task, control) => { void changeTaskHistory(task, control); },
    onEdit:editTask,
    onDelete:deleteTask,
    onCancelBatch:async batch => {
      const result = await requestJson('/api/agent-runs/cancel',{method:'POST',
        headers:{'content-type':'application/json'},
        body:JSON.stringify({expectedRevision:revision,batchId:batch.id})});
      updateRevision(result.revision); adoptAgentRun(result.run); renderTasks();
    },
  });
  renderAgentStatus();
  updatePageBadges();
  renderHistory();
}

function upsertTask(task) {
  tasks = uniqueTasks([...tasks, task]);
  renderTasks();
}

function loadSession(targetRevision = revision) {
  if (Number.isSafeInteger(targetRevision)) {
    sessionRefreshTargetRevision = Math.max(sessionRefreshTargetRevision, targetRevision);
  }
  if (sessionRefreshPromise) return sessionRefreshPromise;
  const refresh = async () => {
    let firstRequest = true;
    while (firstRequest || loadedSessionRevision < sessionRefreshTargetRevision
      || historySnapshotFulfilled < historySnapshotRequirement) {
      firstRequest = false;
      const requestedRevision = sessionRefreshTargetRevision;
      const requestedSnapshotRequirement = historySnapshotRequirement;
      const [session, persistedTasks] = await Promise.all([
        requestJson('/api/session'),
        requestJson('/api/tasks'),
      ]);
      const sessionRevision = Number.isSafeInteger(session.revision) ? session.revision : 0;
      historySnapshotFulfilled = Math.max(
        historySnapshotFulfilled,
        requestedSnapshotRequirement,
      );
      updateRevision(sessionRevision);
      if (sessionRevision >= loadedSessionRevision) {
        loadedSessionRevision = sessionRevision;
        sessionGroups = Array.isArray(session.groups) ? session.groups : [];
        sessionRedo = Array.isArray(session.redo) ? session.redo : [];
        tasks = uniqueTasks([...tasks, ...(Array.isArray(persistedTasks) ? persistedTasks : [])]);
        renderTasks();
        renderInspector();
      } else {
        renderHistory();
      }
      const startupRecovery = session.startupRecovery;
      if (startupRecovery?.code === 'WORKING_DECK_RECOVERED'
        && startupRecovery.invalidFingerprint !== shownStartupRecovery) {
        shownStartupRecovery = startupRecovery.invalidFingerprint;
        showHistoryNotice('检测到上次工作副本写入未完成，已自动恢复最后一个有效版本。');
      }
      if (loadedSessionRevision < requestedRevision) {
        throw new Error(`权威会话 revision ${loadedSessionRevision} 落后于 ${requestedRevision}`);
      }
    }
    syncSessionActions();
  };
  sessionRefreshPromise = refresh().finally(() => { sessionRefreshPromise = undefined; });
  return sessionRefreshPromise;
}

function ensureSessionRevision(targetRevision) {
  if ((!Number.isSafeInteger(targetRevision) || loadedSessionRevision >= targetRevision)
    && historySnapshotFulfilled >= historySnapshotRequirement) {
    return Promise.resolve();
  }
  return loadSession(targetRevision);
}

let viewContextSending = false;
let lastViewContext = '';
let lastViewContextAt = 0;
async function publishViewContext() {
  if (!deckReady || viewContextSending || !currentKey.textContent) return;
  const active = pageList.querySelector('[aria-current="page"]');
  const stage = deckFrame.contentDocument?.querySelector('.stage');
  const stageScrolls = stage && ['auto','scroll','overlay'].includes(deckFrame.contentWindow.getComputedStyle(stage).overflowY)
    && stage.scrollHeight > stage.clientHeight;
  const scrolling = stageScrolls ? stage : deckFrame.contentDocument?.scrollingElement;
  const selected = inspectorSelection;
  const value = {pageKey:currentKey.textContent,pageLabel:currentPage.textContent,
    pageIndex:Number(active?.dataset.pageIndex),revision,
    selection:selected?.target?.pageKey === currentKey.textContent ? {
      target:selected.target, text:String(selected.textPreview ?? '').slice(0,500),
      textRange:selected.textRange ?? null, scope:selected.scope,
    } : null,
    scroll:{x:scrolling?.scrollLeft ?? 0,y:scrolling?.scrollTop ?? 0}};
  const body = JSON.stringify(value);
  if (body === lastViewContext && Date.now()-lastViewContextAt < 5000) return;
  viewContextSending = true;
  try {
    await requestJson(`/api/view-context?editorToken=${encodeURIComponent(editorToken)}`,{method:'POST',headers:{'content-type':'application/json'},body});
    lastViewContext = body; lastViewContextAt = Date.now();
  } catch { /* 下次重新发布；服务端会让过期视图失效。 */ }
  finally { viewContextSending = false; }
}
const viewContextTimer = setInterval(() => void publishViewContext(),400);
window.addEventListener('pagehide',()=>clearInterval(viewContextTimer),{once:true});
function confirmPage(button) {
  for (const item of pageList.querySelectorAll('[data-page-key]')) {
    item.setAttribute('aria-current', item === button ? 'page' : 'false');
  }
  currentPage.textContent = button.dataset.pageTitle;
  currentKey.textContent = button.dataset.pageKey;
  void publishViewContext();
}

function requestPage(button) {
  pendingPageKey = button.dataset.pageKey;
  if(authoritativeReloadPending) {
    authoritativeReloadPending.pageKey=pendingPageKey;
    authoritativeReloadPending.pageIndex=Number(button.dataset.pageIndex);
  }
  deckFrame.contentWindow?.postMessage({
    type: 'show-page',
    pageKey: pendingPageKey,
  }, location.origin);
}

function capturePagePreference() {
  const activePage = pageList.querySelector('[data-page-key][aria-current="page"]');
  const preferredPageKey = pendingPageKey || activePage?.dataset.pageKey;
  const preferredPage = preferredPageKey
    ? [...pageList.querySelectorAll('[data-page-key]')]
      .find(button => button.dataset.pageKey === preferredPageKey)
    : activePage;
  const preferredPageIndex = Number(preferredPage?.dataset.pageIndex);
  return {
    pageKey:preferredPageKey,
    pageIndex:Number.isSafeInteger(preferredPageIndex) && preferredPageIndex > 0
      ? preferredPageIndex : undefined,
  };
}

function samePageInventory(nextPages) {
  return pages.length === nextPages.length && pages.every((page, index) => {
    const next = nextPages[index];
    return page.pageKey === next?.pageKey
      && page.index === next.index
      && page.label === next.label;
  });
}

function renderPages(nextPages, preferredPageKey, preferredPageIndex) {
  pages = nextPages;
  const existing = [...pageList.querySelectorAll('[data-page-key]')];
  const unused = new Set(existing);
  const desired = pages.map(page => {
    let button = existing.find(candidate => (
      unused.has(candidate) && candidate.dataset.pageKey === page.pageKey
    ));
    button ??= existing.find(candidate => (
      unused.has(candidate) && candidate.dataset.pageIndex === String(page.index)
    ));
    if (!button) {
      button = document.createElement('button');
      button.type = 'button';
      button.className = 'page-item';
      button.setAttribute('aria-current', 'false');
      const label = document.createElement('span');
      label.className = 'page-item-label';
      button.append(label);
      button.addEventListener('click', () => requestPage(button));
    }
    unused.delete(button);
    button.dataset.pageKey = page.pageKey;
    button.dataset.pageIndex = String(page.index);
    button.dataset.pageLabel = page.label;
    button.dataset.pageTitle = `${String(page.index).padStart(2, '0')} ${page.label}`;
    const label = button.querySelector('.page-item-label');
    let pageIndex = label.querySelector('.page-item-index');
    let pageName = label.querySelector('.page-item-name');
    if (!pageIndex || !pageName) {
      pageIndex = document.createElement('span');
      pageIndex.className = 'page-item-index';
      pageName = document.createElement('span');
      pageName.className = 'page-item-name';
      label.replaceChildren(pageIndex, document.createTextNode(' '), pageName);
    }
    pageIndex.textContent = String(page.index).padStart(2, '0');
    pageName.textContent = page.label;
    button.setAttribute('aria-label', button.dataset.pageTitle);
    return button;
  });
  for (const [index, button] of desired.entries()) {
    const current = pageList.children[index];
    if (current !== button) pageList.insertBefore(button, current ?? null);
  }
  const desiredSet = new Set(desired);
  for (const child of [...pageList.children]) {
    if (!desiredSet.has(child)) child.remove();
  }
  pageCount.textContent = `${pages.length} 页`;
  updatePageBadges();
  const preferredPage = preferredPageKey
    ? pageList.querySelector(`[data-page-key="${CSS.escape(preferredPageKey)}"]`)
    : null;
  const fallbackPage = Number.isSafeInteger(preferredPageIndex) && preferredPageIndex > 0
    ? pageList.querySelector(`[data-page-index="${preferredPageIndex}"]`)
    : null;
  const requestedPage = preferredPage ?? fallbackPage ?? pageList.querySelector('[data-page-key]');
  if (requestedPage) {
    // Deck 重放时先保留（或按页序迁移）当前高亮，再异步向 iframe 确认。
    // 不再清空整列按钮，避免出现“无选中页”的一帧。
    confirmPage(requestedPage);
    requestPage(requestedPage);
  }
}

function postRegionResult(requestId, result) {
  deckFrame.contentWindow?.postMessage({
    type: 'region-task-result',
    requestId,
    ...result,
  }, location.origin);
}

function postManualResult(requestId, result) {
  deckFrame.contentWindow?.postMessage({
    type: 'manual-actions-result', requestId, ...result,
  }, location.origin);
}

async function submitManualActions(message) {
  const { requestId, actions, coalesceKey } = message;
  if (typeof requestId !== 'string' || manualRequests.has(requestId)) return;
  manualRequests.add(requestId);
  try {
    let result;
    let retried = false;
    while (!result) {
      try {
        result = await requestJson('/api/actions', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            expectedRevision:revision, taskId:null, actions, commandId:requestId,
            ...(typeof coalesceKey === 'string' && coalesceKey ? { coalesceKey } : {}),
          }),
        });
      } catch (error) {
        if (error.status === 409 && error.code === 'REVISION_CONFLICT' && !retried) {
          retried = true;
          requireHistoryRefresh(error.revision);
          await loadSession();
          continue;
        }
        throw error;
      }
    }
    updateRevision(result.revision);
    requireHistoryRefresh(result.revision);
    let sessionRefreshPending = false;
    try { await ensureSessionRevision(result.revision); }
    catch { sessionRefreshPending = true; }
    postManualResult(requestId, {
      ok:true, ...result, sessionRefreshPending,
      ...(sessionRefreshPending ? { message:'动作已保存、会话同步待重试' } : {}),
    });
  } catch (error) {
    if (error.committed === true) {
      updateRevision(error.revision);
      requireHistoryRefresh(error.revision);
      await loadSession(error.revision).catch(() => {});
      postManualResult(requestId, {
        ok: true, committed:true, commitConfirmed:false, recoveredBySync:false,
        syncPending:true, revision:error.revision, groupId:error.groupId,
        message:'动作已保存、同步待确认',
      });
      return;
    }
    postManualResult(requestId, {
      ok: false, code: error.code, message: error.message || '动作提交失败',
      failedActionId: error.failedActionId, candidates: error.candidates,
    });
  } finally {
    manualRequests.delete(requestId);
  }
}

async function createRegionTask(message) {
  const {
    requestId, payload, snapshot = null, attachments = [], processAfterCreate = false,
  } = message;
  if (typeof requestId !== 'string' || createRequests.has(requestId)) return;
  createRequests.add(requestId);
  try {
    if (typeof processAfterCreate !== 'boolean') throw new TypeError('任务提交方式无效');
    if (!Array.isArray(attachments) || attachments.length > 8
      || attachments.some(item => !item || !['selected', 'pasted'].includes(item.source)
        || !(item.file instanceof File))) {
      throw new TypeError('附件提交数据无效');
    }
    let result;
    let submittedSnapshot = snapshot;
    let revisionRetried = false;
    let snapshotDropped = snapshotByteLength(snapshot) > MAX_SNAPSHOT_BYTES;
    if (snapshotDropped) submittedSnapshot = null;
    while (!result) {
      try {
        result = await requestJson('/api/tasks', {
          method: 'POST',
          body: taskFormData(payload, submittedSnapshot, attachments, revision),
        });
      } catch (error) {
        if (error.code === 'SNAPSHOT_TOO_LARGE' && submittedSnapshot !== null && !snapshotDropped) {
          submittedSnapshot = null;
          snapshotDropped = true;
          continue;
        }
        if (error.status === 409 && error.code === 'REVISION_CONFLICT' && !revisionRetried) {
          revisionRetried = true;
          await loadSession();
          continue;
        }
        throw error;
      }
    }
    revision = Math.max(revision, result.revision);
    upsertTask(result.task);
    let processStarted = false;
    let processError = '';
    if (processAfterCreate) {
      const actionableTasks = tasks.filter(task => (
        task.targetMissing !== true && ['pending', 'failed'].includes(task.status)
      ));
      const actionableIds = actionableTasks.map(task => task.id);
      try {
        const processMessage = await processAllTasks(actionableTasks);
        processStarted = ['queued', 'running'].includes(agentRun.status)
          && actionableIds.every(id => agentRun.taskIds?.includes(id));
        if (!processStarted) processError = processMessage || '当前 Agent 未接收这批任务';
      } catch (error) {
        processError = error.message || 'Agent 启动失败';
      }
    }
    postRegionResult(requestId, {
      ok:true,
      taskId:result.task.id,
      snapshotDropped,
      processRequested:processAfterCreate,
      processStarted,
      ...(processError ? { processError } : {}),
    });
  } catch (error) {
    postRegionResult(requestId, {
      ok:false,
      code:error.code,
      message:error.message || '任务提交失败',
    });
  } finally {
    createRequests.delete(requestId);
  }
}

function onFrameMessage(event) {
  if (event.origin !== location.origin || event.source !== deckFrame.contentWindow) return;
  if (tornDown) return;
  if (event.data?.type === 'editor-surface-pointerdown') {
    setTaskDrawerOpen(taskDrawer, false);
    return;
  }
  if (event.data?.type === 'editor-surface-pointer-presence'
    && typeof event.data.active === 'boolean') {
    deckSurfacePointerActive = event.data.active;
    return;
  }
  if (event.data?.type === 'inspector-selection-changed') {
    inspectorSelection = event.data.selection?.selectionId ? event.data.selection : null;
    if (!inspectorSelection) {
      inspectorBusy = false;
      pendingInspectorRequest = null;
      inspectorNotice = '';
    }
    renderInspector();
    return;
  }
  if (event.data?.type === 'inspector-style-result'
    && pendingInspectorRequest?.requestId === event.data.requestId) {
    pendingInspectorRequest = null;
    inspectorBusy = false;
    inspectorNotice = event.data.ok
      ? (event.data.sessionRefreshPending ? '样式已保存，会话同步待重试' : '')
      : `失败：${event.data.message || '样式修改未保存'}`;
    renderInspector();
    return;
  }
  if (event.data?.type === 'history-shortcut'
    && ['undo', 'redo'].includes(event.data.method)) {
    triggerHistoryShortcut(event.data.method);
    return;
  }
  if (event.data?.type === 'action-replay-failed'
    && typeof event.data.code === 'string') {
    showHistoryNotice(
      `历史重放冲突：${event.data.code}，请撤销冲突修改或等待页面重新同步`,
      'error',
    );
    return;
  }
  if (event.data?.type === 'temporary-region-shortcut'
    && typeof event.data.active === 'boolean') {
    setTemporaryRegionShortcut(event.data.active);
    return;
  }
  if (event.data?.type === 'request-authoritative-reload'
    && typeof event.data.frameInstanceId === 'string'
    && Number.isSafeInteger(event.data.requestSequence)
    && event.data.requestSequence > 0) {
    if (event.data.frameInstanceId !== activeFrameInstanceId) return;
    const requestKey = `${event.data.frameInstanceId}:${event.data.requestSequence}`;
    if (handledAuthoritativeReloads.has(requestKey) || authoritativeReloadPending) return;
    handledAuthoritativeReloads.add(requestKey);
    const pagePreference = capturePagePreference();
    authoritativeReloadPending = {
      frameInstanceId:event.data.frameInstanceId,
      requestSequence:event.data.requestSequence,
      pageKey:pagePreference.pageKey || currentKey.textContent,
      pageIndex:pagePreference.pageIndex,
    };
    deckReady = false;
    deckReadyPayload = undefined;
    pendingPageKey = undefined;
    deckFrame.contentWindow?.location.reload();
    return;
  }
  if (event.data?.type === 'deck-error' && typeof event.data.code === 'string') {
    deckReady = false;
    deckReadyPayload = undefined;
    pages = [];
    pendingFrameCommands.clear();
    pageList.replaceChildren();
    const error = document.createElement('div');
    error.dataset.deckError = '';
    error.setAttribute('role', 'alert');
    error.textContent = `${event.data.code}：${event.data.message || 'Deck 运行时不可用'}`;
    pageList.append(error);
    pageCount.textContent = '0 页';
    currentPage.textContent = '运行时错误';
    currentKey.textContent = event.data.code;
    inspectorSelection = null;
    inspectorBusy = false;
    pendingInspectorRequest = null;
    inspectorNotice = '';
    renderInspector();
    return;
  }
  if (event.data?.type === 'deck-ready' && Array.isArray(event.data.pages)) {
    if (authoritativeReloadPending
      && event.data.frameInstanceId === authoritativeReloadPending.frameInstanceId) return;
    const pagePreference = capturePagePreference();
    const completedReload = authoritativeReloadPending;
    const inventoryUnchanged = !completedReload
      && activeFrameInstanceId === event.data.frameInstanceId
      && samePageInventory(event.data.pages);
    activeFrameInstanceId = typeof event.data.frameInstanceId === 'string'
      ? event.data.frameInstanceId : undefined;
    deckReady = true;
    deckReadyPayload = {
      type:'deck-ready',
      pages:event.data.pages,
      diagnostics:Array.isArray(event.data.diagnostics) ? event.data.diagnostics : [],
    };
    announceDeckReady();
    if (inventoryUnchanged) {
      pages = event.data.pages;
      pageCount.textContent = `${pages.length} 页`;
      updatePageBadges();
      // 只有 Deck 真正替换了 canvas 节点时才重放页面定位。页内标题、目录或
      // layer 的结构重绘也会重新发布相同 inventory，但不能把用户的细粒度滚动
      // 位置吸回页面顶端。
      if (event.data.canvasReferencesChanged === true) {
        const requestedPage = pagePreference.pageKey
          ? [...pageList.querySelectorAll('[data-page-key]')]
            .find(button => button.dataset.pageKey === pagePreference.pageKey)
          : null;
        if (requestedPage) requestPage(requestedPage);
      }
    } else {
      renderPages(
        event.data.pages,
        completedReload?.pageKey ?? pagePreference.pageKey,
        completedReload?.pageIndex ?? pagePreference.pageIndex,
      );
    }
    deckFrame.contentWindow?.postMessage({
      type:'set-editor-mode', mode:activeEditorMode(),
    }, location.origin);
    if (loadedSessionRevision >= revision) syncSessionActions();
    else void ensureSessionRevision(revision).catch(() => {});
    for (const command of pendingFrameCommands.values()) {
      deckFrame.contentWindow?.postMessage(command, location.origin);
    }
    pendingFrameCommands.clear();
    if (completedReload) {
      authoritativeReloadPending = undefined;
      deckFrame.contentWindow?.postMessage({ type:'show-authoritative-reload-notice' }, location.origin);
    }
    return;
  }
  if (event.data?.type === 'active-page-changed'
    && typeof event.data.pageKey === 'string') {
    const button = [...pageList.querySelectorAll('[data-page-key]')]
      .find(candidate => candidate.dataset.pageKey === event.data.pageKey);
    if (!button) return;
    pendingPageKey = undefined;
    confirmPage(button);
    return;
  }
  if (event.data?.type === 'create-region-task') {
    void createRegionTask(event.data);
    return;
  }
  if (event.data?.type === 'submit-manual-actions') {
    void submitManualActions(event.data);
    return;
  }
  if(event.data?.type==='restart-status-result' && typeof event.data.commandId==='string') {
    // 属性输入、任务草稿与导出等在外层窗口；合并后才能判断整个编辑器。
    const inputs=[...document.querySelectorAll('input:not([type=hidden]),textarea')];
    const draft=inputs.some(input=>input.getClientRects().length>0&&!input.disabled
      && restartDraftInputs.has(input) && !input.closest('[data-agent-terminal-host]'));
    eventsClient?.send({...event.data,busy:event.data.busy!==false||draft||Boolean(document.querySelector('[data-task-edit-form]'))||!deckReady||tornDown
      ||Boolean(historyBusy||solidifyBusy||deckBindingBusy||inspectorBusy||pptxExportBusy||pptxExportStarting
        ||authoritativeReloadPending||createRequests.size||manualRequests.size||pendingInspectorRequest)});
    return;
  }
  if (['actions-applied', 'actions-rejected', 'actions-prepared', 'actions-committed',
    'actions-rolled-back', 'actions-synced', 'diagnostics-result',
    'diagnostics-rejected', 'text-locations', 'text-locations-rejected', 'editor-lock-result']
    .includes(event.data?.type)
    && typeof event.data.commandId === 'string') {
    commandReplies.set(`${event.data.type}:${event.data.commandId}`, event.data);
    if (commandReplies.size > 100) commandReplies.delete(commandReplies.keys().next().value);
    eventsClient?.send(event.data);
    return;
  }
  if (event.data?.type !== 'page-shown' || event.data.pageKey !== pendingPageKey) return;
  pendingPageKey = undefined;
  if (event.data.shown !== true) return;
  const button = [...pageList.querySelectorAll('[data-page-key]')]
    .find(candidate => candidate.dataset.pageKey === event.data.pageKey);
  if (button) confirmPage(button);
}

window.addEventListener('message', onFrameMessage);

function activeEditorMode() {
  if (!temporaryRegionShortcut) return editorMode;
  if (editorMode === 'edit') return 'region';
  if (editorMode === 'region') return 'preview';
  return editorMode;
}

function renderEditorMode({ preserveRegionPopover=false } = {}) {
  const activeMode = activeEditorMode();
  modeTools.dataset.activeMode = activeMode;
  if (temporaryRegionShortcut) modeTools.dataset.temporaryMode = activeMode;
  else delete modeTools.dataset.temporaryMode;
  for (const button of modeButtons) {
    button.setAttribute('aria-pressed', String(button.dataset.mode === activeMode));
  }
  deckFrame.contentWindow?.postMessage({
    type:'set-editor-mode', mode:activeMode, preserveRegionPopover,
  }, location.origin);
}

function setEditorMode(mode) {
  temporaryRegionShortcut = false;
  const normalizedMode = ['text', 'move', 'resize'].includes(mode) ? 'edit' : mode;
  editorMode = normalizedMode;
  inspectorExpanded = normalizedMode === 'edit';
  renderInspectorLayout();
  renderEditorMode();
}

function setTemporaryRegionShortcut(active) {
  const next = active === true && ['edit', 'region'].includes(editorMode);
  if (temporaryRegionShortcut === next) return false;
  temporaryRegionShortcut = next;
  renderEditorMode({ preserveRegionPopover:!next || editorMode === 'region' });
  return true;
}

function isAgentTerminalInput(target) {
  const element = target instanceof Element ? target : target?.parentElement;
  return Boolean(element?.closest('[data-agent-terminal-host]'));
}

function onTemporaryRegionKeydown(event) {
  const captureAgentInput = deckSurfacePointerActive && agentTerminalOpen
    && isAgentTerminalInput(event.target);
  if (!['edit', 'region'].includes(editorMode) || !isRegionShortcutKey(event)
    || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey
    || (acceptsNativeHistoryShortcut(event.target) && !captureAgentInput)) return;
  event.preventDefault();
  if (captureAgentInput) event.stopImmediatePropagation();
  setTemporaryRegionShortcut(true);
}

function onTemporaryRegionKeyup(event) {
  if (!temporaryRegionShortcut || !isRegionShortcutKey(event)) return;
  event.preventDefault();
  if (deckSurfacePointerActive && agentTerminalOpen && isAgentTerminalInput(event.target)) {
    event.stopImmediatePropagation();
  }
  setTemporaryRegionShortcut(false);
}

const onModeClick = event => setEditorMode(event.currentTarget.dataset.mode);
for (const button of modeButtons) button.addEventListener('click', onModeClick);
canvasPresentationButton.addEventListener('click', enterCanvasPresentation);
exportPptxButton.addEventListener('click', openPptxExportDialog);
pptxExportCancel.addEventListener('click', closePptxExportDialog);
pptxExportConfirm.addEventListener('click', onExportPptx);
const onInspectorCollapse = () => setInspectorExpanded(false);
const onInspectorReopen = () => setInspectorExpanded(true);
inspectorCollapseButton.addEventListener('click', onInspectorCollapse);
inspectorReopenButton.addEventListener('click', onInspectorReopen);
function setPagePanelCollapsed(collapsed) {
  editorShell.dataset.pagePanelCollapsed = String(collapsed === true);
  pagePanelToggle.setAttribute('aria-expanded', String(collapsed !== true));
  pagePanelToggle.setAttribute('aria-label', collapsed ? '展开页面列表' : '收起页面列表');
  pagePanelToggle.title = collapsed ? '展开页面列表' : '收起页面列表';
  pagePanelToggle.dataset.pillArrowDirection = collapsed ? 'right' : 'left';
}
const onPagePanelToggle = () => setPagePanelCollapsed(
  editorShell.dataset.pagePanelCollapsed !== 'true',
);
pagePanelToggle.addEventListener('click', onPagePanelToggle);
const onUndoClick = () => { void changeHistory('undo', undoButton); };
const onRedoClick = () => { void changeHistory('redo', redoButton); };
const onSolidifyClick = () => openSolidifyDialog('toolbar');
const onSolidifyReminderAction = () => openSolidifyDialog('toolbar');
const onSolidifyConfirm = () => { void solidifyChanges(); };
undoButton.addEventListener('click', onUndoClick);
redoButton.addEventListener('click', onRedoClick);
solidifyButton.addEventListener('click', onSolidifyClick);
solidifyReminderAction.addEventListener('click', onSolidifyReminderAction);
solidifyReminderClose.addEventListener('click', hideSolidifyReminder);
solidifyCancel.addEventListener('click', closeSolidifyDialog);
solidifyExitWithout.addEventListener('click', exitWorkspaceWithoutSolidifying);
solidifyConfirm.addEventListener('click', onSolidifyConfirm);

function fitFrame() {
  const availableWidth = Math.max(frameViewport.clientWidth - 56, 1);
  const availableHeight = Math.max(frameViewport.clientHeight - 56, 1);
  const scale = Math.min(availableWidth / 1920, availableHeight / 1080, 1);
  frameScene.style.width = `${Math.round(1920 * scale)}px`;
  frameScene.style.height = `${Math.round(1080 * scale)}px`;
  deckFrame.style.transform = `scale(${scale})`;
  zoomValue.textContent = `${Math.round(scale * 100)}%`;
}

const resizeObserver = new ResizeObserver(() => {
  cancelAnimationFrame(fitFrameRequest);
  fitFrameRequest = requestAnimationFrame(fitFrame);
});
resizeObserver.observe(frameViewport);
fitFrame();
if (ownsAgentTerminal) {
  const { AgentTerminalPanel } = await import('./agent-terminal-panel.mjs');
  agentTerminal = new AgentTerminalPanel(agentTerminalRoot, {
    token,
    editorToken,
    onClose:() => {
      agentTerminalOpen = false;
      renderAgentTerminal();
      renderAgentStatus();
      agentStatus.focus();
    },
    onState:state => {
      adoptAgentTerminalState(state);
    },
  });
}
renderTasks();
renderAgentTerminal();
renderInspector();
if (ownsAgentTerminal) agentStatus.addEventListener('click', openAgentTerminal);

function onAgentTerminalKeydown(event) {
  if (event.key !== 'Escape' || !agentTerminalOpen) return;
  event.preventDefault();
  agentTerminalOpen = false;
  renderAgentTerminal();
  renderAgentStatus();
  agentStatus.focus();
}

function onTaskDrawerOutsidePointerDown(event) {
  if (taskDrawer.dataset.open !== 'true') return;
  if (event.composedPath().includes(taskDrawer)) return;
  setTaskDrawerOpen(taskDrawer, false);
}

function onEditorPointerMove(event) {
  // 跨 iframe 边缘时 Chromium 可能先在父页面把 iframe 本身作为 pointermove
  // 目标，再由 frame bridge 上报内部位置。iframe 目标仍属于 Deck；若无条件
  // 清零，会在终端重排布局的同一帧吞掉用户的 R 临时模式快捷键。
  deckSurfacePointerActive = event.target === deckFrame;
}

document.addEventListener('pointerdown', onTaskDrawerOutsidePointerDown, true);
document.addEventListener('pointermove', onEditorPointerMove, true);
document.addEventListener('keydown', onAgentTerminalKeydown);
document.addEventListener('keydown', onHistoryKeydown);
document.addEventListener('keydown', onSelectionDeleteKeydown);
document.addEventListener('keydown', onTemporaryRegionKeydown, true);
document.addEventListener('keyup', onTemporaryRegionKeyup, true);

const eventsUrl = new URL('/events', location.href);
eventsUrl.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
eventsUrl.searchParams.set('editorToken', editorToken);
eventsClient = connectEvents({
  onDiagnostic: record => {
    const endpoint = new URL('/api/connection-diagnostics', location.origin);
    endpoint.searchParams.set('token', token);
    endpoint.searchParams.set('editorToken', editorToken);
    void fetch(endpoint, {method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify(record), keepalive:true}).catch(() => {});
  },
  url: eventsUrl,
  token,
  onEvent: event => {
    if(event?.type==='restart-status' && typeof event.commandId==='string' && !deckReady) {
      eventsClient?.send({type:'restart-status-result',commandId:event.commandId,busy:true});
      return;
    }
    const replyTypes = {
      'apply-actions': event?.tentative === true ? 'actions-prepared' : 'actions-applied',
      'commit-actions': 'actions-committed',
      'rollback-actions': 'actions-rolled-back',
      'sync-actions': 'actions-synced',
      'diagnose-pages': 'diagnostics-result',
      'locate-text': 'text-locations',
      'editor-lock': 'editor-lock-result',
      'restart-status': 'restart-status-result',
    };
    if (replyTypes[event?.type] && typeof event.commandId === 'string') {
      const reply = commandReplies.get(`${replyTypes[event.type]}:${event.commandId}`);
      if (reply) eventsClient?.send(reply);
      else if (deckReady) deckFrame.contentWindow?.postMessage(event, location.origin);
      else pendingFrameCommands.set(event.commandId, event);
      return;
    }
    if (event?.type === 'dsh-agent-request' && embeddedDsh && dshParentOrigin
      && typeof event.payload?.requestId === 'string'
      && typeof event.payload?.prompt === 'string') {
      window.parent.postMessage({
        type:'aico-ppt:agent-request',
        requestId:event.payload.requestId,
        prompt:event.payload.prompt,
        sessionId:event.payload.assignedSessionId,
      }, dshParentOrigin);
      return;
    }
    if (event?.type === 'deck-binding-changed') {
      renderDeckBinding(event.payload, { announce:true });
      return;
    }
    if (['actions-recorded','group-undone','group-redone',
      'source-mutation-recorded'].includes(event?.type)) {
      expectHistoryRevision(event.revision);
      updateRevision(event.revision);
      void ensureSessionRevision(event.revision).catch(() => {});
    } else if (event?.type === 'deck-solidified') {
      updateRevision(event.revision);
      requireHistoryRefresh(event.revision);
      reloadSolidifiedDeck(event.revision);
      void ensureSessionRevision(event.revision).catch(() => {});
    } else {
      updateRevision(event?.revision);
    }
    if (event?.type === 'working-deck-changed') {
      reloadWorkingDeck(event.revision, event.payload?.reason ?? 'source');
    } else if (event?.type === 'source-mutation-failed') {
      showHistoryNotice(`工作副本修改未进入历史：${event.payload?.message ?? '未知错误'}`, 'error');
    }
    if (['task-created','task-updated'].includes(event?.type) && event.payload?.id) {
      upsertTask(event.payload);
    } else if (event?.type === 'task-deleted' && event.payload?.id) {
      tasks = tasks.filter(task => task.id !== event.payload.id);
      renderTasks();
    } else if (event?.type === 'agent-run-updated' && event.payload?.status) {
      if (adoptAgentRun(event.payload)) renderTasks();
    } else if (event?.type === 'agent-terminal-updated' && event.payload?.state) {
      adoptAgentTerminalState(event.payload);
    }
  },
  onState: state => {
    wsState.dataset.wsState = state;
    wsLabel.textContent = state === 'online' ? '在线' : '离线';
    if (state === 'offline') {
      deckFrame.contentWindow?.postMessage({ type:'rollback-all-tentative' }, location.origin);
    } else {
      announceDeckReady();
      if (seenOnline) { void loadSession().catch(() => {}); void refreshPptxExport(); }
      else seenOnline = true;
    }
  },
});
const startupRequests = [
  refreshPptxExport(),
  loadSession(),
  requestJson('/api/deck-binding').then(binding => renderDeckBinding(binding)),
  requestJson('/api/agent-runs/current').then(run => {
    if (adoptAgentRun(run)) renderTasks();
  }),
];
if (ownsAgentTerminal) startupRequests.push(requestJson('/api/agent-terminal').then(state => {
  adoptAgentTerminalState(state);
}));
else if (embeddedDsh) startupRequests.push(initializeDshWorkItem());
void Promise.all(startupRequests).then(() => {
  renderAgentStatus();
}).catch(error => {
  showHistoryNotice(`编辑状态恢复失败：${error.message}`, 'error');
});

function teardown() {
  if (tornDown) return;
  tornDown = true;
  clearTimeout(pptxExportTimer);
  pptxExportRequest += 1;
  pendingHistoryShortcut = null;
  clearTimeout(historyNoticeTimer);
  deckFrame.contentWindow?.postMessage({ type: 'editor-teardown' }, location.origin);
  eventsClient?.close();
  unsubscribeDshSession?.();
  dshWorkBridge?.close();
  agentTerminal?.dispose();
  resizeObserver.disconnect();
  cancelAnimationFrame(fitFrameRequest);
  pendingFrameCommands.clear();
  deckFrame.removeEventListener('load', onDeckFrameLoad);
  for (const button of modeButtons) button.removeEventListener('click', onModeClick);
  canvasPresentationButton.removeEventListener('click', enterCanvasPresentation);
  exportPptxButton.removeEventListener('click', openPptxExportDialog);
  pptxExportCancel.removeEventListener('click', closePptxExportDialog);
  pptxExportConfirm.removeEventListener('click', onExportPptx);
  pptxExportModal.destroy();
  inspectorCollapseButton.removeEventListener('click', onInspectorCollapse);
  inspectorReopenButton.removeEventListener('click', onInspectorReopen);
  pagePanelToggle.removeEventListener('click', onPagePanelToggle);
  undoButton.removeEventListener('click', onUndoClick);
  redoButton.removeEventListener('click', onRedoClick);
  solidifyButton.removeEventListener('click', onSolidifyClick);
  solidifyReminderAction.removeEventListener('click', onSolidifyReminderAction);
  solidifyReminderClose.removeEventListener('click', hideSolidifyReminder);
  solidifyCancel.removeEventListener('click', closeSolidifyDialog);
  solidifyExitWithout.removeEventListener('click', exitWorkspaceWithoutSolidifying);
  solidifyConfirm.removeEventListener('click', onSolidifyConfirm);
  if (navigateToWorkspaceHome) {
    workspaceHomeButton.removeEventListener('click', navigateToWorkspaceHome);
    exitEditorButton.removeEventListener('click', requestWorkspaceExit);
  }
  deckBindingRecheck.removeEventListener('click', reconcileDeckBinding);
  deckBindingChoose.removeEventListener('click', chooseDeckBinding);
  solidifyModal.destroy();
  if (!embeddedDsh) agentStatus.removeEventListener('click', openAgentTerminal);
  document.removeEventListener('pointerdown', onTaskDrawerOutsidePointerDown, true);
  document.removeEventListener('pointermove', onEditorPointerMove, true);
  document.removeEventListener('keydown', onAgentTerminalKeydown);
  document.removeEventListener('keydown', onHistoryKeydown);
  document.removeEventListener('keydown', onSelectionDeleteKeydown);
  document.removeEventListener('keydown', onTemporaryRegionKeydown, true);
  document.removeEventListener('keyup', onTemporaryRegionKeyup, true);
  window.removeEventListener('message', onFrameMessage);
  window.removeEventListener('message', onDshParentMessage);
  window.removeEventListener('pagehide', teardown);
  window.removeEventListener('unload', teardown);
}

function onDshParentMessage(event) {
  if (!embeddedDsh || dshParentOrigin === null || event.origin !== dshParentOrigin
    || event.source !== window.parent || event.data?.type !== 'aico-ppt:agent-result') return;
  const { requestId, accepted, message='' } = event.data;
  if (typeof requestId !== 'string' || typeof accepted !== 'boolean') return;
  void requestJson('/api/dsh-agent-requests/acknowledge', {
    method:'POST',
    headers:{ 'content-type':'application/json' },
    body:JSON.stringify({ requestId, accepted, message }),
  }).catch(error => {
    if (error?.code !== 'DSH_REQUEST_NOT_FOUND') {
      showTaskNotice(`DSH 会话确认失败：${error.message}`);
    }
  });
}

if (embeddedDsh) window.addEventListener('message', onDshParentMessage);

window.addEventListener('pagehide', teardown);
window.addEventListener('unload', teardown);
