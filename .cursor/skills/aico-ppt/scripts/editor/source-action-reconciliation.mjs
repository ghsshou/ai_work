import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { actionKey, compileActionGroups } from './action-compiler.mjs';
import { EditTimeline } from './edit-timeline.mjs';
import { defaultPythonExecutable, pythonUtf8SpawnOptions } from './python-utf8.mjs';

const adapter = fileURLToPath(new URL('./source_action_diff.py', import.meta.url));
function template(record, fingerprint) {
  const bytes = Buffer.from(record.bytes, 'base64');
  if (createHash('sha256').update(bytes).digest('hex') !== fingerprint) throw new Error('源码对账快照指纹不一致');
  const match = bytes.toString('utf8').match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/);
  if (!match) throw new Error('源码对账快照缺少模板');
  return JSON.parse(match[1]);
}

export async function reconcileSourceActions(source, groups, io, pythonExecutable=defaultPythonExecutable()) {
  const actions = compileActionGroups(groups);
  const [before, after] = await Promise.all([
    io.readWorkingDeck({versionFingerprint:source.beforeFingerprint}),
    io.readWorkingDeck({versionFingerprint:source.afterFingerprint}),
  ]);
  const input = {before:template(before,source.beforeFingerprint),after:template(after,source.afterFingerprint),actions};
  const evidence = await new Promise((resolve,reject) => {
    const child = spawn(pythonExecutable,[adapter],pythonUtf8SpawnOptions({stdio:['pipe','pipe','pipe']}));
    let output='',error='';
    const timer=setTimeout(()=>child.kill('SIGKILL'),30_000);
    child.stdout.setEncoding('utf8');child.stderr.setEncoding('utf8');
    child.stdout.on('data',chunk=>{output+=chunk;});child.stderr.on('data',chunk=>{error+=chunk;});
    child.on('error',e=>{clearTimeout(timer);reject(e);});
    child.on('close',code=>{
      clearTimeout(timer);
      if(code!==0)return reject(new Error(`源码动作对账失败：${error}`));
      try{resolve(JSON.parse(output));}catch(e){reject(e);}
    });
    child.stdin.on('error',reject);
    child.stdin.end(JSON.stringify(input));
  });
  const ids=evidence?.superseded;
  if(!Array.isArray(ids)||ids.some(id=>!actions.some(a=>a.id===id)))throw new Error('源码动作对账结果无效');
  const resizeBaselines={};
  for(const action of actions) {
    if(action.kind!=='resize'||Object.hasOwn(action.payload,'scale'))continue;
    const value=evidence.resizeBaselines?.[action.id];
    if(value!==null&&typeof value!=='string')throw new Error('源码尺寸对账结果无效');
    resizeBaselines[actionKey(action)]=value;
  }
  return {version:2,supersededKeys:[...new Set(actions.filter(a=>ids.includes(a.id)).map(actionKey))],resizeBaselines,impact:evidence.impact};
}

// 对旧会话补充可复核的快照证据，保留全部条目、游标、任务及源版本。
export async function reconcileLegacySourceHistory(state, io, pythonExecutable) {
  if (!state.timeline?.entries.some(e=>e.mutation.kind==='source'&&e.mutation.source.actionReconciliation?.version!==2))return null;
  const candidate=structuredClone(state);
  const timeline=EditTimeline.open(candidate);
  for(let index=0;index<candidate.timeline.entries.length;index++) {
    const entry=candidate.timeline.entries[index];
    if(entry.mutation.kind!=='source'||entry.mutation.source.actionReconciliation?.version===2)continue;
    const groups=timeline.groups().slice(0,index).map(g=>({...g,active:true}));
    entry.mutation.source.actionReconciliation=await reconcileSourceActions(entry.mutation.source,groups,io,pythonExecutable);
  }
  EditTimeline.open(candidate);
  candidate.revision+=1;
  return candidate;
}
