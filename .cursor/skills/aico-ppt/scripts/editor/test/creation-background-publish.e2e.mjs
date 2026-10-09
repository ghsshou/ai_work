import test from 'node:test';
import assert from 'node:assert/strict';
import {startFixtureServer} from './test-helpers.mjs';
import {CreationManagedDeck} from '../creation-managed-deck.mjs';
import {resolveEditingContext} from '../dsh-editing-context.mjs';
test('创建项目未打开可见画布时可挂载后台 Editor 完成发布准备并释放', {timeout:30000}, async t=>{
 const app=await startFixtureServer({autoStartAgentTerminal:false});t.after(()=>app.close());
 const managed=new CreationManagedDeck({editor:app,sourceDeckPath:app.deckPath});
 const result=await managed.preparePublish();assert.equal(result.solidified,false);
 assert.equal(app.hasEditorConnection(),false);
});
test('创建会话解析自己的 Managed Editor，不借用其他编辑项目',async t=>{
 const app=await startFixtureServer({autoStartAgentTerminal:false});t.after(()=>app.close());
 const result=await resolveEditingContext({sessionId:'creation-session',workCatalog:{resolveByDshSession:async()=>({kind:'creation',workId:'creation-work',draftId:'draft',projectRoot:'/project'})},findEditingRuntime:()=>{throw Error('不能借用编辑项目')},findCreationRuntime:()=>({workspace:{managedDeck:{editor:app}}})});
 assert.equal(result.status,'ready');assert.equal(result.deckPath,app.deckPath);
});

test('创建项目切离后，带未固化修改的发布仍走真实固化事务', {timeout:60000},async t=>{
 const {startHeadlessEditorRuntime}=await import('../headless-editor-runtime.mjs');
 const {execFile}=await import('node:child_process');const {promisify}=await import('node:util');
 const {readFile}=await import('node:fs/promises');
 const app=await startFixtureServer({autoStartAgentTerminal:false,bundle:true});t.after(()=>app.close());
 const managed=new CreationManagedDeck({editor:app,sourceDeckPath:app.deckPath});
 const visible=await startHeadlessEditorRuntime({editorUrl:managed.snapshot().editorUrl});t.after(()=>visible.close());
 await app.waitUntilReady({timeoutMs:5000});
 await promisify(execFile)(process.execPath,['scripts/editor/cli.mjs','replace-text','第一页标题','后台发布已固化'],{env:{...process.env,AICO_PPT_EDITOR_URL:app.url,AICO_PPT_EDITOR_TOKEN:app.token,AICO_PPT_WORKSPACE_CAPABILITY_FILE:''}});
 assert.equal(app.session.groups.length,1);
 await visible.close();
 for(let i=0;i<50 && app.hasEditorConnection();i++)await new Promise(r=>setTimeout(r,20));
 assert.equal(app.hasEditorConnection(),false);
 const result=await managed.preparePublish();
 assert.equal(result.solidified,true);assert.equal(app.session.groups.length,0);
 assert.match(await readFile(app.deckPath,'utf8'),/后台发布已固化/);
});
