import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reconcileSourceActions,reconcileLegacySourceHistory} from '../source-action-reconciliation.mjs';
import {compileActionGroups} from '../action-compiler.mjs';
import {EditTimeline} from '../edit-timeline.mjs';

const id='element-11111111111111111111111111111111';
const target={pageKey:'page-a',editorId:id,tag:'H2',path:'0',fingerprint:'old'};
const title={id:'title',target,kind:'setText',payload:{text:'动作标题'},before:'初始标题',after:'动作标题'};
const color={id:'color',target,kind:'setStyle',payload:{property:'color',value:'black'},before:'',after:'black'};
function fixture(before,after) {
 const versions=new Map();
 const add=html=>{
  const bytes=Buffer.from(`<script type="__bundler/template">${JSON.stringify(html).replaceAll('</','<\\u002F')}</script>`);
  const fp=createHash('sha256').update(bytes).digest('hex');versions.set(fp,{bytes:bytes.toString('base64')});return fp;
 };
 const source={beforeFingerprint:add(before),afterFingerprint:add(after)};
 return {source,io:{readWorkingDeck:async({versionFingerprint})=>versions.get(versionFingerprint)}};
}
const heading=text=>`<h2 data-editor-id="${id}">${text}</h2>`;

test('由前后源码证明标题覆盖，保留独立样式，历史迁移幂等且撤销可恢复',async()=>{
 const {source,io}=fixture(heading('初始标题'),heading('新的源码标题'));
 const state={version:1,revision:4,tasks:[],groups:[
  {id:'a',active:true,actions:[title,color]},
  {id:'s',active:true,mutationType:'source',source,actions:[]},
 ],redo:[]};
 EditTimeline.open(state);
 const migrated=await reconcileLegacySourceHistory(state,io);
 assert.equal(migrated.revision,5);
 assert.equal(migrated.timeline.entries.length,2);
 assert.deepEqual(compileActionGroups(migrated.groups).map(a=>a.id),['color']);
 assert.equal(state.timeline.entries[1].mutation.source.actionReconciliation,undefined);
 assert.equal(await reconcileLegacySourceHistory(migrated,io),null);
 EditTimeline.open(migrated).undo('s');
 assert.deepEqual(compileActionGroups(migrated.groups).map(a=>a.id),['title','color']);
});

test('重排、仅样式变化、重复身份与找不到目标不推断文字覆盖',async()=>{
 for(const after of [
  `<div>${heading('初始标题')}</div>`,
  heading('初始标题').replace('<h2 ','<h2 style="color:red" '),
  heading('新标题')+heading('另一个标题'),
  '<h2>无持久身份</h2>',
 ]) {
  const {source,io}=fixture(heading('初始标题'),after);
  assert.deepEqual((await reconcileSourceActions(source,[{active:true,actions:[title]}],io)).supersededKeys,[]);
 }
});

test('快照内容与归档指纹不符时不进行历史修复',async()=>{
 const {source,io}=fixture(heading('初始标题'),heading('新标题'));
 const original=io.readWorkingDeck;
 io.readWorkingDeck=async args=>({...await original(args),bytes:Buffer.from('篡改').toString('base64')});
 await assert.rejects(reconcileSourceActions(source,[{active:true,actions:[title]}],io),/指纹不一致/);
});

test('源码改父级布局时仅凭前后相同声明为旧 resize 提供重放证据，撤销保留动作',async()=>{
 const box=parent=>`<section style="${parent}"><div data-editor-id="${id}" style="display:flex;gap:16px">内容</div></section>`;
 const resize={id:'resize',target:{...target,tag:'DIV'},kind:'resize',payload:{width:1740,height:829},before:{width:1342,height:829.416},after:{width:1740,height:829}};
 const {source,io}=fixture(box('width:1342px'),box('width:1740px'));
 const groups=[{id:'a',active:true,actions:[resize]}];
 const evidence=await reconcileSourceActions(source,groups,io);
 const compiled=compileActionGroups([...groups,{id:'s',active:true,mutationType:'source',source:{...source,actionReconciliation:evidence},actions:[]}]);
 assert.equal(compiled[0].sourceResizeStyle,'display:flex;gap:16px');
 assert.equal(resize.sourceResizeStyle,undefined);
 const changed=fixture(box(''),box('').replace('display:flex;gap:16px','width:500px'));
 const rejected=await reconcileSourceActions(changed.source,groups,changed.io);
 assert.equal(Object.values(rejected.resizeBaselines)[0],null);
});

test('实际差异决定局部或完整检查；页面内共享样式也需要完整检查',async()=>{
 const original='<html><body><section data-page-id="page-one"><h2>旧标题</h2></section><section data-page-id="page-two"><p>第二页</p></section></body></html>';
 for(const [changed,flow,pages] of [
  [original.replace('旧标题','新标题'),'page-structure',['page-one']],
  [original.replace('<h2>','<style>p{color:red}</style><h2>'),'full-edit',['page-one','page-two']],
  [original.replace('<body>','<body class="new-layout">'),'full-edit',['page-one','page-two']],
 ]){
  const {source,io}=fixture(original,changed);
  const result=await reconcileSourceActions(source,[],io);
  assert.equal(result.impact.flow,flow);
  assert.deepEqual(result.impact.pageKeys,pages);
 }
});
