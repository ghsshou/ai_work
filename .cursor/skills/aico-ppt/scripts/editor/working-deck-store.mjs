import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { defaultPythonExecutable, pythonUtf8SpawnOptions } from './python-utf8.mjs';


const ADAPTER = fileURLToPath(new URL('./working_deck.py', import.meta.url));
const PATCH_VERIFIER = fileURLToPath(new URL('../verify/patches.mjs', import.meta.url));
const MAX_WORKING_DECK_JSON_BYTES = 72 * 1024 * 1024;
const PATCH_BEGIN = '<!-- huawei-deck-editor:begin -->';
const PATCH_END = '<!-- huawei-deck-editor:end -->';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const FINGERPRINT = /^[a-f0-9]{64}$/;
const DEFAULT_PYTHON_EXECUTABLE = defaultPythonExecutable();

// 只扫描新到达的数据；逐块计算累计字符串大小会让大 Deck 接收退化为平方复杂度。
function collectWorkingOutput(child) {
  const chunks=[];
  let bytes=0,exceeded=false;
  child.stdout.setEncoding('utf8');
  child.stdout.on('data',chunk=>{
    if(exceeded)return;
    bytes+=Buffer.byteLength(chunk);
    if(bytes>MAX_WORKING_DECK_JSON_BYTES){exceeded=true;child.kill('SIGKILL');return;}
    chunks.push(chunk);
  });
  return ()=>{
    if(exceeded)throw new Error('工作副本适配器输出超过上限');
    return chunks.join('');
  };
}

function invalidWorkingDeck(error) {
  if (error && typeof error === 'object') {
    error.code = 'INVALID_WORKING_DECK';
    error.statusCode = 409;
    return error;
  }
  return Object.assign(new Error(String(error)), {
    code:'INVALID_WORKING_DECK', statusCode:409,
  });
}

function decodePrepared(stdout) {
  const value = JSON.parse(stdout);
  if (!value || typeof value !== 'object' || !Array.isArray(value.pageIds)
    || !value.pageKeyMap || typeof value.pageKeyMap !== 'object'
    || typeof value.bytes !== 'string') throw new Error('工作副本适配器返回无效结果');
  const bytes = Buffer.from(value.bytes, 'base64');
  if (!bytes.length || Buffer.byteLength(value.bytes) > 64 * 1024 * 1024) {
    throw new Error('工作副本适配器返回内容为空或过大');
  }
  return { ...value, bytes };
}

function runPrepare(sourcePath, {
  pythonExecutable=DEFAULT_PYTHON_EXECUTABLE, spawnProcess=spawn,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(pythonExecutable, [ADAPTER, sourcePath], pythonUtf8SpawnOptions({
      stdio:['ignore', 'pipe', 'pipe'],
    }));
    const readOutput = collectWorkingOutput(child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `工作副本适配器退出码 ${code}`));
        return;
      }
      try { resolvePromise(decodePrepared(readOutput())); }
      catch (error) { reject(error); }
    });
  });
}

export function materializePatchBytes(bytes, patches, {
  pythonExecutable=DEFAULT_PYTHON_EXECUTABLE, spawnProcess=spawn,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(pythonExecutable, [ADAPTER, '--apply-patches'], pythonUtf8SpawnOptions({
      stdio:['pipe', 'pipe', 'pipe'],
    }));
    const readOutput = collectWorkingOutput(child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `工作副本补丁适配器退出码 ${code}`));
        return;
      }
      try {
        const value = JSON.parse(readOutput());
        const output = Buffer.from(value.bytes, 'base64');
        if (!output.length) throw new Error('工作副本补丁适配器返回空内容');
        resolvePromise(output);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({
      bytes:Buffer.from(bytes).toString('base64'), patches,
    }));
  });
}

function runIdentityAdapter(bytes, {
  pythonExecutable=DEFAULT_PYTHON_EXECUTABLE, spawnProcess=spawn,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const child = spawnProcess(pythonExecutable, [ADAPTER, '--normalize-bytes'], pythonUtf8SpawnOptions({
      stdio:['pipe', 'pipe', 'pipe'],
    }));
    const readOutput = collectWorkingOutput(child);
    let stderr = '';
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', chunk => { stderr = `${stderr}${chunk}`.slice(-16_384); });
    child.once('error', reject);
    child.once('close', code => {
      if (code !== 0) {
        reject(new Error(stderr.trim() || `工作副本身份适配器退出码 ${code}`));
        return;
      }
      try {
        const value = JSON.parse(readOutput());
        const output = Buffer.from(value.bytes, 'base64');
        if (!output.length) throw new Error('工作副本身份适配器返回空内容');
        resolvePromise(output);
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify({ bytes:Buffer.from(bytes).toString('base64') }));
  });
}

export function verifyWorkingPatchReplay(path, {
  spawnProcess=spawn, timeoutMs=180_000, droppableActionIds=[],
} = {}) {
  if (!Array.isArray(droppableActionIds)
    || droppableActionIds.some(id => typeof id !== 'string' || !id)
    || new Set(droppableActionIds).size !== droppableActionIds.length) {
    throw new TypeError('可清理动作标识必须是唯一非空字符串数组');
  }
  return new Promise((resolvePromise, reject) => {
    const repairMissing = droppableActionIds.length > 0;
    const child = spawnProcess(process.execPath, [
      PATCH_VERIFIER, resolve(path), ...(repairMissing ? ['--repair-missing'] : []),
    ], {
      stdio:[repairMissing ? 'pipe' : 'ignore', 'pipe', 'pipe'],
      // 打包宿主的 execPath 指向 Desktop.exe；只为本次 Node 验证子进程
      // 指定运行模式，不依赖宿主保留该环境变量，也不改写宿主 process.env。
      ...(process.versions.electron ? { env:{...process.env,ELECTRON_RUN_AS_NODE:'1'} } : {}),
      windowsHide:true,
    });
    let stdout = '';
    let stderr = '';
    const append = (current, chunk) => `${current}${chunk}`.slice(-32_768);
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => { stdout = append(stdout, chunk); });
    child.stderr.on('data', chunk => { stderr = append(stderr, chunk); });
    const timer = setTimeout(() => child.kill('SIGKILL'), timeoutMs);
    timer.unref?.();
    child.once('error', error => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', code => {
      clearTimeout(timer);
      if (code === 0) {
        let report;
        try { report = JSON.parse(stdout.trim()); }
        catch (error) {
          reject(Object.assign(new Error(`补丁验证器成功响应无效：${error.message}`), {
            code:'PATCH_REPLAY_UNAVAILABLE', statusCode:500, stage:'patch-replay',
          }));
          return;
        }
        const droppedActionIds = report?.droppedActionIds ?? [];
        if (!Array.isArray(droppedActionIds)
          || droppedActionIds.some(id => typeof id !== 'string' || !id)
          || new Set(droppedActionIds).size !== droppedActionIds.length) {
          reject(Object.assign(new Error('补丁验证器返回的批量清理结果无效'), {
            code:'PATCH_REPLAY_UNAVAILABLE', statusCode:500, stage:'patch-replay',
          }));
          return;
        }
        resolvePromise({ ok:true, droppedActionIds });
        return;
      }
      const diagnostic = [stdout.trim(), stderr.trim()].filter(Boolean).join('\n');
      let report;
      try { report = JSON.parse(stdout.trim()); } catch { /* 保留原始诊断。 */ }
      const failedActionId = typeof report?.error?.failedActionId === 'string'
        && report.error.failedActionId ? report.error.failedActionId : undefined;
      const replayCode = typeof report?.error?.code === 'string'
        && report.error.code ? report.error.code : undefined;
      const replayFailed = code === 1;
      reject(Object.assign(new Error(replayFailed
        ? '历史修改无法安全重放，已拒绝当前候选且原 Deck 未被改动'
        : diagnostic || '补丁重放验证基础设施不可用'), {
        code:replayFailed ? 'PATCH_REPLAY_FAILED' : 'PATCH_REPLAY_UNAVAILABLE',
        statusCode:replayFailed ? 409 : 500,
        stage:'patch-replay',
        recovery:replayFailed
          ? '原 Deck 未被改动；撤销或重新执行提示中的冲突修改后重试'
          : '确认本机 Chrome 与 Node.js 可用后重试',
        ...(failedActionId ? { failedActionId } : {}),
        ...(replayCode ? { replayCode } : {}),
        ...(diagnostic ? { diagnostic } : {}),
      }));
    });
    if (repairMissing) child.stdin.end(JSON.stringify({ droppableActionIds }));
  });
}

export async function writeVerifiedPatches(store, patches, {
  verify=(path, options) => verifyWorkingPatchReplay(path, options),
  droppableActionIds=[],
} = {}) {
  if (!store || typeof store.writePatches !== 'function'
    || typeof store.restore !== 'function' || typeof store.path !== 'string') {
    throw new TypeError('补丁固化需要可写、可恢复的工作副本');
  }
  if (!Array.isArray(patches) || !Array.isArray(droppableActionIds)
    || droppableActionIds.some(id => typeof id !== 'string' || !id)) {
    throw new TypeError('补丁和可取代动作标识必须是数组');
  }
  const droppable = new Set(droppableActionIds);
  const effectivePatches = structuredClone(patches);
  const droppedActionIds = [];
  while (true) {
    const written = await store.writePatches(effectivePatches);
    let repairActionIds = [];
    let verificationError = null;
    try {
      const verified = await verify(store.path, {
        droppableActionIds:[...droppable],
      });
      repairActionIds = verified?.droppedActionIds ?? [];
      const repairSet = new Set(repairActionIds);
      const validRepair = Array.isArray(repairActionIds)
        && repairSet.size === repairActionIds.length
        && repairActionIds.every(id => typeof id === 'string' && id
          && droppable.has(id)
          && effectivePatches.some(patch => patch?.id === id));
      if (!validRepair) {
        throw Object.assign(new Error('补丁验证器返回了未授权或不存在的清理动作'), {
          code:'INVALID_PATCH_REPAIR', statusCode:500,
        });
      }
    } catch (error) {
      const failedActionId = error?.failedActionId;
      const canDrop = error?.code === 'PATCH_REPLAY_FAILED'
        && ['PAGE_NOT_FOUND', 'TARGET_NOT_FOUND'].includes(error?.replayCode)
        && droppable.has(failedActionId);
      const failedIndex = canDrop
        ? effectivePatches.findIndex(patch => patch?.id === failedActionId) : -1;
      if (failedIndex >= 0) repairActionIds = [failedActionId];
      else verificationError = error;
    }
    if (repairActionIds.length === 0 && verificationError === null) {
      return {
        ...written,
        effectivePatches:structuredClone(effectivePatches),
        droppedActionIds:[...droppedActionIds],
      };
    }
    try {
      await store.restore(written.previousFingerprint, written.fingerprint);
    } catch (restoreError) {
      // 仅显示稳定错误码，不把子进程输出、环境变量或令牌带进界面。
      const errorCode = error => /^[A-Z][A-Z0-9_]{0,79}$/.test(error?.code ?? '')
        ? error.code : 'UNKNOWN';
      const verifyCode = verificationError ? errorCode(verificationError) : 'PATCH_REPAIR';
      throw Object.assign(new Error(
        `补丁验证失败且工作副本无法恢复（验证：${verifyCode}；恢复：${errorCode(restoreError)}），请重启 Editor 完成对账`,
      ), {
        code:'RECOVERY_REQUIRED', statusCode:503,
        committed:true, commitScope:'working-deck',
        cause:restoreError, originalError:verificationError,
      });
    }
    if (verificationError) throw verificationError;
    const repairSet = new Set(repairActionIds);
    for (let index=effectivePatches.length - 1; index >= 0; index-=1) {
      if (repairSet.has(effectivePatches[index]?.id)) effectivePatches.splice(index, 1);
    }
    droppedActionIds.push(...repairActionIds);
  }
}

function templateFromBundle(bytes) {
  const source = Buffer.from(bytes).toString('utf8');
  const match = source.match(/<script type="__bundler\/template">\s*([\s\S]*?)\s*<\/script>/);
  if (!match) throw new Error('工作副本缺少 bundle template');
  return JSON.parse(match[1]);
}

function embeddedPatchesFromTemplate(template) {
  const count = marker => template.split(marker).length - 1;
  const beginCount = count(PATCH_BEGIN);
  const endCount = count(PATCH_END);
  if (beginCount === 0 && endCount === 0) return [];
  if (beginCount !== 1 || endCount !== 1) {
    throw new Error('工作副本补丁标记必须各恰好出现一次');
  }
  const begin = template.indexOf(PATCH_BEGIN);
  const end = template.indexOf(PATCH_END);
  if (begin >= end) throw new Error('工作副本补丁标记顺序错误');
  const block = template.slice(begin, end + PATCH_END.length);
  const scripts = [...block.matchAll(
    /<script\b(?=[^>]*\btype=["']application\/json["'])(?=[^>]*\bid=["']huawei-deck-editor-patches["'])[^>]*>([\s\S]*?)<\/script>/g,
  )];
  if (scripts.length !== 1) {
    throw new Error('工作副本必须包含唯一补丁 JSON script');
  }
  let patches;
  try { patches = JSON.parse(scripts[0][1]); }
  catch (error) { throw new Error(`工作副本补丁 JSON 无效：${error.message}`); }
  if (!Array.isArray(patches)
    || patches.some(item => !item || typeof item !== 'object' || Array.isArray(item))) {
    throw new Error('工作副本补丁 JSON 顶层必须是对象数组');
  }
  return patches;
}

export function pageIdsFromBundle(bytes) {
  const template = templateFromBundle(bytes);
  const sections = [...template.matchAll(
    /<section\b(?=[^>]*\bdata-label="[^"]+")[^>]*>/g,
  )].map(match => match[0]);
  const ids = sections.map(section => (
    section.match(/\bdata-page-id="(page-[0-9a-f]{32})"/)?.[1] ?? null
  ));
  const navNumbers = [...template.matchAll(/\{ i:(\d+),/g)].map(match => Number(match[1]));
  const countLayoutNodes = className => [...template.matchAll(new RegExp(
    `<div\\b[^>]*\\bclass=(["'])[^"']*\\b${className}\\b[^"']*\\1[^>]*>`,
    'g',
  ))].length;
  const fittedSlides = countLayoutNodes('slide-fit');
  // 旧模板和测试夹具可能直接把 slide-canvas 放在 stage 下，没有 slide-fit 外壳。
  // 两种结构都以“一个页面容器对应一个 section”作为三处同步不变量。
  const slideCount = fittedSlides || countLayoutNodes('slide-canvas');
  if (!ids.length || ids.some(id => id === null) || ids.length !== new Set(ids).size) {
    throw new Error('工作副本 pageId 缺失或重复');
  }
  if (slideCount !== sections.length || navNumbers.length !== sections.length
    || navNumbers.some((value, index) => value !== index)) {
    throw new Error(
      `工作副本 slide / section / nav 未保持三处同步：`
      + `slides=${slideCount}, sections=${sections.length}, nav=${navNumbers.length}`,
    );
  }
  return ids;
}

function inspectBundle(bytes) {
  try {
    const template = templateFromBundle(bytes);
    return {
      managed:true,
      pageIds:pageIdsFromBundle(bytes),
      embeddedPatches:embeddedPatchesFromTemplate(template),
    };
  }
  catch (error) {
    if (!Buffer.from(bytes).toString('utf8').includes('<script type="__bundler/template">')) {
      return { managed:false, pageIds:[], embeddedPatches:null };
    }
    throw error;
  }
}

function decodeRead(result) {
  if (!result || typeof result.bytes !== 'string'
    || typeof result.fingerprint !== 'string') throw new Error('工作副本读取结果无效');
  const bytes = Buffer.from(result.bytes, 'base64');
  if (sha256(bytes) !== result.fingerprint) throw new Error('工作副本读取指纹不一致');
  return { bytes, fingerprint:result.fingerprint };
}

export class WorkingDeckStore {
  static async open({
    deckPath, sessionDir, sessionId, sidecarIO,
    pythonExecutable=DEFAULT_PYTHON_EXECUTABLE, spawnProcess=spawn,
    manageBundle=true, expectedWorkingFingerprint=null,
    reservedBeforeFingerprint=null,
  }) {
    if (reservedBeforeFingerprint !== null
      && (!FINGERPRINT.test(reservedBeforeFingerprint)
        || reservedBeforeFingerprint !== expectedWorkingFingerprint)) {
      throw new Error('持久化源码事务的起始指纹与 session 工作副本基线不一致');
    }
    const workingPath = join(sessionDir, 'working', 'deck.html');
    const existing = await sidecarIO.readWorkingDeck({ missingOk:true });
    if (existing) {
      let current = decodeRead(existing);
      let recovery = null;
      const fingerprintMap = {};
      let inspected;
      try {
        inspected = manageBundle
          ? inspectBundle(current.bytes)
          : { managed:false, pageIds:[], embeddedPatches:null };
      } catch (error) {
        const invalid = invalidWorkingDeck(error);
        if (!FINGERPRINT.test(expectedWorkingFingerprint ?? '')
          || expectedWorkingFingerprint === current.fingerprint) throw invalid;
        try {
          await sidecarIO.restoreWorkingDeck({
            fingerprint:expectedWorkingFingerprint,
            expectedFingerprint:current.fingerprint,
          });
          const invalidFingerprint = current.fingerprint;
          current = decodeRead(await sidecarIO.readWorkingDeck({ missingOk:false }));
          if (current.fingerprint !== expectedWorkingFingerprint) {
            throw new Error('恢复后的 working Deck 指纹与 session 基线不一致');
          }
          inspected = manageBundle
            ? inspectBundle(current.bytes)
            : { managed:false, pageIds:[], embeddedPatches:null };
          recovery = {
            code:'WORKING_DECK_RECOVERED',
            invalidFingerprint,
            restoredFingerprint:current.fingerprint,
          };
        } catch (recoveryError) {
          invalid.recoveryError = recoveryError;
          throw invalid;
        }
      }
      if (inspected.managed) {
        let normalized;
        try {
          normalized = await runIdentityAdapter(current.bytes, { pythonExecutable, spawnProcess });
        } catch (error) {
          throw invalidWorkingDeck(error);
        }
        if (!normalized.equals(current.bytes)) {
          const previousFingerprint = current.fingerprint;
          const written = await sidecarIO.writeWorkingDeck({
            sessionId, bytes:normalized, expectedFingerprint:previousFingerprint,
          });
          if (written.fingerprint !== sha256(normalized)) {
            throw new Error('工作副本身份迁移落盘指纹不一致');
          }
          current = { bytes:normalized, fingerprint:written.fingerprint };
          fingerprintMap[previousFingerprint] = written.fingerprint;
          inspected = inspectBundle(normalized);
        }
      }
      const store = new WorkingDeckStore({
        deckPath, workingPath, sessionId, sidecarIO,
        // 源码事务可能在写盘后、显式 commit 前遭遇服务退出。此时磁盘内容
        // 是待提交候选，session 指纹仍是事务起始版本；启动时必须保留旧基线，
        // 让 checkpointExternalChange 能重建同一条 before -> after SourceMutation。
        fingerprint:reservedBeforeFingerprint === null
          ? current.fingerprint
          : (fingerprintMap[reservedBeforeFingerprint] ?? reservedBeforeFingerprint),
        pageIds:inspected.pageIds,
        managed:inspected.managed,
        embeddedPatches:inspected.embeddedPatches,
        pythonExecutable, spawnProcess,
      });
      await sidecarIO.archiveWorkingDeck({ expectedFingerprint:current.fingerprint });
      return { store, pageKeyMap:{}, fingerprintMap, recovery };
    }
    const prepared = manageBundle
      ? await runPrepare(resolve(deckPath), { pythonExecutable, spawnProcess })
      : {
        bytes:await readFile(resolve(deckPath)),
        pageIds:[],
        pageKeyMap:{},
        managed:false,
      };
    const written = await sidecarIO.writeWorkingDeck({
      sessionId, bytes:prepared.bytes, expectedFingerprint:null,
    });
    if (written.fingerprint !== sha256(prepared.bytes)) {
      throw new Error('工作副本落盘指纹与准备结果不一致');
    }
    const store = new WorkingDeckStore({
      deckPath, workingPath, sessionId, sidecarIO,
      fingerprint:written.fingerprint, pageIds:prepared.pageIds,
      managed:prepared.managed !== false,
      embeddedPatches:manageBundle
        ? inspectBundle(prepared.bytes).embeddedPatches : null,
      pythonExecutable, spawnProcess,
    });
    return { store, pageKeyMap:prepared.pageKeyMap, fingerprintMap:{}, recovery:null };
  }

  constructor({
    deckPath, workingPath, sessionId, sidecarIO, fingerprint, pageIds,
    pythonExecutable=DEFAULT_PYTHON_EXECUTABLE, spawnProcess=spawn,
    managed=true, embeddedPatches=null,
  }) {
    this.deckPath = resolve(deckPath);
    this.path = resolve(workingPath);
    this.sessionId = sessionId;
    this.sidecarIO = sidecarIO;
    this.fingerprint = fingerprint;
    this.pageIds = [...pageIds];
    this.managed = managed;
    this.embeddedPatches = embeddedPatches === null
      ? null : structuredClone(embeddedPatches);
    this.pythonExecutable = pythonExecutable;
    this.spawnProcess = spawnProcess;
    this.pendingExternalChange = null;
  }

  mapLegacyPageKey(value) {
    if (!this.managed) return value;
    if (this.pageIds.includes(value)) return value;
    const match = String(value ?? '').match(/^page-(\d{3})-[0-9a-f]{8}$/);
    if (!match) throw new Error(`无法迁移历史 pageKey：${value}`);
    const pageId = this.pageIds[Number(match[1]) - 1];
    if (!pageId) throw new Error(`历史 pageKey 页序越界：${value}`);
    return pageId;
  }

  async read() {
    const value = decodeRead(await this.sidecarIO.readWorkingDeck({ missingOk:false }));
    if (value.fingerprint !== this.fingerprint) {
      throw Object.assign(new Error('working Deck 已被外部修改，等待记录结构历史'), {
        code:'WORKING_DECK_CHANGED',
        expectedFingerprint:this.fingerprint,
        actualFingerprint:value.fingerprint,
      });
    }
    return value.bytes;
  }

  async replace(bytes, expectedFingerprint=this.fingerprint) {
    if (this.pendingExternalChange) {
      throw Object.assign(new Error('working Deck 的外部修改尚未写入历史'), {
        code:'WORKING_DECK_CHANGED',
      });
    }
    const result = await this.sidecarIO.writeWorkingDeck({
      sessionId:this.sessionId, bytes, expectedFingerprint,
    });
    this.fingerprint = result.fingerprint;
    const inspected = inspectBundle(bytes);
    this.managed = inspected.managed;
    this.pageIds = inspected.pageIds;
    this.embeddedPatches = inspected.embeddedPatches;
    return result;
  }

  async writePatches(patches) {
    if (this.pendingExternalChange) {
      throw Object.assign(new Error('working Deck 的外部修改尚未写入历史'), {
        code:'WORKING_DECK_CHANGED',
      });
    }
    const beforeFingerprint = this.fingerprint;
    const current = await this.read();
    if (this.fingerprint !== beforeFingerprint) {
      throw Object.assign(new Error('working Deck 在补丁同步前发生变化'), {
        code:'WORKING_DECK_CHANGED',
      });
    }
    const bytes = await materializePatchBytes(current, patches, {
      pythonExecutable:this.pythonExecutable, spawnProcess:this.spawnProcess,
    });
    const result = await this.replace(bytes, beforeFingerprint);
    return { ...result, previousFingerprint:beforeFingerprint };
  }

  async rewritePendingExternalPatches(patches) {
    if (!Array.isArray(patches)) throw new TypeError('补丁必须是数组');
    const pending = this.pendingExternalChange;
    if (!pending) {
      throw Object.assign(new Error('working Deck 当前没有待登记的外部修改'), {
        code:'WORKING_DECK_CHANGED',
      });
    }
    const current = decodeRead(await this.sidecarIO.readWorkingDeck({ missingOk:false }));
    if (current.fingerprint !== this.fingerprint
      || current.fingerprint !== pending.afterFingerprint) {
      throw Object.assign(new Error('working Deck 在清理失效补丁前再次发生变化'), {
        code:'WORKING_DECK_CHANGED',
        expectedFingerprint:pending.afterFingerprint,
        actualFingerprint:current.fingerprint,
      });
    }
    const bytes = await materializePatchBytes(current.bytes, patches, {
      pythonExecutable:this.pythonExecutable, spawnProcess:this.spawnProcess,
    });
    const inspected = inspectBundle(bytes);
    const result = await this.sidecarIO.writeWorkingDeck({
      sessionId:this.sessionId,
      bytes,
      expectedFingerprint:current.fingerprint,
    });
    if (result.fingerprint !== sha256(bytes)) {
      throw new Error('清理失效补丁后的工作副本指纹不一致');
    }
    this.fingerprint = result.fingerprint;
    this.managed = inspected.managed;
    this.pageIds = inspected.pageIds;
    this.embeddedPatches = inspected.embeddedPatches;
    this.pendingExternalChange = {
      ...pending,
      afterFingerprint:result.fingerprint,
      managed:inspected.managed,
      pageIds:[...inspected.pageIds],
    };
    // SourceMutation 的 after 版本必须进入归档，否则撤销后无法再重做到
    // 已清理补丁的最终候选。
    await this.sidecarIO.archiveWorkingDeck({ expectedFingerprint:result.fingerprint });
    return {
      ...result,
      previousFingerprint:current.fingerprint,
      change:structuredClone(this.pendingExternalChange),
    };
  }

  async materializePatches(patches) {
    if (!Array.isArray(patches)) throw new TypeError('补丁必须是数组');
    if (this.pendingExternalChange) {
      throw Object.assign(new Error('working Deck 的外部修改尚未写入历史'), {
        code:'WORKING_DECK_CHANGED',
      });
    }
    const beforeFingerprint = this.fingerprint;
    const current = await this.read();
    if (this.fingerprint !== beforeFingerprint) {
      throw Object.assign(new Error('working Deck 在生成导出快照前发生变化'), {
        code:'WORKING_DECK_CHANGED',
      });
    }
    if (patches.length === 0) return Buffer.from(current);
    return materializePatchBytes(current, patches, {
      pythonExecutable:this.pythonExecutable, spawnProcess:this.spawnProcess,
    });
  }

  async checkpointExternalChange() {
    if (this.pendingExternalChange) return structuredClone(this.pendingExternalChange);
    const read = await this.sidecarIO.readWorkingDeck({ missingOk:false, ifFingerprint:this.fingerprint });
    if (read?.unchanged === true && read.fingerprint === this.fingerprint) return null;
    let value = decodeRead(read);
    if (value.fingerprint === this.fingerprint) return null;
    const beforeFingerprint = this.fingerprint;
    let inspected;
    try { inspected = inspectBundle(value.bytes); }
    catch (error) { throw invalidWorkingDeck(error); }
    if (inspected.managed) {
      let normalized;
      try {
        normalized = await runIdentityAdapter(value.bytes, {
          pythonExecutable:this.pythonExecutable, spawnProcess:this.spawnProcess,
        });
      } catch (error) {
        throw invalidWorkingDeck(error);
      }
      if (!normalized.equals(value.bytes)) {
        const rawFingerprint = value.fingerprint;
        const written = await this.sidecarIO.writeWorkingDeck({
          sessionId:this.sessionId, bytes:normalized, expectedFingerprint:rawFingerprint,
        });
        if (written.fingerprint !== sha256(normalized)) {
          throw new Error('工作副本身份规范化落盘指纹不一致');
        }
        value = { bytes:normalized, fingerprint:written.fingerprint };
        inspected = inspectBundle(normalized);
      }
    }
    await this.sidecarIO.archiveWorkingDeck({ expectedFingerprint:value.fingerprint });
    this.fingerprint = value.fingerprint;
    this.managed = inspected.managed;
    this.pageIds = inspected.pageIds;
    this.embeddedPatches = inspected.embeddedPatches;
    this.pendingExternalChange = {
      beforeFingerprint, afterFingerprint:value.fingerprint,
      managed:inspected.managed, pageIds:[...inspected.pageIds],
    };
    return structuredClone(this.pendingExternalChange);
  }

  confirmExternalChange(afterFingerprint) {
    if (this.pendingExternalChange?.afterFingerprint !== afterFingerprint) {
      throw new Error('确认的 working Deck 外部版本与待记录版本不一致');
    }
    this.pendingExternalChange = null;
  }

  async discardExternalChange(beforeFingerprint) {
    if (this.pendingExternalChange) {
      if (this.pendingExternalChange.beforeFingerprint !== beforeFingerprint) {
        throw Object.assign(new Error('取消的源码事务起始版本与待登记版本不一致'), {
          code:'WORKING_DECK_CHANGED',
        });
      }
      return this.restore(beforeFingerprint, this.pendingExternalChange.afterFingerprint);
    }
    const current = decodeRead(await this.sidecarIO.readWorkingDeck({ missingOk:false }));
    if (current.fingerprint === beforeFingerprint) return { fingerprint:beforeFingerprint, changed:false };
    if (this.fingerprint !== beforeFingerprint) {
      throw Object.assign(new Error('取消的源码事务起始版本已经改变'), {
        code:'WORKING_DECK_CHANGED',
      });
    }
    const result = await this.sidecarIO.restoreWorkingDeck({
      fingerprint:beforeFingerprint,
      expectedFingerprint:current.fingerprint,
    });
    this.fingerprint = result.fingerprint;
    const restored = decodeRead(await this.sidecarIO.readWorkingDeck({ missingOk:false }));
    const inspected = inspectBundle(restored.bytes);
    this.managed = inspected.managed;
    this.pageIds = inspected.pageIds;
    this.embeddedPatches = inspected.embeddedPatches;
    this.pendingExternalChange = null;
    return { ...result, changed:true };
  }

  async restore(targetFingerprint, expectedFingerprint=this.fingerprint) {
    const result = await this.sidecarIO.restoreWorkingDeck({
      fingerprint:targetFingerprint, expectedFingerprint,
    });
    this.fingerprint = result.fingerprint;
    const bytes = await this.read();
    const inspected = inspectBundle(bytes);
    this.managed = inspected.managed;
    this.pageIds = inspected.pageIds;
    this.embeddedPatches = inspected.embeddedPatches;
    this.pendingExternalChange = null;
    return result;
  }
}
