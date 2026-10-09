/** 所有只读检查使用同一物化候选；不写工作副本、不移动历史游标。 */
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {createHash} from 'node:crypto';
import {materializePatchBytes,verifyWorkingPatchReplay} from './working-deck-store.mjs';

export async function withEffectiveDeck({bytes,actions,pythonExecutable},use) {
  const htmlBytes=await materializePatchBytes(bytes,actions,{pythonExecutable});
  const directory=await mkdtemp(join(tmpdir(),'aico-ppt-effective-'));
  const path=join(directory,'deck.html');
  try {
    await writeFile(path,htmlBytes,{mode:0o600});
    return await use({path,bytes:htmlBytes,stateId:createHash('sha256').update(htmlBytes).digest('hex')});
  } finally {await rm(directory,{recursive:true,force:true});}
}

export function verifyEffectiveDeck(input,{verify=verifyWorkingPatchReplay,droppableActionIds=[]}={}) {
  return withEffectiveDeck(input,async candidate=>({
    ...await verify(candidate.path,{droppableActionIds}),stateId:candidate.stateId,
  }));
}

/** 候选先在临时文件验证，成功后才替换工作副本，避免验证失败污染基线。 */
export async function writeVerifiedWorkingPatches(store, patches, {
  verify=verifyWorkingPatchReplay, droppableActionIds=[],
}={}) {
  if(!Array.isArray(patches)||!Array.isArray(droppableActionIds)
    ||droppableActionIds.some(id=>typeof id!=='string'||!id))throw new TypeError('补丁和可清理动作标识必须是数组');
  const before=store.fingerprint;
  const bytes=await store.read();
  let effective=structuredClone(patches);
  const allowed=new Set(droppableActionIds), dropped=[];
  while(true) {
    let repairs=[];
    const result=await withEffectiveDeck({bytes,actions:effective,pythonExecutable:store.pythonExecutable},async candidate=>{
      try { repairs=(await verify(candidate.path,{droppableActionIds}))?.droppedActionIds??[]; }
      catch(error) {
        if(error?.code==='PATCH_REPLAY_FAILED'
          && ['PAGE_NOT_FOUND','TARGET_NOT_FOUND'].includes(error.replayCode)
          && allowed.has(error.failedActionId)) repairs=[error.failedActionId];
        else throw error;
      }
      if(!Array.isArray(repairs)||new Set(repairs).size!==repairs.length
        ||repairs.some(id=>!allowed.has(id)||!effective.some(action=>action.id===id))) {
        throw Object.assign(new Error('补丁验证器返回了未授权或不存在的清理动作'),{code:'INVALID_PATCH_REPAIR',statusCode:500});
      }
      if(repairs.length)return null;
      const written=await store.replace(candidate.bytes,before);
      return {...written,previousFingerprint:before,effectivePatches:effective,droppedActionIds:dropped};
    });
    if(result)return result;
    const remove=new Set(repairs);effective=effective.filter(action=>!remove.has(action.id));dropped.push(...repairs);
  }
}
