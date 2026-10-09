import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditorViews} from '../editor-view.mjs';
import {loadChromium,chromiumLaunchOptions} from '../../verify/load-playwright.mjs';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
import {readFile} from 'node:fs/promises';

test('页面图包含未固化动作和父容器；重复查看复用缓存，新动作不复用旧图',async t=>{
 let inner=await readFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'),'utf8');
 inner=inner.replace('<section data-label="目录页">','<section data-page-id="page-11111111111111111111111111111111" data-label="目录页">');
 inner=inner.replace('<h2>第一页标题</h2>','<h2 data-editor-id="element-11111111111111111111111111111111">第一页标题</h2>');
 // 编辑器会重新生成补丁 runtime；测试 bundle 只负责解包。
 inner=inner.replace('<script src="../../runtime/patch-runtime.js"></script>','');
 const bytes=Buffer.from('<script type="__bundler/manifest">\n{}\n</script>\n<script type="__bundler/template">\n'+JSON.stringify(inner).replaceAll('</','<\\u002F')+'\n</script>\n<script>const html=JSON.parse(document.querySelector(\'script[type="__bundler/template"]\').textContent);document.open();document.write(html);document.close();</script>');
 let launches=0;
 const view=createEditorViews({launch:async()=>{launches++;return(await loadChromium()).launch(chromiumLaunchOptions());}});
 t.after(()=>view.close());
 const initial=await view({bytes,actions:[]},{query:'第一页标题'});
 const target=initial.targets.find(t=>t.target.tag==='H2').target;
 const action={id:'change',target,kind:'setText',payload:{text:'修改后的标题'},before:'第一页标题',after:'修改后的标题'};
 const changed=await view({bytes,actions:[action]},{query:'修改后的标题'});
 assert.ok(changed.targets.some(t=>t.text==='修改后的标题'));
 assert.notEqual(changed.stateId,initial.stateId);
 assert.notEqual(changed.image,initial.image);
 assert.equal(Buffer.from(changed.image,'base64').subarray(1,4).toString(),'PNG');
 const cached=await view({bytes,actions:[action]},{query:'修改后的标题'});
 assert.equal(cached.image,changed.image);assert.equal(cached.cacheHit,true);
 assert.equal(launches,1);
 const directory=await view({bytes,actions:[action]},{catalogOnly:true});
 assert.equal(directory.mode,'page-directory');
 assert.equal(directory.pages.length,2);
 assert.equal(directory.image,undefined);
});

test('同版本页面的检索与查看复用渲染，查看不返回定位候选',async t=>{
 const inner=(await readFile(resolve('scripts/editor/test/fixtures/minimal-deck.html'),'utf8')).replace('<script src="../../runtime/patch-runtime.js"></script>','');
 const bytes=Buffer.from('<script type="__bundler/manifest">\n{}\n</script>\n<script type="__bundler/template">\n'+JSON.stringify(inner).replaceAll('</','<\\u002F')+'\n</script>\n<script>const html=JSON.parse(document.querySelector(\'script[type="__bundler/template"]\').textContent);document.open();document.write(html);document.close();</script>');
 let launches=0;
 const view=createEditorViews({launch:async()=>{launches++;return(await loadChromium()).launch(chromiumLaunchOptions());}});
 t.after(()=>view.close());
 const first=await view({bytes,actions:[]},{pageKey:'1',query:'第一页'});
 const second=await view({bytes,actions:[]},{pageKey:'1',query:'卡片'});
 const picture=await view({bytes,actions:[]},{pageKey:'1',mode:'view'});
 assert.equal(launches,1,'改变检索条件不能重启浏览器');
 assert.equal(first.image,second.image);
 assert.equal(second.cacheHit,true);assert.equal(picture.cacheHit,true);
 assert.equal(picture.image,first.image);
 assert.equal(picture.targets,undefined,'看图不重复输出目标与父容器');
 assert.equal(picture.pages,undefined,'看图不重复输出整个目录');
});
