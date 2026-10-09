const SUPPORT_TITLES = {
  onboarding:'开始使用',
  help:'帮助中心',
  diagnostics:'安装与诊断',
};
const ONBOARDING_STORAGE_KEY = 'aico-ppt-onboarding-v1';
const GUIDED_TOUR_STORAGE_KEY = 'aico-ppt-guided-tour-v1';
const GUIDED_TOUR_SEQUENCES = {
  home:[
    {
      target:'[data-tour-target="create-deck"]', placement:'right',
      title:'从零创建一份 Deck',
      copy:'选择这条路径后，先和 Agent 对齐需求、大纲和页面规划，再进入实时画布继续制作。',
    },
    {
      target:'[data-tour-target="edit-deck"]', placement:'left',
      title:'继续修改已有 Deck',
      copy:'已经有单文件 HTML 时，从这里添加。编辑器会使用托管工作副本，明确固化前不会覆盖源文件。',
    },
    {
      target:'[data-tour-target="continue-work"]', placement:'right',
      title:'从上次停下的位置继续',
      copy:'创建记录、编辑会话和 Agent 上下文都会显示在这里。点击记录即可恢复，不必重新选择文件。',
    },
    {
      target:'[data-support-navigation]', placement:'bottom',
      title:'需要时再查看帮助',
      copy:'“帮助”用于查具体操作；“安装与诊断”会按任务检查本机能力，不让可选工具阻塞基础编辑。',
    },
    {
      target:'.local-badge', placement:'bottom',
      title:'内容始终留在本机',
      copy:'Deck、Draft、附件和修改记录都保存在本机。现在可以选择一条路径，开始第一项工作。',
    },
  ],
  creation:[
    {
      target:'.milestone-rail', placement:'right',
      title:'四个里程碑自动点亮',
      copy:'需求、大纲、页面规划和 Deck 生成都由真实文件状态驱动。这里只看进度，不需要手动勾选。',
    },
    {
      target:'[data-agent-terminal]', placement:'left',
      title:'在这里和 Agent 一起制作',
      copy:'右侧是真实 Agent 终端。继续描述需求、确认大纲或提出修改，过程会保留在当前工作项中。',
    },
    {
      target:'[data-milestone="deck"]', placement:'right',
      title:'Deck 出现后画布自动展开',
      copy:'第四个里程碑完成时，中间会打开实时画布；结构制作和后续微调使用同一份托管工作副本。',
    },
    {
      target:['[data-open-generated]:not([hidden])', '[data-milestone="deck"]'], placement:'right',
      title:'完成后进入微调编辑器',
      copy:'Deck 发布后可进入标准编辑页，继续改字、移动、缩放、标注任务，并在确认后固化到正式文件。',
    },
  ],
};


function createElement(tag, className = '', text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}


function appendInlineText(parent, text) {
  for (const part of String(text).split(/(`[^`]+`)/g)) {
    if (part.startsWith('`') && part.endsWith('`')) {
      parent.append(createElement('code', '', part.slice(1, -1)));
    } else {
      parent.append(document.createTextNode(part));
    }
  }
}


function markdownCells(line) {
  return line.trim().replace(/^\||\|$/g, '').split('|').map(value => value.trim());
}


export function renderHelpMarkdown(markdown) {
  const fragment = document.createDocumentFragment();
  const lines = String(markdown).replace(/\r\n/g, '\n').split('\n');
  let list = null;
  let code = null;
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (line.startsWith('```')) {
      list = null;
      if (code) {
        code = null;
      } else {
        const pre = document.createElement('pre');
        code = document.createElement('code');
        pre.append(code);
        fragment.append(pre);
      }
      continue;
    }
    if (code) {
      code.textContent += (code.textContent ? '\n' : '') + line;
      continue;
    }
    const heading = line.match(/^(#{1,3})\s+(.+)$/);
    if (heading) {
      list = null;
      const node = document.createElement(`h${heading[1].length}`);
      appendInlineText(node, heading[2]);
      fragment.append(node);
      continue;
    }
    if (line.includes('|') && lines[index + 1]?.match(/^\s*\|?[\s:-]+\|/)) {
      list = null;
      const table = document.createElement('table');
      const head = document.createElement('thead');
      const headRow = document.createElement('tr');
      for (const value of markdownCells(line)) {
        const cell = document.createElement('th');
        appendInlineText(cell, value);
        headRow.append(cell);
      }
      head.append(headRow);
      table.append(head);
      index += 2;
      const body = document.createElement('tbody');
      while (index < lines.length && lines[index].includes('|') && lines[index].trim()) {
        const row = document.createElement('tr');
        for (const value of markdownCells(lines[index])) {
          const cell = document.createElement('td');
          appendInlineText(cell, value);
          row.append(cell);
        }
        body.append(row);
        index += 1;
      }
      index -= 1;
      table.append(body);
      fragment.append(table);
      continue;
    }
    const bullet = line.match(/^\s*[-*]\s+(.+)$/);
    const numbered = line.match(/^\s*\d+\.\s+(.+)$/);
    if (bullet || numbered) {
      const kind = numbered ? 'ol' : 'ul';
      if (!list || list.tagName.toLowerCase() !== kind) {
        list = document.createElement(kind);
        fragment.append(list);
      }
      const item = document.createElement('li');
      appendInlineText(item, (bullet || numbered)[1]);
      list.append(item);
      continue;
    }
    if (!line.trim()) {
      list = null;
      continue;
    }
    list = null;
    const paragraph = document.createElement('p');
    appendInlineText(paragraph, line);
    fragment.append(paragraph);
  }
  return fragment;
}


export function createSupportCenter({
  requestJson,
  post,
  getAppState,
  onSampleCreated,
} = {}) {
  const ui = {
    layer:document.querySelector('[data-support-layer]'),
    title:document.querySelector('[data-support-title]'),
    tabs:[...document.querySelectorAll('[data-support-tab]')],
    views:[...document.querySelectorAll('[data-support-view]')],
    openers:[...document.querySelectorAll('[data-support-open]')],
    guidedTourOpeners:[...document.querySelectorAll('[data-guided-tour]')],
    closers:[...document.querySelectorAll('[data-support-close]')],
    helpTopics:document.querySelector('[data-help-topic-list]'),
    helpArticle:document.querySelector('[data-help-article]'),
    diagnostics:document.querySelector('[data-diagnostic-groups]'),
    diagnosticsStatus:document.querySelector('[data-diagnostics-status]'),
    refreshDiagnostics:document.querySelector('[data-refresh-diagnostics]'),
    onboardingStatus:document.querySelector('[data-onboarding-status]'),
    onboardingChecks:[...document.querySelectorAll('[data-onboarding-step]')],
    createSample:document.querySelector('[data-create-sample]'),
    openDiagnostics:document.querySelector('[data-open-diagnostics]'),
    tour:document.querySelector('[data-onboarding-tour]'),
    tourSpotlight:document.querySelector('[data-tour-spotlight]'),
    tourArrowShape:document.querySelector('[data-tour-arrow-shape]'),
    tourCard:document.querySelector('[data-tour-card]'),
    tourProgress:document.querySelector('[data-tour-progress]'),
    tourTitle:document.querySelector('[data-tour-title]'),
    tourCopy:document.querySelector('[data-tour-copy]'),
    tourDots:document.querySelector('[data-tour-dots]'),
    tourPrevious:document.querySelector('[data-tour-previous]'),
    tourSample:document.querySelector('[data-tour-sample]'),
    tourNext:document.querySelector('[data-tour-next]'),
    tourSkip:document.querySelector('[data-tour-skip]'),
  };
  let helpCatalog = null;
  let activeHelpTopic = 'quick-start';
  let diagnosticsLoading = false;
  let tourSequence = 'home';
  let tourSteps = GUIDED_TOUR_SEQUENCES.home;
  let tourIndex = 0;
  let tourTarget = null;
  let tourFrame = null;

  const status = (node, message = '', kind = '') => {
    node.textContent = message;
    node.dataset.kind = kind;
  };
  const restoreProgress = () => {
    let completed = [];
    try { completed = JSON.parse(localStorage.getItem(ONBOARDING_STORAGE_KEY) || '[]'); }
    catch { completed = []; }
    for (const input of ui.onboardingChecks) {
      input.checked = completed.includes(input.dataset.onboardingStep);
    }
  };
  const saveProgress = () => {
    const completed = ui.onboardingChecks
      .filter(input => input.checked)
      .map(input => input.dataset.onboardingStep);
    try { localStorage.setItem(ONBOARDING_STORAGE_KEY, JSON.stringify(completed)); }
    catch { /* 禁用本机存储时只保留当前页面状态。 */ }
  };

  const selectTopic = topicId => {
    if (!helpCatalog) return;
    const topic = helpCatalog.topics.find(value => value.id === topicId) ?? helpCatalog.topics[0];
    activeHelpTopic = topic.id;
    for (const button of ui.helpTopics.querySelectorAll('button')) {
      button.dataset.active = String(button.dataset.helpTopic === topic.id);
    }
    ui.helpArticle.replaceChildren(renderHelpMarkdown(topic.markdown));
  };

  const loadHelp = async () => {
    if (helpCatalog) {
      selectTopic(activeHelpTopic);
      return;
    }
    ui.helpTopics.replaceChildren(createElement('p', '', '正在读取帮助内容…'));
    try {
      helpCatalog = await requestJson('/api/help-catalog');
      ui.helpTopics.replaceChildren();
      for (const topic of helpCatalog.topics) {
        const button = createElement('button');
        button.type = 'button';
        button.dataset.helpTopic = topic.id;
        button.append(
          createElement('strong', '', topic.title),
          createElement('small', '', topic.summary),
        );
        button.addEventListener('click', () => selectTopic(topic.id));
        ui.helpTopics.append(button);
      }
      selectTopic(activeHelpTopic);
    } catch (error) {
      ui.helpTopics.replaceChildren(createElement('p', '', error.message || '帮助内容读取失败'));
    }
  };

  const checksForProfile = (environment, profileId) => {
    const profile = environment.profiles[profileId];
    return (profile?.missing || []).map(key => (
      environment.checks.find(item => item.key === key)
      ?? { key, label:key, state:'manual-action-required', remediation:null }
    ));
  };

  const makeRow = ({
    label, description, detail, state, repair, guidance = [], actionLabel = '修复并复检',
  }) => {
    const row = createElement('div', 'diagnostic-row');
    row.dataset.state = state;
    const marker = createElement('span', 'diagnostic-state', state === 'ready' ? '✓' : '!');
    const copy = createElement('span', 'diagnostic-copy');
    copy.append(createElement('strong', '', label), createElement('small', '', description));
    row.append(marker, copy, createElement('span', 'diagnostic-detail', detail));
    if (repair && state !== 'ready') {
      const button = createElement('button', 'diagnostic-action', actionLabel);
      button.type = 'button';
      button.addEventListener('click', async () => {
        if (repair.confirmation && !window.confirm(repair.confirmation)) return;
        button.disabled = true;
        button.textContent = '正在修复…';
        button.setAttribute('aria-busy', 'true');
        diagnosticsLoading = true;
        ui.refreshDiagnostics.disabled = true;
        status(ui.diagnosticsStatus, `正在修复 ${label}…`, 'working');
        try {
          await post('/api/diagnostics/repair', repair);
          const snapshot = await requestJson('/api/diagnostics');
          renderDiagnostics(snapshot);
          const updated = repair.kind === 'profile'
            ? snapshot.environment.profiles[repair.profile] : null;
          if (updated?.ready || (repair.kind === 'skill' && snapshot.installation.ready)) {
            status(ui.diagnosticsStatus, `${label}已修复并通过复检。`, 'success');
          } else if (updated) {
            const remaining = checksForProfile(snapshot.environment, repair.profile);
            const names = remaining.map(item => item.label).join('、') || '未知依赖';
            status(ui.diagnosticsStatus, `已完成复检；${label}仍需处理：${names}。`, 'error');
          } else {
            status(ui.diagnosticsStatus, `${label}修复后仍未就绪，请查看目标目录。`, 'error');
          }
        } catch (error) {
          status(ui.diagnosticsStatus, error.message || `${label} 修复失败`, 'error');
        } finally {
          diagnosticsLoading = false;
          ui.refreshDiagnostics.disabled = false;
          button.disabled = false;
          button.textContent = actionLabel;
          button.removeAttribute('aria-busy');
        }
      });
      row.append(button);
    } else if (guidance.length && state !== 'ready') {
      const button = createElement('button', 'diagnostic-action', '查看安装方法');
      button.type = 'button';
      button.addEventListener('click', () => {
        status(ui.diagnosticsStatus, guidance.join('；'), 'working');
      });
      row.append(button);
    } else {
      row.append(document.createElement('span'));
    }
    return row;
  };

  const makeGroup = (title, rows) => {
    const group = createElement('section', 'diagnostic-group');
    group.append(createElement('h4', '', title), ...rows);
    return group;
  };

  const renderDiagnostics = snapshot => {
    const { environment, installation } = snapshot;
    const desktop = installation.delivery === 'desktop';
    const registration = installation.registrations?.find(item => item.host === (desktop ? 'dsh' : 'codex'));
    const skillState = registration?.state === 'ready' ? 'ready'
      : ['occupied', 'adoption-required'].includes(registration?.state)
        ? 'manual-action-required' : 'repairable';
    const adoptionRequired = registration?.state === 'adoption-required';
    const profileRow = (profileId, description) => {
      const profile = environment.profiles[profileId];
      const missing = checksForProfile(environment, profileId);
      const automatic = missing.filter(item => item.remediation?.kind === 'automatic');
      const guidance = missing
        .filter(item => item.remediation?.kind === 'manual')
        .map(item => `${item.label}：${item.remediation?.hint || item.detail || '请手动安装'}`);
      const problems = missing.map(item => (
        item.detail?.startsWith('已安装')
          ? `${item.label}（${item.detail}）` : item.label
      ));
      return makeRow({
        label:profile.label,
        description,
        detail:profile.ready ? '已就绪' : `未就绪：${problems.join('、') || '未知依赖'}`,
        state:profile.state,
        repair:!desktop && automatic.length ? { kind:'profile', profile:profileId } : null,
        guidance:desktop && !profile.ready ? ['运行环境随 AICO-PPT 插件提供，请在设置的插件页重新安装 AICO-PPT 插件。'] : guidance,
      });
    };
    ui.diagnostics.replaceChildren(
      makeGroup('基础使用', [
        makeRow({
          label:'AICO-PPT Skill',
          description:desktop ? '已安装 PPT 插件工作流' : '让 Codex 发现本仓库的工作流',
          detail:desktop ? '由 AICO-Harness 插件商店管理' : registration ? `${registration.targetPath} · ${registration.state}` : '未找到注册信息',
          state:skillState,
          repair:desktop ? null : adoptionRequired ? {
            kind:'skill',
            adoptExisting:true,
            confirmation:'目标已经指向当前 AICO-PPT 仓库。确认由安装器接管该 Skill 注册，以便后续安全修复和卸载吗？',
          } : { kind:'skill' },
          actionLabel:adoptionRequired ? '接管此安装' : '修复并复检',
        }),
        profileRow('editor-core', '启动 DSH 中的画布、任务、历史与固化运行时'),
        ...(!desktop ? [profileRow('dev-shell', '开发调试时启动本机 Agent PTY（正式 DSH 使用不需要）')] : []),
      ]),
      makeGroup('质量验证', [profileRow('verify', '截图、溢出检测和动画逐拍检查')]),
      makeGroup('导出与材料', [
        profileRow('pptx-export', '将 HTML Deck 导出为 PPTX'),
        profileRow('pptx-read', '按页读取 PPTX 文字、备注、表格和内嵌原图'),
        profileRow('materials', '读取和处理 PDF 参考材料'),
      ]),
    );
    const skillInput = ui.onboardingChecks.find(input => input.dataset.onboardingStep === 'skill');
    const agentInput = ui.onboardingChecks.find(input => input.dataset.onboardingStep === 'agent');
    const agentCheck = environment.checks.find(item => item.key === 'agent-cli');
    if (skillInput && skillState === 'ready') skillInput.checked = true;
    if (agentInput && (desktop || agentCheck?.present)) agentInput.checked = true;
    saveProgress();
  };

  async function loadDiagnostics(force = false) {
    if (diagnosticsLoading && !force) return;
    diagnosticsLoading = true;
    ui.refreshDiagnostics.disabled = true;
    ui.diagnostics.replaceChildren(createElement('p', '', '正在检查 Skill、Editor Core 和可选能力…'));
    status(ui.diagnosticsStatus, '诊断只读取本机状态，不读取 Deck 内容。', 'working');
    try {
      const snapshot = await requestJson('/api/diagnostics');
      renderDiagnostics(snapshot);
      status(ui.diagnosticsStatus, '检查完成。缺失的可选能力不会阻塞 Editor Core。');
      return snapshot;
    } catch (error) {
      ui.diagnostics.replaceChildren(createElement('p', '', '无法读取诊断结果。'));
      status(ui.diagnosticsStatus, error.message || '诊断失败', 'error');
    } finally {
      diagnosticsLoading = false;
      ui.refreshDiagnostics.disabled = false;
    }
    return null;
  }

  const clamp = (value, minimum, maximum) => Math.min(maximum, Math.max(minimum, value));
  const positionTour = () => {
    if (ui.tour.hidden || !tourTarget?.isConnected) return;
    const target = tourTarget.getBoundingClientRect();
    if (target.width <= 0 || target.height <= 0) return;
    const inset = 10;
    ui.tourSpotlight.style.left = `${target.left - inset}px`;
    ui.tourSpotlight.style.top = `${target.top - inset}px`;
    ui.tourSpotlight.style.width = `${target.width + inset * 2}px`;
    ui.tourSpotlight.style.height = `${target.height + inset * 2}px`;

    const card = ui.tourCard.getBoundingClientRect();
    const gap = 126;
    const edge = 24;
    const step = tourSteps[tourIndex];
    const positions = {
      right:{ left:target.right + gap, top:target.top + (target.height - card.height) / 2 },
      left:{ left:target.left - card.width - gap, top:target.top + (target.height - card.height) / 2 },
      bottom:{ left:target.left + (target.width - card.width) / 2, top:target.bottom + gap },
      top:{ left:target.left + (target.width - card.width) / 2, top:target.top - card.height - gap },
    };
    const preferred = positions[step.placement] ?? positions.bottom;
    const left = clamp(preferred.left, edge, window.innerWidth - card.width - edge);
    const top = clamp(preferred.top, edge, window.innerHeight - card.height - edge);
    ui.tourCard.style.left = `${left}px`;
    ui.tourCard.style.top = `${top}px`;

    const placedCard = { left, top, right:left + card.width, bottom:top + card.height };
    const cardCenter = { x:(placedCard.left + placedCard.right) / 2, y:(placedCard.top + placedCard.bottom) / 2 };
    const targetCenter = { x:target.left + target.width / 2, y:target.top + target.height / 2 };
    const delta = { x:targetCenter.x - cardCenter.x, y:targetCenter.y - cardCenter.y };
    let start;
    let end;
    if (Math.abs(delta.x) > Math.abs(delta.y)) {
      start = { x:delta.x > 0 ? placedCard.right : placedCard.left, y:cardCenter.y };
      end = { x:delta.x > 0 ? target.left - 6 : target.right + 6, y:targetCenter.y };
    } else {
      start = { x:cardCenter.x, y:delta.y > 0 ? placedCard.bottom : placedCard.top };
      end = { x:targetCenter.x, y:delta.y > 0 ? target.top - 6 : target.bottom + 6 };
    }
    const length = Math.max(70, Math.hypot(end.x - start.x, end.y - start.y));
    const angle = Math.atan2(end.y - start.y, end.x - start.x) * 180 / Math.PI;
    const thickness = clamp(length / 180, .72, 1.05);
    ui.tourArrowShape.setAttribute(
      'transform',
      `translate(${start.x} ${start.y}) rotate(${angle}) scale(${length / 196} ${thickness}) translate(0 -44)`,
    );
  };
  const queueTourPosition = () => {
    if (tourFrame !== null) cancelAnimationFrame(tourFrame);
    tourFrame = requestAnimationFrame(() => {
      tourFrame = null;
      positionTour();
    });
  };
  const renderTourStep = () => {
    const step = tourSteps[tourIndex];
    const selectors = Array.isArray(step.target) ? step.target : [step.target];
    tourTarget = selectors
      .map(selector => document.querySelector(selector))
      .find(node => {
        if (!node || node.hidden) return false;
        const rect = node.getBoundingClientRect();
        return rect.width > 0 && rect.height > 0;
      });
    if (!tourTarget) return;
    ui.tourProgress.textContent = `${String(tourIndex + 1).padStart(2, '0')} / ${String(tourSteps.length).padStart(2, '0')}`;
    ui.tourTitle.textContent = step.title;
    ui.tourCopy.textContent = step.copy;
    ui.tourPrevious.disabled = tourIndex === 0;
    const finalStep = tourIndex === tourSteps.length - 1;
    ui.tourSample.hidden = !(finalStep && tourSequence === 'home');
    ui.tourNext.textContent = finalStep ? '完成' : '下一步';
    for (const [index, dot] of [...ui.tourDots.children].entries()) {
      dot.dataset.active = String(index === tourIndex);
    }
    queueTourPosition();
    ui.tourNext.focus();
  };
  const closeTour = ({ completed=false } = {}) => {
    if (tourFrame !== null) cancelAnimationFrame(tourFrame);
    tourFrame = null;
    ui.tour.hidden = true;
    tourTarget = null;
    delete document.body.dataset.tourOpen;
    if (completed) {
      try { localStorage.setItem(GUIDED_TOUR_STORAGE_KEY, 'completed'); }
      catch { /* 禁用本机存储时不影响引导。 */ }
    }
  };
  const startTour = (sequence='home') => {
    const expectedState = sequence === 'creation' ? 'building' : 'idle';
    if (getAppState() !== expectedState || !GUIDED_TOUR_SEQUENCES[sequence]) return;
    ui.layer.hidden = true;
    delete document.body.dataset.supportOpen;
    tourSequence = sequence;
    tourSteps = GUIDED_TOUR_SEQUENCES[sequence];
    tourIndex = 0;
    ui.tourDots.replaceChildren(...tourSteps.map(() => {
      const dot = createElement('i');
      dot.setAttribute('aria-hidden', 'true');
      return dot;
    }));
    ui.tour.hidden = false;
    document.body.dataset.tourOpen = 'true';
    renderTourStep();
  };
  const changeTourStep = direction => {
    const next = tourIndex + direction;
    if (next < 0) return;
    if (next >= tourSteps.length) {
      closeTour({ completed:true });
      return;
    }
    tourIndex = next;
    renderTourStep();
  };

  const setView = name => {
    const view = SUPPORT_TITLES[name] ? name : 'onboarding';
    ui.title.textContent = SUPPORT_TITLES[view];
    for (const tab of ui.tabs) tab.dataset.active = String(tab.dataset.supportTab === view);
    for (const panel of ui.views) panel.hidden = panel.dataset.supportView !== view;
    if (view === 'help') void loadHelp();
    if (view === 'diagnostics') void loadDiagnostics();
  };
  const open = name => {
    if (name === 'onboarding') {
      startTour();
      return;
    }
    restoreProgress();
    setView(name);
    ui.layer.hidden = false;
    document.body.dataset.supportOpen = 'true';
    ui.layer.querySelector('.support-close')?.focus();
  };
  const close = () => {
    ui.layer.hidden = true;
    delete document.body.dataset.supportOpen;
  };

  for (const opener of ui.openers) opener.addEventListener('click', () => open(opener.dataset.supportOpen));
  for (const opener of ui.guidedTourOpeners) {
    opener.addEventListener('click', () => startTour(opener.dataset.guidedTour));
  }
  for (const closer of ui.closers) closer.addEventListener('click', close);
  for (const tab of ui.tabs) tab.addEventListener('click', () => {
    if (tab.dataset.supportTab === 'onboarding') {
      startTour();
      return;
    }
    setView(tab.dataset.supportTab);
  });
  for (const input of ui.onboardingChecks) input.addEventListener('change', saveProgress);
  ui.openDiagnostics.addEventListener('click', () => setView('diagnostics'));
  ui.refreshDiagnostics.addEventListener('click', () => void loadDiagnostics(true));
  const createSampleProject = async ({ fromTour=false } = {}) => {
    if (getAppState() !== 'idle') {
      if (fromTour) ui.tourCopy.textContent = '请先返回“初始页”，再创建示例副本。';
      else status(ui.onboardingStatus, '请先返回“初始页”，再创建示例副本。', 'error');
      return;
    }
    ui.createSample.disabled = true;
    ui.tourSample.disabled = true;
    if (fromTour) ui.tourSample.textContent = '请选择目录…';
    else status(ui.onboardingStatus, '请选择存放示例项目的目录…', 'working');
    try {
      const result = await post('/api/onboarding/sample', {});
      if (result.status === 'cancelled') {
        if (fromTour) ui.tourCopy.textContent = '已取消，可以稍后再试；也可以先完成引导。';
        else status(ui.onboardingStatus, '已取消，可以稍后再试。');
        return;
      }
      const sample = ui.onboardingChecks.find(input => input.dataset.onboardingStep === 'sample');
      if (sample) sample.checked = true;
      saveProgress();
      close();
      closeTour({ completed:true });
      onSampleCreated(result);
    } catch (error) {
      if (fromTour) ui.tourCopy.textContent = error.message || '示例项目创建失败';
      else status(ui.onboardingStatus, error.message || '示例项目创建失败', 'error');
    } finally {
      ui.createSample.disabled = false;
      ui.tourSample.disabled = false;
      ui.tourSample.textContent = '创建示例副本';
    }
  };
  ui.createSample.addEventListener('click', () => void createSampleProject());
  ui.tourPrevious.addEventListener('click', () => changeTourStep(-1));
  ui.tourSample.addEventListener('click', () => void createSampleProject({ fromTour:true }));
  ui.tourNext.addEventListener('click', () => changeTourStep(1));
  ui.tourSkip.addEventListener('click', () => closeTour());
  window.addEventListener('resize', queueTourPosition);
  document.addEventListener('keydown', event => {
    if (!ui.tour.hidden) {
      if (event.key === 'Escape') {
        event.preventDefault();
        closeTour();
        return;
      }
      if (event.key === 'ArrowRight') {
        event.preventDefault();
        changeTourStep(1);
        return;
      }
      if (event.key === 'ArrowLeft') {
        event.preventDefault();
        changeTourStep(-1);
        return;
      }
      if (event.key === 'Tab') {
        const controls = [ui.tourSkip, ui.tourPrevious, ui.tourSample, ui.tourNext]
          .filter(button => !button.disabled && !button.hidden);
        const current = controls.indexOf(document.activeElement);
        const offset = event.shiftKey ? -1 : 1;
        const next = (current + offset + controls.length) % controls.length;
        event.preventDefault();
        controls[next].focus();
        return;
      }
    }
    if (event.key === 'Escape' && !ui.layer.hidden) close();
  });
  restoreProgress();
  return { open, close, setView, loadDiagnostics, startTour, closeTour };
}
