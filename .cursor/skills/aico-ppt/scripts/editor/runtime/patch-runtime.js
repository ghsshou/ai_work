(() => {
  const contract=Object.freeze({
    brand:'com.huawei.deck.visual-editor.patch-runtime',schema:1,version:'1.0.0',
    api:'pageKey,makeLocator,resolve,applyAction,applyAll,applyTransaction,beginTransaction,suspendTarget,pendingTransactionCount,activeActionCount,suspendedTargetCount',
    features:'textPath,textRangeStyle',
  });
  const contractError=code => Object.assign(new Error(code),{code});
  const compatible=runtime => {
    const seen=runtime?.contract;
    return seen?.brand===contract.brand && seen.schema===contract.schema
      && seen.version===contract.version && seen.api===contract.api
      && contract.api.split(',').every(name => typeof runtime[name]==='function');
  };
  // 编辑预览可能先加载受保护 runtime，保存后的 bundle 随后再解包同一份 inline runtime。
  // 二次加载必须复用已登记的 pageKey、locator 与动作状态，不能覆盖全局实例。
  if (window.HuaweiDeckPatchRuntime) {
    if (compatible(window.HuaweiDeckPatchRuntime)) return;
    throw contractError(window.HuaweiDeckPatchRuntime.contract?.brand===contract.brand
      ? 'RUNTIME_INCOMPATIBLE' : 'RUNTIME_GLOBAL_CONFLICT');
  }
  const slides = () => [...document.querySelectorAll('.stage .slide-canvas')];
  const fnv1a = text => { let h=2166136261; for (const c of text) { h ^= c.charCodeAt(0); h = Math.imul(h,16777619); } return (h>>>0).toString(16).padStart(8,'0'); };
  const normalizeTag=tag => {
    let cursor=0,index=1,normalized='';
    while (index<tag.length && !/[\s/>]/.test(tag[index])) index+=1;
    while (index<tag.length) {
      while (/\s/.test(tag[index]??'')) index+=1;
      if (!tag[index] || tag[index]==='>' || tag[index]==='/') break;
      const start=index;
      while (index<tag.length && !/[\s=/>]/.test(tag[index])) index+=1;
      const name=tag.slice(start,index).toLowerCase();
      while (/\s/.test(tag[index]??'')) index+=1;
      if (tag[index]!=='=') continue;
      index+=1; while (/\s/.test(tag[index]??'')) index+=1;
      const quote=tag[index];
      if (quote!=='"' && quote!=="'") {
        const valueStart=index;
        while (index<tag.length && !/[\s>]/.test(tag[index])) index+=1;
        if ((name==='src' || name==='href') && tag.slice(valueStart,index).startsWith('blob:')) {
          normalized+=`${tag.slice(cursor,valueStart)}blob:`; cursor=index;
        }
        continue;
      }
      const valueStart=index+1,valueEnd=tag.indexOf(quote,valueStart);
      if (valueEnd<0) break;
      if ((name==='src' || name==='href') && tag.slice(valueStart,valueEnd).startsWith('blob:')) {
        normalized+=`${tag.slice(cursor,valueStart)}blob:`; cursor=valueEnd;
      }
      index=valueEnd+1;
    }
    return normalized ? normalized+tag.slice(cursor) : tag;
  };
  const pageStructure = html => {
    const source=String(html); let output='',cursor=0,rawTextTag=null;
    while (cursor<source.length) {
      const start=source.indexOf('<',cursor);
      if (start<0) return output+source.slice(cursor);
      output+=source.slice(cursor,start);
      if (rawTextTag) {
        const close=source.toLowerCase().indexOf(`</${rawTextTag}`,start);
        if (close<0) return output+source.slice(start);
        output+=source.slice(start,close); cursor=close; rawTextTag=null; continue;
      }
      if (source.startsWith('<!--',start)) {
        const close=source.indexOf('-->',start+4),next=close<0?source.length:close+3;
        output+=source.slice(start,next); cursor=next; continue;
      }
      let end=start+1,quote='';
      for (;end<source.length;end+=1) {
        const char=source[end];
        if (quote) { if (char===quote) quote=''; }
        else if (char==='"' || char==="'") quote=char;
        else if (char==='>') break;
      }
      if (end>=source.length) return output+source.slice(start);
      const tag=source.slice(start,end+1),match=tag.match(/^<\s*([A-Za-z][\w:-]*)/);
      output+=match?normalizeTag(tag):tag;
      if (match && ['script','style'].includes(match[1].toLowerCase()) && !/\/\s*>$/.test(tag)) rawTextTag=match[1].toLowerCase();
      cursor=end+1;
    }
    return output;
  };
  const pageKeys = new WeakMap(), locators = new WeakMap(), resolved = new Map();
  const suspendedTargets = new Set();
  let activeActions = [], activeBaselines = new Map(), replayTimer = 0, tentativeCount = 0;
  const pageKey = canvas => {
    if (!canvas) throw runtimeError('PAGE_NOT_FOUND');
    if (pageKeys.has(canvas)) return pageKeys.get(canvas);
    const index = slides().indexOf(canvas) + 1;
    const section = canvas.querySelector('section[data-label]');
    const declaredId=section?.dataset.pageId;
    if (declaredId!==undefined) {
      if (!/^page-[0-9a-f]{32}$/.test(declaredId)) throw runtimeError('PAGE_ID_INVALID');
      const owners=slides().filter(candidate => (
        candidate.querySelector('section[data-label]')?.dataset.pageId===declaredId
      ));
      if (owners.length!==1) throw runtimeError('PAGE_ID_AMBIGUOUS');
      pageKeys.set(canvas,declaredId);
      return declaredId;
    }
    // 兼容尚未迁移 data-page-id 的历史 Deck；新建及经 Editor 托管的 Deck
    // 必须使用上面的持久 ID，避免改文案、改样式或调整页序后页面身份漂移。
    const key = `page-${String(index).padStart(3,'0')}-${fnv1a(`${index}\0${section?.dataset.label ?? ''}\0${pageStructure(section?.outerHTML ?? '')}`)}`;
    pageKeys.set(canvas, key); return key;
  };
  const pathOf = (root, el) => {
    const path=[];
    while (el && el !== root) {
      const parent=el.parentElement;
      if (!parent) throw runtimeError('TARGET_NOT_FOUND');
      path.unshift([...parent.children].indexOf(el)); el=parent;
    }
    return path.join('/');
  };
  const EDITOR_ID_RE=/^element-[0-9a-f]{32}$/;
  const sourceFingerprint = el => fnv1a(`${el.tagName}\0${el.className}\0${(el.textContent ?? '').trim().slice(0,120)}`);
  const fingerprint = el => fnv1a(`${el.tagName}\0${el.className}\0${(el.textContent ?? '').trim().slice(0,120)}\0${el.getAttribute('style') ?? ''}`);
  const locatorIdentity = locator => locator.editorId
    ? `id:${locator.editorId}` : `path:${locator.path}|${locator.tag}`;
  const locatorKey = locator => `${locator.pageKey}|${locatorIdentity(locator)}|${locator.fingerprint}`;
  const stableTargetKey = locator => `${locator.pageKey}|${locatorIdentity(locator)}|${locator.textPath ?? ''}`;
  const actionKey = action => {
    const kind = action.kind === 'hide' || action.kind === 'show' ? 'visibility' : action.kind;
    const textRange=action.kind==='setStyle' ? action.payload.textRange : null;
    const rangeKey=textRange ? `${textRange.start}:${textRange.end}` : '';
    // 与服务端编译器一致：宽高和 CSS scale 分别维护基线。
    const property=action.kind==='resize' && Object.hasOwn(action.payload,'scale')
      ? 'scale' : (action.kind==='setStyle' ? action.payload.property : '');
    return `${stableTargetKey(action.target)}|${kind}|${property}|${rangeKey}`;
  };
  function runtimeError(code, candidates = []) {
    return Object.assign(new Error(code), { code, candidates });
  }
  function makeLocator(el) {
    if (locators.has(el)) return locators.get(el);
    const canvas = el?.closest?.('.slide-canvas');
    const section = canvas?.querySelector('section[data-label]');
    if (!canvas || !section || !section.contains(el)) throw runtimeError('TARGET_NOT_FOUND');
    const r = el.getBoundingClientRect(), c = canvas.getBoundingClientRect();
    const declaredEditorId=el.getAttribute('data-editor-id');
    if (declaredEditorId!==null) {
      if (!EDITOR_ID_RE.test(declaredEditorId)) throw runtimeError('TARGET_ID_INVALID');
      if (canvas.querySelectorAll(`[data-editor-id="${declaredEditorId}"]`).length!==1) {
        throw runtimeError('TARGET_ID_AMBIGUOUS');
      }
    }
    const locator = {
      pageKey:pageKey(canvas), path:pathOf(section, el), tag:el.tagName,
      fingerprint:fingerprint(el), sourceFingerprint:sourceFingerprint(el),
      ...(declaredEditorId===null ? {} : {editorId:declaredEditorId}),
      rect:{
        x:Math.round((r.left-c.left)*1920/c.width), y:Math.round((r.top-c.top)*1080/c.height),
        w:Math.round(r.width*1920/c.width), h:Math.round(r.height*1080/c.height),
      },
    };
    locators.set(el, locator); resolved.set(locatorKey(locator), el); return locator;
  }
  function candidateLocators(locator, canvas) {
    const canvasRect = canvas.getBoundingClientRect();
    const desired = locator.rect ?? { x:0, y:0, w:0, h:0 };
    const center = { x:desired.x + desired.w/2, y:desired.y + desired.h/2 };
    const selector = /^[A-Za-z][A-Za-z0-9:-]*$/.test(String(locator.tag)) ? String(locator.tag) : '*';
    const visibleThroughAncestors = el => {
      for (let current=el; current && current!==canvas.parentElement; current=current.parentElement) {
        const computed=getComputedStyle(current);
        if (computed.display==='none' || computed.visibility==='hidden'
          || computed.contentVisibility==='hidden' || Number(computed.opacity || 1)<=0) return false;
      }
      return true;
    };
    return [...canvas.querySelectorAll(selector)]
      .filter(el => !el.closest('[data-deck-editor-ui]'))
      .map(el => {
        const rect = el.getBoundingClientRect();
        const visible = rect.width > 0 && rect.height > 0 && visibleThroughAncestors(el);
        const tooLarge = rect.width * rect.height > canvasRect.width * canvasRect.height * .8;
        const x=(rect.left-canvasRect.left)*1920/canvasRect.width + rect.width*960/canvasRect.width;
        const y=(rect.top-canvasRect.top)*1080/canvasRect.height + rect.height*540/canvasRect.height;
        return { el, visible, tooLarge, distance:(x-center.x)**2 + (y-center.y)**2 };
      })
      .filter(item => item.visible && !item.tooLarge)
      .sort((a,b) => a.distance-b.distance)
      .slice(0,5)
      .map(item => { try { return makeLocator(item.el); } catch { return null; } })
      .filter(Boolean);
  }
  const sourceRebaseGeometryMatches = (locator, el, canvas) => {
    const desired=locator?.rect;
    if (!desired || !['x','y','w','h'].every(key => Number.isFinite(desired[key]))) return false;
    const rect=el.getBoundingClientRect(), canvasRect=canvas.getBoundingClientRect();
    if (!(canvasRect.width>0 && canvasRect.height>0 && rect.width>0 && rect.height>0)) return false;
    const current={
      x:(rect.left-canvasRect.left)*1920/canvasRect.width,
      y:(rect.top-canvasRect.top)*1080/canvasRect.height,
      w:rect.width*1920/canvasRect.width,
      h:rect.height*1080/canvasRect.height,
    };
    const desiredCenter={x:desired.x+desired.w/2,y:desired.y+desired.h/2};
    const currentCenter={x:current.x+current.w/2,y:current.y+current.h/2};
    const centerTolerance=Math.max(32,Math.min(120,Math.max(desired.w,desired.h)*.15));
    const widthTolerance=Math.max(32,Math.abs(desired.w)*.25);
    const heightTolerance=Math.max(32,Math.abs(desired.h)*.5);
    return Math.hypot(currentCenter.x-desiredCenter.x,currentCenter.y-desiredCenter.y)
        <= centerTolerance
      && Math.abs(current.w-desired.w)<=widthTolerance
      && Math.abs(current.h-desired.h)<=heightTolerance;
  };
  const sameCanonicalValue = (left,right) => {
    if (Object.is(left,right)) return true;
    if (!left || !right || typeof left!=='object' || typeof right!=='object'
      || Array.isArray(left)!==Array.isArray(right)) return false;
    const leftKeys=Object.keys(left).sort(),rightKeys=Object.keys(right).sort();
    return leftKeys.length===rightKeys.length
      && leftKeys.every((key,index) => key===rightKeys[index]
        && sameCanonicalValue(left[key],right[key]));
  };
  // 历史记录的是写入的 CSS 像素值；缩放后的 computed 值会有子像素舍入。
  // 仅收养明确的 px，百分比和其他单位仍由布局引擎解析。
  const resizeSizeOf = el => {
    const computed=getComputedStyle(el);
    const dimension = name => {
      const inline=el.style.getPropertyValue(name).trim();
      return /^\d+(?:\.\d+)?px$/.test(inline)
        ? parseFloat(inline) : parseFloat(computed[name]);
    };
    return {width:dimension('width'),height:dimension('height')};
  };
  const sourceRebaseCurrentValue = (action,el) => {
    if (action.kind==='setText') {
      const textTarget=textEditTarget(action,el);
      return textTarget ? (el.textContent ?? '').slice(textTarget.start,textTarget.end) : el.textContent;
    }
    if (action.kind==='translate') return translateOf(el);
    if (action.kind==='resize') {
      if (Object.hasOwn(action.payload,'scale')) {
        return {scale:parseFloat(getComputedStyle(el).scale)||1};
      }
      return resizeSizeOf(el);
    }
    if (action.kind==='setStyle') {
      return action.payload.textRange
        ? rangeComputedStyle(el,action.payload.textRange,action.payload.property)
        : el.style.getPropertyValue(action.payload.property);
    }
    return el.style.display;
  };
  const sourceRebaseMatches = (locator,action,el,canvas) => {
    const hasStableIdentity=typeof locator.editorId==='string';
    if ((!hasStableIdentity && !sourceRebaseGeometryMatches(locator,el,canvas)) || !action
      || (!Object.hasOwn(action,'before') && !Object.hasOwn(action,'after'))) return false;
    // 新 locator 用不含 inline style 的语义锚点区分“同一元素样式变化”和
    // “同路径的新元素”。持久 editorId 已经给出更强的显式身份，因此允许 Agent
    // 调整层级、class、文字以外的属性或几何；同一动作值仍必须匹配 before/after。
    // 局部文字格式还必须保留语义指纹，因为 editorId 只能标识元素，不能标识字符偏移。
    // 旧 locator 只为 setText 保留基于 before/after 的安全兼容。
    const hasTextRange=action.kind==='setStyle' && action.payload?.textRange;
    if ((!hasStableIdentity || hasTextRange) && typeof locator.sourceFingerprint==='string') {
      if (sourceFingerprint(el)!==locator.sourceFingerprint) return false;
    } else if ((!hasStableIdentity && action.kind!=='setText') || hasTextRange) return false;
    // 只接受源码事务中前后声明相同的证据，不能仅凭身份或放宽浮点比较。
    if(hasStableIdentity && action.kind==='resize' && !Object.hasOwn(action.payload,'scale')
      && typeof action.sourceResizeStyle==='string') {
      const declaration=document.createElement('div');
      declaration.style.cssText=action.sourceResizeStyle;
      if(declaration.style.cssText===el.style.cssText)return true;
    }
    let current;
    try { current=sourceRebaseCurrentValue(action,el); }
    catch { return false; }
    return (Object.hasOwn(action,'before') && sameCanonicalValue(current,action.before))
      || (Object.hasOwn(action,'after') && sameCanonicalValue(current,action.after));
  };
  function locateTarget(locator) {
    const canvas = slides().find(c => pageKey(c) === locator.pageKey);
    if (!canvas) throw runtimeError('PAGE_NOT_FOUND');
    let el;
    if (locator.editorId!==undefined) {
      if (!EDITOR_ID_RE.test(locator.editorId)) throw runtimeError('TARGET_ID_INVALID');
      const matches=[...canvas.querySelectorAll(`[data-editor-id="${locator.editorId}"]`)];
      if (matches.length>1) throw runtimeError('TARGET_ID_AMBIGUOUS', candidateLocators(locator,canvas));
      [el]=matches;
    } else {
      el = canvas.querySelector('section[data-label]');
      for (const part of String(locator.path).split('/').filter(Boolean)) {
        if (!/^\d+$/.test(part)) throw runtimeError('TARGET_NOT_FOUND', candidateLocators(locator, canvas));
        el = el?.children[Number(part)];
      }
    }
    if (!el || el.tagName !== locator.tag) {
      throw runtimeError('TARGET_NOT_FOUND', candidateLocators(locator, canvas));
    }
    return {el,canvas};
  }
  function resolve(locator,{allowSourceRebase=false,action=null}={}) {
    const cached = resolved.get(locatorKey(locator));
    if (cached?.isConnected) return cached;
    const {el,canvas}=locateTarget(locator);
    if (fingerprint(el) !== locator.fingerprint
      && !(allowSourceRebase && sourceRebaseMatches(locator,action,el,canvas))) {
      throw runtimeError('TARGET_AMBIGUOUS', candidateLocators(locator, canvas));
    }
    resolved.set(locatorKey(locator), el);
    return el;
  }
  const finite = value => Number.isFinite(value);
  const validTextPath = value => typeof value === 'string'
    && /^(0|[1-9]\d{0,3})(\/(0|[1-9]\d{0,3})){0,31}$/.test(value);
  const textNodeAtPath = (el,path) => {
    let node=el;
    for (const part of path.split('/')) node=node?.childNodes[Number(part)];
    return node?.nodeType===Node.TEXT_NODE ? node : null;
  };
  function validatePayload(action) {
    const payload = action?.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)
      || Object.getPrototypeOf(payload)!==Object.prototype) throw runtimeError('INVALID_ACTION');
    if (action.target?.textPath !== undefined
      && (action.kind!=='setText' || !validTextPath(action.target.textPath))) {
      throw runtimeError('INVALID_ACTION');
    }
    if (action.kind === 'setText') {
      const sourceRange=payload.sourceRange;
      const validSourceRange=sourceRange===undefined || (
        action.target.textPath!==undefined
        && sourceRange && typeof sourceRange==='object' && !Array.isArray(sourceRange)
        && Object.getPrototypeOf(sourceRange)===Object.prototype
        && Object.keys(sourceRange).length===2
        && Object.keys(sourceRange).every(key => key==='start' || key==='end')
        && Number.isSafeInteger(sourceRange.start) && Number.isSafeInteger(sourceRange.end)
        && sourceRange.start>=0 && sourceRange.end>sourceRange.start
        && sourceRange.end<=1_000_000
      );
      const allowedKeys=sourceRange===undefined ? ['text'] : ['text','sourceRange'];
      if (typeof payload.text!=='string' || !validSourceRange
        || Object.keys(payload).length!==allowedKeys.length
        || Object.keys(payload).some(key => !allowedKeys.includes(key))) throw runtimeError('INVALID_ACTION');
    }
    if (action.kind === 'translate' && (![payload.x,payload.y].every(finite)
      || Object.keys(payload).some(key => !['x','y'].includes(key)))) throw runtimeError('INVALID_ACTION');
    if (action.kind === 'resize') {
      const keys=Object.keys(payload);
      const scale=keys.length===1 && finite(payload.scale) && payload.scale>0;
      const size=keys.length===2 && keys.every(key => ['width','height'].includes(key))
        && finite(payload.width) && payload.width>0 && finite(payload.height) && payload.height>0;
      if (!scale && !size) throw runtimeError('INVALID_ACTION');
    }
    if (action.kind === 'setStyle') {
      const allowed=[
        'color','background-color','font-family','font-size','font-style','font-weight',
        'text-decoration-line','text-align','line-height',
        'list-style-type','list-style-position','display','opacity',
        'border-color','border-width','border-style','fill','stroke','stroke-width',
      ];
      const textRange=payload.textRange;
      const rangeAllowed=[
        'color','font-family','font-size','font-style','font-weight','text-decoration-line',
      ];
      const validRange=textRange===undefined || (textRange
        && typeof textRange==='object' && !Array.isArray(textRange)
        && Object.getPrototypeOf(textRange)===Object.prototype
        && Object.keys(textRange).length===2
        && Object.keys(textRange).every(key => ['start','end'].includes(key))
        && Number.isSafeInteger(textRange.start) && Number.isSafeInteger(textRange.end)
        && textRange.start>=0 && textRange.end>textRange.start && textRange.end<=1000000);
      const allowedKeys=textRange===undefined ? ['property','value'] : ['property','value','textRange'];
      if (!allowed.includes(payload.property) || typeof payload.value !== 'string'
        || !validRange || (textRange && !rangeAllowed.includes(payload.property))
        || Object.keys(payload).length!==allowedKeys.length
        || Object.keys(payload).some(key => !allowedKeys.includes(key))) throw runtimeError('INVALID_ACTION');
    }
    if (action.kind === 'hide' && Object.keys(payload).length) throw runtimeError('INVALID_ACTION');
    if (action.kind === 'show' && (Object.keys(payload).some(key => key !== 'display')
      || (payload.display !== undefined && typeof payload.display !== 'string'))) throw runtimeError('INVALID_ACTION');
    if (!['setText','setStyle','translate','resize','hide','show'].includes(action.kind)) throw runtimeError('INVALID_ACTION');
  }
  const translateOf = el => {
    const computed=getComputedStyle(el).translate;
    const parts=(computed && computed!=='none' ? computed : '0px 0px').split(/\s+/);
    return { x:parseFloat(parts[0])||0, y:parseFloat(parts[1])||0 };
  };
  const textNodesOf = el => {
    const walker=document.createTreeWalker(el,NodeFilter.SHOW_TEXT);
    const nodes=[];
    while (walker.nextNode()) {
      if (walker.currentNode.data.length>0) nodes.push(walker.currentNode);
    }
    return nodes;
  };
  const textOffsetOf = (el,target) => {
    let offset=0;
    for (const node of textNodesOf(el)) {
      if (node===target) return offset;
      offset+=node.data.length;
    }
    throw runtimeError('TARGET_NOT_FOUND');
  };
  const uniqueTextRange = (el,text) => {
    if (typeof text!=='string' || text.length===0) return null;
    const source=el.textContent ?? '';
    const start=source.indexOf(text);
    if (start<0) return null;
    if (source.indexOf(text,start+1)>=0) throw runtimeError('TARGET_AMBIGUOUS');
    return {start,end:start+text.length};
  };
  const textEditTarget = (action,el) => {
    if (action.target.textPath===undefined) return null;
    const node=textNodeAtPath(el,action.target.textPath);
    const expected=typeof action.before==='string' ? action.before : null;
    const desired=action.payload?.text;
    // MutationObserver 会重放 active actions。若新文字本身仍包含旧文字（例如
    // “更新后的普通文字”包含“普通文字”），先按旧文字做全框回退会再次替换，
    // 生成“更新后的更新后的普通文字”。textPath 对应节点已经等于目标值时，
    // 应返回当前范围，让 applyOne 识别为幂等 no-op。
    if (node && (expected===null || node.data===expected || node.data===desired)) {
      const start=textOffsetOf(el,node);
      return {node,start,end:start+node.data.length};
    }
    // 局部格式 span 是运行时结构，会随同范围格式覆盖/撤销而拆装。旧会话里的
    // textPath 可能因此失效；用动作记录的原文在整个文本框内唯一回退，避免误改。
    const range=uniqueTextRange(el,expected);
    if (!range) throw runtimeError('TARGET_NOT_FOUND');
    return range;
  };
  const textPointAt = (el,offset,bias) => {
    const nodes=textNodesOf(el);
    let consumed=0;
    for (const node of nodes) {
      const next=consumed+node.data.length;
      if (offset<next || (offset===next && bias==='end')) {
        return {node,offset:offset-consumed};
      }
      consumed=next;
    }
    if (offset===consumed && nodes.length) {
      const node=nodes[nodes.length-1];
      return {node,offset:node.data.length};
    }
    throw runtimeError('TARGET_NOT_FOUND');
  };
  const replaceTextRange = (el,startOffset,endOffset,text) => {
    const start=textPointAt(el,startOffset,'start');
    const end=textPointAt(el,endOffset,'end');
    if (start.node===end.node && start.offset===0 && end.offset===start.node.data.length) {
      start.node.data=text;
      return;
    }
    const range=document.createRange();
    range.setStart(start.node,start.offset);
    range.setEnd(end.node,end.offset);
    range.deleteContents();
    range.insertNode(document.createTextNode(text));
  };
  const rangeComputedStyle = (el,textRange,property) => {
    const point=textPointAt(el,textRange.start,'start');
    const owner=point.node.parentElement ?? el;
    if (property==='text-decoration-line') {
      for (let current=owner;current;current=current.parentElement) {
        const value=getComputedStyle(current).getPropertyValue(property).trim();
        if (value.split(/\s+/).includes('underline')) return 'underline';
        if (current===el) return value;
      }
    }
    return getComputedStyle(owner).getPropertyValue(property).trim();
  };
  const textRangeWrapper = (el,textRange,property) => [...el.querySelectorAll(
    '[data-deck-text-range-style]',
  )].find(wrapper => wrapper.dataset.deckTextRangeProperty===property
    && Number(wrapper.dataset.deckTextRangeStart)===textRange.start
    && Number(wrapper.dataset.deckTextRangeEnd)===textRange.end);
  const applyTextRangeStyle = (el,payload) => {
    const {textRange,property,value}=payload;
    const existing=textRangeWrapper(el,textRange,property);
    const before=existing
      ? getComputedStyle(existing).getPropertyValue(property).trim()
      : rangeComputedStyle(el,textRange,property);
    const after=value;
    if (before===after) return {before,after};
    if (existing) {
      existing.style.setProperty(property,value);
      return {before,after};
    }
    const start=textPointAt(el,textRange.start,'start');
    const end=textPointAt(el,textRange.end,'end');
    const range=document.createRange();
    range.setStart(start.node,start.offset);
    range.setEnd(end.node,end.offset);
    const wrapper=document.createElement('span');
    wrapper.dataset.deckTextRangeStyle='';
    wrapper.dataset.deckTextRangeProperty=property;
    wrapper.dataset.deckTextRangeStart=String(textRange.start);
    wrapper.dataset.deckTextRangeEnd=String(textRange.end);
    wrapper.style.setProperty('display','contents','important');
    wrapper.style.setProperty(property,value);
    wrapper.append(range.extractContents());
    range.insertNode(wrapper);
    el.normalize();
    return {before,after};
  };
  function applyOne(action, el=resolve(action.target)) {
    validatePayload(action);
    let before, after;
    if (action.kind === 'setText') {
      const textTarget=textEditTarget(action,el);
      before=textTarget ? (el.textContent ?? '').slice(textTarget.start,textTarget.end) : el.textContent;
      after=action.payload.text;
      if (before !== after) {
        if (textTarget) replaceTextRange(el,textTarget.start,textTarget.end,after);
        else el.textContent=after;
      }
    }
    if (action.kind === 'translate') {
      before=translateOf(el); after={ x:action.payload.x, y:action.payload.y };
      if (after.x === 0 && after.y === 0) el.style.removeProperty('translate');
      else el.style.translate=`${after.x}px ${after.y}px`;
    }
    if (action.kind === 'resize') {
      if (Object.hasOwn(action.payload,'scale')) {
        before={ scale:parseFloat(getComputedStyle(el).scale)||1 }; after={ scale:action.payload.scale };
        el.style.scale=String(after.scale);
      } else {
        before=resizeSizeOf(el);
        after={ width:action.payload.width, height:action.payload.height };
        el.style.width=`${after.width}px`; el.style.height=`${after.height}px`;
      }
    }
    if (action.kind === 'setStyle') {
      if (action.payload.textRange) {
        ({before,after}=applyTextRangeStyle(el,action.payload));
      } else {
        before=el.style.getPropertyValue(action.payload.property); after=action.payload.value;
        el.style.setProperty(action.payload.property, after);
      }
    }
    if (action.kind === 'hide' || action.kind === 'show') {
      before=el.style.display; after=action.kind === 'hide'?'none':(action.payload.display ?? '');
      el.style.display=after;
    }
    return { ...action, before, after, appliedAt:new Date().toISOString() };
  }
  const inlineProperty = (el,property) => ({
    value:el.style.getPropertyValue(property), priority:el.style.getPropertyPriority(property),
  });
  const restoreInlineProperty = (el,property,snapshot) => {
    if (snapshot.value) el.style.setProperty(property,snapshot.value,snapshot.priority);
    else el.style.removeProperty(property);
  };
  function captureBaseline(action,el) {
    if (action.kind==='setText') {
      const textTarget=textEditTarget(action,el);
      return textTarget
        ? {
          text:(el.textContent ?? '').slice(textTarget.start,textTarget.end),
          textRange:{start:textTarget.start,end:textTarget.end},
          html:el.innerHTML,
        }
        : { text:el.textContent,html:el.innerHTML };
    }
    if (action.kind==='translate') return { translate:inlineProperty(el,'translate') };
    if (action.kind==='resize') return {
      width:inlineProperty(el,'width'), height:inlineProperty(el,'height'), scale:inlineProperty(el,'scale'),
    };
    if (action.kind==='setStyle') {
      if (action.payload.textRange) {
        const wrapper=textRangeWrapper(el,action.payload.textRange,action.payload.property);
        return { rangeStyle:wrapper ? {
          existed:true,
          property:inlineProperty(wrapper,action.payload.property),
        } : { existed:false } };
      }
      return { property:action.payload.property, style:inlineProperty(el,action.payload.property) };
    }
    return { display:inlineProperty(el,'display') };
  }
  function baselineElement(action,baseline) {
    // 恢复父容器的 HTML 会重建子元素，而子元素仍可能处于已修改状态。
    // 沿用持久身份与 before/after 值校验，重新取得该元素后再恢复基线。
    return baseline?.el?.isConnected ? baseline.el
      : resolve(action.target,{allowSourceRebase:true,action});
  }
  function restoreBaseline(action,baseline) {
    const el=baselineElement(action,baseline);
    if (action.kind==='setText') {
      // setText 可能跨越富文本后代。只恢复 textContent 无法重建被删除的 span，
      // 也会让更早的范围样式动作丢失目标；基线必须按结构快照恢复。
      if (Object.hasOwn(baseline,'html')) el.innerHTML=baseline.html;
      else if (baseline.textRange) {
        const start=baseline.textRange.start;
        replaceTextRange(el,start,start+action.payload.text.length,baseline.text);
      }
      else el.textContent=baseline.text;
    }
    else if (action.kind==='translate') restoreInlineProperty(el,'translate',baseline.translate);
    else if (action.kind==='resize') {
      restoreInlineProperty(el,'width',baseline.width);
      restoreInlineProperty(el,'height',baseline.height);
      restoreInlineProperty(el,'scale',baseline.scale);
    } else if (action.kind==='setStyle' && action.payload.textRange) {
      const wrapper=textRangeWrapper(el,action.payload.textRange,action.payload.property);
      if (baseline.rangeStyle?.existed) {
        if (wrapper) restoreInlineProperty(wrapper,action.payload.property,baseline.rangeStyle.property);
      } else if (wrapper) {
        wrapper.replaceWith(...wrapper.childNodes);
        el.normalize();
      }
    }
    else if (action.kind==='setStyle') restoreInlineProperty(el,baseline.property,baseline.style);
    else restoreInlineProperty(el,'display',baseline.display);
  }
  const resizeBranch = action => action?.kind==='resize'
    ? (Object.hasOwn(action.payload,'scale') ? 'scale' : 'size') : null;
  function recordActive(action,baseline) {
    const key=actionKey(action), index=activeActions.findIndex(active => actionKey(active) === key);
    if (index < 0) {
      activeActions.push(action);
      activeBaselines.set(key,{ ...baseline,el:baseline.el });
    } else activeActions[index]=action;
  }
  function applyAction(action) {
    const el=resolve(action.target),key=actionKey(action);
    const baseline=activeBaselines.get(key) ?? { ...captureBaseline(action,el),el };
    const applied=applyOne(action,el); recordActive(applied,baseline); return applied;
  }
  const snapshotElement = el => ({ html:el.innerHTML,style:el.getAttribute('style') });
  const restoreElementSnapshot = (el,snapshot) => {
    if (!el.isConnected) return;
    el.innerHTML=snapshot.html;
    if (snapshot.style===null) el.removeAttribute('style'); else el.setAttribute('style',snapshot.style);
  };
  function prepareActions(actions,{
    allowEmpty=false,rebaseActionIds=[],resolveTargets=true,
  }={}) {
    if (!Array.isArray(actions) || (!allowEmpty && !actions.length)) throw runtimeError('INVALID_ACTION');
    if (!Array.isArray(rebaseActionIds)
      || rebaseActionIds.some(id => typeof id!=='string' || !id)
      || new Set(rebaseActionIds).size!==rebaseActionIds.length) throw runtimeError('INVALID_ACTION');
    const sourceRebaseIds=new Set(rebaseActionIds);
    const prepared=[];
    for (const action of actions) {
      try {
        validatePayload(action);
        const item={
          action,allowSourceRebase:sourceRebaseIds.has(action.id),
        };
        if (resolveTargets) {
          item.el=resolve(action.target,{
            allowSourceRebase:sourceRebaseIds.has(action.id), action,
          });
        } else {
          // 只按 page/editorId/path/tag 提前取得回滚对象，不在此时校验
          // 依赖前置动作的指纹。所有快照都必须在任何动作生效前完成，
          // 否则子节点先改、父节点后失败时无法原子回滚。
          item.el=locateTarget(action.target).el;
        }
        prepared.push(item);
      }
      catch (error) { error.failedActionId=action?.id; throw error; }
    }
    return prepared;
  }
  function beginReplaceTransaction(actions,{rebaseActionIds=[]}={}) {
    const prepared=prepareActions(actions,{allowEmpty:true,rebaseActionIds});
    const oldActions=[...activeActions], oldBaselines=new Map(activeBaselines);
    const touched=new Set(prepared.map(item => item.el));
    for (const action of oldActions) {
      const baseline=oldBaselines.get(actionKey(action));
      const el=baselineElement(action,baseline);
      touched.add(el);
    }
    const snapshots=new Map([...touched].map(el => [el,snapshotElement(el)]));
    const results=[], nextBaselines=new Map(), currentByKey=new Map();
    let settled=false;
    tentativeCount+=1;
    try {
      for (const action of [...oldActions].reverse()) {
        const baseline=oldBaselines.get(actionKey(action));
        if (baseline) restoreBaseline(action,baseline);
      }
      for (const {action,el:preparedElement} of prepared) {
        // 前面的基线恢复可能重建后代；不能把新动作写到已脱离页面的旧节点。
        const el=preparedElement.isConnected ? preparedElement
          : resolve(action.target,{allowSourceRebase:true,action});
        const key=actionKey(action);
        const baseline=nextBaselines.get(key) ?? { ...captureBaseline(action,el),el };
        const current=currentByKey.get(key);
        if (resizeBranch(current) && resizeBranch(current)!==resizeBranch(action)) {
          restoreBaseline(current,baseline);
        }
        const result=applyOne(action,el);
        results.push(result);
        nextBaselines.set(key,baseline);
        currentByKey.set(key,result);
      }
    } catch (error) {
      for (const [el,snapshot] of snapshots) restoreElementSnapshot(el,snapshot);
      activeActions=oldActions;
      activeBaselines=oldBaselines;
      tentativeCount-=1;
      throw error;
    }
    const finish=method => {
      if (settled) return false;
      settled=true;
      tentativeCount-=1;
      clearTimeout(replayTimer);
      if (method==='commit') {
        activeActions=[];
        activeBaselines=new Map();
        for (const [index,result] of results.entries()) {
          recordActive(result,nextBaselines.get(actionKey(actions[index])));
        }
      } else {
        for (const [el,snapshot] of snapshots) restoreElementSnapshot(el,snapshot);
        activeActions=oldActions;
        activeBaselines=oldBaselines;
      }
      return true;
    };
    return {results,commit:() => finish('commit'),rollback:() => finish('rollback')};
  }
  function beginTransaction(actions,{replace=false,rebaseActionIds=[]}={}) {
    if (replace) return beginReplaceTransaction(actions,{rebaseActionIds});
    // locator 的指纹可能包含同一批次中较早动作造成的内容变化。
    // 因此先校验全部 payload，再按历史顺序逐条解析和应用目标；
    // 一次性预解析会在前置修改尚未生效时产生伪 TARGET_AMBIGUOUS。
    const prepared=prepareActions(actions,{rebaseActionIds,resolveTargets:false});
    const oldActions=[...activeActions];
    const oldBaselines=new Map(activeBaselines);
    const snapshots=new Map(prepared.map(({el}) => [el,snapshotElement(el)]));
    const results=[];
    const transactionBaselines=new Map();
    const currentByKey=new Map(activeActions.map(active => [actionKey(active),active]));
    let settled=false;
    tentativeCount+=1;
    try {
      for (const {action,allowSourceRebase} of prepared) {
        let el;
        try {
          el=resolve(action.target,{allowSourceRebase,action});
        } catch (error) {
          error.failedActionId=action?.id;
          throw error;
        }
        const key=actionKey(action);
        const existingBaseline=activeBaselines.get(key) ?? transactionBaselines.get(key);
        const baseline=existingBaseline ?? { ...captureBaseline(action,el),el };
        const current=currentByKey.get(key);
        if (resizeBranch(current) && resizeBranch(current)!==resizeBranch(action)) {
          restoreBaseline(current,baseline);
        }
        const result=applyOne(action,el);
        results.push(result);
        transactionBaselines.set(key,baseline);
        currentByKey.set(key,result);
      }
    } catch (error) {
      for (const [el,snapshot] of [...snapshots].reverse()) {
        restoreElementSnapshot(el,snapshot);
      }
      activeActions=oldActions;
      activeBaselines=oldBaselines;
      tentativeCount-=1;
      throw error;
    }
    const finish = method => {
      if (settled) return false;
      settled=true;
      tentativeCount-=1;
      clearTimeout(replayTimer);
      if (method==='commit') {
        for (const [index,action] of results.entries()) {
          recordActive(action,transactionBaselines.get(actionKey(actions[index])));
        }
      } else {
        for (const [el,snapshot] of [...snapshots].reverse()) {
          restoreElementSnapshot(el,snapshot);
        }
        activeActions=oldActions;
        activeBaselines=oldBaselines;
      }
      return true;
    };
    return {
      results,
      commit:() => finish('commit'),
      rollback:() => finish('rollback'),
    };
  }
  function applyTransaction(actions, options) {
    const transaction=beginTransaction(actions,options);
    transaction.commit();
    return transaction.results;
  }
  function captureReplayRollback(actions) {
    const elements=new Set();
    for (const action of actions) {
      try { elements.add(locateTarget(action.target).el); }
      catch { /* 缺失目标由正式恢复报告；仍须保护其余页面的可见状态。 */ }
    }
    const roots=[...elements].filter(el => ![...elements].some(parent => parent!==el && parent.contains(el)));
    // 保存原节点引用，失败时连同子树和样式一起恢复。只保存 innerHTML 会
    // 再次使旧缓存与基线脱离 DOM，从而把一次失败变成后续连续失败。
    const capture=node => ({
      node,
      ...(node.nodeType===Node.ELEMENT_NODE ? {style:node.getAttribute('style')} : {data:node.nodeValue}),
      children:[...node.childNodes].map(capture),
    });
    const snapshots=roots.map(capture);
    const restore=snapshot => {
      const {node,children}=snapshot;
      if (node.nodeType===Node.ELEMENT_NODE) {
        if (snapshot.style===null) node.removeAttribute('style');
        else node.setAttribute('style',snapshot.style);
      } else node.nodeValue=snapshot.data;
      for (const child of children) restore(child);
      if (node.childNodes.length!==children.length
        || children.some((child,index)=>node.childNodes[index]!==child.node)) {
        node.replaceChildren(...children.map(child=>child.node));
      }
    };
    return () => {
      for (const snapshot of snapshots) if (snapshot.node.isConnected) restore(snapshot);
    };
  }
  function applyAll(actions,{rebaseActionIds=[]}={}) {
    if (!Array.isArray(actions)) throw runtimeError('INVALID_ACTION');
    const oldActions=[...activeActions];
    const oldBaselines=new Map(activeBaselines), oldResolved=new Map(resolved);
    const rollback=captureReplayRollback([...oldActions,...actions]);
    tentativeCount+=1;
    clearTimeout(replayTimer);
    try {
      for (const action of [...activeActions].reverse()) {
        const baseline=activeBaselines.get(actionKey(action));
        if (baseline) restoreBaseline(action,baseline);
      }
      activeActions=[];
      activeBaselines=new Map();
      if (!actions.length) return [];
      return applyTransaction(actions,{rebaseActionIds});
    } catch (error) {
      rollback();
      activeActions=oldActions;
      activeBaselines=oldBaselines;
      resolved.clear();
      for (const [key,element] of oldResolved) resolved.set(key,element);
      throw error;
    } finally {
      tentativeCount-=1;
    }
  }
  function applyAllDroppingMissing(actions,{rebaseActionIds=[]}={}) {
    if (!Array.isArray(actions)) throw runtimeError('INVALID_ACTION');
    const droppable=new Set(rebaseActionIds);
    const effectiveActions=[...actions];
    const droppedActionIds=[];
    while (true) {
      try {
        return {
          results:applyAll(effectiveActions,{rebaseActionIds}),
          effectiveActions:[...effectiveActions],
          droppedActionIds:[...droppedActionIds],
        };
      } catch (error) {
        const failedActionId=error?.failedActionId;
        const canDrop=['PAGE_NOT_FOUND','TARGET_NOT_FOUND'].includes(error?.code)
          && typeof failedActionId==='string' && droppable.has(failedActionId);
        const failedIndex=canDrop
          ? effectiveActions.findIndex(action => action?.id===failedActionId) : -1;
        if (failedIndex<0) throw error;
        effectiveActions.splice(failedIndex,1);
        droppedActionIds.push(failedActionId);
      }
    }
  }
  function adoptActiveAsBaseline() {
    if (tentativeCount>0) throw runtimeError('TRANSACTION_PENDING');
    const adopted=activeActions.length;
    activeActions=[];
    activeBaselines=new Map();
    clearTimeout(replayTimer);
    return adopted;
  }
  function suspendTarget(locator) {
    const suspension={locator,element:resolve(locator)};
    suspendedTargets.add(suspension);
    let resumed=false;
    return () => {
      if (resumed) return;
      resumed=true;
      suspendedTargets.delete(suspension);
      // 直接编辑结束时会先恢复进入编辑前的 DOM。若等待 MutationObserver 的
      // 延迟重放，用户紧接着点击整框会在短暂的“无格式”窗口里取得错误快照。
      replayActive();
    };
  }
  function replayActive() {
    if (tentativeCount>0) return;
    for (const action of activeActions) {
      // 直接编辑会临时拆装富文本后代。暂停范围覆盖整个编辑子树，
      // 同时暂停会改到它的祖先动作，不能只比较带 textPath 的动作键。
      if ([...suspendedTargets].some(({locator,element}) => {
        if (locator.pageKey!==action.target.pageKey) return false;
        if (locatorIdentity(locator)===locatorIdentity(action.target)) return true;
        const target=resolved.get(locatorKey(action.target));
        if (target && (element.contains(target) || target.contains(element))) return true;
        const editedPath=String(locator.path), actionPath=String(action.target.path);
        return actionPath.startsWith(`${editedPath}/`) || editedPath.startsWith(`${actionPath}/`);
      })) continue;
      try {
        // 大容器结束文字编辑时可能按 innerHTML 重建后代节点。
        // 此时元素的稳定 ID 不变，而指纹已经包含动作 after 状态；
        // 允许按 before/after 幂等值安全重建 runtime 缓存。
        const el=resolve(action.target,{allowSourceRebase:true,action});
        applyOne(action,el);
      }
      catch (error) {
        const detail={
          code:String(error?.code ?? error?.message ?? 'ACTION_REPLAY_FAILED'),
          actionId:String(action?.id ?? ''),
          failedActionId:String(error?.failedActionId ?? action?.id ?? ''),
        };
        document.dispatchEvent(new CustomEvent('huawei-deck-patch-replay-error',{detail}));
      }
    }
  }
  new MutationObserver(() => {
    clearTimeout(replayTimer);
    replayTimer=setTimeout(replayActive,30);
  }).observe(document.documentElement,{childList:true,subtree:true});
  window.HuaweiDeckPatchRuntime={
    contract,
    pageKey,makeLocator,resolve,applyAction,applyAll,applyAllDroppingMissing,
    applyTransaction,beginTransaction,suspendTarget,
    adoptActiveAsBaseline,
    pendingTransactionCount:() => tentativeCount,
    activeActionCount:() => activeActions.length,
    suspendedTargetCount:() => suspendedTargets.size,
  };
})();
