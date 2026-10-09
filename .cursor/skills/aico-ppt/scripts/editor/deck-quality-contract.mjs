const CORE_RULES = Object.freeze([
  '先识别或选择 training / tech-share / work-report 场景外壳，再从 availablePageTypes 选择原生或兼容共享页型；已有 Deck 默认继承现有外壳，除非用户明确要求不得换壳。三份模板不合并，能复用现有页型时必须复用，不得另起一套视觉系统。',
  '封面和感谢页必须沿用所选模板的原始结构；目录页必须与当前实际大纲一致：新建，或修改涉及章数、章名、章节目标、页序、目录 DOM 或目录动画时，必须重建目录项、layer 与逐章动画，不能继承模板示例动画；无关修改则保持目录结构不变。',
  '内容页标题必须直接表达本页核心观点，写清对象与主要判断；机制页点技术，资产或计划页点产物与目标场景，不强套句式或堆满术语。语言朴实、可核验，避免空泛口号、营销话术和 AI 式比喻。',
  '先按 workflow.md 第 1.1、2.1 节整理材料事实与页面要回答的问题，再填版式；分清已完成、探索与建议，以及本项目新增与既有积累。核对数字的单位、分母、基线与范围，不编造负责人、日期、收益或资产；入选主张的来源位置实际保存在伴生 plan.md 或已有来源记录中。',
  '成果与能力沉淀汇报应呈现可重复方法、成果证据、具体资产及后续行动：资产列实际产物、承载平台和已有入口，计划说明目标场景、动作与已知的责任和交付。不要写成泛化注意事项或无具体对象的改进清单；按听众问题选择结构，不把这种汇报骨架套到授课和使用手册。',
  '导语、页尾总结、来源小字与装饰标签不是模板必填项，默认不补重复句或过程说明；按 design-system.md 第 4.1 节做删除测试。影响判断的单位、基线与范围随结论清楚呈现，详细来源实际落到伴生材料或已验证写入的备注。初版交给用户前及终版交付前均执行 workflow.md 第 4.1 节的主线、事实、删字与可读性检查。',
  '正文默认不得小于 21px；代码、图表标注和表格可按规范例外，但必须保证投屏可读。',
  '用有效信息衡量密度，内容有层次并在画布中平衡；删去冗余后给核心内容更多空间，保留合理留白，不用套话填空。表格和截图的关键内容也必须按目标观看尺寸检查可读性，不能因图元豁免而缩成小字。',
  '一页同时包含两个以上耦合维度（如阶段 + 责任 + 交付物，系统 + 结果，代码 + 曲线 + 指标）时，优先选择 useWhen 匹配且 density=dense 的复合页型，不得拆成多页低信息卡片来回避复杂结构。',
  '页面编排必须在网格、分栏、流程、矩阵、全图、证据等视觉家族之间切换；连续三页不得使用同一视觉家族。',
  '每个内容页都要写清页型理由与配图或证据计划；不需要外部素材时也要明确写“无”，不能把空白当成规划。',
  '同一组、同一层级、同一语义角色的普通信息卡必须同构：统一白底、1px 灰边、14px 圆角，并保持阴影、内边距以及标题、正文和标签的字体族、字号、字重、行距一致。只有页面文案明确表达选中、推荐、当前、风险或结论差异时，才允许单卡使用红色、底色、特殊边框、阴影或额外字重；不得为了构图制造默认高亮。',
]);

export function buildSkillContractInstructions({ skillRoot } = {}) {
  const root = String(skillRoot ?? '').replace(/\/$/, '');
  return [
    '当前执行 AICO-PPT 单一作业规范。不得按“新建 / 初版制作 / 修改 / 区域任务”切换、删减或降级质量要求；入口差异只决定当前是否已有合法 Deck，以及需要先收集需求、建立规划还是直接处理现有内容。',
    `必须完整读取并遵循 ${JSON.stringify(`${root}/SKILL.md`)}。`,
    `随后读取 ${JSON.stringify(`${root}/references/workflow.md`)}、${JSON.stringify(`${root}/references/template-pages.md`)}、${JSON.stringify(`${root}/references/animation.md`)}、${JSON.stringify(`${root}/references/design-system.md`)}、${JSON.stringify(`${root}/references/artwork.md`)} 和 ${JSON.stringify(`${root}/references/huawei-style.md`)}。`,
    '所有入口原样复用以下单一质量契约：',
    ...CORE_RULES.map((rule, index) => `${index + 1}. ${rule}`),
  ];
}

export function buildAdaptiveTocInstructions({ outline, tocContractPath } = {}) {
  const sections = Array.isArray(outline?.sections) ? outline.sections : [];
  const chapterLines = sections.map((section, index) => (
    `${index + 1}. ${section.chapterId}｜${section.title}｜动画必须表达：${section.objective}`
  ));
  return [
    '目录页执行自适应契约：保留所选模板目录页的外层版式和视觉语言，但删除模板示例条目及示例动画，按已确认大纲重建内部内容。',
    `目录契约文件：${tocContractPath}`,
    `实际章数：${sections.length}。data-layer-btn、data-layer-panel、data-toc-visual-index 与 tocBuilders 必须都恰好为 ${sections.length} 项。`,
    'layer key 按 chapter-01、chapter-02… 连续生成；首章默认 data-active 且无 data-step，后续按钮的 data-step 按 0、1、2… 连续编号。',
    '每项都写入对应 data-toc-chapter-id；按钮 .toc-layer-name 与面板 data-toc-title 使用真实章名；动画容器 data-toc-animation-topic 使用该章目标。',
    '每章必须新建一个内容不同的具名动画函数；返回的 SVG / HTML 根节点写入 data-toc-animation-chapter 和 data-toc-animation-topic。不得直接复用模板 tocBuilders 中的函数，也不得只给同一动画换函数名。',
    ...chapterLines,
  ];
}

export function buildTemplatePlanInstructions({ template, pagePlan, pagePlanContractPath } = {}) {
  const pages = Array.isArray(pagePlan?.pages) ? pagePlan.pages : [];
  const contractRules = [
    ...(pagePlanContractPath ? [`页面规划发布契约：${pagePlanContractPath}`] : []),
    '最终 Deck 必须与页面规划页数相同且顺序一致；每个 section 的 data-label 必须等于规划 label，并按规划写入 data-plan-page-id 与 data-plan-chapter-id。',
    '不得删除、复用或虚构页面规划身份；页数、顺序、页型或身份任一不一致都会被发布闸门拒绝。',
  ];
  if (!template) return contractRules;
  const byId = new Map(
    (template.availablePageTypes ?? template.pageTypes).map(item => [item.pageTypeId, item]),
  );
  const mapping = pages.map((page, index) => {
    const type = byId.get(page.pageTypeId);
    const origin = type?.sourceTemplateId && type.sourceTemplateId !== template.templateId
      ? `借自 ${type.sourceTemplateId}` : '当前外壳原生';
    return `${index + 1}. ${page.label}（${page.pageId} / ${page.chapterId}）：${page.pageTypeId} → ${origin}第 ${type?.sourcePage ?? '?'} 页「${type?.sourceLabel ?? type?.name ?? '未知'}」；视觉家族 ${type?.visualFamily ?? '未知'} / 密度 ${type?.density ?? '未知'}`;
  });
  return [
    `所选模板：${template.name}（${template.templateId}，共 ${template.pageCount} 个原始页型）。`,
    `当前场景可用 ${template.availablePageTypes?.length ?? template.pageTypes.length} 个页型；原生页保留当前模板外壳，标记为“借自”的页型必须通过 deck_factory.py import-page 受控导入，不得手工跨 bundle 粘贴。`,
    '页面规划中的 pageTypeId 是强约束；制作时从对应来源页复制 DOM，再替换内容，不得把 pageTypeId 只当建议。',
    '连续三页同一视觉家族会被页面规划闸门拒绝；密集页后优先安排 light/breather 页形成呼吸。',
    ...contractRules,
    ...mapping,
  ];
}

export function coreQualityRules() {
  return [...CORE_RULES];
}
