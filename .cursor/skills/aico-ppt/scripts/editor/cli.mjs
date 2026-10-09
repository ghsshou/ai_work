#!/usr/bin/env node
import { randomUUID } from 'node:crypto';
import { readFile,writeFile } from 'node:fs/promises';
import { readWorkspaceCapability } from './workspace-capability.mjs';

const HELP = {
  usage: 'node scripts/editor/cli.mjs [连接选项] COMMAND [ARG]',
  environment: [
    'AICO_PPT_EDITOR_URL',
    'AICO_PPT_EDITOR_TOKEN',
    'AICO_PPT_WORKSPACE_CAPABILITY_FILE',
  ],
  options: [
    '--url URL', '--token TOKEN', '--capability-file FILE',
    '--expected-revision N', '--help',
  ],
  commands: [
    'inspect TASK_ID OUT.png', 'view PAGE OUT.png', 'result COMMAND_ID', 'revision', 'status', 'tasks', 'task', 'locate-text', 'replace-text',
    'apply', 'begin-source-edit', 'begin-source-task',
    'commit-source-edit', 'cancel-source-edit', 'cancel-source-task',
    'undo', 'redo', 'verify', 'solidify', 'creation ...',
  ],
};

const CREATION_HELP = {
  usage:'node scripts/editor/cli.mjs creation COMMAND [选项]',
  environment:[
    'AICO_PPT_CREATION_URL',
    'AICO_PPT_CREATION_CAPABILITY_FILE',
  ],
  commands:[
    'status', 'templates', 'update-brief', 'confirm-brief', 'propose-outline', 'confirm-outline',
    'propose-page-plan', 'confirm-page-plan', 'set-output', 'start-generation',
    'generation-ready', 'retry-generation', 'cancel-generation',
  ],
  options:['--json FILE', '--expected-revision N', '--url URL', '--token TOKEN', '--capability-file FILE'],
};

class CliError extends Error {
  constructor(message, exitCode = 2, output = null) {
    super(message);
    this.exitCode = exitCode;
    this.output = output;
  }
}

function writeJson(stream, value) {
  stream.write(`${JSON.stringify(value)}\n`);
}

function parseArguments(argv) {
  let url = process.env.AICO_PPT_EDITOR_URL ?? process.env.HUAWEI_DECK_EDITOR_URL;
  let token = process.env.AICO_PPT_EDITOR_TOKEN ?? process.env.HUAWEI_DECK_EDITOR_TOKEN;
  let capabilityFile = process.env.AICO_PPT_WORKSPACE_CAPABILITY_FILE
    ?? process.env.HUAWEI_DECK_WORKSPACE_CAPABILITY_FILE;
  let expectedRevision = null;
  const positional = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--help' || argument === '-h') return { help: true };
    if (['--url', '--token', '--capability-file', '--expected-revision'].includes(argument)) {
      const value = argv[index + 1];
      if (!value || value.startsWith('--')) throw new CliError(`${argument} 缺少值`);
      if (argument === '--url') url = value;
      else if (argument === '--token') token = value;
      else if (argument === '--capability-file') capabilityFile = value;
      else {
        expectedRevision = Number(value);
        if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
          throw new CliError('--expected-revision 必须是非负整数');
        }
      }
      index += 1;
      continue;
    }
    if (argument.startsWith('-')) throw new CliError(`未知参数: ${argument}`);
    positional.push(argument);
  }
  const [command, ...args] = positional;
  const expectedArgs = {
    inspect:2,view:2,result:1,revision:0, status:0, tasks:0, task:1, 'locate-text':1,
    'replace-text':2, apply:1,
    'begin-source-edit':0, 'begin-source-task':1,
    'commit-source-edit':1, 'cancel-source-edit':1, 'cancel-source-task':1,
    undo:1, redo:1, verify:0, solidify:0,
  };
  if (!(command in expectedArgs)) throw new CliError(command ? `未知命令: ${command}` : '缺少命令');
  if (args.length !== expectedArgs[command]) throw new CliError(`${command} 参数数量错误`);
  return {
    help:false, url, token, capabilityFile, expectedRevision, command, args,
  };
}

function normalizedBaseUrl(url) {
  let baseUrl;
  try { baseUrl = new URL(url); }
  catch { throw new CliError(`无效 Editor URL: ${url}`); }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new CliError('Editor URL 必须使用 http 或 https');
  }
  baseUrl.pathname = baseUrl.pathname.replace(/\/+$/, '');
  baseUrl.search = '';
  baseUrl.hash = '';
  return baseUrl;
}

async function editorCredentials(options) {
  let { url, token } = options;
  if ((!url || !token) && options.capabilityFile) {
    let capability;
    try { capability = await readWorkspaceCapability(options.capabilityFile); }
    catch (error) { throw new CliError(error.message); }
    url ||= capability.url;
    token ||= capability.token;
  }
  if (!url) {
    throw new CliError(
      '缺少 Editor URL；请设置 AICO_PPT_EDITOR_URL、--url 或 --capability-file',
    );
  }
  if (!token) {
    throw new CliError(
      '缺少 Editor token；请设置 AICO_PPT_EDITOR_TOKEN、--token 或 --capability-file',
    );
  }
  return { ...options, url, token, baseUrl:normalizedBaseUrl(url) };
}

async function requestJson({ baseUrl, token, redirect }, pathname, { method = 'GET', body } = {}) {
  const endpoint = new URL(pathname, `${baseUrl.href.replace(/\/$/, '')}/`);
  const headers = { authorization: `Bearer ${token}` };
  if (body !== undefined) headers['content-type'] = 'application/json';
  let response;
  try {
    response = await fetch(endpoint, {
      method,
      redirect,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch (error) {
    throw new CliError(`无法连接编辑服务: ${error.message}`, 1);
  }
  const text = await response.text();
  if (!response.ok) {
    throw new CliError(`HTTP ${response.status}`, 1, text || JSON.stringify({
      error: 'HTTP_ERROR', message: `HTTP ${response.status}`,
    }));
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError('服务返回的成功响应不是有效 JSON', 1);
  }
}

async function readActions(path) {
  let contents;
  try {
    contents = await readFile(path, 'utf8');
  } catch (error) {
    throw new CliError(`无法读取动作文件: ${error.message}`);
  }
  try {
    return JSON.parse(contents);
  } catch (error) {
    throw new CliError(`动作文件不是有效 JSON: ${error.message}`);
  }
}

async function readJsonFile(path, label = 'JSON 文件') {
  if (!path) return {};
  let contents;
  try { contents = await readFile(path, 'utf8'); }
  catch (error) { throw new CliError(`无法读取${label}: ${error.message}`); }
  try {
    const value = JSON.parse(contents);
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('顶层必须是对象');
    }
    return value;
  } catch (error) {
    throw new CliError(`${label}不是有效 JSON 对象: ${error.message}`);
  }
}

function parseCreationArguments(argv) {
  const command = argv[0];
  if (command === '--help' || command === '-h') return { help:true };
  if (!CREATION_HELP.commands.includes(command)) {
    throw new CliError(command ? `未知 creation 命令: ${command}` : '缺少 creation 命令');
  }
  const result = {
    help:false, command,
    url:process.env.AICO_PPT_CREATION_URL ?? process.env.HUAWEI_DECK_CREATION_URL,
    token:process.env.AICO_PPT_CREATION_TOKEN ?? process.env.HUAWEI_DECK_CREATION_TOKEN,
    capabilityFile:process.env.AICO_PPT_CREATION_CAPABILITY_FILE
      ?? process.env.HUAWEI_DECK_CREATION_CAPABILITY_FILE,
    jsonPath:null,
    expectedRevision:null,
  };
  for (let index = 1; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--url', '--token', '--capability-file', '--json', '--expected-revision'].includes(argument)) {
      throw new CliError(`未知 creation 参数: ${argument}`);
    }
    const value = argv[index + 1];
    if (!value || value.startsWith('--')) throw new CliError(`${argument} 缺少值`);
    if (argument === '--url') result.url = value;
    else if (argument === '--token') result.token = value;
    else if (argument === '--capability-file') result.capabilityFile = value;
    else if (argument === '--json') result.jsonPath = value;
    else {
      result.expectedRevision = Number(value);
      if (!Number.isSafeInteger(result.expectedRevision) || result.expectedRevision < 0) {
        throw new CliError('--expected-revision 必须是非负整数');
      }
    }
    index += 1;
  }
  return result;
}

async function creationCredentials(options) {
  let { url, token } = options;
  let fromCapability = false;
  if ((!url || !token) && options.capabilityFile) {
    const capability = await readJsonFile(options.capabilityFile, ' capability 文件');
    if (capability.version !== 1 || capability.scope !== 'creation-draft'
      || typeof capability.token !== 'string' || !capability.token) {
      throw new CliError('capability 文件不是当前 Creation Draft 的有效凭据');
    }
    url ||= capability.url;
    token ||= capability.token;
    fromCapability = true;
  }
  if (!url) throw new CliError('缺少创建工作区 URL；请设置 AICO_PPT_CREATION_URL、--url 或 --capability-file');
  let baseUrl;
  try { baseUrl = new URL(url); }
  catch { throw new CliError('无效创建工作区 URL'); }
  if (!['http:', 'https:'].includes(baseUrl.protocol)) {
    throw new CliError('创建工作区 URL 必须使用 http 或 https');
  }
  // 文件中的凭据只能交给本机服务，显式 URL 覆盖也不能改变这个边界。
  if (fromCapability && (!['127.0.0.1', 'localhost', '[::1]'].includes(baseUrl.hostname)
    || baseUrl.username || baseUrl.password)) {
    throw new CliError('Creation capability URL 必须指向本机 loopback 服务');
  }
  if (!token) throw new CliError('缺少创建 Draft capability；请设置 AICO_PPT_CREATION_CAPABILITY_FILE、--capability-file 或 --token');
  return { ...options, baseUrl, token, redirect:'error' };
}

async function executeCreation(argv) {
  let options = parseCreationArguments(argv);
  if (options.help) return CREATION_HELP;
  options = await creationCredentials(options);
  if (options.command === 'status' || options.command === 'templates') {
    if (options.jsonPath || options.expectedRevision !== null) {
      throw new CliError(`creation ${options.command} 不接受 --json 或 --expected-revision`);
    }
    return requestJson(options, options.command === 'status'
      ? '/api/creation-draft' : '/api/creation-draft/templates');
  }
  const payload = await readJsonFile(options.jsonPath, ' CreationCommand 文件');
  if (payload.type !== undefined && payload.type !== options.command) {
    throw new CliError(`JSON 中的 type 与命令不一致：${payload.type}`);
  }
  const expectedRevision = options.expectedRevision ?? payload.expectedRevision;
  if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 0) {
    throw new CliError('creation mutation 必须提供 --expected-revision 或 JSON expectedRevision');
  }
  const command = { ...payload, type:options.command, expectedRevision };
  return requestJson(options, '/api/creation-draft/commands', { method:'POST', body:command });
}

async function execute(options) {
  const { command, args } = options;
  if(command==='inspect'||command==='view') {
    const result=await requestJson(options,'/api/inspect',{method:'POST',body:{
      ...(command==='inspect'?{taskId:args[0]}:{pageKey:args[0]})}});
    await writeFile(args[1],Buffer.from(result.image,'base64'));
    const {image,...metadata}=result;
    return {...metadata,imagePath:args[1]};
  }
  if(command==='result')return requestJson(options,`/api/commands/${encodeURIComponent(args[0])}`);
  if (command === 'revision') {
    const session = await requestJson(options, '/api/session');
    return { revision:session.revision };
  }
  if (command === 'status') return requestJson(options, '/api/session');
  if (command === 'tasks') return requestJson(options, '/api/tasks');
  if (command === 'task') return requestJson(options, `/api/tasks/${encodeURIComponent(args[0])}`);
  if (command === 'locate-text' || command === 'replace-text') {
    const query = encodeURIComponent(args[0]);
    const located = await requestJson(options, `/api/text-locations?text=${query}`);
    if (command === 'locate-text') return located;
    if (args[0] === args[1]) throw new CliError('新旧文字相同');
    if (located.results?.length !== 1 || located.results[0].occurrences !== 1) {
      throw new CliError('文字目标不是唯一命中，拒绝猜测修改位置', 1, JSON.stringify({
        error:'TEXT_TARGET_AMBIGUOUS',
        message:'文字目标不是唯一命中，请用 locate-text 查看候选后再提交 action',
        candidates:located.results ?? [],
      }));
    }
    const match = located.results[0];
    return requestJson(options, '/api/actions', { method:'POST', body:{
      expectedRevision:located.revision,
      commandId:randomUUID(),
      taskId:null,
      actions:[{
        id:randomUUID(), taskId:null, target:match.target,
        kind:'setText', payload:{ text:match.text.replace(args[0], args[1]) },
      }],
    } });
  }
  if (command === 'apply') {
    const input = await readActions(args[0]);
    if (input === null || typeof input !== 'object') throw new CliError('动作文件必须是数组或对象');
    let body = input;
    if (Array.isArray(input)) {
      const expectedRevision = await mutationRevision(options);
      body = { expectedRevision, commandId:randomUUID(), taskId: null, actions: input };
    } else if (body.commandId === undefined) {
      body = { ...body, commandId:randomUUID() };
    }
    return requestJson(options, '/api/actions', { method: 'POST', body });
  }
  if (command === 'begin-source-edit' || command === 'begin-source-task') {
    const expectedRevision = await mutationRevision(options);
    return requestJson(options, '/api/source-edits', {
      method:'POST',
      body:{ expectedRevision, taskId:command === 'begin-source-task' ? args[0] : null },
    });
  }
  if (command === 'commit-source-edit' || command === 'cancel-source-edit') {
    const expectedRevision = await mutationRevision(options);
    const operation = command === 'commit-source-edit' ? 'commit' : 'cancel';
    return requestJson(options,
      `/api/source-edits/${encodeURIComponent(args[0])}/${operation}`,
      { method:'POST', body:{ expectedRevision } });
  }
  if (command === 'cancel-source-task') {
    const expectedRevision = await mutationRevision(options);
    return requestJson(options,
      `/api/tasks/${encodeURIComponent(args[0])}/source-edit/cancel`,
      { method:'POST', body:{ expectedRevision } });
  }
  if (command === 'verify') {
    const expectedRevision = await mutationRevision(options);
    return requestJson(options, '/api/verify', {
      method:'POST', body:{ expectedRevision },
    });
  }
  if (command === 'solidify') {
    const expectedRevision = await mutationRevision(options);
    const preflight = await requestJson(options, '/api/solidify-preflight', {
      method:'POST', body:{ expectedRevision },
    });
    return requestJson(options, '/api/solidify-deck', {
      method:'POST', body:{
        expectedRevision,
        expectedBindingRevision:preflight.bindingRevision,
        preflightToken:preflight.preflightToken,
      },
    });
  }
  const expectedRevision = await mutationRevision(options);
  return requestJson(options, `/api/groups/${encodeURIComponent(args[0])}/${command}`, {
    method: 'POST', body: { expectedRevision },
  });
}

async function mutationRevision(options) {
  if (options.expectedRevision !== null) return options.expectedRevision;
  const session = await requestJson(options, '/api/session');
  return session.revision;
}

export async function main(argv = process.argv.slice(2)) {
  try {
    if (argv[0] === 'creation') {
      writeJson(process.stdout, await executeCreation(argv.slice(1)));
      return 0;
    }
    let options = parseArguments(argv);
    if (options.help) {
      writeJson(process.stdout, HELP);
      return 0;
    }
    options = await editorCredentials(options);
    writeJson(process.stdout, await execute(options));
    return 0;
  } catch (error) {
    const exitCode = error instanceof CliError ? error.exitCode : 1;
    if (error instanceof CliError && error.output !== null) {
      process.stderr.write(`${error.output.replace(/\n?$/, '\n')}`);
    } else {
      writeJson(process.stderr, {
        error: exitCode === 2 ? 'CLI_INPUT_ERROR' : 'CLI_ERROR',
        message: error.message,
      });
    }
    return exitCode;
  }
}

process.exitCode = await main();
