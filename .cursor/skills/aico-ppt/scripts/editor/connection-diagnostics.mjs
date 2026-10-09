/** 连接诊断仅记录白名单字段；写入失败不得影响业务。 */
import { mkdir, appendFile, stat, rename, readdir, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
export function connectionDiagnostics(component, { directory = join(homedir(), '.aico', 'diagnostics'), maxBytes = 1024 * 1024 } = {}) {
  const file = join(directory, `${component}-${process.pid}-${randomUUID()}.jsonl`);
  let chain = Promise.resolve(), pending = 0, initialized = false;
  const record = (event, details = {}) => {
    if (pending >= 128 || !/^[a-z-]{1,48}$/.test(event)) return;
    const entry = { time:new Date().toISOString(), component, event };
    for (const key of ['connectionId','sessionId','attempt','delayMs','code','status','upstreamStatus','port','durationMs','wasClean','opened','removed','removedBytes','kept','skipped']) {
      const value = details[key];
      if (typeof value === 'number' && Number.isFinite(value) || typeof value === 'boolean') entry[key] = value;
      else if (['connectionId','sessionId','code','skipped'].includes(key) && typeof value === 'string' && /^[a-zA-Z0-9_-]{1,80}$/.test(value)) entry[key] = value;
    }
    pending++;
    chain = chain.then(async () => {
      await mkdir(directory, {recursive:true});
      if (!initialized) {
        initialized = true;
        const names = (await readdir(directory)).filter(name => name.startsWith(component + '-') && /\.jsonl(?:\.1)?$/.test(name));
        const files = await Promise.all(names.map(async name => ({name, time:await stat(join(directory,name)).then(x=>x.mtimeMs,()=>0)})));
        files.sort((a,b)=>b.time-a.time);
        await Promise.all(files.slice(18).map(x=>unlink(join(directory,x.name)).catch(()=>{})));
      }
      if (await stat(file).then(x => x.size >= maxBytes, () => false)) await rename(file, file + '.1');
      await appendFile(file, JSON.stringify(entry) + '\n', {mode:0o600});
    }).catch(() => {}).finally(() => { pending--; });
  };
  return { record, file, flush:() => chain };
}
