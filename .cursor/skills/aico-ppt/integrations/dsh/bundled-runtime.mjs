/** 压缩发行资源外置运行；源码模式保留原开发入口。 */
import {readFile,stat,realpath,mkdir} from 'node:fs/promises';
import {join,relative,isAbsolute,sep} from 'node:path';
import {homedir} from 'node:os';
import {acquireManagedRuntime} from './managed-runtime.mjs';

export async function resolveBundledRuntime(pluginRoot,env=process.env,{resourceDirectory}={}) {
  const metadata=JSON.parse(await readFile(join(pluginRoot,'package.json'),'utf8'));
  const source=join(pluginRoot,'runtime');
  try {await stat(source);} catch(error) {
    if(error.code!=='ENOENT')throw error;
    if(metadata.aico?.bundledRuntime)throw Error('发行包运行时资源缺失，请重新安装完整 Windows 插件包');
    return null;
  }
  const store=resourceDirectory||join(env.LOCALAPPDATA||join(homedir(),'.local','share'),'AICO','PptRuntime');
  await mkdir(store,{recursive:true});
  const packageRoot=await realpath(pluginRoot),suffix=relative(packageRoot,await realpath(store));
  if(!suffix||(!isAbsolute(suffix)&&suffix!=='..'&&!suffix.startsWith('..'+sep)))throw Error('私有运行时必须位于插件目录之外');
  const lease=await acquireManagedRuntime(source,store);
  return {root:lease.root,paths:{python:join(lease.root,'python','python.exe'),browser:join(lease.root,'browser','chrome.exe')},release:lease.release};
}
