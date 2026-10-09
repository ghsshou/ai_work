import { applyPill } from './pill-nav.mjs';

const GROUPS = [
  {
    kind:'creation', index:'01', title:'新建 Deck', description:'从零创建的进行中任务',
    empty:'暂无进行中的新建任务',
  },
  {
    kind:'editing', index:'02', title:'修改 Deck', description:'已有 Deck 的微调任务',
    empty:'暂无可继续的修改任务',
  },
];

function formatTime(value) {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return new Intl.DateTimeFormat('zh-CN', {
    month:'numeric', day:'numeric', hour:'2-digit', minute:'2-digit', hour12:false,
  }).format(date);
}

function taskCopy(kind, entry) {
  if (kind === 'creation') {
    return {
      title:entry.displayName || entry.title || '未命名 Deck',
      detail:[entry.progress, entry.projectName].filter(Boolean).join(' · '),
      timestamp:entry.updatedAt,
    };
  }
  return {
    title:entry.displayName || entry.deckName || '未命名 Deck',
    detail:[entry.progress || '继续编辑', entry.directory]
      .filter(Boolean).join(' · '),
    timestamp:entry.modifiedAt,
  };
}

export class WorkspaceSwitcher {
  constructor({ root, trigger, loadHistory, onSelect, onRename = null, isCurrent = () => false }) {
    if (!(root instanceof HTMLElement) || !(trigger instanceof HTMLButtonElement)) {
      throw new TypeError('项目切换器缺少有效挂载节点');
    }
    if (typeof loadHistory !== 'function' || typeof onSelect !== 'function') {
      throw new TypeError('项目切换器缺少数据或切换处理器');
    }
    this.root = root;
    this.trigger = trigger;
    this.loadHistory = loadHistory;
    this.onSelect = onSelect;
    this.onRename = typeof onRename === 'function' ? onRename : null;
    this.isCurrent = isCurrent;
    this.loading = false;
    this.requestId = 0;
    this.panel = document.createElement('section');
    this.panel.className = 'workspace-switcher';
    this.panel.dataset.workspaceSwitcher = '';
    this.panel.setAttribute('role', 'dialog');
    this.panel.setAttribute('aria-label', '切换到其他项目');
    this.panel.hidden = true;
    // 菜单脱离工具栏滚动裁切区域，坐标仍锚定入口。
    document.body.append(this.panel);
    this.panel.style.position = 'fixed';
    this.panel.style.zIndex = '1000';
    window.addEventListener('resize', () => this.position());
    document.addEventListener('scroll', () => this.position(), true);
    this.trigger.setAttribute('aria-haspopup', 'dialog');
    this.trigger.setAttribute('aria-expanded', 'false');
    this.trigger.addEventListener('click', () => void this.toggle());
    document.addEventListener('pointerdown', event => {
      if (!this.panel.hidden && !this.root.contains(event.target) && !this.panel.contains(event.target)) this.close();
    });
    document.addEventListener('keydown', event => {
      if (event.key !== 'Escape' || this.panel.hidden) return;
      this.close();
      this.trigger.focus();
    });
  }

  position() {
    if (this.panel.hidden) return;
    const anchor = this.trigger.getBoundingClientRect();
    const margin = 12;
    const width = Math.max(0, Math.min(430, innerWidth - margin * 2));
    const top = Math.max(margin, Math.min(anchor.bottom + 10, innerHeight - 100));
    this.panel.style.width = `${width}px`;
    this.panel.style.left = `${Math.max(margin, Math.min(anchor.left, innerWidth - width - margin))}px`;
    this.panel.style.top = `${top}px`;
    this.panel.style.maxHeight = `${Math.max(0, innerHeight - top - margin)}px`;
  }

  close() {
    this.panel.hidden = true;
    this.trigger.setAttribute('aria-expanded', 'false');
  }

  async toggle() {
    if (!this.panel.hidden) {
      this.close();
      return;
    }
    this.panel.hidden = false;
    this.position();
    this.trigger.setAttribute('aria-expanded', 'true');
    const requestId = this.requestId += 1;
    this.renderStatus('正在读取项目…', true);
    try {
      const history = await this.loadHistory();
      if (requestId === this.requestId && !this.panel.hidden) this.render(history);
    } catch (error) {
      if (requestId === this.requestId && !this.panel.hidden) {
        this.renderStatus(error.message || '项目列表读取失败，请稍后重试');
      }
    }
  }

  renderStatus(message, loading = false) {
    this.panel.replaceChildren();
    const header = this.header();
    const status = document.createElement('p');
    status.className = 'workspace-switcher-status';
    status.dataset.loading = String(loading);
    if (loading) {
      const spinner = document.createElement('span');
      spinner.className = 'workspace-switcher-spinner';
      spinner.setAttribute('aria-hidden', 'true');
      status.append(spinner);
    }
    status.append(document.createTextNode(message));
    this.panel.append(header, status);
  }

  header() {
    const header = document.createElement('header');
    header.className = 'workspace-switcher-header';
    const copy = document.createElement('span');
    const title = document.createElement('strong');
    title.textContent = '切换项目';
    const description = document.createElement('small');
    description.textContent = '点击任务，直接恢复工作进度';
    copy.append(title, description);
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'workspace-switcher-close';
    close.setAttribute('aria-label', '关闭项目列表');
    close.textContent = '×';
    applyPill(close, { variant:'neutral', size:'sm', kind:'icon' });
    close.addEventListener('click', () => {
      this.close();
      this.trigger.focus();
    });
    header.append(copy, close);
    return header;
  }

  render(history) {
    this.panel.replaceChildren(this.header());
    for (const group of GROUPS) {
      const entries = Array.isArray(history?.[group.kind]) ? history[group.kind] : [];
      const section = document.createElement('section');
      section.className = 'workspace-switcher-group';
      section.dataset.workspaceSwitcherGroup = group.kind;
      const heading = document.createElement('header');
      heading.className = 'workspace-switcher-group-heading';
      const identity = document.createElement('span');
      identity.className = 'workspace-switcher-group-identity';
      const index = document.createElement('span');
      index.className = 'workspace-switcher-group-index';
      index.textContent = group.index;
      const copy = document.createElement('span');
      copy.className = 'workspace-switcher-group-copy';
      const title = document.createElement('strong');
      title.textContent = group.title;
      const description = document.createElement('small');
      description.textContent = group.description;
      copy.append(title, description);
      identity.append(index, copy);
      const count = document.createElement('span');
      count.className = 'workspace-switcher-group-count';
      count.textContent = `${entries.length} 项`;
      heading.append(identity, count);
      const list = document.createElement('div');
      list.className = 'workspace-switcher-list';
      if (entries.length === 0) {
        const empty = document.createElement('p');
        empty.className = 'workspace-switcher-empty';
        empty.textContent = group.empty;
        list.append(empty);
      } else {
        for (const entry of entries) list.append(this.taskRow(group.kind, entry));
      }
      section.append(heading, list);
      this.panel.append(section);
    }
  }

  taskRow(kind, entry) {
    const current = Boolean(this.isCurrent(kind, entry));
    const copy = taskCopy(kind, entry);
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'workspace-switcher-item';
    button.dataset.workspaceTask = kind;
    button.dataset.current = String(current);
    button.dataset.locked = String(Boolean(entry.locked && !current));
    button.dataset.runtimeState = entry.runtimeState ?? '';
    const text = document.createElement('span');
    text.className = 'workspace-switcher-item-copy';
    const titleRow = document.createElement('span');
    titleRow.className = 'workspace-switcher-item-title';
    const title = document.createElement('strong');
    title.textContent = copy.title;
    if (current || entry.runtimeState === 'background' || entry.locked) {
      const badge = document.createElement('span');
      badge.className = 'workspace-switcher-item-badge';
      badge.dataset.kind = current
        ? 'current' : entry.runtimeState === 'background' ? 'background' : 'locked';
      badge.textContent = current
        ? '当前' : entry.runtimeState === 'background' ? '后台运行' : '其他窗口';
      titleRow.append(title, badge);
    } else {
      titleRow.append(title);
    }
    const detail = document.createElement('small');
    detail.textContent = copy.detail;
    text.append(titleRow, detail);
    const meta = document.createElement('span');
    meta.className = 'workspace-switcher-item-meta';
    const time = document.createElement('time');
    time.dateTime = copy.timestamp || '';
    time.textContent = formatTime(copy.timestamp);
    meta.append(time);
    button.append(text, meta);
    button.addEventListener('click', async () => {
      if (this.loading) return;
      this.loading = true;
      this.panel.dataset.busy = 'true';
      for (const item of this.panel.querySelectorAll('button')) item.disabled = true;
      try {
        if (await this.onSelect(kind, entry) === false) {
          this.loading = false;
          this.panel.dataset.busy = 'false';
          this.close();
        }
      }
      catch (error) {
        this.loading = false;
        this.panel.dataset.busy = 'false';
        this.renderStatus(error.message || '项目切换失败，请重试');
      }
    });
    if (!this.onRename || !entry.workId) return button;
    const row = document.createElement('div');
    row.className = 'workspace-switcher-item-row';
    const rename = document.createElement('button');
    rename.type = 'button';
    rename.className = 'workspace-switcher-item-rename';
    rename.setAttribute('aria-label', `重命名 ${copy.title}`);
    rename.title = '只修改工作项显示名称';
    rename.textContent = '✎';
    applyPill(rename, { variant:'neutral', size:'sm', kind:'icon' });
    rename.addEventListener('click', () => this.beginRename(row, kind, entry, copy.title));
    row.append(button, rename);
    return row;
  }

  beginRename(row, kind, entry, currentName) {
    if (this.loading) return;
    const form = document.createElement('form');
    form.className = 'workspace-switcher-rename-form';
    const input = document.createElement('input');
    input.type = 'text';
    input.maxLength = 80;
    input.value = currentName;
    input.autocomplete = 'off';
    input.setAttribute('aria-label', '工作项名称');
    const save = document.createElement('button');
    save.type = 'submit';
    save.textContent = '保存';
    save.setAttribute('aria-label', '保存名称');
    applyPill(save, { variant:'primary', size:'sm', kind:'action' });
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = '取消';
    applyPill(cancel, { variant:'secondary', size:'sm', kind:'action' });
    const restore = () => row.replaceWith(this.taskRow(kind, entry));
    cancel.addEventListener('click', restore);
    input.addEventListener('keydown', event => {
      if (event.key === 'Escape') restore();
    });
    form.addEventListener('submit', async event => {
      event.preventDefault();
      this.loading = true;
      this.panel.dataset.busy = 'true';
      input.disabled = true;
      save.disabled = true;
      cancel.disabled = true;
      try {
        await this.onRename({
          workId:entry.workId,
          displayName:input.value,
          expectedRevision:entry.revision,
        });
        const history = await this.loadHistory();
        this.loading = false;
        this.panel.dataset.busy = 'false';
        this.render(history);
      } catch (error) {
        this.loading = false;
        this.panel.dataset.busy = 'false';
        input.disabled = false;
        save.disabled = false;
        cancel.disabled = false;
        input.setCustomValidity(error.message || '工作项改名失败');
        input.reportValidity();
        input.focus();
      }
    });
    form.append(input, save, cancel);
    row.replaceWith(form);
    input.focus();
    input.select();
  }
}
