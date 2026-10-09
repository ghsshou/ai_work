/** 恢复未发布候选混入工作副本的情况，保留权威时间线和撤销游标。 */
import { isDeepStrictEqual } from 'node:util';
import { withEffectiveDeck } from './effective-deck.mjs';

export async function recoverStagedPatches(state, store, { verify, pythonExecutable } = {}) {
  if (state.sourceEdit || !store.managed || !Array.isArray(store.embeddedPatches)) return null;
  const entries = state.timeline?.entries ?? [];
  // 源码历史可能已把动作物化进 DOM；本恢复只处理可以证明来源的纯动作历史。
  if (entries.some(entry => entry.mutation?.kind !== 'actions')) return null;
  const pending = new Map(entries.flatMap(entry => entry.mutation.actions ?? []).map(action => [action.id, action]));
  const overlapping = store.embeddedPatches.filter(action => pending.has(action.id));
  if (!overlapping.length) return null;
  for (const embedded of overlapping) {
    const action = pending.get(embedded.id);
    const target = value => ({ pageKey:value?.pageKey, editorId:value?.editorId, tag:value?.tag, textPath:value?.textPath });
    if (!action.target?.editorId || action.kind !== embedded.kind
      || !isDeepStrictEqual(action.payload, embedded.payload)
      || !isDeepStrictEqual(target(action.target), target(embedded.target))) {
      throw Object.assign(new Error('工作副本候选与未固化历史不一致，保留现场等待恢复'), { code:'RECOVERY_REQUIRED', statusCode:503 });
    }
  }
  const ids = new Set(overlapping.map(action => action.id));
  const baseline = store.embeddedPatches.filter(action => !ids.has(action.id));
  const before = store.fingerprint;
  return withEffectiveDeck({ bytes:await store.read(), actions:baseline, pythonExecutable }, async candidate => {
    if (verify) await verify(candidate.path);
    await store.replace(candidate.bytes, before);
    return { code:'STAGED_PATCHES_RECOVERED', actionIds:[...ids], previousFingerprint:before, restoredFingerprint:store.fingerprint };
  });
}
