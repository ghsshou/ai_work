import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {startFixtureServer,openEditor} from './test-helpers.mjs';
import {installEditingTools} from '../../../integrations/dsh/editing-tools.mjs';
import {writeWorkspaceCapability} from '../workspace-capability.mjs';

test('原生编辑入口检查、提交、截图和查询复用真实画布与幂等回执',async t=>{
 const app=await startFixtureServer({bundle:true,fixtureTransform:html=>html.replace('<script src="/editor/patch-runtime.js"></script>','')});
 t.after(()=>app.close());
 const {browser,page}=await openEditor(app);t.after(()=>browser.close());
 const root=await mkdtemp(join(tmpdir(),'aico-native-e2e-'));t.after(()=>rm(root,{recursive:true,force:true}));
 const capabilityPath=await writeWorkspaceCapability(root,{url:app.url,token:app.token});
 let tool;let images=0;
 installEditingTools({tools:{register(value){tool=value;}},attachments:{saveImage:async()=>({id:`image-${++images}`})}},'http://127.0.0.1:1/?token=test',{
  request:(url,options)=>new URL(url).pathname==='/api/dsh-work-items/editing-context'
   ?Promise.resolve({ok:true,json:async()=>({status:'ready',capabilityPath})}):fetch(url,options),
 });
 const exec={agent:{session:{id:'test-session'}},signal:new AbortController().signal};
 const inspected=await tool.execute({operation:'inspect',query:'第一页标题'},exec);
 const target=inspected.targets.find(row=>row.target.tag==='H2').target;
 const args={operation:'edit',expectedRevision:inspected.revision,commandId:'11111111-1111-4111-a111-111111111111',actions:[{target,kind:'setText',payload:{text:'原生工具已修改'}}]};
 const edited=await tool.execute(args,exec);
 assert.equal(edited.committed,true,JSON.stringify(edited));
 assert.equal(edited.visualStatus,'ready',JSON.stringify(edited));
 assert.equal(edited.currentViewMatchesCommit,true);
 assert.equal(await page.frameLocator('#deck-frame').locator('h2').first().textContent(),'原生工具已修改');
 const receipt=await tool.execute({operation:'result',commandId:args.commandId},exec);assert.equal(receipt.committed,true);
 const repeated=await tool.execute(args,exec);
 assert.equal(repeated.committed,true,JSON.stringify(repeated));
 assert.equal(repeated.revision,edited.revision);
 assert.equal(app.session.groups.length,1);
});
