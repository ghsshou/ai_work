import test from 'node:test';
import assert from 'node:assert/strict';
import { compileActionGroups, sourceRebaseActionIds } from '../action-compiler.mjs';

const target = Object.freeze({
  pageKey:'page-001', path:'0/1', tag:'DIV', fingerprint:'标题',
});

function rangeStyle(id, property, value, start, end) {
  return {
    id, taskId:null, target:{ ...target }, kind:'setStyle',
    payload:{ property, value, textRange:{ start, end } },
    before:'', after:value,
  };
}

test('宽高与 scale 分别编译，后续缩放不丢失此前尺寸且各自保留最早基线', () => {
  const resize = (id, before, after) => ({
    id, taskId:null, target:{ ...target }, kind:'resize', payload:after, before, after,
  });
  const compiled = compileActionGroups([
    { active:true, actions:[resize('size', { width:300, height:100 }, { width:500, height:200 })] },
    { active:true, actions:[resize('scale-1', { scale:1 }, { scale:1.5 })] },
    { active:true, actions:[resize('scale-2', { scale:1.5 }, { scale:2 })] },
  ]);
  assert.deepEqual(compiled.map(({ before, payload }) => ({ before, payload })), [
    { before:{ width:300, height:100 }, payload:{ width:500, height:200 } },
    { before:{ scale:1 }, payload:{ scale:2 } },
  ]);
});

test('局部格式编译为互不重叠的最终运行段，并合并相邻同值区间', () => {
  const compiled = compileActionGroups([{
    id:'group-1', active:true, actions:[
      rangeStyle('weight-a', 'font-weight', '700', 0, 1),
      rangeStyle('weight-b', 'font-weight', '700', 1, 9),
      rangeStyle('weight-c', 'font-weight', '700', 9, 56),
      rangeStyle('color-a', 'color', '#c7000b', 0, 10),
      rangeStyle('color-b', 'color', '#000000', 5, 15),
    ],
  }]);

  assert.deepEqual(compiled.map(action => ({
    property:action.payload.property,
    value:action.payload.value,
    range:action.payload.textRange,
  })), [
    { property:'font-weight', value:'700', range:{ start:0, end:56 } },
    { property:'color', value:'#c7000b', range:{ start:0, end:5 } },
    { property:'color', value:'#000000', range:{ start:5, end:15 } },
  ]);
});

test('后续文字替换会淘汰同一元素上基于旧文字范围的局部格式', () => {
  const editorId = 'element-22222222222222222222222222222222';
  const rangeTarget = { ...target, editorId, fingerprint:'旧范围指纹' };
  const textTarget = {
    ...target,
    editorId,
    fingerprint:'文字替换指纹',
    textPath:'2',
  };
  const groups = [
    {
      id:'range-style', mutationType:'action', active:true,
      actions:[{
        ...rangeStyle('old-range-font', 'font-family', 'STXingkai', 16, 36),
        target:rangeTarget,
      }],
    },
    {
      id:'replace-text', mutationType:'action', active:true,
      actions:[{
        id:'replace-whole-copy', taskId:null, target:textTarget, kind:'setText',
        payload:{ text:'组织内部技术分享' },
        before:'组织内部技术分享 · 模型结构 / 训推框架 / 资源预测',
        after:'组织内部技术分享',
      }],
    },
    { id:'later-source', mutationType:'source', active:true, actions:[] },
  ];

  const compiled = compileActionGroups(groups);
  assert.deepEqual(compiled.map(action => action.id), ['replace-whole-copy']);
});

test('局部格式之后的细粒度文字替换保留不受影响的格式范围', () => {
  const editorId = 'element-33333333333333333333333333333333';
  const rangeTarget = { ...target, editorId, fingerprint:'局部格式指纹' };
  const groups = [
    {
      id:'range-style', mutationType:'action', active:true,
      actions:[{
        ...rangeStyle('local-color', 'color', '#c7000b', 3, 7),
        target:rangeTarget,
      }],
    },
    {
      id:'replace-trailing-text', mutationType:'action', active:true,
      actions:[{
        id:'replace-trailing-run', taskId:null,
        target:{ ...rangeTarget, textPath:'2' }, kind:'setText',
        payload:{ text:'统一编辑', sourceRange:{ start:7, end:10 } },
        before:'第二段', after:'统一编辑',
      }],
    },
  ];

  assert.deepEqual(
    compileActionGroups(groups).map(action => action.id),
    ['local-color', 'replace-trailing-run'],
  );
});

test('只标记最新有效源码基线之前仍参与编译的动作', () => {
  const action = (id, path, text, before = '旧') => ({
    id, taskId:null, target:{ ...target, path }, kind:'setText',
    payload:{ text }, before, after:text,
  });
  const groups = [
    { id:'old', mutationType:'action', active:true, actions:[action('old', '0/1', '旧动作')] },
    { id:'source', mutationType:'source', active:true, actions:[] },
    { id:'new', mutationType:'action', active:true, actions:[
      action('new', '0/1', '覆盖旧动作', '旧动作'),
      action('after-source', '0/2', '源码后的动作'),
    ] },
  ];
  const compiled = compileActionGroups(groups);
  assert.deepEqual(compiled.map(item => item.id), ['new', 'after-source']);
  assert.deepEqual(sourceRebaseActionIds(groups, compiled), []);

  groups[2].active = false;
  const restored = compileActionGroups(groups);
  assert.deepEqual(restored.map(item => item.id), ['old']);
  assert.deepEqual(sourceRebaseActionIds(groups, restored), ['old']);

  groups[1].active = false;
  assert.deepEqual(sourceRebaseActionIds(groups, restored), []);
});

test('源码后的实际 before 与旧动作不连续时，撤销不会复活过期动作', () => {
  const old = {
    id:'old', taskId:null, target:{ ...target }, kind:'setText',
    payload:{ text:'旧动作结果' }, before:'源码原文', after:'旧动作结果',
  };
  const oldGranular = {
    id:'old-granular', taskId:null, target:{ ...target, textPath:'0/1' }, kind:'setText',
    payload:{ text:'局部旧结果' }, before:'局部原文', after:'局部旧结果',
  };
  const afterSource = {
    id:'after-source', taskId:null,
    target:{ ...target, fingerprint:'新源码指纹' }, kind:'setText',
    payload:{ text:'删字后' }, before:'源码改写后的文字', after:'删字后',
  };
  const groups = [
    { id:'old-group', mutationType:'action', active:true, actions:[old, oldGranular] },
    { id:'source-group', mutationType:'source', active:true, actions:[] },
    { id:'new-group', mutationType:'action', active:false, actions:[afterSource] },
  ];
  assert.deepEqual(compileActionGroups(groups), []);
  assert.deepEqual(sourceRebaseActionIds(groups), []);

  groups[2].active = true;
  const compiled = compileActionGroups(groups);
  assert.equal(compiled.length, 1);
  assert.equal(compiled[0].id, 'after-source');
  assert.equal(compiled[0].target.fingerprint, '新源码指纹');
  assert.deepEqual(sourceRebaseActionIds(groups, compiled), []);
});

test('持久元素身份跨 DOM 路径合并连续的源码前后动作并继承重定位资格', () => {
  const editorId = 'element-11111111111111111111111111111111';
  const action = (id, path, text, before) => ({
    id, taskId:null,
    target:{ ...target, path, editorId },
    kind:'setText', payload:{ text }, before, after:text,
  });
  const old = action('before-source', '0/1', '人工旧结果', '原始标题');
  const afterSource = action('after-source', '3/2/0', 'Agent 后人工结果', '人工旧结果');
  const groups = [
    { id:'old-group', mutationType:'action', active:true, actions:[old] },
    { id:'source-group', mutationType:'source', active:true, actions:[] },
    { id:'new-group', mutationType:'action', active:true, actions:[afterSource] },
  ];

  const compiled = compileActionGroups(groups);
  assert.deepEqual(compiled.map(item => item.id), ['after-source']);
  assert.equal(compiled[0].before, '原始标题');
  assert.equal(compiled[0].target.path, '0/1');
  assert.deepEqual(sourceRebaseActionIds(groups, compiled), ['after-source']);

  groups[2].active = false;
  const restored = compileActionGroups(groups);
  assert.deepEqual(restored.map(item => item.id), ['before-source']);
  assert.deepEqual(sourceRebaseActionIds(groups, restored), ['before-source']);
});

test('源码后同一持久元素的新文字节点继承受控重定位资格', () => {
  const editorId = 'element-44444444444444444444444444444444';
  const old = {
    id:'before-source', taskId:null,
    target:{ ...target, editorId, textPath:'2', fingerprint:'源码前指纹' },
    kind:'setText', payload:{ text:'旧结果' }, before:'旧原文', after:'旧结果',
  };
  const afterSource = {
    id:'after-source-new-node', taskId:null,
    target:{ ...target, editorId, textPath:'0/0', fingerprint:'源码后指纹' },
    kind:'setText', payload:{ text:'新结果' }, before:'源码新增节点', after:'新结果',
  };
  const groups = [
    { id:'old-group', mutationType:'action', active:true, actions:[old] },
    { id:'source-group', mutationType:'source', active:true, actions:[] },
    { id:'new-group', mutationType:'action', active:true, actions:[afterSource] },
  ];

  const compiled = compileActionGroups(groups);
  assert.deepEqual(compiled.map(item => item.id), ['before-source', 'after-source-new-node']);
  assert.equal(compiled[1].target.fingerprint, '源码后指纹');
  assert.deepEqual(
    sourceRebaseActionIds(groups, compiled),
    ['before-source', 'after-source-new-node'],
  );
});

test('后写子元素整段文字桥接同一节点的父级细粒度分支', () => {
  const childId = 'element-55555555555555555555555555555555';
  const parentId = 'element-66666666666666666666666666666666';
  const child = (id, text, before) => ({
    id, taskId:null,
    target:{ ...target, path:'0/1/0', editorId:childId },
    kind:'setText', payload:{ text }, before, after:text,
  });
  const parentGranular = {
    id:'parent-granular', taskId:null,
    target:{ ...target, path:'0/1', editorId:parentId, textPath:'0/0' },
    kind:'setText', payload:{ text:'父级中间结果' },
    before:'子元素中间结果', after:'父级中间结果',
  };
  const groups = [
    { id:'child-first', mutationType:'action', active:true,
      actions:[child('child-first', '子元素中间结果', '子元素原文')] },
    { id:'parent-middle', mutationType:'action', active:true, actions:[parentGranular] },
    { id:'child-final', mutationType:'action', active:true,
      actions:[child('child-final', '子元素最终结果', '子元素中间结果')] },
  ];

  const compiled = compileActionGroups(groups);
  assert.deepEqual(compiled.map(item => item.id), ['parent-granular', 'child-final']);
  assert.equal(compiled[0].before, '子元素原文');
  assert.equal(compiled[0].after, '父级中间结果');
  assert.equal(compiled[1].before, '父级中间结果');
  assert.equal(compiled[1].after, '子元素最终结果');
});

test('合并子标题并隐藏旧正文的分支规范化为最终标题与空正文', () => {
  const parentId = 'element-77777777777777777777777777777777';
  const childId = 'element-88888888888888888888888888888888';
  const childTarget = { ...target, path:'0/1/0', editorId:childId };
  const bodyTarget = { ...target, path:'0/1', editorId:parentId, textPath:'2' };
  const groups = [
    { id:'baseline', mutationType:'action', active:true, actions:[
      {
        id:'child-baseline', taskId:null, target:childTarget, kind:'setText',
        payload:{ text:'短标题' }, before:'原始标题', after:'短标题',
      },
      {
        id:'body-baseline', taskId:null, target:bodyTarget, kind:'setText',
        payload:{ text:'旧正文内容' }, before:'原始正文', after:'旧正文内容',
      },
    ] },
    { id:'stale-branch', mutationType:'action', active:true, actions:[
      {
        id:'parent-title-branch', taskId:null,
        target:{ ...bodyTarget, textPath:'0/0' }, kind:'setText',
        payload:{ text:'分支标题' }, before:'短标题', after:'分支标题',
      },
      {
        id:'body-branch', taskId:null, target:bodyTarget, kind:'setText',
        payload:{ text:'分支正文' }, before:'旧正文内容', after:'分支正文',
      },
    ] },
    { id:'final-merge', mutationType:'action', active:true, actions:[
      {
        id:'hide-old-body', taskId:'task-final',
        target:{ ...bodyTarget, textPath:undefined }, kind:'setStyle',
        payload:{ property:'font-size', value:'0px', textRange:{ start:3, end:8 } },
        before:'15px', after:'0px',
      },
      {
        id:'child-final', taskId:'task-final', target:childTarget, kind:'setText',
        payload:{ text:'最终合并标题' }, before:'短标题', after:'最终合并标题',
      },
    ] },
  ];

  const compiled = compileActionGroups(groups);
  assert.deepEqual(compiled.map(item => item.id), ['child-final', 'hide-old-body']);
  assert.deepEqual(compiled.map(item => ({
    kind:item.kind, textPath:item.target.textPath, before:item.before,
    after:item.after, text:item.payload.text,
  })), [
    {
      kind:'setText', textPath:undefined, before:'原始标题',
      after:'最终合并标题', text:'最终合并标题',
    },
    {
      kind:'setText', textPath:'2', before:'原始正文', after:'', text:'',
    },
  ]);
});

test('源码明确覆盖的属性退出重放，其他页面样式保留，撤销源码后旧动作恢复', () => {
  const title = {id:'title',kind:'setText',target:{...target,editorId:'element-11111111111111111111111111111111'},payload:{text:'旧动作标题'},before:'最初标题',after:'旧动作标题'};
  const color = {...rangeStyle('color','fill','#20252b',0,1),payload:{property:'fill',value:'#20252b'}};
  const key = `${title.target.pageKey}|id:${title.target.editorId}||setText||`;
  const groups = [
    {active:true,actions:[title]},
    {active:true,mutationType:'source',source:{actionReconciliation:{version:1,supersededKeys:[key]}},actions:[]},
    {active:true,actions:[color]},
    {active:true,mutationType:'source',source:{actionReconciliation:{version:1,supersededKeys:[]}},actions:[]},
  ];
  assert.deepEqual(compileActionGroups(groups).map(a=>a.id),['color']);
  assert.deepEqual(sourceRebaseActionIds(groups),['color']);
  groups[1].active=false;groups[2].active=false;groups[3].active=false;
  assert.deepEqual(compileActionGroups(groups).map(a=>a.id),['title']);
});

test('源码后整段手改覆盖同一标题的旧文字节点分支，撤销后保留节点修改',()=>{
 const base={id:'base',target:{...target,editorId:'element-11111111111111111111111111111111'},kind:'setText',payload:{text:'中间标题'},before:'原始标题',after:'中间标题'};
 const granular={...base,id:'granular',target:{...base.target,textPath:'0'},payload:{text:'Agent 标题'},before:'中间标题',after:'Agent 标题'};
 const manual={...base,id:'manual',payload:{text:'用户标题'},before:'中间标题',after:'用户标题'};
 const groups=[{active:true,actions:[base,granular]},{active:true,mutationType:'source',actions:[]},{active:true,actions:[manual]}];
 let result=compileActionGroups(groups);
 assert.deepEqual(result.map(a=>[a.id,a.before,a.after]),[['manual','原始标题','用户标题']]);
 groups[2].active=false;
 result=compileActionGroups(groups);
 assert.ok(result.some(a=>a.id==='granular'&&a.after==='Agent 标题'));
});

test('源码后连续两次移动不把第二次的起始值误判为源码覆盖',()=>{
 const t={...target,editorId:'element-11111111111111111111111111111111'};
 const move=(id,before,after)=>({id,target:t,kind:'translate',payload:after,before,after});
 const groups=[{active:true,actions:[move('base',{x:0,y:0},{x:-145,y:0})]},
  {active:true,mutationType:'source',actions:[]},
  {active:true,actions:[move('first',{x:-145,y:0},{x:-75,y:-1})]},
  {active:true,actions:[move('second',{x:-75,y:-1},{x:-72,y:-8})]}];
 const result=compileActionGroups(groups);
 assert.equal(result.length,1);assert.deepEqual(result[0].before,{x:0,y:0});
 assert.deepEqual(result[0].after,{x:-72,y:-8});
 assert.deepEqual(sourceRebaseActionIds(groups,result),['second']);
});

test('同一文字节点通过子标题和祖先容器交替修改时合并连续链',()=>{
 const child={...target,path:'3/0/0/3/0',editorId:'element-child',textPath:'0/0'};
 const parent={...target,path:'3/0/0',editorId:'element-parent',textPath:'3/0/0/0'};
 const edit=(id,target,before,after)=>({id,target,kind:'setText',payload:{text:after,sourceRange:{start:0,end:before.length}},before,after});
 const groups=[{active:true,actions:[edit('child',child,'原始','很长的标题')]},
  {active:true,actions:[edit('parent',parent,'很长的标题','短标题')]},
  {active:true,actions:[edit('noop',parent,'短标题','短标题')]},
  {active:true,actions:[edit('final',child,'很长的标题','短标题')]}];
 const compiled=compileActionGroups(groups);
 assert.equal(compiled.length,1);assert.equal(compiled[0].before,'原始');
 assert.equal(compiled[0].after,'短标题');assert.equal(compiled[0].target.editorId,'element-child');
});
