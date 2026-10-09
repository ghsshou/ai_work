/** 只使用同一工作区内仍可用的显式关联，不能借用当前普通会话。 */
export function linkedProjectSession(workItem) {
  const binding = workItem?.dshBinding;
  const links = binding?.sessions?.filter(link => link.state === 'available'
    && link.workspaceId === binding.workspaceId) ?? [];
  return links.find(link => link.sessionId === binding.activeSessionId)?.sessionId
    ?? links.at(-1)?.sessionId ?? null;
}

/** 打开旧项目之前由用户明确决定是否新建专属会话。取消没有导航或模型消息副作用。 */
export function confirmProjectSession(workItem) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.setAttribute('aria-label', '此项目尚未关联会话');
    dialog.style.cssText = 'max-width:440px;width:calc(100vw - 64px);padding:24px;border:1px solid #ddd;border-radius:16px;background:#fff;color:#202124;box-shadow:0 16px 64px #0003;font:15px/1.6 system-ui';
    const title = document.createElement('h2');
    title.style.cssText = 'margin:0 0 12px;font-size:20px';
    title.textContent = '此项目尚未关联会话';
    const description = document.createElement('p');
    description.textContent = `为“${workItem.displayName || workItem.deckName || '此项目'}”创建独立会话后再打开，避免与当前对话混淆。`;
    const actions = document.createElement('div');
    actions.style.cssText = 'display:flex;justify-content:flex-end;gap:12px;margin-top:24px';
    for (const [label, value] of [['取消', 'cancel'], ['新建项目会话', 'create']]) {
      const button = document.createElement('button');
      button.type = 'button';button.textContent = label;
      button.style.cssText = 'padding:8px 16px;border:1px solid #ccc;border-radius:8px;font:inherit;cursor:pointer;background:'
        + (value === 'create' ? '#c7000b;color:white' : 'white;color:#333');
      button.addEventListener('click', () => dialog.close(value));
      actions.append(button);
    }
    dialog.append(title, description, actions);
    dialog.addEventListener('close', () => { const accepted = dialog.returnValue === 'create';dialog.remove();resolve(accepted); }, {once:true});
    document.body.append(dialog);
    dialog.showModal();
    actions.firstElementChild.focus();
  });
}
