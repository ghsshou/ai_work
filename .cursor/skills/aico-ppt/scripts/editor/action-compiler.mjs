const targetIdentity = target => target.editorId
  ? `id:${target.editorId}` : `path:${target.path}|${target.tag ?? ''}`;

export const stableTargetKey = action => (
  `${action.target.pageKey}|${targetIdentity(action.target)}|${action.target.textPath ?? ''}`
);

const stableElementKey = action => (
  `${action.target.pageKey}|${targetIdentity(action.target)}`
);

const pathParent = path => {
  const parts = String(path ?? '').split('/');
  return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
};

function normalizeGeneratedRangeTargets(groups) {
  const lineage = new Map();
  return groups.map(group => ({
    ...group,
    actions:(group.actions ?? []).map(action => {
      const range = action.kind === 'setStyle' ? action.payload?.textRange : null;
      if (!range) return action;
      let normalized = action;
      const parentPath = action.target?.tag === 'SPAN' ? pathParent(action.target.path) : null;
      const candidates = parentPath
        ? lineage.get(`${action.target.pageKey}|${parentPath}`) ?? [] : [];
      for (let index = candidates.length - 1; index >= 0; index -= 1) {
        const candidate = candidates[index];
        const candidateRange = candidate.payload.textRange;
        const candidateLength = candidateRange.end - candidateRange.start;
        if (range.start < 0 || range.end > candidateLength) continue;
        normalized = {
          ...action,
          target:candidate.target,
          payload:{
            ...action.payload,
            textRange:{
              start:candidateRange.start + range.start,
              end:candidateRange.start + range.end,
            },
          },
        };
        break;
      }
      const lineageKey = `${action.target.pageKey}|${action.target.path}`;
      const previous = lineage.get(lineageKey) ?? [];
      previous.push(normalized);
      lineage.set(lineageKey, previous);
      return normalized;
    }),
  }));
}

function normalizeRecordedTextTargets(groups) {
  const previous=[];
  return groups.map(group=>({...group,actions:(group.actions??[]).map(action=>{
    if(!group.active || action.kind!=='setText' || !action.target?.editorId
      || action.target.textPath===undefined)return action;
    const path=action.target.path.split('/'), textPath=action.target.textPath.split('/');
    const candidates=previous.filter(candidate=>{
      if(candidate.target.pageKey!==action.target.pageKey)return false;
      const childPath=candidate.target.path.split('/');
      const offset=childPath.length-path.length;
      return offset>0 && path.every((part,i)=>part===childPath[i])
        && childPath.slice(path.length).every((part,i)=>part===textPath[i])
        && textPath.slice(offset).join('/')===candidate.target.textPath
        && (candidate.after===action.before || (action.before===action.after && candidate.before===action.before));
    });
    const identities=new Map(candidates.map(candidate=>[stableTargetKey(candidate),candidate]));
    // 同一文字节点因选择父容器产生不同 locator 时，复用唯一已记录的较小目标。
    // 必须同时证明路径后缀和完整文字连续；重复文字或多个候选不做转换。
    const candidate=identities.size===1?[...identities.values()][0]:null;
    const result=candidate?{...action,target:candidate.target,payload:{text:action.payload.text}}:action;
    previous.push(result);
    return result;
  })}));
}

export const actionKey = action => {
  const kind = action.kind === 'hide' || action.kind === 'show' ? 'visibility' : action.kind;
  const textRange = action.kind === 'setStyle' ? action.payload?.textRange : null;
  const rangeKey = textRange ? `${textRange.start}:${textRange.end}` : '';
  // 宽高与 CSS scale 修改不同属性，不能共享连续值校验与折叠槽位。
  const property = action.kind === 'resize' && Object.hasOwn(action.payload ?? {}, 'scale')
    ? 'scale' : (action.payload?.property ?? '');
  return `${stableTargetKey(action)}|${kind}|${property}|${rangeKey}`;
};

const rangeStyleKey = action => (
  `${stableTargetKey(action)}|setStyle|${action.payload.property}`
);

function withTextRange(action, start, end) {
  return {
    ...action,
    payload:{ ...action.payload, textRange:{ start, end } },
  };
}

function textEditPreservesRangeStyle(textAction, styleAction) {
  const sourceRange = textAction.payload?.sourceRange;
  const styleRange = styleAction.payload?.textRange;
  if (!sourceRange || !styleRange) return false;
  if (sourceRange.start >= styleRange.end) return true;
  if (sourceRange.end > styleRange.start) return false;
  return typeof textAction.before === 'string'
    && textAction.before.length === textAction.payload.text.length;
}

function granularTextTargetsDescendant(granular, descendant) {
  if (granular.kind !== 'setText' || descendant.kind !== 'setText'
    || granular.target?.textPath === undefined
    || descendant.target?.textPath !== undefined
    || !granular.target?.editorId || !descendant.target?.editorId
    || granular.target.pageKey !== descendant.target.pageKey) return false;
  const parentPath = String(granular.target.path ?? '').split('/').filter(Boolean);
  const childPath = String(descendant.target.path ?? '').split('/').filter(Boolean);
  if (childPath.length <= parentPath.length
    || !parentPath.every((part, index) => childPath[index] === part)) return false;
  const relativePath = childPath.slice(parentPath.length);
  const textPath = String(granular.target.textPath).split('/');
  // DOM path 按 element.children 编号，textPath 按 childNodes 编号。只有两者的
  // 已记录前缀完全一致时才证明细粒度文字落在这个持久子元素内；否则保守保留。
  return textPath.length > relativePath.length
    && relativePath.every((part, index) => textPath[index] === part);
}

function canonicalizeMergedTextBranches(groups) {
  const entries = [];
  for (const [groupIndex, group] of groups.entries()) {
    for (const [actionIndex, action] of (group.actions ?? []).entries()) {
      entries.push({ group, groupIndex, actionIndex, action, index:entries.length });
    }
  }
  const suppressed = new Set();
  const replacements = new Map();
  for (const rangeEntry of entries) {
    const range = rangeEntry.action;
    const textRange = range.kind === 'setStyle' ? range.payload?.textRange : null;
    const child = rangeEntry.group.actions?.[rangeEntry.actionIndex + 1];
    if (rangeEntry.group?.active !== true
      || range.payload?.property !== 'font-size' || range.payload?.value !== '0px'
      || !textRange || !Number.isSafeInteger(textRange.start)
      || !Number.isSafeInteger(textRange.end)
      || child?.kind !== 'setText' || child.target?.textPath !== undefined
      || typeof child.before !== 'string'
      || textRange.start !== child.before.length
      || !granularTextTargetsDescendant({
        kind:'setText', target:{ ...range.target, textPath:'0/0' },
      }, child)) continue;

    const earlier = entries.filter(entry => entry.index < rangeEntry.index
      && entry.group?.active === true && !suppressed.has(entry.action));
    const childBaseline = earlier.findLast(entry => (
      actionKey(entry.action) === actionKey(child)
      && Object.hasOwn(entry.action, 'after')
      && sameCanonicalValue(entry.action.after, child.before)
      && Object.hasOwn(entry.action, 'before')
    ));
    const hiddenLength = textRange.end - textRange.start;
    const trailingBaseline = earlier.findLast(entry => {
      const candidate = entry.action;
      return candidate.kind === 'setText'
        && candidate.target?.textPath !== undefined
        && stableElementKey(candidate) === stableElementKey(range)
        && !granularTextTargetsDescendant(candidate, child)
        && typeof candidate.after === 'string'
        && candidate.after.length === hiddenLength
        && Object.hasOwn(candidate, 'before');
    });
    if (!childBaseline || !trailingBaseline) continue;

    const branchStart = Math.max(childBaseline.index, trailingBaseline.index);
    const trailingKey = actionKey(trailingBaseline.action);
    for (const entry of entries) {
      if (entry.index <= branchStart || entry.index >= rangeEntry.index
        || entry.group?.active !== true) continue;
      if (actionKey(entry.action) === trailingKey
        || granularTextTargetsDescendant(entry.action, child)) {
        suppressed.add(entry.action);
      }
    }
    replacements.set(range, {
      ...trailingBaseline.action,
      id:range.id,
      taskId:range.taskId,
      kind:'setText',
      payload:{ text:'' },
      before:structuredClone(trailingBaseline.action.before),
      after:'',
      ...(Object.hasOwn(range, 'appliedAt') ? { appliedAt:range.appliedAt } : {}),
    });
  }
  if (suppressed.size === 0 && replacements.size === 0) return groups;
  return groups.map(group => ({
    ...group,
    actions:(group.actions ?? [])
      .filter(action => !suppressed.has(action))
      .map(action => replacements.get(action) ?? action),
  }));
}

function overlayRangeStyle(segments, action) {
  const { start, end } = action.payload.textRange;
  const next = [];
  for (const segment of segments) {
    const range = segment.payload.textRange;
    if (range.end <= start || range.start >= end) {
      next.push(segment);
      continue;
    }
    if (range.start < start) next.push(withTextRange(segment, range.start, start));
    if (range.end > end) next.push(withTextRange(segment, end, range.end));
  }
  next.push(action);
  next.sort((left, right) => (
    left.payload.textRange.start - right.payload.textRange.start
      || left.payload.textRange.end - right.payload.textRange.end
  ));
  const merged = [];
  for (const segment of next) {
    const previous = merged.at(-1);
    if (previous
      && previous.payload.value === segment.payload.value
      && previous.payload.textRange.end === segment.payload.textRange.start) {
      previous.payload.textRange.end = segment.payload.textRange.end;
    } else {
      merged.push(withTextRange(
        segment, segment.payload.textRange.start, segment.payload.textRange.end,
      ));
    }
  }
  return merged;
}

function compactRangeStyles(actions) {
  const buckets = new Map();
  const output = [];
  for (const action of actions) {
    if (action.kind !== 'setStyle' || !action.payload?.textRange) {
      output.push({ action });
      continue;
    }
    const key = rangeStyleKey(action);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = { segments:[] };
      buckets.set(key, bucket);
      output.push({ bucket });
    }
    bucket.segments = overlayRangeStyle(bucket.segments, action);
  }
  return output.flatMap(item => item.action ? [item.action] : item.bucket.segments);
}

function sameCanonicalValue(left, right) {
  if (Object.is(left, right)) return true;
  if (!left || !right || typeof left !== 'object' || typeof right !== 'object'
    || Array.isArray(left) !== Array.isArray(right)) return false;
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  return leftKeys.length === rightKeys.length
    && leftKeys.every((key, index) => key === rightKeys[index]
      && sameCanonicalValue(left[key], right[key]));
}

function activeSourceSegment(groups) {
  const sourceIndex = groups.findLastIndex(group => (
    group?.active === true && group?.mutationType === 'source'
  ));
  if (sourceIndex < 0) return { sourceIndex:-1, endIndex:groups.length };
  const nextSourceOffset = groups.slice(sourceIndex + 1)
    .findIndex(group => group?.mutationType === 'source');
  return {
    sourceIndex,
    endIndex:nextSourceOffset < 0 ? groups.length : sourceIndex + 1 + nextSourceOffset,
  };
}

function sourceSupersededActionKeys(groups, sourceIndex, endIndex) {
  if (sourceIndex < 0) return new Set();
  const beforeSource = new Map();
  const beforeSourceByElement = new Map();
  for (const group of groups.slice(0, sourceIndex)) {
    if (group?.active !== true) continue;
    for (const action of group.actions ?? []) {
      beforeSource.set(actionKey(action), action);
      const elementKey = stableElementKey(action);
      const elementActions = beforeSourceByElement.get(elementKey) ?? [];
      elementActions.push(action);
      beforeSourceByElement.set(elementKey, elementActions);
    }
  }
  const superseded = new Set();
  const inspected = new Set();
  for (const group of groups.slice(sourceIndex + 1, endIndex)) {
    for (const action of group.actions ?? []) {
      const key=actionKey(action);
      // 只有源码之后该属性的第一个 before 能说明源码是否覆盖旧值。
      // 第二次拖动的 before 是第一次拖动的 after，不能拿它与源码前末值比较。
      if(inspected.has(key))continue;
      inspected.add(key);
      const previous = beforeSource.get(key);
      if (previous && Object.hasOwn(action, 'before') && Object.hasOwn(previous, 'after')
        && !sameCanonicalValue(action.before, previous.after)) {
        superseded.add(actionKey(action));
        if (action.kind === 'setText' && action.target?.textPath === undefined) {
          for (const candidate of beforeSourceByElement.get(stableElementKey(action)) ?? []) {
            if (candidate.kind === 'setText') superseded.add(actionKey(candidate));
          }
        }
      }
    }
  }
  return superseded;
}

function continuousSourceActions(groups, sourceIndex, superseded) {
  const keys = new Set();
  const ids = new Set();
  const elements = new Set();
  const targets = new Map();
  if (sourceIndex < 0) return { keys, ids, elements, targets };
  for (const group of groups.slice(0, sourceIndex)) {
    if (group?.active !== true) continue;
    for (const action of group.actions ?? []) {
      const key = actionKey(action);
      if (superseded.has(key)) continue;
      if (typeof action.id === 'string' && action.id) ids.add(action.id);
      // 新的源码后动作 ID 只有在持久 editorId 能证明仍是同一元素时，
      // 才能继承源码前动作链；单靠可变 DOM path 不足以放宽指纹匹配。
      if (action.target?.editorId) {
        keys.add(key);
        elements.add(stableElementKey(action));
      }
      if (action.target?.editorId && !targets.has(key)) {
        const { textPath: _textPath, ...elementTarget } = action.target;
        targets.set(key, elementTarget);
      }
    }
  }
  return { keys, ids, elements, targets };
}

// 源码前后快照已证明被覆盖的槽位只退出投影；原历史仍支持顺序撤销。
function applySourceReconciliations(groups) {
  const overridden = new Set();
  const resizeBaselines = new Map();
  return [...groups].reverse().map(group => {
    const actions = (group.actions ?? []).filter(action => !overridden.has(actionKey(action))).map(action => {
      const basis=resizeBaselines.get(actionKey(action));
      return typeof basis==='string' ? {...action,sourceResizeStyle:basis} : action;
    });
    if (group.active && group.mutationType === 'source') {
      for (const key of group.source?.actionReconciliation?.supersededKeys ?? []) overridden.add(key);
      for(const [key,value] of Object.entries(group.source?.actionReconciliation?.resizeBaselines ?? {})) {
        if(!resizeBaselines.has(key))resizeBaselines.set(key,value);
        else if(resizeBaselines.get(key)!==value)resizeBaselines.set(key,null);
      }
    }
    return { ...group, actions };
  }).reverse();
}

export function compileActionGroups(groups = []) {
  const normalizedGroups = normalizeGeneratedRangeTargets(
    canonicalizeMergedTextBranches(normalizeRecordedTextTargets(applySourceReconciliations(groups))),
  );
  const { sourceIndex, endIndex } = activeSourceSegment(normalizedGroups);
  const superseded = sourceSupersededActionKeys(
    normalizedGroups, sourceIndex, endIndex,
  );
  const continuous = continuousSourceActions(
    normalizedGroups, sourceIndex, superseded,
  );
  const stableTargets = new Map();
  const postSourceTargets = new Set();
  for (const [groupIndex, group] of normalizedGroups.entries()) {
    if (groupIndex >= endIndex) break;
    for (const action of group.actions ?? []) {
      const key = stableElementKey(action);
      const firstAfterSource = sourceIndex >= 0 && groupIndex > sourceIndex
        && !postSourceTargets.has(key);
      if (!stableTargets.has(key) || firstAfterSource) {
        const { textPath: _textPath, ...elementTarget } = action.target;
        stableTargets.set(key, elementTarget);
        if (firstAfterSource) postSourceTargets.add(key);
      }
    }
  }

  const final = new Map();
  for (const [groupIndex, group] of normalizedGroups.entries()) {
    if (!group.active) continue;
    for (const action of group.actions ?? []) {
      if (groupIndex < sourceIndex && superseded.has(actionKey(action))) continue;
      let bridgedBefore;
      let hasBridgedBefore = false;
      if (action.kind === 'setText') {
        const elementKey = stableElementKey(action);
        if(action.target?.editorId && action.target.textPath === undefined) {
          for(const [key,earlier] of final) {
            // 同一持久元素的整段替换覆盖旧文字节点分支。整段起始值必须
            // 等于该节点记录的完整前值/后值，不能只按 path 或字符串包含推断。
            if(earlier.kind==='setText' && earlier.target.textPath !== undefined
              && stableElementKey(earlier)===elementKey
              && typeof action.before==='string'
              && (earlier.before===action.before || earlier.after===action.before)) {
              final.delete(key);
              if(!final.has(actionKey(action))) {
                bridgedBefore=structuredClone(earlier.before);
                hasBridgedBefore=true;
              }
            }
          }
        }
        for (const [key, previous] of final) {
          if (previous.kind === 'setStyle'
            && previous.payload?.textRange
            && stableElementKey(previous) === elementKey
            && !textEditPreservesRangeStyle(action, previous)) {
            // 局部格式使用旧文字的字符偏移。后续文字替换后这些偏移不再具有
            // 稳定语义；继续发布会让离线补丁在预解析阶段 TARGET_AMBIGUOUS。
            // 已知修改位于格式段之后，或位于之前但长度不变时，原范围仍安全；
            // 其他情况保持保守淘汰。之后新建的局部格式会重新进入最终动作集。
            final.delete(key);
          }
        }
        const key = actionKey(action);
        const previous = final.get(key);
        const branches = action.target?.textPath === undefined && previous
          ? [...final.entries()].filter(([, candidate]) => (
            granularTextTargetsDescendant(candidate, action)
            && Object.hasOwn(candidate, 'before')
            && Object.hasOwn(candidate, 'after')
            && Object.hasOwn(previous, 'before')
            && Object.hasOwn(previous, 'after')
            && Object.hasOwn(action, 'before')
            && sameCanonicalValue(candidate.before, previous.after)
            && sameCanonicalValue(action.before, previous.after)
          )) : [];
        if (branches.length === 1) {
          const [branchKey, branch] = branches[0];
          // 子元素动作和父级 textPath 动作从同一个中间值分叉时，按记录顺序
          // 直接压缩会把最终子元素动作提前到父级分支之前。把最早基线迁给
          // 父级分支、再让最终子元素动作接续其 after，既保留最后写入结果，
          // 也维持后续局部格式 locator 赖以成立的中间 DOM。
          final.set(branchKey, {
            ...branch,
            before:structuredClone(previous.before),
          });
          final.delete(key);
          bridgedBefore = structuredClone(branch.after);
          hasBridgedBefore = true;
        }
      }
      const key = actionKey(action);
      const previous = final.get(key);
      const continuousTarget = continuous.targets.get(key);
      final.set(key, {
        ...action,
        ...(typeof previous?.sourceResizeStyle==='string' && action.sourceResizeStyle===undefined
          ? {sourceResizeStyle:previous.sourceResizeStyle} : {}),
        // 同一属性的连续动作只发布最终值，但离线固化和
        // replace 撤销必须从这条链的最早基线重放，不能把中间态
        // 误当成 Deck 基线。源码修改判定为 superseded 时，旧动作
        // 已在上方跳过，因此不会把跨源码边界的旧 before 带进来。
        ...(hasBridgedBefore
          ? { before:bridgedBefore }
          : (previous && Object.hasOwn(previous, 'before')
            ? { before:structuredClone(previous.before) } : {})),
        target:{
          // 同一属性在源码事务前后的 before/after 连续时，它仍是一条动作链。
          // 保留源码前定位器并授予受控重定位，才能对已经固化旧动作的 DOM
          // 安全重放；不连续的动作已标记为 superseded，仍使用源码后定位器。
          ...(continuousTarget
            ?? stableTargets.get(stableElementKey(action))
            ?? action.target),
          ...(action.target.textPath === undefined ? {} : { textPath:action.target.textPath }),
        },
      });
    }
  }
  return compactRangeStyles([...final.values()]);
}

export function sourceRebaseActionIds(groups = [], compiled = compileActionGroups(groups)) {
  const normalizedGroups = normalizeGeneratedRangeTargets(applySourceReconciliations(groups));
  const { sourceIndex, endIndex } = activeSourceSegment(normalizedGroups);
  if (sourceIndex < 0) return [];
  const superseded = sourceSupersededActionKeys(
    normalizedGroups, sourceIndex, endIndex,
  );
  const continuous = continuousSourceActions(
    normalizedGroups, sourceIndex, superseded,
  );
  return compiled
    .filter(action => continuous.ids.has(action.id)
      || continuous.keys.has(actionKey(action))
      // 源码事务可能在同一个持久元素内新增文字节点。源码前仍生效的
      // 兄弟节点动作会改变整个元素指纹；新节点没有旧 actionKey 可继承，
      // 但 editorId + 当前 before/after 仍可由 runtime 做受控重定位。
      || (action.target?.editorId
        && continuous.elements.has(stableElementKey(action))
        && !superseded.has(actionKey(action))))
    .map(action => action.id);
}
