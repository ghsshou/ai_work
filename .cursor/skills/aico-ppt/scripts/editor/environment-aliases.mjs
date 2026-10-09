/** 为旧 Agent 会话保留兼容变量；新提示与文档只使用 AICO_PPT_*。 */
export function withLegacyAicoPptEnvironment(environment) {
  const result = { ...environment };
  for (const [name, value] of Object.entries(result)) {
    if (!name.startsWith('AICO_PPT_')) continue;
    const legacy = `HUAWEI_DECK_${name.slice('AICO_PPT_'.length)}`;
    if (result[legacy] === undefined) result[legacy] = value;
  }
  return result;
}
