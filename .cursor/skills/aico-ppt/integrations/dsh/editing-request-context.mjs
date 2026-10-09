/** 同轮使用首次执行时的目标快照；浏览导航不改变已发起的请求。 */
const anchors=new WeakMap();
export function editingRequestAnchor(agent,context) {
  const turn=agent?.session.snapshotEvents?.().findLast(event=>event.type==='turn/start')?.seq;
  if(!agent||turn===undefined)return context.view??null;
  const key=JSON.stringify([context.workId,turn]);
  if(anchors.get(agent)?.key!==key)anchors.set(agent,{key,view:structuredClone(context.view??null)});
  return anchors.get(agent).view;
}
