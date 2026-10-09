const landing = document.querySelector('[data-landing]');
const supportNavigation = document.querySelector('[data-support-navigation]');
const existingFlow = document.querySelector('[data-existing-flow]');
const existingDeckButton = document.querySelector('[data-existing-deck]');
const backHomeButton = document.querySelector('[data-back-home]');
const addButton = document.querySelector('[data-add-deck]');
const buttonLabels = document.querySelectorAll('[data-button-label]');
const status = document.querySelector('[data-existing-status]');
const confirmation = document.querySelector('[data-confirmation]');
const deckName = document.querySelector('[data-deck-name]');
const projectRoot = document.querySelector('[data-project-root]');
const projectSource = document.querySelector('[data-project-source]');
const projectWarning = document.querySelector('[data-project-warning]');
const confirmationRow = document.querySelector('[data-project-confirmation]');
const confirmationInput = document.querySelector('[data-confirm-project]');
const provider = document.querySelector('[data-provider]');
const changeDeckButton = document.querySelector('[data-change-deck]');
const changeProjectButton = document.querySelector('[data-change-project]');
const openButton = document.querySelector('[data-open-deck]');
const exitEditorButton = document.querySelector('[data-exit-editor]');
const historyUi = {
  creationList:document.querySelector('[data-creation-work-list]'),
  editingList:document.querySelector('[data-editing-work-list]'),
  creationCount:document.querySelector('[data-creation-work-count]'),
  editingCount:document.querySelector('[data-editing-work-count]'),
  creationStatus:document.querySelector('[data-creation-history-status]'),
  editingStatus:document.querySelector('[data-editing-history-status]'),
};
const launchParams = new URLSearchParams(window.location.search);
const token = launchParams.get('token');
const embeddedDsh = launchParams.get('embedded') === 'dsh';
const dshParentOrigin = (() => {
  if (!embeddedDsh) return null;
  try { return new URL(launchParams.get('parentOrigin')).origin; }
  catch { return null; }
})();
if (embeddedDsh) document.documentElement.dataset.embedded = 'dsh';
document.documentElement.dataset.runtimeProfile = embeddedDsh ? 'dsh-product' : 'standalone-dev';
if (embeddedDsh && exitEditorButton) {
  exitEditorButton.setAttribute('aria-label', '关闭 AICO-PPT 工作台');
  exitEditorButton.title = '关闭 AICO-PPT 工作台';
  exitEditorButton.dataset.toolbarTooltip = '关闭工作台';
}
let pageIsClosing = false;
let launcherLeaseHandedOff = false;
let startupVisualsReleased = false;
let liquidEtherBackground = { destroy() {} };
function startStartupVisuals() {
  if (pageIsClosing || startupVisualsReleased) return;
  const startShell = document.querySelector('[data-start-shell]');
  if (startShell?.hidden) {
    document.querySelector('[data-liquid-ether-background]')?.setAttribute('data-state', 'paused');
    startupVisualsReleased = true;
    return;
  }
  void import(`/app/liquid-ether-background.mjs?token=${encodeURIComponent(token)}`)
    .then(({ createLiquidEtherBackground }) => {
      if (pageIsClosing || startupVisualsReleased) return;
      liquidEtherBackground = createLiquidEtherBackground(
        document.querySelector('[data-liquid-ether-background]'),
      );
    })
    .catch(error => {
      const background = document.querySelector('[data-liquid-ether-background]');
      if (background) background.dataset.state = 'fallback';
      console.warn('启动页动态背景载入失败，已使用静态柔光。', error);
    });
}
function releaseStartupVisuals() {
  startupVisualsReleased = true;
  liquidEtherBackground.destroy();
  liquidEtherBackground = { destroy() {} };
}
const isLeavingWorkspace = launchParams.get('leaveWorkspace') === '1';
if (isLeavingWorkspace) {
  document.documentElement.dataset.workspaceNavigationState = 'pending';
}
const requestedWorkspaceView = ['home', 'creation', 'editing'].includes(launchParams.get('view'))
  ? launchParams.get('view') : null;
const launcherClientId = sessionStorage.getItem('aico-ppt-launcher-client-id')
  ?? globalThis.crypto?.randomUUID?.()
  ?? `${Date.now()}-${Math.random()}`;
sessionStorage.setItem('aico-ppt-launcher-client-id', launcherClientId);
const launcherClientSequence = Number(
  sessionStorage.getItem('aico-ppt-launcher-client-sequence') ?? 0,
) + 1;
sessionStorage.setItem('aico-ppt-launcher-client-sequence', String(launcherClientSequence));
const launcherLeasePromise = fetch(
  `/api/client-connected?token=${encodeURIComponent(token)}`,
  {
    method:'POST',
    headers:{ accept:'application/json', 'content-type':'application/json' },
    body:JSON.stringify({ clientId:launcherClientId, sequence:launcherClientSequence }),
  },
).then(async response => {
  const result = await response.json();
  if (!response.ok) throw new Error(result.message || '页面连接失败');
  return result;
}).catch(() => null);
let launcherLeaseClient = null;
void launcherLeasePromise.then(async connected => {
  if (!connected || pageIsClosing) return;
  const { createLauncherLeaseClient } = await import(
    `/app/launcher-lease-client.mjs?token=${encodeURIComponent(token)}`
  );
  if (pageIsClosing) return;
  launcherLeaseClient = createLauncherLeaseClient({
    workspaceUrl:new URL(location.href),
    clientId:launcherClientId,
    sequence:launcherClientSequence,
  });
  launcherLeaseClient.start();
}).catch(() => {});
let AgentTerminalPanel = null;
if (!embeddedDsh) {
  ({ AgentTerminalPanel } = await import(
    `/app/agent-terminal-panel.mjs?token=${encodeURIComponent(token)}`
  ));
}
const { confirmProjectSession, linkedProjectSession } = await import(`/app/dsh-project-choice.mjs?token=${encodeURIComponent(token)}`);
const { WorkspaceSwitcher } = await import(
  `/app/workspace-switcher.mjs?token=${encodeURIComponent(token)}`
);
const { enhanceSelect } = await import(
  `/app/native-controls.mjs?token=${encodeURIComponent(token)}`
);
const { applyPill, installPillNav, setPillLabel } = await import(
  `/app/pill-nav.mjs?token=${encodeURIComponent(token)}`
);
const { installToolbarTooltip } = await import(
  `/app/toolbar-tooltip.mjs?token=${encodeURIComponent(token)}`
);
const {
  agentProviderDefinition,
  isAgentProviderId,
  publicAgentProviders,
} = await import(`/app/agent-provider-registry.mjs?token=${encodeURIComponent(token)}`);
enhanceSelect(provider, { minimumMenuWidth:190 });
enhanceSelect(document.querySelector('[data-creation-provider]'), { minimumMenuWidth:190 });
installPillNav(document);
installToolbarTooltip(document);
let state = 'idle';
let appReady = false;
let candidate = null;
let creationCandidate = null;
let creationDraft = null;
let activeCreationWorkItem = null;
let creationTerminalPanel = null;
let creationEvents = null;
let creationRefreshTimer = null;
let creationPreviewKey = null;
let creationHasDeck = false;
let creationDshPrompt = '';
let dshBridge = null;
let deckTaskCoordinator = null;
let describeDshWorkSessionTarget = () => null;
let listDshWorkSessionTargets = () => [];
let dshWorkHistory = null;
let dshWorkHistoryRequest = null;
let dshCurrentSession = null;
let dshSessionNavigationBusy = false;
let creationDshSessionBusy = false;
let creationDshSessionRenderVersion = 0;
let suppressDshSessionNavigation = 0;
// 显式项目导航尚未就绪时，旧会话的 ready 重放不能覆盖用户选定的目标。
let requestedProjectNavigationPending = ['creation', 'editing'].includes(launchParams.get('switchKind'));
let ignoredHomeSessionId;
let holdExplicitHome = isLeavingWorkspace && requestedWorkspaceView === 'home';

const creationUi = {
  startShell:document.querySelector('[data-start-shell]'),
  creationFlow:document.querySelector('[data-creation-flow]'),
  builder:document.querySelector('[data-builder]'),
  newDeck:document.querySelector('[data-new-deck]'),
  creationBack:document.querySelector('[data-creation-back]'),
  chooseProject:document.querySelector('[data-choose-creation-project]'),
  changeProject:document.querySelector('[data-change-creation-project]'),
  createDraft:document.querySelector('[data-create-draft]'),
  confirmation:document.querySelector('[data-creation-confirmation]'),
  projectRoot:document.querySelector('[data-creation-project-root]'),
  projectSource:document.querySelector('[data-creation-project-source]'),
  projectWarning:document.querySelector('[data-creation-project-warning]'),
  projectConfirmation:document.querySelector('[data-creation-project-confirmation]'),
  confirmProject:document.querySelector('[data-confirm-creation-project]'),
  provider:document.querySelector('[data-creation-provider]'),
  status:document.querySelector('[data-creation-status]'),
  terminalRoot:document.querySelector('[data-agent-terminal]'),
  terminalReopen:document.querySelector('[data-terminal-reopen]'),
  workspaceNavigation:document.querySelector('[data-workspace-navigation]'),
  switchWorkspace:document.querySelector('[data-workspace-switch]'),
  home:document.querySelector('[data-workspace-home]'),
  draftTitle:document.querySelector('[data-draft-title]'),
  draftTitleButton:document.querySelector('[data-draft-title-button]'),
  draftTitleForm:document.querySelector('[data-draft-title-form]'),
  draftTitleInput:document.querySelector('[data-draft-title-input]'),
  draftTitleSave:document.querySelector('[data-draft-title-save]'),
  draftTitleCancel:document.querySelector('[data-draft-title-cancel]'),
  draftRevision:document.querySelector('[data-draft-revision]'),
  dshTaskSession:document.querySelector('[data-dsh-task-session]'),
  dshSession:document.querySelector('[data-dsh-task-session-label]'),
  dshCompanion:document.querySelector('[data-dsh-creation-companion]'),
  deckStage:document.querySelector('[data-deck-stage]'),
  deckStageTitle:document.querySelector('[data-deck-stage-title]'),
  deckStageStatus:document.querySelector('[data-deck-stage-status]'),
  deckPreview:document.querySelector('[data-deck-preview]'),
  openGenerated:document.querySelector('[data-open-generated]'),
  workspaceStatus:document.querySelector('[data-workspace-status]'),
};
applyPill(creationUi.draftTitleSave, { variant:'primary', size:'sm', kind:'action' });
applyPill(creationUi.draftTitleCancel, { variant:'secondary', size:'sm', kind:'action' });

for (const select of [provider, creationUi.provider]) {
  select.replaceChildren(...publicAgentProviders().map(({ id, label }) => {
    const option = document.createElement('option');
    option.value = id;
    option.textContent = label;
    return option;
  }));
}

function setStatus(message, kind = '') {
  status.textContent = message;
  status.dataset.kind = kind;
}

function setState(nextState, message, kind = '') {
  state = nextState;
  addButton.disabled = nextState !== 'idle';
  for (const label of buttonLabels) {
    label.textContent = nextState === 'choosing-deck'
      ? '请选择 HTML…'
      : '添加 Deck HTML';
  }
  changeProjectButton.disabled = nextState !== 'deck-selected';
  changeDeckButton.disabled = nextState !== 'deck-selected';
  openButton.disabled = nextState !== 'deck-selected';
  provider.disabled = nextState !== 'deck-selected';
  syncLandingButtons();
  setStatus(message, kind);
}

function syncLandingButtons() {
  for (const button of landing.querySelectorAll(
    '[data-work-task], [data-dismiss-work], [data-rename-work], [data-new-deck], [data-existing-deck]',
  )) {
    button.disabled = !appReady || state !== 'idle';
  }
}

async function requestJson(path, { method = 'GET', body } = {}) {
  const url = new URL(path, location.origin);
  url.searchParams.set('token', token);
  const response = await fetch(url, {
    method,
    headers:{ accept:'application/json', ...(body === undefined ? {} : { 'content-type':'application/json' }) },
    ...(body === undefined ? {} : { body:JSON.stringify(body) }),
  });
  const result = await response.json();
  if (!response.ok) {
    const error = new Error(result.message || '操作失败');
    error.code = result.code;
    throw error;
  }
  return result;
}

function post(path, body) {
  return requestJson(path, { method:'POST', body:body ?? {} });
}

if (embeddedDsh && dshParentOrigin) {
  const [bridgeModule, { createDeckTaskCoordinator }] = await Promise.all([
    import(`/app/dsh-work-bridge.mjs?token=${encodeURIComponent(token)}`),
    import(`/app/deck-task-coordinator.mjs?token=${encodeURIComponent(token)}`),
  ]);
  ({ describeDshWorkSessionTarget, listDshWorkSessionTargets } = bridgeModule);
  dshBridge = bridgeModule.createDshWorkBridge({ targetOrigin:dshParentOrigin });
  const commandPaths = {
    'set-workspace':'/api/dsh-work-items/set-workspace',
    'begin-session':'/api/dsh-work-items/begin-session',
    'complete-session':'/api/dsh-work-items/complete-session',
    'fail-session':'/api/dsh-work-items/fail-session',
    'activate-session':'/api/dsh-work-items/activate-session',
    'archive-sessions':'/api/dsh-work-items/archive-sessions',
    'resolve-session':'/api/dsh-work-items/resolve-session',
  };
  deckTaskCoordinator = createDeckTaskCoordinator({
    bridge:dshBridge,
    catalogCommand:(command, payload) => {
      const path = commandPaths[command];
      if (!path) throw new Error(`不支持的 WorkCatalog 命令：${command}`);
      return post(path, payload);
    },
  });
  dshBridge.registerWorkSessionCreator(createCurrentCreationDshWorkSession);
  dshBridge.registerWorkSessionTargetNavigator(navigateToCreationDshWorkSessionTarget);
  void requestJson('/api/work-history').then(history => {
    dshWorkHistory = history;
    publishCreationDshWorkContext({ refreshHistory:false });
  }).catch(error => {
    console.warn('无法发布 AICO-PPT 项目会话目标列表。', error);
  });
}

function editorNavigationUrl(value) {
  if (!embeddedDsh) return value;
  const url = new URL(value);
  url.searchParams.set('embedded', 'dsh');
  if (dshParentOrigin) url.searchParams.set('parentOrigin', dshParentOrigin);
  window.parent.postMessage({
    type:'aico-ppt:dsh-frame-origin',
    origin:url.origin,
  }, dshParentOrigin);
  return url.href;
}

function workspaceNavigationUrl(destination) {
  const url = new URL('/app/', location.origin);
  url.searchParams.set('token', token);
  url.searchParams.set('view', destination);
  url.searchParams.set('leaveWorkspace', '1');
  if (embeddedDsh) {
    url.searchParams.set('embedded', 'dsh');
    url.searchParams.set('parentOrigin', dshParentOrigin);
  }
  return url.href;
}

function workspaceTaskNavigationUrl(kind, entry) {
  const url = new URL(workspaceNavigationUrl(kind));
  url.searchParams.set('switchKind', kind);
  if (kind === 'creation') {
    url.searchParams.set('projectRoot', entry.projectRoot);
    url.searchParams.set('draftId', entry.draftId);
  } else {
    url.searchParams.set('deckPath', entry.deckPath);
  }
  if (typeof entry.workId === 'string') url.searchParams.set('workId', entry.workId);
  return url.href;
}

function currentWorkspaceWorkId() {
  return activeCreationWorkItem?.workId ?? candidate?.workId ?? launchParams.get('workId') ?? null;
}

function publishCreationDshWorkContext({ refreshHistory = true } = {}) {
  if (!dshBridge) return;
  const context = describeDshWorkSessionTarget(activeCreationWorkItem);
  const historyTargets = listDshWorkSessionTargets(dshWorkHistory, activeCreationWorkItem?.workId);
  const targets = context === null
    ? historyTargets
    : [context, ...historyTargets.filter(target => target.workId !== context.workId)];
  dshBridge.publishWorkContext(context, targets);
  if (!refreshHistory || dshWorkHistoryRequest) return;
  dshWorkHistoryRequest = requestJson('/api/work-history?bindings=metadata').then(history => {
    dshWorkHistory = history;
    publishCreationDshWorkContext({ refreshHistory:false });
  }).catch(error => {
    console.warn('无法刷新 AICO-PPT 任务会话目标列表。', error);
  }).finally(() => {
    dshWorkHistoryRequest = null;
  });
}

async function navigateToCreationDshWorkSessionTarget({ workId, contextKey }) {
  const history = await requestJson('/api/work-history');
  dshWorkHistory = history;
  const entry = [...(history.creation ?? []), ...(history.editing ?? [])]
    .find(candidate => candidate.workId === workId);
  const target = describeDshWorkSessionTarget(entry);
  if (!entry || target?.contextKey !== contextKey) {
    throw new Error('所选 Deck 任务已变化，请重新打开“新会话”菜单选择');
  }
  if (activeCreationWorkItem?.workId === workId) {
    publishCreationDshWorkContext({ refreshHistory:false });
    return;
  }
  location.replace(workspaceTaskNavigationUrl(entry.kind, entry));
}

function requestedWorkspaceMatches(workItem) {
  if (!workItem || launchParams.get('switchKind') !== workItem.kind) return false;
  if (typeof workItem.workId === 'string' && launchParams.get('workId') === workItem.workId) {
    return true;
  }
  if (workItem.kind === 'creation') {
    return launchParams.get('draftId') === workItem.draftId
      && launchParams.get('projectRoot') === workItem.projectRoot;
  }
  return launchParams.get('deckPath') === workItem.deckPath;
}

async function withDshNavigationSuppressed(operation) {
  suppressDshSessionNavigation += 1;
  try { return await operation(); }
  finally { suppressDshSessionNavigation -= 1; }
}

async function activateLinkedDshSession(workItem) {
  if (!deckTaskCoordinator || !workItem?.dshBinding?.activeSessionId) return workItem;
  if (dshCurrentSession?.sessionId === workItem.dshBinding.activeSessionId) return workItem;
  const result = await withDshNavigationSuppressed(() => deckTaskCoordinator.activate({ workItem }));
  return result.workItem;
}

async function createDshWorkSession(workItem, prompt) {
  if (!deckTaskCoordinator || !workItem) return workItem;
  const result = await withDshNavigationSuppressed(() => (
    deckTaskCoordinator.createSession({ workItem })
  ));
  if (prompt) {
    await deckTaskCoordinator.send(
      result.workItem.dshBinding.activeSessionId,
      prompt,
    );
  }
  return result.workItem;
}

function updateCreationDshSessionStatus() {
  const control = creationUi.dshTaskSession;
  const select = creationUi.dshSession;
  if (!control || !select) return;
  publishCreationDshWorkContext();
  const renderVersion = ++creationDshSessionRenderVersion;
  const binding = activeCreationWorkItem?.dshBinding ?? null;
  const links = binding?.sessions?.filter(link => (
    link.state === 'available' && link.workspaceId === binding.workspaceId
  )) ?? [];
  const render = (rows = []) => {
    if (renderVersion !== creationDshSessionRenderVersion) return;
    const rowById = new Map(rows.filter(Boolean).map(row => [row.sessionId, row]));
    const archivedIds = new Set(rows.filter(row => row?.archived === true)
      .map(row => row.sessionId));
    const visibleLinks = links.filter(link => !archivedIds.has(link.sessionId));
    if (archivedIds.size > 0 && deckTaskCoordinator && activeCreationWorkItem) {
      void deckTaskCoordinator.reconcileArchivedSessions({
        workItem:activeCreationWorkItem,
        sessionIds:[...archivedIds],
      }).then(result => {
        if (renderVersion !== creationDshSessionRenderVersion) return;
        activeCreationWorkItem = result.workItem;
        updateCreationDshSessionStatus();
      }).catch(error => {
        console.warn('无法持久化 Creation 任务的 DSH 会话归档状态。', error);
      });
    }
    select.replaceChildren();
    if (visibleLinks.length === 0) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = '尚未创建任务会话';
      select.append(option);
      select.disabled = true;
      control.dataset.state = 'missing';
      control.title = '请从左侧“新会话”创建此 Deck 的任务会话';
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
      option.textContent = describedTitle || deckTaskCoordinator.sessionTitle({
        workItem:activeCreationWorkItem,
        sessionId:link.sessionId,
      });
      select.append(option);
    }
    const activeSessionId = visibleLinks.some(link => link.sessionId === binding.activeSessionId)
      ? binding.activeSessionId : null;
    select.value = activeSessionId ?? visibleLinks[0].sessionId;
    select.disabled = creationDshSessionBusy;
    const matchingCurrent = dshCurrentSession?.sessionId === activeSessionId;
    control.dataset.state = matchingCurrent ? 'active' : 'detached';
    control.title = matchingCurrent
      ? '当前 DSH 会话已关联此 Deck'
      : '当前 DSH 会话未关联此 Deck；提交任务时会切回活动任务会话';
  };
  render();
  if (dshBridge && links.length) {
    void dshBridge.request('describe-sessions', {
      sessionIds:links.map(link => link.sessionId),
    }).then(render).catch(() => {});
  }
}

if (dshBridge) {
  dshBridge.subscribeCurrentSession(session => {
    dshCurrentSession = session;
    updateCreationDshSessionStatus();
    if (holdExplicitHome) {
      const sessionId = session?.sessionId ?? null;
      if (ignoredHomeSessionId === undefined) ignoredHomeSessionId = sessionId;
      if (sessionId === ignoredHomeSessionId) return;
      holdExplicitHome = false;
    }
    if (!session?.sessionId || requestedProjectNavigationPending || suppressDshSessionNavigation > 0 || dshSessionNavigationBusy) return;
    dshSessionNavigationBusy = true;
    void deckTaskCoordinator.resolveBySession(session.sessionId).then(async result => {
      if (requestedProjectNavigationPending || suppressDshSessionNavigation > 0 || dshCurrentSession?.sessionId !== session.sessionId) return;
      let workItem = result?.workItem ?? null;
      if (!workItem) return;
      if (workItem.dshBinding.activeSessionId !== session.sessionId) {
        const activated = await post('/api/dsh-work-items/activate-session', {
          workId:workItem.workId,
          sessionId:session.sessionId,
          expectedBindingRevision:workItem.dshBinding.revision,
        });
        workItem = activated.workItem;
      }
      if (workItem.workId === currentWorkspaceWorkId() || requestedWorkspaceMatches(workItem)) {
        if (workItem.kind === 'creation') activeCreationWorkItem = workItem;
        updateCreationDshSessionStatus();
        return;
      }
      location.replace(workspaceTaskNavigationUrl(workItem.kind, workItem));
    }).catch(error => {
      console.warn('无法按 DSH 会话切换 AICO-PPT 工作项。', error);
    }).finally(() => {
      dshSessionNavigationBusy = false;
    });
  });
}

function navigateFromCreation(destination) {
  creationUi.switchWorkspace.disabled = true;
  creationUi.home.disabled = true;
  exitEditorButton.disabled = true;
  location.replace(workspaceNavigationUrl(destination));
}

function terminateEditorProcess() {
  if (embeddedDsh && dshParentOrigin) {
    window.parent.postMessage({ type:'aico-ppt:close-workbench' }, dshParentOrigin);
    return;
  }
  document.documentElement.dataset.processExiting = 'true';
  creationUi.switchWorkspace.disabled = true;
  creationUi.home.disabled = true;
  exitEditorButton.disabled = true;
  setPillLabel(exitEditorButton, '正在退出…');
  const shutdownUrl = `/api/shutdown?token=${encodeURIComponent(token)}`;
  let beaconSent = false;
  try { beaconSent = navigator.sendBeacon(shutdownUrl); }
  catch { beaconSent = false; }
  if (!beaconSent) {
    void fetch(shutdownUrl, { method:'POST', keepalive:true }).catch(() => {});
  }
  setTimeout(() => window.close(), 80);
}

function showLanding() {
  landing.hidden = false;
  existingFlow.hidden = true;
  creationUi.creationFlow.hidden = true;
  supportNavigation.hidden = false;
  exitEditorButton.hidden = false;
}

function showExistingFlow() {
  landing.hidden = true;
  existingFlow.hidden = false;
  creationUi.creationFlow.hidden = true;
  supportNavigation.hidden = true;
  exitEditorButton.hidden = false;
}

function showCreationFlow() {
  landing.hidden = true;
  existingFlow.hidden = true;
  creationUi.creationFlow.hidden = false;
  supportNavigation.hidden = true;
  exitEditorButton.hidden = false;
}

function resetEntryChoices() {
  candidate = null;
  confirmation.hidden = true;
  confirmationInput.checked = false;
  addButton.hidden = false;
  deckName.textContent = '';
  projectRoot.textContent = '';
  projectSource.textContent = '';
  projectWarning.textContent = '';
  projectWarning.hidden = true;
  confirmationRow.hidden = true;

  creationCandidate = null;
  creationUi.confirmation.hidden = true;
  creationUi.confirmProject.checked = false;
  creationUi.chooseProject.hidden = false;
  creationUi.projectRoot.textContent = '';
  creationUi.projectSource.textContent = '';
  creationUi.projectWarning.textContent = '';
  creationUi.projectWarning.hidden = true;
  creationUi.projectConfirmation.hidden = true;

  setCreationChoiceState('idle', '尚未选择目录');
  setState('idle', '尚未添加文件');
}

async function returnToLanding(flow) {
  const selectedState = flow === 'existing' ? 'deck-selected' : 'creation-project-selected';
  if (!['idle', selectedState].includes(state)) return;
  const previousState = state;
  if (previousState !== 'idle') {
    state = 'resetting-selection';
    if (flow === 'existing') setStatus('正在返回首页…', 'working');
    else creationStatus('正在返回首页…', 'working');
    try {
      const result = await post('/api/reset-selection');
      if (result.status !== 'idle') throw new Error('服务未完成选择复位');
    } catch (error) {
      if (flow === 'existing') {
        setState(previousState, error.message || '暂时无法返回首页', 'error');
      } else {
        setCreationChoiceState(previousState, error.message || '暂时无法返回首页', 'error');
      }
      return;
    }
  }
  resetEntryChoices();
  showLanding();
  void loadWorkHistory();
}

function formatModifiedAt(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '修改时间未知';
  return new Intl.DateTimeFormat('zh-CN', {
    month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false,
  }).format(date);
}

function historyStatus(kind, message = '', stateKind = '') {
  const node = kind === 'creation' ? historyUi.creationStatus : historyUi.editingStatus;
  node.textContent = message;
  node.dataset.kind = stateKind;
}

function createTrashIcon(className) {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('work-item-delete-icon', className);
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const paths = [
    ['path', { d:'M4 7h16' }],
    ['path', { d:'M9 7V4.75h6V7' }],
    ['path', { d:'M7 7l.75 12h8.5L17 7' }],
    ['path', { d:'M10 10.5v5' }],
    ['path', { d:'M14 10.5v5' }],
  ];
  for (const [tag, attributes] of paths) {
    const path = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (const [name, value] of Object.entries(attributes)) path.setAttribute(name, value);
    svg.append(path);
  }
  return svg;
}

function createPencilIcon() {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.classList.add('work-item-edit-icon');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('fill', 'none');
  svg.setAttribute('stroke', 'currentColor');
  svg.setAttribute('stroke-width', '1.8');
  svg.setAttribute('stroke-linecap', 'round');
  svg.setAttribute('stroke-linejoin', 'round');
  svg.setAttribute('aria-hidden', 'true');
  const body = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  body.setAttribute('d', 'M4.5 19.5l4.1-.8 10-10a2.1 2.1 0 0 0-3-3l-10 10-.8 4.1z');
  const seam = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  seam.setAttribute('d', 'M14.2 7.1l2.7 2.7');
  svg.append(body, seam);
  return svg;
}

function workItemName(kind, entry) {
  return entry.displayName || (kind === 'creation' ? entry.title : entry.deckName);
}

function beginWorkItemRename(kind, entry, row) {
  if (state !== 'idle' || row.dataset.renaming === 'true') return;
  row.dataset.renaming = 'true';
  const content = row.querySelector('.work-item');
  const actions = row.querySelector('.work-item-actions');
  content.hidden = true;
  actions.hidden = true;
  const form = document.createElement('form');
  form.className = 'work-item-rename-form';
  const input = document.createElement('input');
  input.type = 'text';
  input.maxLength = 80;
  input.value = workItemName(kind, entry);
  input.setAttribute('aria-label', '工作项名称');
  input.autocomplete = 'off';
  const save = document.createElement('button');
  save.type = 'submit';
  save.textContent = '保存';
  save.setAttribute('aria-label', '保存名称');
  applyPill(save, { variant:'primary', size:'sm', kind:'action' });
  const cancel = document.createElement('button');
  cancel.type = 'button';
  cancel.textContent = '取消';
  cancel.setAttribute('aria-label', '取消改名');
  applyPill(cancel, { variant:'secondary', size:'sm', kind:'action' });
  const restore = () => {
    form.remove();
    row.dataset.renaming = 'false';
    content.hidden = false;
    actions.hidden = false;
  };
  cancel.addEventListener('click', restore);
  input.addEventListener('keydown', event => {
    if (event.key === 'Escape') restore();
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    input.disabled = true;
    save.disabled = true;
    cancel.disabled = true;
    historyStatus(kind, '正在保存工作项名称…', 'working');
    try {
      await post('/api/work-items/rename', {
        workId:entry.workId,
        displayName:input.value,
        expectedRevision:entry.revision,
      });
      await loadWorkHistory();
      historyStatus(kind, '工作项名称已更新');
    } catch (error) {
      input.disabled = false;
      save.disabled = false;
      cancel.disabled = false;
      historyStatus(kind, error.message || '工作项改名失败', 'error');
      input.focus();
      input.select();
    }
  });
  form.append(input, save, cancel);
  row.append(form);
  input.focus();
  input.select();
}

function renderWorkList(kind, entries) {
  const creation = kind === 'creation';
  const list = creation ? historyUi.creationList : historyUi.editingList;
  const count = creation ? historyUi.creationCount : historyUi.editingCount;
  list.replaceChildren();
  count.textContent = entries.length ? `${entries.length} 个` : '';
  if (!entries.length) {
    const empty = document.createElement('p');
    empty.className = 'work-empty';
    empty.textContent = creation
      ? '还没有进行中的 Draft。\n从右下角开始第一个新建任务。'
      : '还没有可继续的 Deck。\n从右下角添加一份 HTML。';
    list.append(empty);
    return;
  }
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'work-item-row';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'work-item';
    button.dataset.workTask = creation ? entry.draftId : entry.deckPath;
    if (!creation) button.dataset.recentDeck = entry.deckPath;
    button.dataset.locked = String(Boolean(entry.locked));
    button.title = creation
      ? `继续 ${entry.title} · ${entry.projectRoot}`
      : `继续 ${entry.deckPath}`;
    const copy = document.createElement('span');
    copy.className = 'work-item-copy';
    const name = document.createElement('strong');
    const displayName = workItemName(kind, entry);
    name.textContent = displayName;
    const detail = document.createElement('small');
    const needsRebind = Boolean(!creation && entry.binding && entry.binding.state !== 'bound');
    detail.textContent = creation
      ? `${entry.runtimeState === 'background' ? 'Agent 后台运行 · ' : ''}`
        + `${entry.locked ? '其他窗口正在使用 · ' : ''}${entry.progress} · ${entry.projectName}`
      : `${needsRebind ? '需要重新绑定 · 工作副本已保存 · ' : ''}`
        + `${entry.runtimeState === 'background' ? 'Agent 后台运行 · ' : ''}`
        + `${entry.progress || '继续编辑'} · ${entry.directory}`;
    copy.append(name, detail);
    const time = document.createElement('time');
    time.dateTime = creation ? entry.updatedAt : entry.modifiedAt;
    time.textContent = formatModifiedAt(time.dateTime);
    button.append(copy, time);
    button.addEventListener('click', () => void openSelectedProject(entry, linked => creation
      ? resumeCreationTask(linked) : resumeDeckTask(linked)));
    const actions = document.createElement('span');
    actions.className = 'work-item-actions';
    if (needsRebind) {
      const rebind = document.createElement('button');
      const sourceReplaced = entry.binding.reason === 'replaced';
      rebind.type = 'button';
      rebind.className = 'work-item-rebind';
      rebind.textContent = sourceReplaced ? '查找原文件' : '重新绑定';
      rebind.setAttribute('aria-label', `重新绑定 ${displayName} 的源文件`);
      rebind.title = sourceReplaced
        ? '当前位置已是另一份文件，请选择原来的物理文件'
        : '选择改名或移动后的同一份 HTML 文件';
      applyPill(rebind, { variant:'primary', size:'sm', kind:'action' });
      rebind.addEventListener('click', () => void rebindWorkTask(entry, rebind));
      actions.append(rebind);
    }
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'work-item-edit';
    rename.dataset.renameWork = entry.workId;
    rename.setAttribute('aria-label', `重命名 ${displayName}`);
    rename.title = '只修改 Editor 中显示的工作项名称';
    rename.append(createPencilIcon());
    applyPill(rename, { variant:'secondary', size:'md', kind:'icon' });
    rename.addEventListener('click', () => beginWorkItemRename(kind, entry, row));
    const dismiss = document.createElement('button');
    dismiss.type = 'button';
    dismiss.className = 'work-item-delete';
    dismiss.dataset.dismissWork = creation ? 'creation' : 'editing';
    dismiss.setAttribute('aria-label', `移除项目 ${displayName}`);
    dismiss.title = '移除项目并归档关联会话，保留内容文件';
    dismiss.append(createTrashIcon('work-item-delete-icon-default'));
    applyPill(dismiss, { variant:'danger', size:'md', kind:'icon' });
    dismiss.addEventListener('click', () => void dismissWorkTask(kind, entry, dismiss));
    actions.append(rename, dismiss);
    row.append(button, actions);
    list.append(row);
  }
}

async function rebindWorkTask(entry, button) {
  if (state !== 'idle') return;
  button.disabled = true;
  const sourceReplaced = entry.binding?.reason === 'replaced';
  setState(
    'choosing-rebind',
    sourceReplaced
      ? '当前位置已是另一份文件，请选择原来的 Deck HTML…'
      : '请选择改名或移动后的同一份 Deck HTML…',
    'working',
  );
  historyStatus('editing', '工作副本安全保留；正在等待选择源文件…', 'working');
  try {
    const result = await post('/api/work-items/choose-rebind-file', {
      workId:entry.workId,
    });
    if (result.status === 'cancelled') {
      await loadWorkHistory();
      setState('idle', '已取消重新绑定；工作副本仍安全保留');
      historyStatus('editing', '仍需重新绑定后才能固化', 'error');
      return;
    }
    if (result.status !== 'rebound' || !result.workItem) {
      throw new Error('重新绑定没有返回有效工作项');
    }
    await loadWorkHistory();
    setState('idle', '源文件已重新绑定，正在恢复原编辑会话…', 'working');
    await resumeDeckTask(result.workItem);
  } catch (error) {
    await loadWorkHistory();
    const message = error.message || (sourceReplaced
      ? '所选文件不是原来的物理文件；当前位置的同名文件不能直接替代原文件'
      : '重新绑定失败，请确认选择的是原来的物理文件');
    setState('idle', message, 'error');
    historyStatus('editing', message, 'error');
  }
}

async function dismissWorkTask(kind, entry, button) {
  if (state !== 'idle') return;
  if (entry.lifecycle !== 'removing' && !window.confirm(`移除项目“${entry.displayName}”？\n将归档关联的 ${entry.dshBinding?.sessions?.length ?? 0} 段会话，并移除项目入口。内容文件和历史记录保留。原装宿主按会话逐项归档，失败可重试；恢复项目后需新建会话。`)) return;
  button.disabled = true;
  historyStatus(kind, '正在移除项目并归档会话…', 'working');
  let pending;
  try {
    pending = (await post('/api/project-lifecycle/begin', { workId:entry.workId, expectedRevision:entry.revision })).workItem;
    const removal = pending.removal;
    let result = { changedSessionIds:[] };
    if (removal.sessionIds.length) {
      if (!dshBridge) throw Object.assign(new Error('请在 AICO-Harness 中移除此项目，以归档关联会话'), { code:'HOST_LIFECYCLE_UNAVAILABLE' });
      result = await dshBridge.request('project-sessions', { operationId:removal.operationId, sessionIds:removal.sessionIds, action:'archive' });
    }
    await post('/api/project-lifecycle/complete', { workId:entry.workId, operationId:removal.operationId, changedSessionIds:result.changedSessionIds });
    await loadWorkHistory();
    historyStatus(kind, '项目已移除，关联会话已归档；内容文件保留');
  } catch (error) {
    if (pending && ['PROJECT_BUSY', 'project/busy', 'HOST_LIFECYCLE_UNAVAILABLE'].includes(error.code)) {
      await post('/api/project-lifecycle/cancel', { workId:entry.workId, operationId:pending.removal.operationId, expectedRevision:pending.revision }).catch(() => {});
    }
    await loadWorkHistory();
    button.disabled = false;
    historyStatus(kind, error.message || '项目移除尚未完成，请在已移除项目中重试', 'error');
  }
}

function renderRemovedProjects(entries) {
  let section = document.getElementById('removed-projects');
  if (!section) {
    section = document.createElement('details');
    section.id = 'removed-projects';
    historyUi.editingList.parentElement.append(section);
  }
  section.replaceChildren();
  section.hidden = entries.length === 0;
  const summary = document.createElement('summary');
  summary.textContent = `已移除项目（${entries.length}）`;
  section.append(summary);
  for (const entry of entries) {
    const row = document.createElement('div');
    row.className = 'work-item';
    const label = document.createElement('span');
    label.textContent = entry.displayName;
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = entry.restoreOperation ? '重试恢复会话' : entry.lifecycle === 'removing' ? '重试移除' : '恢复项目';
    button.addEventListener('click', async () => {
      if (entry.lifecycle === 'removing') return dismissWorkTask(entry.kind, entry, button);
      button.disabled = true;
      try {
        if (entry.restoreOperation) {
          if (!dshBridge) throw new Error('请在 AICO-Harness 中重试恢复会话');
          await dshBridge.request('restore-linked-session', { sessionId:entry.restoreOperation.sessionId });
          await loadWorkHistory();
          return;
        }
        const { workItem } = await post('/api/project-lifecycle/restore', { workId:entry.workId, expectedRevision:entry.revision });
        await loadWorkHistory();
        window.location.assign(workspaceTaskNavigationUrl(workItem.kind, workItem));
      } catch (error) {
        historyStatus(entry.kind, error.message, 'error');
        button.disabled = false;
      }
    });
    row.append(label, button);
    section.append(row);
  }
}

async function loadWorkHistory() {
  try {
    const result = await requestJson('/api/work-history?bindings=metadata');
    dshWorkHistory = result;
    publishCreationDshWorkContext({ refreshHistory:false });
    renderRemovedProjects(result.removed ?? []);
    renderWorkList('creation', Array.isArray(result.creation) ? result.creation : []);
    renderWorkList('editing', Array.isArray(result.editing) ? result.editing : []);
    historyStatus('creation');
    historyStatus('editing');
  } catch (error) {
    historyUi.creationList.replaceChildren();
    historyUi.editingList.replaceChildren();
    for (const list of [historyUi.creationList, historyUi.editingList]) {
      const message = document.createElement('p');
      message.className = 'work-empty';
      message.textContent = '任务历史读取失败，可继续使用右下角的新任务入口。';
      list.append(message);
    }
    historyStatus('creation', error.message || '任务历史读取失败', 'error');
    historyStatus('editing', error.message || '任务历史读取失败', 'error');
  }
}

function renderCandidate(value) {
  candidate = value;
  deckName.textContent = value.deckName;
  projectRoot.textContent = value.projectRoot.path;
  projectSource.textContent = ({
    persisted:'已保存目录',
    explicit:'用户选择',
    'launch-cwd':'启动目录',
    'git-root':'Git 根目录',
    'workspace-marker':'工作区标记',
    'deck-directory':'Deck 所在目录',
  })[value.projectRoot.source] ?? value.projectRoot.source;
  projectWarning.textContent = value.projectRoot.warning ?? '';
  projectWarning.hidden = !value.projectRoot.warning;
  confirmationRow.hidden = !value.projectRoot.needsConfirmation;
  confirmationInput.checked = false;
  if (isAgentProviderId(value.provider)) {
    provider.value = value.provider;
  }
  confirmation.hidden = false;
  addButton.hidden = true;
  showExistingFlow();
  setState('deck-selected', '确认项目目录后打开编辑器');
}

let projectSelectionBusy = false;
async function openSelectedProject(entry, navigate, { confirmed = false } = {}) {
  if (projectSelectionBusy) return false;
  projectSelectionBusy = true;
  try {
    return await withDshNavigationSuppressed(async () => {
      if (embeddedDsh && deckTaskCoordinator) {
        const sessionId = linkedProjectSession(entry);
        if (sessionId) {
          if (dshCurrentSession?.sessionId !== sessionId || entry.dshBinding.activeSessionId !== sessionId) {
            entry = (await deckTaskCoordinator.activate({workItem:entry, sessionId})).workItem;
          }
        }
        else {
          if (!confirmed && !await confirmProjectSession(entry)) return false;
          entry = await createDshWorkSession(entry, [
            '/aico-ppt', '', '这是用户明确选择项目并确认创建的独立任务会话。',
            `Work Item：${entry.workId}`, `项目目录：${entry.projectRoot}`,
            entry.kind === 'editing' ? `Deck：${entry.deckPath}` : `Draft：${entry.draftId}`,
            '后续仅处理此工作项，不沿用其他项目或普通会话的上下文。',
          ].join('\n'));
        }
      }
      await navigate(entry);
      return true;
    });
  } catch (error) {
    historyStatus(entry.kind, `无法打开项目：${error.message}`, 'error');
    return false;
  } finally { projectSelectionBusy = false; }
}

async function resumeDeckTask(entry) {
  if (state !== 'idle') return;
  setState('resuming-deck', '正在恢复 Deck 工作区…', 'working');
  historyStatus('editing', '正在恢复工作副本与 Agent 上下文…', 'working');
  try {
    entry = await activateLinkedDshSession(entry);
    const result = await post('/api/resume-deck', {
      workId:entry.workId,
      deckPath:entry.deckPath,
    });
    if (result.status === 'deck-selected') {
      renderCandidate(result);
      setStatus('需要确认项目目录后继续原任务');
      return;
    }
    if (result.status !== 'selected' || !result.editorUrl) throw new Error('编辑器没有返回有效地址');
    state = 'selected';
    historyStatus('editing', `正在打开 ${result.deckName}…`, 'working');
    releaseStartupVisuals();
    launcherLeaseHandedOff = true;
    window.location.replace(editorNavigationUrl(result.editorUrl));
  } catch (error) {
    candidate = null;
    confirmation.hidden = true;
    addButton.hidden = false;
    const message = error.code === 'SESSION_LOCKED'
      ? '这项任务已在另一个编辑器窗口打开，请切换到那个窗口；关闭它后可在这里重试。'
      : error.message || 'Deck 任务恢复失败';
    // 先刷新列表、再写错误。loadWorkHistory 会清空状态栏，顺序反过来会让
    // “另一窗口占用”只闪一下，用户既看不清原因也不知道如何恢复。
    await loadWorkHistory();
    setState('idle', message, 'error');
    historyStatus('editing', message, 'error');
  }
}

async function resumeCreationTask(entry) {
  if (state !== 'idle') return;
  setState('resuming-draft', '正在恢复 Creation Draft…', 'working');
  historyStatus('creation', '正在恢复 Draft、里程碑与 Agent 对话…', 'working');
  try {
    const result = await post('/api/resume-creation-draft', {
      projectRoot:entry.projectRoot,
      draftId:entry.draftId,
    });
    if (result.status !== 'building' || !result.draft) throw new Error('Draft 没有返回有效状态');
    creationDraft = result.draft;
    activeCreationWorkItem = result.workItem ?? entry;
    creationDshPrompt = result.dshPrompt ?? '';
    state = 'building';
    enterCreationBuilder(result.terminal?.provider ?? creationDraft.provider);
    if (embeddedDsh) {
      workspaceStatus('正在恢复任务会话…', 'working');
      // 切换或恢复工作项只激活已关联会话，不产生新的 Agent 消息。
      // 初始上下文只在明确创建会话时发送一次。
      activeCreationWorkItem = await activateLinkedDshSession(activeCreationWorkItem);
      updateCreationDshSessionStatus();
      workspaceStatus('Creation Draft 与 DSH 任务会话已恢复');
    }
  } catch (error) {
    setState('idle', error.message || 'Creation Draft 恢复失败', 'error');
    historyStatus('creation', error.message || 'Creation Draft 恢复失败', 'error');
    void loadWorkHistory();
  }
}

existingDeckButton.addEventListener('click', () => {
  if (!appReady || state !== 'idle') return;
  showExistingFlow();
});

backHomeButton.addEventListener('click', () => void returnToLanding('existing'));

creationUi.newDeck.addEventListener('click', () => {
  if (!appReady || state !== 'idle') return;
  showCreationFlow();
});

creationUi.creationBack.addEventListener('click', () => void returnToLanding('creation'));

async function chooseExistingDeck() {
  if (!['idle', 'deck-selected'].includes(state)) return;
  const previousCandidate = candidate;
  setState('choosing-deck', '系统文件选择器已打开', 'working');
  try {
    const result = await post('/api/choose-deck', {});
    if (result.status === 'cancelled') {
      if (previousCandidate) setState('deck-selected', '已取消，仍使用当前 Deck');
      else setState('idle', '已取消，可以重新添加');
      return;
    }
    if (result.status !== 'deck-selected') throw new Error('没有返回有效的 Deck 候选');
    renderCandidate(result);
  } catch (error) {
    if (previousCandidate) {
      setState('deck-selected', error.message || '重新选择失败，请重试', 'error');
    } else {
      setState('idle', error.message || '添加失败，请重试', 'error');
    }
  }
}

addButton.addEventListener('click', chooseExistingDeck);
changeDeckButton.addEventListener('click', chooseExistingDeck);

changeProjectButton.addEventListener('click', async () => {
  if (state !== 'deck-selected' || !candidate) return;
  setState('choosing-project', '系统目录选择器已打开', 'working');
  try {
    const result = await post('/api/choose-agent-project', {
      candidateNonce:candidate.candidateNonce,
      selectionRevision:candidate.selectionRevision,
    });
    if (result.status === 'cancelled') {
      setState('deck-selected', '已取消更改，仍使用当前项目目录');
      return;
    }
    renderCandidate(result);
    setStatus('项目目录已更新');
  } catch (error) {
    setState('deck-selected', error.message || '无法更改项目目录', 'error');
  }
});

openButton.addEventListener('click', async () => {
  if (state !== 'deck-selected' || !candidate) return;
  if (candidate.projectRoot.needsConfirmation && !confirmationInput.checked) {
    setStatus('请先确认这个项目目录范围', 'error');
    confirmationInput.focus();
    return;
  }
  setState('starting-editor', '正在启动编辑器', 'working');
  try {
    const result = await post('/api/open-deck', {
      candidateNonce:candidate.candidateNonce,
      selectionRevision:candidate.selectionRevision,
      provider:provider.value,
      confirmProjectRoot:confirmationInput.checked,
    });
    if (result.status !== 'selected' || !result.editorUrl) {
      throw new Error('编辑器没有返回有效地址');
    }
    if (embeddedDsh && result.workItem) {
      setStatus('正在创建这份 Deck 的独立 DSH 会话…', 'working');
      const linked = await createDshWorkSession(result.workItem, [
        '/aico-ppt', '',
        '你正在处理一个明确关联到 AICO-PPT Editor 的修改任务。',
        `Work Item：${result.workItem.workId}`,
        `项目目录：${result.workItem.projectRoot}`,
        `Deck 文件：${result.workItem.deckPath}`,
        '右侧 Editor 保持这份 Deck 的托管工作副本；后续修改请求只处理这个 Work Item，不要切换到其他 Deck。',
      ].join('\n'));
      result.workItem = linked;
    }
    state = 'selected';
    setStatus(`已锁定 ${result.deckName}，正在打开编辑器`, 'working');
    releaseStartupVisuals();
    launcherLeaseHandedOff = true;
    window.location.replace(editorNavigationUrl(result.editorUrl));
  } catch (error) {
    setState('deck-selected', error.message || '编辑器启动失败，请重试', 'error');
  }
});

function createElement(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function creationStatus(message, kind = '') {
  creationUi.status.textContent = message;
  creationUi.status.dataset.kind = kind;
}

function workspaceStatus(message, kind = '') {
  creationUi.workspaceStatus.textContent = message;
  creationUi.workspaceStatus.dataset.kind = kind;
}

function setCreationChoiceState(nextState, message, kind = '') {
  state = nextState;
  creationUi.chooseProject.disabled = !['idle', 'creation-project-selected'].includes(nextState);
  creationUi.changeProject.disabled = nextState !== 'creation-project-selected';
  creationUi.createDraft.disabled = nextState !== 'creation-project-selected';
  creationUi.provider.disabled = nextState !== 'creation-project-selected';
  creationStatus(message, kind);
}

function renderCreationCandidate(value) {
  creationCandidate = value;
  creationUi.projectRoot.textContent = value.projectRoot.path;
  creationUi.projectSource.textContent = ({
    explicit:'用户选择', persisted:'已保存目录', 'git-root':'Git 根目录',
    'workspace-marker':'工作区标记', 'deck-directory':'Deck 所在目录',
  })[value.projectRoot.source] ?? value.projectRoot.source;
  creationUi.projectWarning.textContent = value.projectRoot.warning ?? '';
  creationUi.projectWarning.hidden = !value.projectRoot.warning;
  creationUi.projectConfirmation.hidden = !value.projectRoot.needsConfirmation;
  creationUi.confirmProject.checked = false;
  creationUi.confirmation.hidden = false;
  creationUi.chooseProject.hidden = true;
  setCreationChoiceState('creation-project-selected', '确认目录后创建 Draft');
}

async function chooseCreationProject() {
  if (!['idle', 'creation-project-selected'].includes(state)) return;
  const previousState = state;
  setCreationChoiceState('choosing-creation-project', '系统目录选择器已打开', 'working');
  try {
    const result = await post('/api/choose-creation-project', {});
    if (result.status === 'cancelled') {
      if (previousState === 'creation-project-selected' && creationCandidate) {
        setCreationChoiceState(previousState, '已取消更改，仍使用当前目录');
      } else {
        setCreationChoiceState('idle', '已取消，可以重新选择');
      }
      return;
    }
    renderCreationCandidate(result);
  } catch (error) {
    setCreationChoiceState(previousState, error.message || '无法选择项目目录', 'error');
  }
}

creationUi.chooseProject.addEventListener('click', chooseCreationProject);
creationUi.changeProject.addEventListener('click', chooseCreationProject);

creationUi.createDraft.addEventListener('click', async () => {
  if (state !== 'creation-project-selected' || !creationCandidate) return;
  if (creationCandidate.projectRoot.needsConfirmation && !creationUi.confirmProject.checked) {
    creationStatus('请先确认这个项目目录范围', 'error');
    creationUi.confirmProject.focus();
    return;
  }
  setCreationChoiceState('creating-draft', '正在创建 Draft 并启动 Agent…', 'working');
  let result;
  try {
    result = await post('/api/creation-drafts', {
      candidateNonce:creationCandidate.candidateNonce,
      selectionRevision:creationCandidate.selectionRevision,
      provider:creationUi.provider.value,
      confirmProjectRoot:creationUi.confirmProject.checked,
    });
  } catch (error) {
    setCreationChoiceState('creation-project-selected', error.message || 'Draft 创建失败', 'error');
    return;
  }
  creationDraft = result.draft;
  activeCreationWorkItem = result.workItem ?? null;
  creationDshPrompt = result.dshPrompt ?? '';
  state = 'building';
  enterCreationBuilder(result.terminal?.provider ?? creationUi.provider.value);
  if (embeddedDsh) {
    workspaceStatus('正在创建独立的 DSH Workspace 与任务会话…', 'working');
    try {
      activeCreationWorkItem = await createDshWorkSession(
        activeCreationWorkItem,
        creationDshPrompt,
      );
      updateCreationDshSessionStatus();
      workspaceStatus('项目目录、Creation Draft 与 DSH 任务会话已关联');
    } catch (error) {
      workspaceStatus(`Draft 已保存，但任务会话尚未就绪：${error.message}`, 'error');
    }
  }
});



function enterCreationBuilder(providerName) {
  creationUi.startShell.hidden = true;
  creationUi.builder.hidden = false;
  supportNavigation.hidden = true;
  creationUi.workspaceNavigation.hidden = false;
  exitEditorButton.hidden = false;
  exitEditorButton.disabled = false;
  if (!embeddedDsh && !creationTerminalPanel) {
    creationTerminalPanel = new AgentTerminalPanel(creationUi.terminalRoot, {
      token,
      editorToken:token,
      onClose:() => {
        creationTerminalPanel.hide();
        creationUi.builder.dataset.terminalHidden = 'true';
        creationUi.terminalReopen.hidden = false;
      },
      onState:terminalState => {
        if (terminalState?.interactionRequired?.kind) {
          ensureCreationTerminalOpen(terminalState.provider);
        }
      },
    });
  }
  creationUi.builder.dataset.terminalHidden = String(embeddedDsh);
  creationUi.terminalReopen.hidden = true;
  if (embeddedDsh) creationUi.terminalRoot.hidden = true;
  else creationTerminalPanel.open(providerName);
  creationUi.dshTaskSession.hidden = !embeddedDsh;
  connectCreationEvents();
  renderCreationDraft();
}

function creationWorkItemDisplayName() {
  if (activeCreationWorkItem?.nameSource === 'custom') {
    return activeCreationWorkItem.displayName;
  }
  return creationDraft?.brief?.title
    || activeCreationWorkItem?.displayName
    || '未命名 Deck';
}

async function syncActiveCreationWorkItem() {
  if (!creationDraft) return null;
  const history = await requestJson('/api/work-history');
  activeCreationWorkItem = history.creation?.find(entry => (
    entry.draftId === creationDraft.draftId
    && entry.projectRoot === creationDraft.projectRoot
  )) ?? null;
  renderCreationDraft();
  return activeCreationWorkItem;
}

function closeCreationTitleEditor() {
  creationUi.draftTitleForm.hidden = true;
  creationUi.draftTitleButton.hidden = false;
}

creationUi.draftTitleButton.addEventListener('click', async () => {
  if (!activeCreationWorkItem) {
    try { await syncActiveCreationWorkItem(); } catch {}
  }
  if (!activeCreationWorkItem) {
    workspaceStatus('工作项身份尚未就绪，请稍后再试', 'error');
    return;
  }
  creationUi.draftTitleInput.value = creationWorkItemDisplayName();
  creationUi.draftTitleButton.hidden = true;
  creationUi.draftTitleForm.hidden = false;
  creationUi.draftTitleInput.focus();
  creationUi.draftTitleInput.select();
});
creationUi.draftTitleCancel.addEventListener('click', closeCreationTitleEditor);
creationUi.draftTitleInput.addEventListener('keydown', event => {
  if (event.key === 'Escape') closeCreationTitleEditor();
});
creationUi.draftTitleForm.addEventListener('submit', async event => {
  event.preventDefault();
  if (!activeCreationWorkItem) return;
  creationUi.draftTitleInput.disabled = true;
  creationUi.draftTitleSave.disabled = true;
  creationUi.draftTitleCancel.disabled = true;
  workspaceStatus('正在保存工作项名称…', 'working');
  try {
    const result = await post('/api/work-items/rename', {
      workId:activeCreationWorkItem.workId,
      displayName:creationUi.draftTitleInput.value,
      expectedRevision:activeCreationWorkItem.revision,
    });
    activeCreationWorkItem = result.workItem;
    closeCreationTitleEditor();
    renderCreationDraft();
    workspaceStatus('工作项名称已更新；Brief 标题和输出文件名未改变');
  } catch (error) {
    workspaceStatus(error.message || '工作项改名失败', 'error');
    creationUi.draftTitleInput.focus();
    creationUi.draftTitleInput.select();
  } finally {
    creationUi.draftTitleInput.disabled = false;
    creationUi.draftTitleSave.disabled = false;
    creationUi.draftTitleCancel.disabled = false;
  }
});

new WorkspaceSwitcher({
  root:creationUi.workspaceNavigation,
  trigger:creationUi.switchWorkspace,
  loadHistory:() => requestJson('/api/work-history'),
  isCurrent:(kind, entry) => kind === 'creation'
    && creationDraft?.draftId === entry.draftId
    && creationDraft?.projectRoot === entry.projectRoot,
  onRename:input => post('/api/work-items/rename', input),
  onSelect:async (kind, entry) => {
    creationUi.switchWorkspace.disabled = true;
    creationUi.home.disabled = true;
    const moved = await openSelectedProject(entry, linked => location.replace(workspaceTaskNavigationUrl(kind, linked)));
    if (!moved) {
      creationUi.switchWorkspace.disabled = false;
      creationUi.home.disabled = false;
    }
    return moved;
  },
});
creationUi.home.addEventListener('click', () => navigateFromCreation('home'));
exitEditorButton.addEventListener('click', terminateEditorProcess);

creationUi.terminalReopen.addEventListener('click', () => {
  ensureCreationTerminalOpen(creationDraft?.provider);
});

creationUi.dshSession?.addEventListener('change', async () => {
  const sessionId = creationUi.dshSession.value;
  if (!activeCreationWorkItem || !deckTaskCoordinator || !sessionId || creationDshSessionBusy) return;
  creationDshSessionBusy = true;
  void updateCreationDshSessionStatus();
  workspaceStatus('正在切换此 Deck 的活动任务会话…', 'working');
  try {
    const result = await withDshNavigationSuppressed(() => deckTaskCoordinator.activate({
      workItem:activeCreationWorkItem,
      sessionId,
    }));
    activeCreationWorkItem = result.workItem;
    workspaceStatus('已切换此 Deck 的活动任务会话');
  } catch (error) {
    workspaceStatus(error.message || '无法切换任务会话', 'error');
  } finally {
    creationDshSessionBusy = false;
    void updateCreationDshSessionStatus();
  }
});

async function createCurrentCreationDshWorkSession({ workId, contextKey } = {}) {
  if (!activeCreationWorkItem || !deckTaskCoordinator) throw new Error('当前 Deck 任务尚未就绪');
  const currentKey = `${activeCreationWorkItem.workId}:${activeCreationWorkItem.dshBinding?.revision ?? activeCreationWorkItem.revision}`;
  if (workId !== activeCreationWorkItem.workId || contextKey !== currentKey) {
    throw new Error('当前 Deck 已切换，请从左侧“新会话”重新选择');
  }
  if (creationDshSessionBusy) throw new Error('任务会话正在处理中，请稍候');
  creationDshSessionBusy = true;
  void updateCreationDshSessionStatus();
  workspaceStatus('正在为此 Deck 新建独立 DSH 会话…', 'working');
  try {
    activeCreationWorkItem = await createDshWorkSession(
      activeCreationWorkItem,
      creationDshPrompt || [
        '/aico-ppt', '',
        `这是用户为 AICO-PPT Creation Work Item 明确新建的任务会话：${activeCreationWorkItem.workId}。`,
        `项目目录：${activeCreationWorkItem.projectRoot}`,
        `Creation Draft：${activeCreationWorkItem.draftId}`,
        '请读取现有 Draft 状态；等待用户指令后再处理当前任务，不要自行追加操作。',
      ].join('\n'),
    );
    updateCreationDshSessionStatus();
    workspaceStatus('新的任务会话已创建并设为活动会话');
    return {
      workId:activeCreationWorkItem.workId,
      sessionId:activeCreationWorkItem.dshBinding.activeSessionId,
    };
  } catch (error) {
    workspaceStatus(error.message || '无法创建任务会话', 'error');
    throw error;
  } finally {
    creationDshSessionBusy = false;
    void updateCreationDshSessionStatus();
  }
}

function ensureCreationTerminalOpen(providerName = creationDraft?.provider) {
  if (!creationTerminalPanel) return false;
  const hidden = creationUi.builder.dataset.terminalHidden === 'true'
    || creationUi.terminalRoot.hidden;
  if (!hidden) return false;
  creationUi.builder.dataset.terminalHidden = 'false';
  creationUi.terminalReopen.hidden = true;
  creationTerminalPanel.open(providerName);
  return true;
}

function connectCreationEvents() {
  if ([WebSocket.OPEN, WebSocket.CONNECTING].includes(creationEvents?.readyState)) return;
  const url = new URL('/creation-events', location.href);
  url.protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  url.searchParams.set('token', token);
  url.searchParams.set('editorToken', token);
  creationEvents = new WebSocket(url);
  creationEvents.addEventListener('message', event => {
    let message;
    try { message = JSON.parse(String(event.data)); } catch { message = null; }
    if (message?.type === 'agent-terminal-updated'
      && message.payload?.interactionRequired?.kind) {
      ensureCreationTerminalOpen(message.payload.provider);
    }
    if (message?.type === 'dsh-creation-request'
      && typeof message.payload?.requestId === 'string'
      && typeof message.payload?.sessionId === 'string'
      && typeof message.payload?.prompt === 'string') {
      void dshBridge?.request('send-to-session', {
        sessionId:message.payload.sessionId,
        prompt:message.payload.prompt,
      }).then(() => post('/api/creation-dsh-requests/acknowledge', {
        requestId:message.payload.requestId,
        accepted:true,
      })).catch(error => post('/api/creation-dsh-requests/acknowledge', {
        requestId:message.payload.requestId,
        accepted:false,
        message:error.message || 'DSH 会话没有接收 Creation 提示词',
      }).catch(() => {}));
    }
    scheduleCreationRefresh();
  });
  creationEvents.addEventListener('close', () => {
    creationEvents = null;
    if (state === 'building') setTimeout(connectCreationEvents, 600);
  });
}

function scheduleCreationRefresh() {
  clearTimeout(creationRefreshTimer);
  creationRefreshTimer = setTimeout(async () => {
    try {
      const next = await requestJson('/api/creation-draft');
      if (!creationDraft || next.revision >= creationDraft.revision) {
        creationDraft = next;
        renderCreationDraft();
      }
    } catch { /* 断线后由 WebSocket 重连或下一次事件恢复 */ }
  }, 40);
}

function fallbackMilestones(draft) {
  const complete = (value, state) => ({ complete:value, state:value ? 'complete' : state });
  const brief = draft.briefConfirmedRevision !== null;
  const outline = draft.outlineStatus === 'confirmed' && draft.outlineConfirmedRevision !== null;
  const pagePlan = draft.pagePlanStatus === 'confirmed' && draft.pagePlanConfirmedRevision !== null;
  const deck = Boolean(
    draft.generation?.stagingDeck
    && ['editing', 'verifying', 'published'].includes(draft.generation.status),
  );
  return {
    brief:complete(brief, 'active'),
    outline:complete(outline, draft.outlineStatus === 'stale' ? 'stale' : brief ? 'active' : 'pending'),
    pagePlan:complete(pagePlan, draft.pagePlanStatus === 'stale' ? 'stale' : outline ? 'active' : 'pending'),
    deck:complete(deck, draft.generation?.status === 'failed'
      ? 'failed' : draft.generation?.status === 'preparing'
        ? 'working' : pagePlan ? 'active' : 'pending'),
  };
}

const milestoneDetails = {
  brief:{
    pending:'等待开始对话',
    active:'正在通过对话了解需求',
    complete:'brief.json 已写入',
    stale:'需求变化，等待重新确认',
  },
  outline:{
    pending:'等待需求共识',
    active:'Agent 正在组织大纲',
    complete:'outline.json 已写入',
    stale:'上游变化，等待重写',
  },
  pagePlan:{
    pending:'等待大纲共识',
    active:'Agent 正在拆分页面',
    complete:'page-plan.json 已写入',
    stale:'上游变化，等待重写',
  },
  deck:{
    pending:'等待页面规划',
    active:'等待生成独立 Deck',
    working:'正在创建独立 Deck',
    complete:'deck-ready.json 已写入',
    failed:'生成失败，可在对话中重试',
  },
};

function renderMilestones(milestones) {
  for (const node of document.querySelectorAll('[data-milestone]')) {
    const key = node.dataset.milestone;
    const milestone = milestones[key] ?? { state:'pending', complete:false };
    const nextState = key === 'deck' && creationDraft?.generation?.status === 'failed'
      ? 'failed' : milestone.complete ? 'complete' : milestone.state ?? 'pending';
    node.dataset.state = nextState;
    const detail = node.querySelector('[data-milestone-detail]');
    detail.textContent = milestoneDetails[key]?.[nextState] ?? '等待 Agent 更新';
    detail.title = milestone.path ?? '';
  }
}

function generationStatusCopy(generation) {
  const copies = {
    editing:'Agent 正在制作，可继续在右侧讨论',
    verifying:'正在独立验证 Deck',
    published:'已验证并发布，可进入微调编辑器',
    failed:'生成或验证失败，请在对话中让 Agent 修复',
  };
  return copies[generation?.status] ?? '独立 Deck 已载入';
}

function renderCreationDraft() {
  if (!creationDraft) return;
  const milestones = creationDraft.milestones ?? fallbackMilestones(creationDraft);
  const hasDeck = Boolean(creationDraft.previewDeck?.path && milestones.deck?.complete);
  const workItemName = creationWorkItemDisplayName();
  creationUi.draftTitle.textContent = workItemName;
  creationUi.draftTitleButton.setAttribute('aria-label', `重命名工作项 ${workItemName}`);
  let providerLabel = creationDraft.provider;
  try { providerLabel = agentProviderDefinition(creationDraft.provider).label; } catch {}
  creationUi.draftRevision.textContent = 'Revision ' + creationDraft.revision + ' · '
    + providerLabel;
  renderMilestones(milestones);

  creationUi.builder.dataset.hasDeck = String(hasDeck);
  creationUi.dshCompanion.hidden = !embeddedDsh || hasDeck;
  updateCreationDshSessionStatus();
  creationUi.deckStage.hidden = !hasDeck;
  if (hasDeck) {
    creationUi.deckStageTitle.textContent = creationDraft.brief?.title || '未命名 Deck';
    creationUi.deckStageStatus.textContent = generationStatusCopy(creationDraft.generation);
    creationUi.openGenerated.hidden = creationDraft.phase !== 'ready';
    const nextKey = creationDraft.previewDeck.editorUrl
      ?? creationDraft.previewDeck.path + ':' + creationDraft.previewDeck.revision;
    if (creationPreviewKey !== nextKey) {
      creationPreviewKey = nextKey;
      workspaceStatus('正在刷新 Deck 画布…', 'working');
      const previewUrl = creationDraft.previewDeck.editorUrl;
      if (previewUrl && new URLSearchParams(location.search).get('aicoTransport') === '1') {
        const request = new URL('/_aico/ppt-view', location.href);
        request.searchParams.set('token', token);
        request.searchParams.set('url', previewUrl);
        void fetch(request).then(async response => {
          if (!response.ok) throw new Error(`预览地址解析失败：HTTP ${response.status}`);
          const value = await response.json();
          if (creationPreviewKey === nextKey) creationUi.deckPreview.src = value.url;
        }).catch(error => {
          if (creationPreviewKey === nextKey) { creationPreviewKey = null; workspaceStatus(error.message, 'error'); }
        });
      } else creationUi.deckPreview.src = previewUrl
        ?? '/creation-deck-preview?token='
          + encodeURIComponent(token) + '&revision='
          + encodeURIComponent(creationDraft.previewDeck.revision);
    }
  } else {
    creationPreviewKey = null;
    creationUi.openGenerated.hidden = true;
    creationUi.deckPreview.removeAttribute('src');
    workspaceStatus('');
  }

  if (creationHasDeck !== hasDeck) {
    creationHasDeck = hasDeck;
    requestAnimationFrame(() => creationTerminalPanel?.open(creationDraft.provider));
  }
}

creationUi.deckPreview.addEventListener('load', () => {
  if (creationHasDeck) workspaceStatus('Deck 画布已同步');
});

creationUi.openGenerated.addEventListener('click', async () => {
  workspaceStatus('正在把当前 Agent 会话交给编辑器…', 'working');
  try {
    const result = await post('/api/creation-draft/open-editor');
    state = 'selected';
    releaseStartupVisuals();
    launcherLeaseHandedOff = true;
    window.location.replace(editorNavigationUrl(result.editorUrl));
  } catch (error) {
    workspaceStatus(error.message || '无法打开编辑器', 'error');
  }
});

async function resumeCreationDraft() {
  try {
    creationDraft = await requestJson('/api/creation-draft');
    state = 'building';
    enterCreationBuilder(creationDraft.provider);
    void syncActiveCreationWorkItem().catch(() => {});
    return true;
  } catch (error) {
    if (error.code !== 'CREATION_DRAFT_NOT_FOUND') {
      creationStatus(error.message || '无法恢复 Creation Draft', 'error');
    }
    return false;
  }
}

window.addEventListener('pagehide', () => {
  pageIsClosing = true;
  launcherLeaseClient?.close();
  if (!launcherLeaseHandedOff) {
    navigator.sendBeacon('/api/close?token=' + encodeURIComponent(token)
      + '&clientId=' + encodeURIComponent(launcherClientId)
      + '&sequence=' + encodeURIComponent(launcherClientSequence));
  }
  releaseStartupVisuals();
});

let navigationError = null;
const requestedWorkspaceTask = launchParams.get('switchKind') === 'creation'
  && launchParams.get('projectRoot') && launchParams.get('draftId')
  ? {
      kind:'creation',
      workId:launchParams.get('workId'),
      projectRoot:launchParams.get('projectRoot'),
      draftId:launchParams.get('draftId'),
    }
  : launchParams.get('switchKind') === 'editing' && launchParams.get('deckPath')
    ? {
        kind:'editing', deckPath:launchParams.get('deckPath'),
        workId:launchParams.get('workId'),
      }
    : null;
if (isLeavingWorkspace) {
  try {
    await post('/api/leave-workspace', {
      destination:requestedWorkspaceView ?? 'home',
    });
  } catch (error) {
    navigationError = error;
  }
  const cleanUrl = new URL('/app/', location.origin);
  cleanUrl.searchParams.set('token', token);
  if (embeddedDsh) {
    cleanUrl.searchParams.set('embedded', 'dsh');
    cleanUrl.searchParams.set('parentOrigin', dshParentOrigin);
  }
  if (requestedWorkspaceView) cleanUrl.searchParams.set('view', requestedWorkspaceView);
  history.replaceState(null, '', cleanUrl);
}

const connectedState = await launcherLeasePromise ?? await post('/api/client-connected', {
  clientId:launcherClientId,
  sequence:launcherClientSequence,
});
if (requestedWorkspaceTask && !navigationError) {
  showLanding();
  const resume = entry => entry.kind === 'creation' ? resumeCreationTask(entry) : resumeDeckTask(entry);
  if (embeddedDsh && launchParams.get('createProjectSession') === '1') {
    const history = await requestJson('/api/work-history');
    const entry = [...history.creation, ...history.editing].find(item => item.workId === requestedWorkspaceTask.workId);
    if (entry) await openSelectedProject(entry, resume, {confirmed:true});
    else historyStatus(requestedWorkspaceTask.kind, '项目已变化，请重新选择。', 'error');
  } else await resume(requestedWorkspaceTask);
} else if (!isLeavingWorkspace
  && connectedState.status === 'selected' && connectedState.editorUrl) {
  releaseStartupVisuals();
  launcherLeaseHandedOff = true;
  window.location.replace(editorNavigationUrl(connectedState.editorUrl));
} else if (!isLeavingWorkspace && connectedState.status === 'deck-selected') {
  renderCandidate(connectedState);
} else if (!isLeavingWorkspace && connectedState.status === 'creation-project-selected') {
  showCreationFlow();
  renderCreationCandidate(connectedState);
} else if (!await resumeCreationDraft()) {
  if (requestedWorkspaceView === 'creation') showCreationFlow();
  else if (requestedWorkspaceView === 'editing') showExistingFlow();
  else showLanding();
  if (navigationError) {
    if (requestedWorkspaceView === 'creation') {
      creationStatus(navigationError.message || '暂时无法切换项目', 'error');
    } else if (requestedWorkspaceView === 'editing') {
      setStatus(navigationError.message || '暂时无法切换项目', 'error');
    } else {
      historyStatus('creation', navigationError.message || '暂时无法返回初始页', 'error');
    }
  }
  void loadWorkHistory();
}
requestedProjectNavigationPending = false;
startStartupVisuals();
const { createSupportCenter } = await import(
  `/app/support-center.mjs?token=${encodeURIComponent(token)}`
);
createSupportCenter({
  requestJson,
  post,
  getAppState:() => state,
  onSampleCreated:result => {
    renderCandidate(result);
    setStatus('示例副本已创建；确认项目目录和 Agent 后打开编辑器。');
  },
});
// 会话恢复可能切换页面；只在最后一次初始化导航完成后开放入口。
appReady = true;
syncLandingButtons();
document.documentElement.dataset.appReady = 'true';
// Editing 跳转在目标随机端口提交页面前仍停留在当前路由文档；此时保留遮罩，
// 避免浏览器在 location.replace 与真正换页之间重新露出启动页。
if (!launcherLeaseHandedOff) {
  delete document.documentElement.dataset.workspaceNavigationState;
}
