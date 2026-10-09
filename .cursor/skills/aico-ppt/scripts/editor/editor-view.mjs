/** 带内容指纹的标准页面截图；所有工作在隐藏页面内完成。 */
import {createHash} from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {loadChromium,chromiumLaunchOptions} from '../verify/load-playwright.mjs';
import {withEffectiveDeck} from './effective-deck.mjs';

export function createEditorViews({launch=async()=> (await loadChromium()).launch(chromiumLaunchOptions())}={}) {
  const cache=new Map();
  const active=new Set(), pending=new Map();
  let closed=false, browserPromise=null;
  const getBrowser=()=>{
    browserPromise ??= launch().then(async browser=>{
      if(closed){await browser.close();throw new Error('截图服务已关闭');}
      browser.on?.('disconnected',()=>{browserPromise=null;});
      return browser;
    }).catch(error=>{browserPromise=null;throw error;});
    return browserPromise;
  };
  async function render(input,{pageKey=null,catalogOnly=false}={}) {
    const key=createHash('sha256').update(input.bytes).update(JSON.stringify([input.actions,pageKey,catalogOnly])).digest('hex');
    if(cache.has(key))return structuredClone(cache.get(key));
    const started=Date.now();
    const result=await withEffectiveDeck(input,async({path,stateId})=>{
      const browser=await getBrowser();
      let page;
      try {
        if(closed)throw new Error('截图服务已关闭');
        page=await browser.newPage({viewport:{width:1920,height:1080},deviceScaleFactor:1});
        active.add(page);
        await page.goto(pathToFileURL(path).href,{waitUntil:'load',timeout:60_000});
        await page.waitForFunction(()=>['applied','failed'].includes(window.HuaweiDeckEditorPatchStatus?.state),undefined,{timeout:30_000});
        await page.evaluate(async()=>{
          const status=window.HuaweiDeckEditorPatchStatus;
          if(status?.state==='failed')throw new Error(`${status.error?.code}: ${status.error?.failedActionId}`);
          await Promise.race([document.fonts.ready,new Promise((_,reject)=>setTimeout(()=>reject(new Error('字体加载超时')),10_000))]);
          await Promise.all([...document.images].map(img=>img.complete
            ? (img.naturalWidth ? Promise.resolve() : Promise.reject(new Error('图片加载失败')))
            : new Promise((resolve,reject)=>{
            const timer=setTimeout(()=>reject(new Error('图片加载超时')),10_000);
            img.addEventListener('load',()=>{clearTimeout(timer);resolve();},{once:true});
            img.addEventListener('error',()=>{clearTimeout(timer);reject(new Error('图片加载失败'));},{once:true});
          })));
        });
        await page.addStyleTag({content:`.glassbar,.railpanel,.railfoot,.hint,.noteschip,#__deck_loading_overlay{display:none!important}
          .stage .slide-fit{width:1920px!important;height:1080px!important}
          .stage .slide-canvas{content-visibility:visible!important;transform:none!important;width:1920px!important;height:1080px!important}
          .build{opacity:1!important;transform:none!important;filter:none!important}`});
        const detail=await page.evaluate(({pageKey,catalogOnly})=>{
          const rt=window.HuaweiDeckPatchRuntime;
          const canvases=[...document.querySelectorAll('.stage .slide-canvas')];
          const pages=canvases.map((c,i)=>({pageKey:rt.pageKey(c),index:i+1,label:c.querySelector('section')?.dataset.label??''}));
          if(catalogOnly)return {pages,index:-1};
          const index=pageKey?pages.findIndex(p=>p.pageKey===pageKey||p.label===pageKey||String(p.index)===String(pageKey)):0;
          if(index<0)throw new Error('找不到目标页面');
          const canvas=canvases[index],origin=canvas.getBoundingClientRect();
          const rows=[];
          for(const el of canvas.querySelectorAll('[data-editor-id]')) {
            const r=el.getBoundingClientRect();
            if(!r.width||!r.height||getComputedStyle(el).display==='none')continue;
            const text=(el.textContent??'').trim().slice(0,180);
            const box={x:r.x-origin.x,y:r.y-origin.y,w:r.width,h:r.height};
            try{
              const target=rt.makeLocator(el);
              const parent=el.parentElement?.closest('[data-editor-id]');
              const css=getComputedStyle(el);
              const style=Object.fromEntries(['color','background-color','font-size','font-family','font-weight','border-color','border-width','border-radius','display','position','text-align'].map(k=>[k,css.getPropertyValue(k)]));
              rows.push({target,text,parent:parent?rt.makeLocator(parent):null,style,box});
            }catch{}
          }
          return {page:pages[index],pages,targets:rows,index};
        },{pageKey,catalogOnly});
        if(catalogOnly)return {pages:detail.pages,stateId,mode:'page-directory',message:'请根据页面目录指定 pageKey；当前没有可用的右侧视图'};
        const canvas=(await page.$$('.stage .slide-canvas'))[detail.index];
        await canvas.scrollIntoViewIfNeeded();
        const image=await canvas.screenshot({type:'png'});
        return {...detail,stateId,image:Buffer.from(image).toString('base64'),mediaType:'image/png',renderMode:'standard-full-build',elapsedMs:Date.now()-started};
      }finally{if(page){active.delete(page);await page.close().catch(()=>{});}}
    });
    cache.set(key,result);
    while(cache.size>3)cache.delete(cache.keys().next().value);
    return structuredClone(result);
  }
  const view=async(input,options={})=>{
    if(closed)throw new Error('截图服务已关闭');
    const {pageKey=null,catalogOnly=false}=options;
    // 检索词、区域与返回字段不影响像素；同版本的查询共用一份渲染。
    const key=createHash('sha256').update(input.bytes).update(JSON.stringify([input.actions,pageKey,catalogOnly])).digest('hex');
    let hit=cache.has(key)||pending.has(key);
    let job=pending.get(key);
    if(!job) {
      if(!cache.has(key)&&pending.size>=2)throw Object.assign(new Error('正在生成其他页面截图，请稍后查看'),{code:'VIEW_BUSY',statusCode:409});
      job=render(input,{pageKey,catalogOnly});
      pending.set(key,job);
    }
    let result;
    try{result=await job;}finally{if(pending.get(key)===job)pending.delete(key);}
    if(catalogOnly)return result;
    const {targets,pages,...picture}=result;
    if(options.mode==='view')return {...picture,cacheHit:hit};
    const query=options.query??'',rect=options.rect;
    const rows=targets.flatMap(({box,...row})=>{
      if(query&&!row.text.includes(query))return [];
      const intersection=rect?Math.max(0,Math.min(box.x+box.w,rect.x+rect.w)-Math.max(box.x,rect.x))*Math.max(0,Math.min(box.y+box.h,rect.y+rect.h)-Math.max(box.y,rect.y)):0;
      if(rect&&!intersection)return [];
      return [{...row,score:rect?intersection/Math.max(1,box.w*box.h+rect.w*rect.h-intersection):1/Math.max(1,box.w*box.h)}];
    }).sort((a,b)=>b.score-a.score);
    const limit=Math.max(1,Math.min(32,Number.isSafeInteger(options.limit)?options.limit:4));
    const offset=Math.max(0,Number.isSafeInteger(options.offset)?options.offset:0);
    return {...picture,...(options.includePages?{pages}:{}),targets:rows.slice(offset,offset+limit),targetCount:rows.length,
      hasMore:rows.length>offset+limit,nextOffset:rows.length>offset+limit?offset+limit:null,cacheHit:hit};
  };
  view.close=async()=>{
    closed=true;cache.clear();
    await Promise.allSettled([...active].map(page=>page.close()));
    const browser=await browserPromise?.catch(()=>null);
    await browser?.close();
    await Promise.allSettled([...pending.values()]);
    cache.clear();
  };
  return view;
}
