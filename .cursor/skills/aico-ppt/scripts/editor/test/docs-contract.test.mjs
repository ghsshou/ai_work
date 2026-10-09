import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const ROOT = new URL('../../../', import.meta.url);
const FILES = [
  'SKILL.md',
  'references/editing-guide.md',
  'docs/architecture.md',
];

async function loadDocuments() {
  return Object.fromEntries(await Promise.all(FILES.map(async file => [
    file,
    await readFile(new URL(file, ROOT), 'utf8'),
  ])));
}

function requireClaims(file, contents, claims) {
  for (const [claim, pattern] of Object.entries(claims)) {
    assert.match(contents, pattern, `${file} 缺少文档契约：${claim}`);
  }
}

test('三份编辑协议文档共享后期微调、安全写回与结构编辑边界', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '启动命令': /python3 scripts\/deck-editor\.py <deck\.html>/,
      '维护者调试入口位于工具目录': /tools\/dev-shell\/AICO-PPT Dev Shell\.app/,
      '启动页提供双入口': /(?:启动页|本地工作台)[\s\S]{0,180}新建 Deck[\s\S]{0,180}打开已有 Deck/,
      '重复启动不打开第二个工作台页面': /重复(?:双击|启动|派发)[^。\n]{0,300}不会再打开第二个工作台页面/,
      '新建先确认项目目录': /新建 Deck[\s\S]{0,180}项目目录/,
      '打开已有 Deck 使用文件选择器': /打开已有 Deck[\s\S]{0,220}(?:系统文件选择器|添加一份 HTML|添加 Deck HTML)/,
      '无窗口 Skill 保留编辑入口': /python3 scripts\/deck-editor\.py[^\n]*--headless-workspace/,
      'sidecar 托管工作副本': /(?:\.aico-ppt-editor\/[\s\S]{0,120})?(?:sidecar[^。\n]{0,120})?working\/deck\.html|sidecar[^。\n]{0,120}工作副本/i,
      'Skill 不依赖窗口化 Editor': /(?:没有 Editor 窗口也必须|窗口化 Editor[^。\n]{0,80}(?:可选增强|不是使用前提)|无窗口 Managed Workspace)/,
      '窗口 Agent Host 注册三个 provider': /Codex[\s\S]{0,140}Claude Code[\s\S]{0,140}OpenCode/,
      '结构修改经 edit-bundle 作用于工作副本': /(?:结构工作|结构修改|结构能力)[\s\S]{0,180}scripts\/edit-bundle\.py[\s\S]{0,180}(?:工作副本|AICO_PPT_WORKING_PATH)/,
      '只有固化发布真实 Deck': /(?:固化修改|solidify-deck)[\s\S]{0,220}(?:唯一|原子)[^。\n]{0,80}(?:发布|替换)[^。\n]{0,40}(?:真实 Deck|真实文件)/i,
      '后期动作层不直接增删页': /(?:后期编辑器|后期 iframe|iframe 动作层)[\s\S]{0,80}不直接增删页/,
      '后期动作层不调整页序': /不直接增删页、调整页序/,
      '后期动作层不重构复杂动画': /调整页序或重构复杂动画/,
      '结构修改交给同一 Agent': /(?:结构工作|结构修改|结构能力)[\s\S]{0,120}(?:真实 PTY|Agent)[\s\S]{0,120}scripts\/edit-bundle\.py/,
      'bundle 结构验证': /(?:eb\.verify|python3 scripts\/edit-bundle\.py)/,
      '溢出验证': /measure_overflow\.mjs/,
      '截图验证': /shot\.mjs/,
      '动画逐拍验证': /steps\.mjs/,
    });
  }
});

test('模板选择文档统一为场景外壳、共享页型目录和受控导入', async () => {
  const files = [
    'SKILL.md',
      'references/workflow.md',
    'references/template-pages.md',
    'references/editing-guide.md',
    'docs/architecture.md',
  ];
  for (const file of files) {
    const contents = await readFile(new URL(file, ROOT), 'utf8');
    requireClaims(file, contents, {
      '场景外壳与页型库分离': /场景外壳/,
      '公开当前场景可用页型': /availablePageTypes/,
      '共享页型受兼容性约束': /compatibleWith|兼容性审核|兼容白名单/,
      '跨模板页只能受控导入': /deck_factory\.py import-page|`import-page`/,
      '页面规划控制视觉家族': /视觉家族/,
    });
  }
});

test('入口文档明确质量规范不按新建与修改分支', async () => {
  const documents = await loadDocuments();
  requireClaims('SKILL.md', documents['SKILL.md'], {
    'Skill 只有一份质量契约': /不按新建 Deck 和修改 Deck 维护两套规范/,
    '入口差异只表示当前状态': /入口差异只决定当前状态/,
  });
  // README 负责产品入口；质量契约由 Skill 与编辑指南维护，避免强制复制长协议。
  requireClaims('references/editing-guide.md', documents['references/editing-guide.md'], {
    '双入口不是双规范': /两条只是\*\*初始状态入口\*\*，不是两套 Skill 规范/,
    '全部质量要求不得分支': /任何设计、文案、字体、卡片、动画、配图和验收要求都不得按“新建 \/ 修改”分支维护/,
  });
  requireClaims('docs/architecture.md', documents['docs/architecture.md'], {
    '质量契约不接受 phase 分支': /单一质量契约入口；不接受新建 \/ 修改 phase 分支/,
  });
});

test('设计上下文统一同级卡片、字体层级与语义高亮边界', async () => {
  const files = [
    'SKILL.md',
    'references/design-system.md',
    'references/workflow.md',
    'references/artwork.md',
    'references/huawei-style.md',
  ];
  for (const file of files) {
    const contents = await readFile(new URL(file, ROOT), 'utf8');
    requireClaims(file, contents, {
      '同组同级同角色卡片必须一致': /同一组、同一层级、同一语义角色/,
      '卡片字体层级保持一致': /卡片[^。\n]{0,180}(?:字体|标题 \/ 正文 \/ 标签)[^。\n]{0,100}一致/,
      '高亮必须对应可读业务语义': /选中、推荐、当前、风险或结论差异/,
      '禁止为了构图制造默认高亮': /不得为了构图[^。\n]{0,40}(?:默认)?高亮/,
    });
  }
});

test('入口文档统一使用文件驱动里程碑、分层页面身份与当前铁律数量', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '新建页展示四个只读里程碑': /四个(?:\*\*)?只读里程碑/,
      '里程碑不是可点击导航': /(?:里程碑|节点)[^。\n]{0,80}(?:不可点击|不是导航)/,
      '前三段没有结构化表单': /(?:没有|不提供)[^。\n]{0,100}(?:中间)?表单/,
      'Managed Editor 使用持久 pageId': /(?:持久|稳定)[^。\n]{0,80}`data-page-id`|`data-page-id`[^。\n]{0,80}(?:持久|稳定)/,
    });
  }

  const architecture = documents['docs/architecture.md'];
  const editingGuide = documents['references/editing-guide.md'];
  requireClaims('docs/architecture.md', architecture, {
    'Skill 导航记录 16 条铁律': /5 步快速上手 \+ 16 条设计铁律/,
    '正文记录 16 条铁律': /正文给 5 步 \+ 16 条铁律/,
    '页面身份按 pageId 与 label 分层': /页面身份分层[\s\S]{0,180}`data-page-id`[\s\S]{0,180}`data-label`/,
  });
  requireClaims('references/editing-guide.md', editingGuide, {
    'label 仅是工具侧页名': /`data-label`[^。\n]{0,100}工具侧页名/,
    'Editor locator 使用 pageId': /Editor[^。\n]{0,100}`data-page-id`[^。\n]{0,100}page key/,
  });

  const supportingReferences = Object.fromEntries(await Promise.all([
    'references/template-pages.md',
    'references/page-snippets.md',
  ].map(async file => [file, await readFile(new URL(file, ROOT), 'utf8')])));
  for (const [file, contents] of Object.entries(supportingReferences)) {
    requireClaims(file, contents, {
      'label 仅是传统工具侧页名': /`data-label`[^。\n]{0,120}工具侧页名/,
      'Managed Editor 使用持久 pageId': /Managed Editor[^。\n]{0,120}(?:持久 )?`data-page-id`/,
    });
  }

  const skillRules = documents['SKILL.md']
    .split('## 设计铁律（细则见对应 reference）')[1]
    ?.split('## 文件导航')[0] ?? '';
  assert.equal(
    [...skillRules.matchAll(/^\d+\.\s+\*\*/gm)].length,
    16,
    'SKILL.md 的设计铁律数量必须与架构文档一致',
  );
  assert.doesNotMatch(
    Object.values(documents).join('\n'),
    /(?:四步 UI|中间 Draft 是唯一结构化权威|人工表单|9 条设计铁律|5 步 \+ 9 铁律|data-label` 是所有工具定位页面的唯一手段|`data-label` 是唯一定位手段)/,
    '入口文档不得重新引入旧版 Creation UI、铁律数量或页面身份表述',
  );
});

test('用户入口文档覆盖真实启动示例、交互闭环、恢复与 sidecar 生命周期', async () => {
  const documents = await loadDocuments();
  const corpus = Object.values(documents).join('\n');
  requireClaims('三份编辑协议文档合集', corpus, {
    '真实 renzhi 启动示例': /python3 scripts\/deck-editor\.py Deck-Projects\/renzhi\/renzhi-deck\.html/,
    '区域拉框旁侧输入': /区域拉框[\s\S]{0,100}旁侧输入/,
    '跨页任务 drawer': /跨页[\s\S]{0,100}(?:task drawer|任务 drawer|Agent drawer)/i,
    '直接文字移动缩放': /(?:直接)?文字[\s\S]{0,80}移动[\s\S]{0,80}缩放/,
    '外部 Agent 读任务和提交动作': /GET \/api\/tasks[\s\S]{0,260}POST \/api\/actions/,
    'sidecar 内容': /\.aico-ppt-editor\/[\s\S]{0,500}(?:会话|session)[\s\S]{0,220}(?:任务|tasks?)[\s\S]{0,220}(?:ActionMutation|动作)[\s\S]{0,220}(?:SourceMutation|工作版本)[\s\S]{0,220}备份/i,
    'sidecar 不进交付与版本控制': /\.aico-ppt-editor\/[\s\S]{0,300}(?:不进入|不会进入)[^\n]{0,60}(?:交付 deck|最终交付)[\s\S]{0,180}(?:忽略提交|Git 忽略|gitignore)/i,
    '固化发布闸门': /solidify-preflight[\s\S]{0,500}(?:revision|版本)[\s\S]{0,500}(?:文件绑定|binding)[\s\S]{0,500}(?:双指纹|fingerprint)[\s\S]{0,500}(?:诊断|diagnostics)[\s\S]{0,500}(?:动作投影|projection)/i,
    '预览和自动保存不碰 source deck': /(?:真实 source deck|source deck|真实 Deck)[^。\n]{0,120}(?:只读|字节保持不变)[\s\S]{0,220}预览[\s\S]{0,220}(?:自动(?:会话)?保存|session)/i,
    'Agent 动作安全字段': /token[\s\S]{0,100}revision[\s\S]{0,100}locator[\s\S]{0,100}事务/i,
    '冲突不静默覆盖': /(?:冲突|验证失败)[\s\S]{0,120}(?:不静默覆盖|拒绝覆盖)/,
    '恢复与外部变化': /session[\s\S]{0,180}(?:重开|恢复)[\s\S]{0,240}RECOVERY_REQUIRED[\s\S]{0,240}(?:重启|重载|另存副本)/i,
  });

  requireClaims('references/editing-guide.md', documents['references/editing-guide.md'], {
    '三种一级模式': /预览[\s\S]{0,80}编辑[\s\S]{0,80}区域标记/,
    '撤销与重做': /撤销[\s\S]{0,80}重做/,
    '保存会话与发布有区别': /保存会话[\s\S]{0,180}(?:不同于|不等于|区别)[\s\S]{0,180}(?:正式)?(?:发布|写回)/,
    '稳定错误码': /DECK_CHANGED[\s\S]{0,120}NEW_OVERFLOW[\s\S]{0,120}EDITOR_OFFLINE[\s\S]{0,120}RECOVERY_REQUIRED/,
    '目标缺失或歧义': /目标[\s\S]{0,40}(?:缺失|不存在)[\s\S]{0,80}(?:歧义|多个候选)/,
  });
});

test('三份编辑协议文档共享红框文字盒统一编辑契约', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '编辑范围复用红框': /(?:文字编辑|文字双击)[^。\n]{0,100}(?:复用|始终复用)[^。\n]{0,60}红色选框/,
      '统一编辑整个布局盒': /(?:整个|红框对应的)[^。\n]{0,60}独立布局盒/,
      '局部格式不拆编辑框': /(?:局部格式|加粗 \/ 着色)[^。\n]{0,100}(?:不会|不应)[^。\n]{0,40}(?:拆成[^。\n]{0,12}|多个)编辑框/,
      '变化节点使用 textPath': /(?:实际改动|实际变化)[^。\n]{0,80}(?:文本节点)[^。\n]{0,80}`textPath`/,
      '失效 textPath 只在同框唯一恢复': /`textPath`[^。\n]{0,100}(?:同一|同一个)[^。\n]{0,20}(?:文字盒|红框)[^。\n]{0,60}唯一/,
    });
  }
});

test('三份编辑协议文档共享全选删除与固化修改契约', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '全选删除提交空内容': /全选[^。\n]{0,30}删除[^。\n]{0,100}(?:空字符串|空内容)[^。\n]{0,80}(?:不会|不再)[^。\n]{0,40}(?:恢复|取消)/,
      '固化修改按钮': /固化修改/,
      '固化 API': /POST \/api\/solidify-deck/,
      '固化建立检查点并归档历史': /(?:(?:建立|创建)固化检查点[^。\n]{0,100}归档[^。\n]{0,40}(?:编辑|旧)?时间线|固化成功[^。\n]{0,80}建立检查点[^。\n]{0,100}归档[^。\n]{0,40}(?:编辑|当前)?时间线)/i,
      '连续固化保留前一轮': /连续固化[^。\n]{0,100}(?:不会|不)[^。\n]{0,30}(?:丢|覆盖丢失)[^。\n]{0,30}(?:上一轮|前一轮)/,
      '站内退出按任务显示未固化清单': /退出交互以“退出编辑器”[\s\S]{0,760}按 `taskId` 分组/,
      '退出会结束全部运行时': /退出(?:会|通过)[^。\n]{0,140}(?:显式|shutdown)[^。\n]{0,140}(?:全部编辑运行时|启动器)/,
      '任务详情按需展开': /任务默认只显示任务说明与下拉箭头[^。\n]{0,80}首次展开/,
      '标签页关闭不触发原生确认': /标签页的 `×`[^。\n]{0,100}不触发 Chrome 通用离开提醒/,
      '未固化历史跨重开保留': /未固化历史[^。\n]{0,80}保留[^。\n]{0,40}下次打开/,
    });
  }
});

test('三份编辑协议文档共享单一 bypass PTY 与自动 CLI 会话契约', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '三个终端 provider': /Codex[\s\S]{0,140}Claude Code[\s\S]{0,140}OpenCode/,
      '默认后台 CLI 会话': /(?:Editor|编辑服务)[^。\n]{0,80}(?:打开|启动)[^。\n]{0,80}后台[^。\n]{0,40}(?:创建|启动)[^。\n]{0,40}(?:CLI|PTY|终端)[^。\n]{0,20}会话/i,
      'Skill 只初始化一次': /(?:aico-ppt|Skill)[^。\n]{0,120}(?:只初始化一次|加载一次|初始化一次)/i,
      '项目根目录确认': /项目根目录[^。\n]{0,100}(?:确认|可见)/,
      '独立 workspaceRevision': /agent-workspace\.json[\s\S]{0,160}workspaceRevision[\s\S]{0,160}(?:不增加|不改变)[^。\n]{0,40}Deck revision/i,
      'PTY 是唯一交互界面': /(?:唯一的? Agent 交互终端|唯一交互终端|不再维护结构化对话)/,
      '不提供已有会话连接入口': /不(?:再)?提供[^。\n]{0,80}连接已有会话/,
      '刷新重连同一 PTY': /(?:同一编辑服务内)?刷新[^。\n]{0,120}(?:重连|复用)[^。\n]{0,60}(?:(?:同一|原)[^。\n]{0,20})?(?:PTY|终端)/i,
      '右侧抽屉与属性栏等高': /(?:(?:Agent|终端)抽屉[^。\n]{0,100}属性面板[^。\n]{0,50}(?:同高|相同高度)|(?:它|终端抽屉)与属性面板(?:同高|保持相同高度))/,
      '终端默认三分之一宽度': /终端抽屉[^。\n]{0,120}(?:三分之一|1\/3)/,
      '任务面板向内避让': /任务\s*(?:drawer|面板)[^。\n]{0,100}(?:向内|左移|避让)/i,
    });
  }
});

test('三份编辑协议文档共享区域临时预览与任务交互画面绑定契约', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '区域模式按 R 临时预览': /区域标记模式[^。\n]{0,80}按住 `R`[^。\n]{0,80}临时进入预览/,
      '松开恢复区域标记': /松开[^。\n]{0,40}恢复区域标记/,
      '交互状态随任务保存': /(?:layer|data-active)[^。\n]{0,120}(?:交互状态|状态)[^。\n]{0,100}(?:任务|pageState)/i,
      '定位先恢复画面': /定位(?:任务)?[^。\n]{0,80}先恢复[^。\n]{0,30}(?:标记(?:时的)?画面|状态)/,
      '缩略图不参与页面身份': /缩略图(?:副本| clone)?[^。\n]{0,80}不参与(?:当前页判断|页面身份)/i,
    });
  }
});

test('三份编辑协议文档共享中文输入法 R 键与终端复制边界', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '中文输入法按物理 R 键': /物理 `KeyR`[^。\n]{0,80}中文输入法/,
      '终端选区 Ctrl+C 只复制': /有文字选区时[^。\n]{0,40}`Ctrl\+C`[^。\n]{0,80}(?:不向 PTY 发送 `0x03`|浏览器复制)/,
      '终端无选区 Ctrl+C 仍中断': /没有选区时[^。\n]{0,40}(?:仍发送终端中断|`Ctrl\+C` 中断)/,
    });
  }
});

test('三份编辑协议文档共享未完成 badge、完成任务折叠和实时终端边界', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '页码 badge 不显示完成任务': /(?:页码|页序)[^。\n]{0,80}badge[^。\n]{0,140}(?:完成项(?:不再|默认)|completed|已完成任务不再)/i,
      '完成任务默认折叠': /(?:完成项|已完成任务|completed 任务)[^。\n]{0,40}默认[^。\n]{0,40}闭合[^。\n]{0,30}(?:分组|已完成)/i,
      '完成任务永久完成且历史只切换效果': /任务一旦完成[^。\n]{0,50}永久保持 `completed`[^。\n]{0,160}撤销[^。\n]{0,50}重做[^。\n]{0,90}只切换[^。\n]{0,50}(?:修改效果|effectState)/i,
      '完成任务不会再次提交 Agent': /(?:完成项|已完成任务|Agent 任务|任务一旦完成)[^。\n]{0,220}(?:不会|绝不)[^。\n]{0,80}(?:(?:再次提交|再次进入)[^。\n]{0,30}Agent|送回下一批)/i,
      '已固化任务可删除且不影响 Deck': /(?:固化后|已固化)[^。\n]{0,120}删除[^。\n]{0,120}(?:不会|不改变)[^。\n]{0,40}Deck/i,
      'Editor 终端是实时视图': /终端[^。\n]{0,80}Editor[^。\n]{0,80}实时交互视图/i,
      '任务状态仍以 sidecar 为权威': /任务完成[^。\n]{0,100}sidecar[^。\n]{0,40}权威/i,
      '没有结构化对话模式': /(?:不(?:再)?(?:提供|维护)|没有)结构化对话/,
    });
  }
});

test('Skill、README 与架构文档各自承担入口、仓库和开发者职责', async () => {
  const documents = await loadDocuments();
  requireClaims('SKILL.md', documents['SKILL.md'], {
    '独立 Skill 不自动打开桌面编辑器': /第一版[^。\n]{0,100}不自动打开独立桌面编辑器/,
    '可视化入口统一到 Harness': /可视化编辑入口统一放在 AICO-Harness/,
    '启动器文件导航': /`scripts\/deck-editor\.py`/,
    '编辑器目录文件导航': /`scripts\/editor\/`/,
    '批量重构仍由 Agent 完成': /(?:新建|批量重构)[\s\S]{0,180}Agent[\s\S]{0,120}edit-bundle/,
  });
  requireClaims('README.md', await readFile(new URL('README.md',ROOT),'utf8'), {
    '依赖体检': /python3 scripts\/check_deps\.py/,
    '安装指引': /\(INSTALL\.md\)/,
    '架构指引': /\(docs\/architecture\.md\)/,
    '编辑用户指南': /\(docs\/user-guide\/edit-deck\.md\)/,
  });
  requireClaims('docs/architecture.md', documents['docs/architecture.md'], {
    '浏览器双层': /browser parent[\s\S]{0,100}frame/i,
    '桥、时间线和持久化组件': /BridgeService[\s\S]{0,220}EditTimeline[\s\S]{0,220}SessionStore/,
    '可信 sidecar I/O': /persistent dirfd helper/,
    '写回组件': /bundle adapter[\s\S]{0,180}diagnostics[\s\S]{0,100}watch[\s\S]{0,100}write gate/i,
    '状态与动作模型': /session registry[\s\S]{0,220}revision[\s\S]{0,160}mutation queue[\s\S]{0,260}(?:ActionMutation|canonical action)[\s\S]{0,260}(?:SourceMutation|transaction record)[\s\S]{0,260}authoritative reload|session registry[\s\S]{0,600}authoritative reload[\s\S]{0,300}transaction record/i,
    '信任边界': /loopback[\s\S]{0,100}token[\s\S]{0,100}Origin[\s\S]{0,100}dirfd[\s\S]{0,100}fingerprint/i,
    '任务接口同时列出 list detail create': /`GET \/api\/tasks`[^。\n]{0,100}`GET \/api\/tasks\/<TASK_ID>`[^。\n]{0,100}`POST \/api\/tasks`/,
  });
});

test('三份编辑协议文档统一声明 Windows Python 子进程的 UTF-8 编码边界', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      'Python UTF-8 模式': /Python[^。\n]{0,100}PYTHONUTF8=1/i,
      'Python 标准流 UTF-8': /PYTHONIOENCODING=utf-8/i,
      '不继承 Windows GBK/ACP': /(?:不(?:再)?继承|不得继承)[^。\n]{0,80}(?:GBK|ACP)/i,
    });
  }
});

test('三份编辑协议文档统一声明三种 Agent 的可靠 Prompt 提交边界', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '按 UTF-8 字节分块': /Claude(?: Code)?[\s\S]{0,900}UTF-8[^。\n]{0,80}(?:拆成|分块)/i,
      '单块不超过 512 B': /不超过 512 B/,
      '使用 bracketed paste': /bracketed[- ]paste/i,
      '只有真正输入提示符才就绪': /Claude(?: Code)?[^。\n]{0,220}(?:空 `?❯`?|Ink)[^。\n]{0,160}(?:就绪|ready|提示符|光标)/i,
      '关闭 paste 后才发送 Enter': /(?:关闭 paste[^。\n]{0,80}(?:后才|后再)[^。\n]{0,60}(?:发送|开始)|正文结束符[^。\n]{0,40}后才开始) Enter/i,
      'Codex 0.148 草稿框不是就绪': /Codex 0\.148[^。\n]{0,180}(?:草稿框|草稿输入框)[^。\n]{0,180}(?:完整状态栏|不算就绪|不能触发)/i,
      'OpenCode 等真实 placeholder': /OpenCode[^。\n]{0,180}Ask anything[^。\n]{0,100}(?:光标|placeholder)/i,
      'Enter 后等回执且只重试一次': /Enter[^。\n]{0,220}(?:回执|重绘|处理中)[^。\n]{0,180}重试一次/i,
      '恢复阶段同时阻断人工输入与任务提交': /恢复旧会话[^。\n]{0,180}人工键盘输入[^。\n]{0,100}Agent 任务提交/,
      '服务端拒绝恢复期任务': /AGENT_TERMINAL_RESUMING/,
      '恢复陈旧状态只重绘不直接放行': /陈旧的 `model: loading`[^。\n]{0,160}尺寸重绘[^。\n]{0,160}重绘本身不(?:算就绪|设置 `promptReady`)/,
      'Codex 交互更新页开放终端但阻断任务': /Codex 的普通更新通知[^。\n]{0,180}`interactionRequired: \{kind: "codex-update"\}`[^。\n]{0,180}仅开放终端输入[^。\n]{0,80}Agent 任务仍保持阻断/,
      'Codex 恢复目录选择投影为显式交互': /恢复(?:会话)?目录[^。\n]{0,180}working-directory-selection/,
      '未知编号选择页走通用交互兜底': /高亮编号项[^。\n]{0,100}(?:至少两个|多个)[^。\n]{0,40}编号选项[^。\n]{0,180}terminal-selection/,
      '选择页撤掉加载遮罩': /working-directory-selection[\s\S]{0,900}(?:撤掉|关闭|解除)(?:加载)?遮罩/,
      '选择页继续阻断任务': /working-directory-selection[\s\S]{0,900}(?:阻断|锁定|保留)[^。\n]{0,100}(?:Prompt|任务)/,
    });
  }
});

test('三份编辑协议文档统一声明 Codex 与 Claude Code 失效会话自动替换边界', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '同时覆盖 Codex 与 Claude Code': /Codex[^。\n]{0,80}Claude Code/,
      '只匹配明确不存在': /(?:明确报告|明确命中)[^。\n]{0,100}(?:会话 ID 不存在|会话 ID[^。\n]{0,30}不存在)/,
      '自动创建替代会话': /(?:自动创建|重启)[^。\n]{0,100}(?:替代(?:会话| ID)|新的?可恢复会话|newConversation:true)/,
      '保留工作副本和待办': /(?:保留[^。\n]{0,100}工作副本[^。\n]{0,80}待办|工作副本[^。\n]{0,80}待办[^。\n]{0,50}(?:保留|不变))/,
    });
  }
});

test('三份编辑协议文档统一声明 bypass 目录信任交互闸门', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      'CLI 的目录信任提示': /(?:(?:trust|信任)[^。\n]{0,100}(?:目录|项目)|(?:目录|项目)[^。\n]{0,100}(?:trust|信任))/i,
      '需要用户确认而不是已就绪': /(?:等待确认|需要用户交互|interactionRequired)/,
      '自动展开右侧终端': /(?:自动展开|展开或重新展开|自动展开或重新展开)[^。\n]{0,80}右侧终端|右侧终端[^。\n]{0,80}(?:自动展开|重新展开)/,
      '正常输入框出现后才提交任务': /(?:正常输入框|正常输入屏)[^。\n]{0,100}(?:后才|才继续|才会)[^。\n]{0,100}(?:任务|Prompt|提交|粘贴)/i,
    });
  }
});

test('三份编辑协议文档准确区分 Agent HTTP、observer WS、editor capability 与写回职责', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      'Agent 读取 session/status': /\/api\/session/,
      'Agent 读取 tasks': /\/api\/tasks/,
      'Agent 提交 actions': /\/api\/actions/,
      'Agent undo/redo': /\/api\/groups\/<GROUP_ID>\/(?:undo|redo)[\s\S]{0,160}(?:undo|redo)/i,
      'Agent 检查点 API': /\/api\/write-deck[\s\S]{0,160}(?:检查点|不发布)/,
      '用户固化 API': /\/api\/solidify-preflight[\s\S]{0,260}\/api\/solidify-deck[\s\S]{0,700}(?:用户|确认|固化)[\s\S]{0,500}(?:发布|真实 Deck)/i,
      'observer WS 只订阅 events': /observer WebSocket[\s\S]{0,100}\/events[\s\S]{0,100}(?:只|仅)[^。\n]{0,40}(?:订阅|接收)/i,
      '唯一 editor capability 只传 frame 事务 ACK': /唯一 editor capability WebSocket[\s\S]{0,160}frame[\s\S]{0,100}(?:事务|命令)[\s\S]{0,80}ACK[\s\S]{0,100}(?:不对外|不能用于|不用于)[^。\n]{0,40}(?:提交|动作)/i,
      'edit-bundle 只操作托管工作副本': /scripts\/edit-bundle\.py[\s\S]{0,220}(?:托管工作副本|AICO_PPT_WORKING_PATH)/,
      'sidecar 负责原子发布': /(?:sidecar helper|可信 sidecar|WorkingDeckStore|helper 为真实 Deck)[\s\S]{0,780}(?:os\.replace|原子替换|原子发布)/i,
    });
    assert.doesNotMatch(
      contents,
      /外部 (?:Codex|Claude Code|Agent)[^。\n]{0,180}(?:WebSocket|capability WS)[^。\n]{0,120}(?:提交动作|提交 actions)/i,
      `${file} 错误宣称外部 Agent 可经 WebSocket 提交动作`,
    );
    assert.doesNotMatch(
      contents,
      /scripts\/edit-bundle\.py[^；。\n]{0,160}(?:处理|生成|创建|负责)[^；。\n]{0,100}(?:备份|transaction|原子替换|os\.replace)/,
      `${file} 错误把持久备份或原子替换归给 edit-bundle.py`,
    );
  }
});

test('editing guide 准确说明 drawer 切换完成任务效果且不承诺缩略图', async () => {
  const documents = await loadDocuments();
  const guide = documents['references/editing-guide.md'];
  requireClaims('references/editing-guide.md', guide, {
    '左栏是文字页序列表和 badge': /左侧文字页序列表[\s\S]{0,100}badge/,
    'drawer 可撤销或重做已完成任务效果': /drawer[\s\S]{0,180}已完成[\s\S]{0,160}撤销[\s\S]{0,40}重做/,
    'undo 由 CLI 或 HTTP 完成': /undo[\s\S]{0,100}(?:CLI|HTTP)/i,
    'redo 由 HTTP 完成': /redo[\s\S]{0,100}HTTP/i,
  });
  assert.doesNotMatch(guide, /页缩略图/, 'references/editing-guide.md 左栏不是页缩略图');
});

test('三份编辑协议文档与 steps 无动画页行为一致', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    assert.doesNotMatch(
      contents,
      /无动画页[^。\n]{0,100}(?:生成|得到|输出)[^。\n]{0,80}(?:起始|开始)[^。\n]{0,40}(?:结束|末尾)[^。\n]{0,20}(?:两帧|2\s*帧)/,
      `${file} 不得声称 steps.mjs 为无动画页生成两帧`,
    );
    requireClaims(file, contents, {
      '无动画页明确不生成逐拍截图': /无动画页[^。\n]{0,120}(?:不生成|不会生成|不输出)[^。\n]{0,80}(?:逐拍)?截图/,
    });
  }
});

test('三份编辑协议文档完整说明全局历史与任务附件边界', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '顶栏全局撤销重做': /顶栏[\s\S]{0,120}撤销[\s\S]{0,40}重做/,
      '人工与 Agent 共用权威历史': /ActionMutation[\s\S]{0,220}(?:人工|手工)[\s\S]{0,160}Agent|(?:人工|手工)[\s\S]{0,220}Agent[\s\S]{0,220}ActionMutation|人工文字[\s\S]{0,100}移动[\s\S]{0,100}缩放[\s\S]{0,160}Agent[^。\n]{0,100}(?:动作|修改)/i,
      '任务行用补偿修改撤回非末尾任务': /任务行[\s\S]{0,120}非末尾[^。\n]{0,80}(?:补偿修改|补偿)/,
      '文件与粘贴入口': /选择文件[\s\S]{0,100}粘贴图片/,
      '附件数量与大小限制': /最多 8 个[\s\S]{0,100}25 MiB/,
      '粘贴图片转 PNG': /粘贴图片[\s\S]{0,80}(?:转为|转换为|转成) PNG/,
      'sidecar 附件目录': /sidecar[\s\S]{0,160}attachments\//,
      '浏览器不提供原绝对路径': /浏览器[\s\S]{0,100}(?:无法|不能)[^。\n]{0,50}原文件[^。\n]{0,30}绝对路径/,
      '任务列表与详情派生副本绝对路径': /GET \/api\/tasks[\s\S]{0,80}GET \/api\/tasks\/<TASK_ID>[\s\S]{0,220}副本[^。\n]{0,50}绝对 (?:path|路径)/i,
      '创建和事件任务 payload 派生绝对路径': /POST \/api\/tasks[\s\S]{0,160}task-created[\s\S]{0,80}task-updated[\s\S]{0,180}绝对 (?:path|路径)/i,
      'CLI tasks task 派生绝对路径': /CLI[\s\S]{0,100}`tasks`[\s\S]{0,40}`task`[\s\S]{0,140}绝对 (?:path|路径)/i,
      'session API 与磁盘只含相对路径': /GET \/api\/session[\s\S]{0,120}session\.json[\s\S]{0,100}relativePath[\s\S]{0,120}(?:不保存|不会保存)[\s\S]{0,40}(?:不返回|不会返回)[^。\n]{0,40}绝对路径/i,
      '附件不进入成品': /附件[^。\n]{0,100}不进入最终 deck/i,
      '附件随 sidecar 生命周期管理': /附件[^。\n]{0,120}sidecar[^。\n]{0,80}生命周期/,
    });
  }
});

test('三份编辑协议文档共享 Agent 与人工交错修改的安全重放契约', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      'revision 写操作先登记已写盘源码变化': /(?:带|改变) revision[^。\n]{0,140}(?:先|必须先)[^。\n]{0,100}(?:登记|工作副本检查点)[^。\n]{0,80}(?:SourceMutation|工作副本变化)/i,
      '旧操作以 revision 冲突停止': /拒绝过期请求|REVISION_CONFLICT[^。\n]{0,80}旧请求|(?:旧请求|旧人工动作|撤销 \/ 重做或固化)[^。\n]{0,180}(?:REVISION_CONFLICT|revision 冲突)/i,
      '源码重放同时核对语义与前后值': /(?:语义指纹|语义锚点)[^。\n]{0,140}(?:before[^。\n]{0,20}after|`before` \/ `after`)/i,
      '冲突必须可见而非静默覆盖': /(?:界面|全局历史提示|工作台)[^。\n]{0,100}(?:显示|可见)[^。\n]{0,80}冲突|冲突[^。\n]{0,80}界面[^。\n]{0,40}可见|不能静默覆盖|不能用空 `catch` 隐藏分叉/,
      '固化与实时重放使用同一规则': /(?:固化|离线补丁)[^。\n]{0,120}(?:同一(?:重放)?契约|同一规则)/,
      '源码事务显式开始和提交': /begin-source-(?:edit|task)[\s\S]{0,240}sourceEditId[\s\S]{0,240}commit-source-edit/,
      '源码事务阻断其他修改': /SOURCE_EDIT_ACTIVE[^。\n]{0,160}(?:人工|action|撤销|重做|固化)|(?:人工|action|撤销|重做|固化)[^。\n]{0,160}SOURCE_EDIT_ACTIVE/i,
      '源码事务重开后继续提交或取消': /源码事务[^。\n]{0,180}(?:重开|重启)[^。\n]{0,180}(?:commit|提交)[^。\n]{0,80}(?:cancel|取消)|(?:重开|重启)[^。\n]{0,180}(?:commit|提交)[^。\n]{0,80}(?:cancel|取消)/i,
    });
  }
});

test('三份编辑协议文档共享持久元素身份与冲突关闭契约', async () => {
  const documents = await loadDocuments();
  for (const [file, contents] of Object.entries(documents)) {
    requireClaims(file, contents, {
      '持久元素身份': /data-editor-id[^。\n]{0,120}(?:持久|稳定)[^。\n]{0,40}(?:元素身份|身份)/,
      'Agent 保留既有身份': /Agent[^。\n]{0,100}(?:移动|调整层级|重包)[^。\n]{0,100}(?:保留|不得改写)[^。\n]{0,40}data-editor-id/,
      '新增元素在 SourceMutation 前归一化': /新增元素[^。\n]{0,120}(?:SourceMutation[^。\n]{0,40}(?:之前|前)|(?:之前|前)[^。\n]{0,40}SourceMutation)[^。\n]{0,80}(?:补齐|归一化)/,
      '非法或重复身份安全停止': /(?:非法|格式错误)[^。\n]{0,30}(?:或|、)[^。\n]{0,20}重复[^。\n]{0,80}(?:安全停止|fail-closed|拒绝)/i,
      '身份不放宽前后值和文字范围校验': /data-editor-id[^。\n]{0,180}(?:before[^。\n]{0,20}after|`before` \/ `after`)[^。\n]{0,120}文字范围|文字范围[^。\n]{0,120}data-editor-id[^。\n]{0,180}(?:before[^。\n]{0,20}after|`before` \/ `after`)/i,
    });
  }
});

test('架构文档列出附件 sidecar 目录与可信 dirfd 生命周期', async () => {
  const documents = await loadDocuments();
  requireClaims('docs/architecture.md', documents['docs/architecture.md'], {
    '正式附件目录': /attachments\//,
    '附件暂存目录': /attachments\/\.staging/,
    '附件目录 dirfd 生命周期': /attachments\/[\s\S]{0,180}dirfd[\s\S]{0,180}(?:绑定|生命周期)[\s\S]{0,180}(?:关闭|释放)/,
  });
});

test('浏览器 E2E 使用单并发串行执行', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../../../package.json', import.meta.url), 'utf8'));
  assert.equal(
    packageJson.scripts['test:editor:e2e'],
    'node scripts/run-editor-tests.mjs e2e',
  );
});
