import {editingRequestAnchor} from './editing-request-context.mjs';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';

/** 最新连接信息覆盖历史端口与旧的“等待区域任务”提示，不改变用户意图。 */
export function renderEditingContext(context) {
  if (context.status === 'unlinked') return '';
  const identity = `当前会话明确关联的 AICO-PPT 工作项：${JSON.stringify(context.workId)}；源文件：${JSON.stringify(context.deckPath)}。`;
  if (context.status !== 'ready') return `${identity}\n对应 Editor 工作区当前不可用。不要使用历史 capability，不另起 headless workspace，不直改源文件；请提示用户打开此会话关联的右侧 Editor 后重试。`;
  const cli = fileURLToPath(new URL('../../scripts/editor/cli.mjs', import.meta.url));
  const view=Object.hasOwn(context,'requestView')?context.requestView:context.view;
  const compactView=view?{pageKey:view.pageKey,pageIndex:view.pageIndex,selection:view.selection,revision:view.revision}:null;
  return [
    identity,
    `本轮目标参考（首次执行快照，非发送瞬间）：${JSON.stringify(compactView)}。翻页不改变本轮目标；inspect 重新校验对象。`,
    `项目资料索引：${JSON.stringify(context.project ?? {})}。只在内容创作或跨页一致性需要时展开。`,
    `未完成反馈任务：${JSON.stringify(context.feedbackTasks ?? [])}。`,
    `托管工作副本：${JSON.stringify(context.workingDeckPath)}。CLI：${JSON.stringify(cli)} --capability-file ${JSON.stringify(context.capabilityPath)}。`,
    ...(context.includeInstructions===false?[]:[
      '普通查看 inspect 不传 taskId；workId 不是 taskId。写入携带 inspect 的 workId、expectedRevision 和原 target。补充原任务传 taskRelation:"supplement" 与 taskId；独立修改传 taskRelation:"new"，不结束旧任务，歧义才澄清。',
      '文字样式位置用 edit；形状、图片、模块增删和局部 HTML 用 structure，自动事务、验证、结果图。先读目标区域，跨页任务才读 catalog 和相关页；不读取完整 Skill，不写临时脚本。成功回执无需重复 verify/task；图片待检查用 view，传输不明用 result 查同一 commandId，不重复写入。',
      '只有整页增删排序或共享 CSS/脚本修改才读取 references/editing-guide.md，并走 begin-source-task / begin-source-edit → edit-bundle.py → commit-source-edit；失败 cancel-source-edit。普通问答、讨论和分析只读。不得要求退出 Editor、关闭租约或直改真实 Deck；只有固化发布真实文件。',
      '删除反馈任务先 tasks，再 delete_task；取消批次等待用 cancel_batch，不等于停止会话或撤销已提交内容。无关标注增删改允许继续编辑；TASK_CHANGED/TASK_NOT_FOUND 核对当前任务，REVISION_CONFLICT 重新 inspect。commitStatus:rejected 明确未提交，无需 result；右侧文字输入或拖拽冲突时等待操作结束。',
    ]),
  ].join('\n');
}

/** 每步重新解析稳定会话标识，兼容旧会话、服务重启与界面切换。 */
export function installEditingContext(ctx, appUrl, { fetchContext = fetch } = {}) {
  const emitted = new WeakMap();
  const endpoint = new URL('/api/dsh-work-items/editing-context', appUrl);
  endpoint.searchParams.set('token', new URL(appUrl).searchParams.get('token'));
  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next();
    if (decision.kind === 'reject' || signal.aborted) return decision;
    let text,context;
    try {
      const response = await fetchContext(endpoint, {
        method:'POST', headers:{ 'content-type':'application/json', origin:endpoint.origin },
        body:JSON.stringify({ sessionId:agent.session.id }),
        signal:AbortSignal.any([signal, AbortSignal.timeout(5000)]),
      });
      if (!response.ok) throw new Error(`AICO-PPT 会话工作区解析失败（${response.status}）`);
      context=await response.json();
      context.requestView=editingRequestAnchor(agent,context);
      text = renderEditingContext(context);
    } catch (error) {
      if (signal.aborted) throw error;
      text = 'AICO-PPT 当前连接暂时无法确认。可以继续普通问答，但本步不要使用历史工作区凭据、不要修改或固化 Deck，也不要另起编辑器。需要操作 Deck 时请说明暂不可用，稍后重新确认连接。';
    }
    if (!text || signal.aborted) {emitted.delete(agent);return decision;}
    // 连接每步检查；同一轮、同一压缩段的稳定说明只进入一次历史。
    // 没有公开日志读取能力的宿主保持原来逐步注入的兼容行为。
    const events=agent.session.snapshotEvents?.();
    if(events) {
      let turn='',compaction='';
      for(let i=events.length-1;i>=0;i--) {
        if(!turn&&events[i].type==='turn/start')turn=String(events[i].seq);
        if(!compaction&&events[i].type==='compaction/end')compaction=String(events[i].seq);
        if(turn&&compaction)break;
      }
      const key=JSON.stringify([text,turn,compaction]);
      const previous=emitted.get(agent);
      if(previous?.key===key)return decision;
      if(context && previous?.turn===turn && previous?.compaction===compaction)text=renderEditingContext({...context,includeInstructions:false});
      emitted.set(agent,{key,turn,compaction});
    }
    // 采用 Host 的标准消息结构，不让独立插件依赖 Host 的内部 npm 包。
    const message = Object.freeze({
      id:randomUUID(), role:'user',
      content:Object.freeze([Object.freeze({ type:'text', text })]),
      source:Object.freeze({ kind:'plugin', plugin:'aico-ppt', form:'snapshot',
        sections:Object.freeze([Object.freeze({ name:'aico-ppt-workspace', text })]) }),
    });
    return { ...decision, messages:[...decision.messages, message] };
  }, { prepend:true });
}
