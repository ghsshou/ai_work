/** 插件自己承载编辑协议，Host 只提供工具与图片附件能力。 */
import {randomUUID,createHash} from 'node:crypto';
import {editingRequestAnchor} from './editing-request-context.mjs';
import {LOCAL_EDIT_KINDS} from '../../scripts/editor/local-edit.mjs';
import {readWorkspaceCapability} from '../../scripts/editor/workspace-capability.mjs';

export function installEditingTools(ctx,appUrl,{request=fetch}={}) {
  if(!ctx.tools?.register)return;
  const endpoint=new URL('/api/dsh-work-items/editing-context',appUrl);
  endpoint.searchParams.set('token',new URL(appUrl).searchParams.get('token'));
  ctx.tools.register({
    name:'aico_ppt',
    description:'操作当前会话关联的 PPT。任务列表用 tasks；用户明确要求删除任务时用 delete_task(taskId,expectedRevision,cancelActiveBatch:true)，只删除反馈记录不删除页面；取消批次等待用 cancel_batch。先 inspect 读取 taskId 或 pageKey/query 的目标、父容器和当前截图，再 edit 原样使用目标提交。普通编辑无需读取完整 Skill、源码或协议，不要额外改版式。edit 返回提交结果及同版本截图；已提交但检查未完成时用 view/result，禁止重交。setText payload={text}; setStyle={property,value}; translate={x,y}; resize={width,height} 或 {scale}; hide/show={}; hide 是隐藏、不补位。局部形状、模块、图片优先 structure：operations=[{target,kind,payload}]，kind=setShape(shape:triangle|rectangle|ellipse|diamond,stroke,fill,strokeWidth)、replaceFragment(html,保留原 data-editor-id)、insertFragment(html,不指定新身份)、deleteElement、duplicateElement、replaceImage(src)。structure 自动事务、完整历史验证并返回结果图，不写临时脚本、不额外 verify。批量页目录用 catalog；默认只读目标区域，需更多候选用 limit/offset 或 query。整页增删排序与共享脚本仍走源码事务。',
    parameters:{type:'object',additionalProperties:false,properties:{
      operation:{type:'string',enum:['inspect','edit','structure','view','catalog','result','verify','tasks','delete_task','cancel_batch']},
      taskId:{type:'string',description:'区域反馈任务 ID，不是 workId 或会话 ID。左侧对原任务的补充仍传原 taskId；独立新修改不传。'},
      taskRelation:{type:'string',enum:['supplement','new'],description:'由 Agent 根据用户意图判断。supplement 需原 taskId；new 不传 taskId，不完成已有任务。有未完成标注时必须明确选择，歧义先澄清。'},pageKey:{type:'string'},query:{type:'string'},
      workId:{type:'string',description:'写操作必须原样携带 inspect 返回的工作项身份，避免会话切换后修改另一份文档。'},
      detail:{type:'string',enum:['source'],description:'仅局部 HTML 替换前按需读取指定 target 的原片段，保留身份，不读全文件。'},target:{type:'object'},
      limit:{type:'integer',minimum:1,maximum:32},offset:{type:'integer',minimum:0},
      operations:{type:'array',items:{type:'object',properties:{target:{type:'object'},kind:{type:'string',enum:LOCAL_EDIT_KINDS},payload:{type:'object'}},required:['target','kind','payload']}},
      expectedRevision:{type:'integer',minimum:0},commandId:{type:'string'},cancelActiveBatch:{type:'boolean'},
      actions:{type:'array',items:{type:'object',properties:{
        target:{type:'object'},kind:{type:'string',enum:['setText','setStyle','translate','resize','hide','show']},payload:{type:'object'},
      },required:['target','kind','payload']}}
    },required:['operation']},
    output:{schema:{type:'object'},render:(_args,value)=>{
      const {imageRef,imageRefs,...text}=value;
      return [{type:'text',text:JSON.stringify(text)},...(imageRefs??(imageRef?[imageRef]:[])).map(attachment=>({type:'image',attachment}))];
    }},
    async execute(args,exec) {
      if(!args||!['inspect','edit','structure','view','catalog','result','verify','tasks','delete_task','cancel_batch'].includes(args.operation))throw new Error('无效的 PPT 操作');
      const linked=await request(endpoint,{method:'POST',headers:{'content-type':'application/json',origin:endpoint.origin},
        body:JSON.stringify({sessionId:exec.agent?.session.id}),signal:exec.signal});
      if(!linked.ok)throw new Error('无法取得当前 PPT 工作区');
      const context=await linked.json();
      if(context.status!=='ready')throw new Error('请先打开此会话关联的 PPT Editor');
      if(args.taskId&&args.taskId===context.workId)return {
        status:'invalid-target',code:'WORK_ID_NOT_TASK_ID',
        message:'传入的是工作项 ID，不是区域反馈任务 ID。当前工作区已由会话明确关联。',
        recovery:'普通查看请调用 inspect 不传 taskId；指定页面用 pageKey/query。只有明确的区域反馈任务才传它自己的 taskId。',
      };
      if(['edit','structure','delete_task','cancel_batch'].includes(args.operation)&&context.workId&&args.workId!==context.workId)return {
        committed:false,code:'WORKSPACE_CHANGED',message:'请先 inspect 当前工作项，写入时携带返回的 workId；不得把旧目标提交到另一份 PPT。',workId:context.workId,
      };
      const anchor=editingRequestAnchor(exec.agent,context);
      const capability=await readWorkspaceCapability(context.capabilityPath);
      const call=async(path,body,method)=>{
        const response=await request(new URL(path,capability.url),{method:method??(body?'POST':'GET'),
          headers:{authorization:`Bearer ${capability.token}`,'content-type':'application/json'},
          ...(body?{body:JSON.stringify(body)}:{}),signal:exec.signal});
        const value=await response.json();
        if(!response.ok)throw Object.assign(new Error(value.message??value.code),{...value,code:value.code??value.error,statusCode:response.status});
        return value;
      };
      if(args.operation==='tasks') return {workId:context.workId,revision:context.revision,tasks:context.feedbackTasks,
        activeBatch:context.agentRun?.activeBatch ?? null};
      if(args.operation==='delete_task') {
        if(!args.taskId || !Number.isSafeInteger(args.expectedRevision)) throw new Error('删除任务需要 taskId 和最新 expectedRevision');
        return call(`/api/tasks/${encodeURIComponent(args.taskId)}`,{
          expectedRevision:args.expectedRevision,cancelActiveBatch:args.cancelActiveBatch===true},'DELETE');
      }
      if(args.operation==='cancel_batch') {
        if(!Number.isSafeInteger(args.expectedRevision)) throw new Error('取消批次需要最新 expectedRevision');
        return call('/api/agent-runs/cancel',{expectedRevision:args.expectedRevision,batchId:context.agentRun?.activeBatch?.id});
      }
      const picture=async(body,mode='view')=>{
        let result;
        for(let attempt=0;attempt<2;attempt++) {
          try{result=await call(mode==='view'?'/api/view':'/api/inspect',body);break;}
          catch(error){if(attempt||!['SNAPSHOT_STALE','REVISION_CONFLICT'].includes(error.code))throw error;}
        }
        const {image,...metadata}=result;
        if(!image)return {...metadata,visualStatus:'not-requested'};
        const attachments=ctx.get?.('attachments')??ctx.attachments;
        if(!attachments)return {...metadata,visualStatus:'unavailable',message:'Host 未提供图片附件服务'};
        const imageRef=await attachments.saveImage({data:Buffer.from(image,'base64'),mediaType:'image/png',name:'aico-ppt-page.png'});
        return {...metadata,imageRef,visualStatus:'ready'};
      };
      if(['inspect','view','catalog'].includes(args.operation)){
        const pageKey=args.pageKey??(args.taskId?undefined:anchor?.pageKey);
        try{return {...await picture({taskId:args.taskId,pageKey,query:args.query,limit:args.limit,offset:args.offset,detail:args.detail,target:args.target,catalogOnly:args.operation==='catalog'},args.operation==='view'?'view':'inspect'),workId:context.workId};}
        catch(error){
          if(error.code!=='EDITOR_SOLIDIFYING')throw error;
          return {status:'busy',code:error.code,message:'此 Deck 正在固化，尚未读取或修改中间副本。',recovery:'可以继续普通问答；固化完成后再 inspect 获取新版本，不要重复提交固化。'};
        }
      }
      if(args.operation==='result') {
        if(!args.commandId)throw new Error('读取结果需要 commandId');
        return call(`/api/commands/${encodeURIComponent(args.commandId)}`);
      }
      if(args.operation==='verify')return call('/api/verify',{});
      let hasReceipt=false;
      if(args.commandId){
        const previous=await call(`/api/commands/${encodeURIComponent(args.commandId)}`);
        hasReceipt=previous.committed===true;
      }
      const feedbackTasks=hasReceipt?[]:(context.feedbackTasks??[]);
      const relationError=(code,message)=>({status:'needs-task-relation',code,message,committed:false,feedbackTasks,
        recovery:'结合用户补充与最近追问自主判断：补充则传原 taskId 和 taskRelation:"supplement"；独立新修改传 taskRelation:"new" 且不传 taskId；有歧义才询问用户。已提交过的命令先用 result 查回执，不重放。'});
      if(args.taskRelation==='new'&&args.taskId)return relationError('TASK_RELATION_CONFLICT','独立新修改不能同时关联原反馈任务');
      if(args.taskRelation!==undefined&&!['supplement','new'].includes(args.taskRelation))return relationError('TASK_RELATION_CONFLICT','无效的任务归属判断');
      if(!args.taskId&&(args.taskRelation==='supplement'||(feedbackTasks.length&&args.taskRelation!=='new')))
        return relationError('TASK_RELATION_REQUIRED','尚未明确这是对哪条任务的补充，或独立新修改；未执行任何写入');
      if(!hasReceipt&&args.taskId&&Array.isArray(context.feedbackTasks)&&!feedbackTasks.some(task=>task.taskId===args.taskId))
        return relationError('TASK_RELATION_STALE','该反馈任务已结束或不属于当前工作项，请重新确认任务状态');
      const isStructure=args.operation==='structure';
      const inputActions=isStructure?args.operations:args.actions;
      if(!Number.isSafeInteger(args.expectedRevision)||!Array.isArray(inputActions)||!inputActions.length)throw new Error('修改需要 inspect 返回的 expectedRevision 与非空操作数组');
      // 将命令号返回给调用方；断线后只按同一号查回执，不自动换版本重放写操作。
      const commandId=args.commandId??randomUUID();
      const taskId=args.taskId??null;
      const actions=inputActions.map((action,index)=>{
        const hex=createHash('sha256').update(`${commandId}:${index}`).digest('hex');
        const id=`${hex.slice(0,8)}-${hex.slice(8,12)}-4${hex.slice(13,16)}-a${hex.slice(17,20)}-${hex.slice(20,32)}`;
        return {...action,id,taskId};
      });
      let committed;
      try {committed={...await call(isStructure?'/api/local-edits':'/api/actions',{
        expectedRevision:args.expectedRevision,taskId,commandId,...(isStructure?{operations:inputActions}:{actions})}),committed:true};}
      catch(error) {
        const rejected=error.committed===false || (error.committed!==true &&
          ['REVISION_CONFLICT','TASK_CHANGED','TASK_NOT_FOUND','TASK_ALREADY_COMPLETED',
            'INVALID_INPUT','EDITOR_INTERACTION_ACTIVE','SOURCE_EDIT_ACTIVE','EDITOR_SOLIDIFYING'].includes(error.code));
        return {committed:rejected?false:error.committed??null,
          commitStatus:rejected?'rejected':error.committed===true?'committed':'unknown',
          commandId,error:error.code??'TRANSPORT_ERROR',message:error.message,
          recovery:rejected
            ? '本次明确未提交，无需 result 查询。按错误核对目标任务或 Deck 状态，再 inspect 获取有效目标后决定是否编辑；无关框选和任务增删不要求暂停。'
            : '用 result 查询同一 commandId；不要直接重复提交或改用新版本'};
      }
      const affectedPages=[...new Set(inputActions.map(a=>a.target.pageKey))];
      try {
        const pictures=[];
        for(const pageKey of affectedPages.slice(0,3))pictures.push(await picture({pageKey,expectedRevision:committed.commandRevision??committed.revision}));
        const refs=pictures.map(view=>view.imageRef).filter(Boolean);
        return {...committed,commandId,workId:context.workId,affectedPages,
          imageRefs:refs,visualStatus:refs.length===pictures.length?'ready':'pending',
          views:pictures.map(({imageRef,...metadata})=>metadata),remainingViewPages:affectedPages.slice(3),
          currentViewMatchesCommit:pictures.every(view=>view.revision===(committed.commandRevision??committed.revision))};
      }catch(error){return {...committed,commandId,workId:context.workId,affectedPages,visualStatus:'pending',visualError:error.message,recovery:'修改已经提交；使用 view 查看，勿重交修改'};}
    },
  });
}
