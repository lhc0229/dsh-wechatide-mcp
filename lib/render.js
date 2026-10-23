/**
 * IDE MCP 工具的结果渲染。
 *
 * 这些规则源于 IDE 的应答方式：
 * - 业务失败是 *成功* 的 JSON-RPC 结果里的 `{success:false,error}`，
 *   所以只看 `isError` 不够；
 * - 参数被拒表现为 `isError:true`，正文是 `MCP error -32602` 的
 *   完整校验报告——值得保留，但只留前几行；
 * - 负载会自我重复（`structuredContent` 加上同一份 JSON 的文本块），
 *   天真地拼接会让每个结果翻倍。
 *
 * @module dsh-wechatide-mcp/render
 */

const CTRL_ESCAPE = { '\n': '\\n', '\r': '\\r', '\t': '\\t' };

/** 硬性字节截断；结果在被压缩前一直计费。 */
export function clamp(text, maxBytes = 6000) {
  const value = String(text ?? '');
  const buf = Buffer.from(value, 'utf8');
  if (buf.length <= maxBytes) return value;
  const head = buf.subarray(0, Math.max(0, maxBytes - 90)).toString('utf8');
  return `${head}\n[truncated 已截断 ${buf.length}B → ${maxBytes}B；用更窄的参数取详情]`;
}

/** 工具名 → 粗粒度归类，用于分组列表。 */
export function toolFamily(name) {
  if (typeof name !== 'string') return 'other';
  // 模拟器读取同属模拟器组——它们面向同一个窗口。
  if (name.startsWith('simulator_') || name.startsWith('get_simulator_')) return 'simulator 模拟器';
  if (name === 'get_user_appids') return 'ide 开发者工具';
  const prefix = name.split('_')[0];
  const known = {
    automation: 'automation 自动化',
    cloud: 'cloud 云开发',
    project: 'project 项目',
    compile: 'compile 编译',
    simulator: 'simulator 模拟器',
    get: 'read 读取',
    open: 'project 项目',
    close: 'project 项目',
    build: 'compile 编译',
    auto: 'preview 预览上传',
    create: 'preview 预览上传',
    upload: 'preview 预览上传',
    debug: 'debug 调试',
    login: 'ide 开发者工具',
    quit: 'ide 开发者工具',
    check: 'ide 开发者工具',
    polling: 'ide 开发者工具',
    share: 'project 项目',
    import: 'project 项目',
  };
  return known[prefix] ?? 'other 其他';
}

/**
 * 把一个 `tools/call` 结果规范化为 `{ ok, data, text, validation }`。
 * `data` 是服务端返回的结构化负载（如果有的话）。
 */
export function normalizeCallResult(result) {
  const blocks = Array.isArray(result?.content) ? result.content : [];
  const textParts = [];
  for (const block of blocks) {
    if (block?.type === 'text' && typeof block.text === 'string') textParts.push(block.text);
    else if (block?.type === 'image') textParts.push('[image]');
    else if (block?.type === 'resource') textParts.push(`[resource ${block.resource?.uri ?? ''}]`);
  }
  const text = textParts.join('\n').trim();
  let data = result?.structuredContent;
  if (data === undefined && text.startsWith('{')) {
    try {
      data = JSON.parse(text);
    } catch {
      /* 保留原始文本 */
    }
  }
  const businessFailure = data !== undefined && data !== null && typeof data === 'object' && data.success === false;
  const validation = result?.isError === true ? text : undefined;
  return {
    ok: result?.isError !== true && !businessFailure,
    data,
    text,
    validation,
  };
}

/**
 * 把一次调用渲染成紧凑、结论先行的块。
 *
 * @param {string} toolName
 * @param {object} result 原始 MCP 结果
 * @param {{elapsedMs?: number, maxBytes?: number}} options
 */
export function renderCall(toolName, result, { elapsedMs, maxBytes = 6000 } = {}) {
  const normalized = normalizeCallResult(result);
  const took = Number.isFinite(elapsedMs) ? ` (${formatMs(elapsedMs)})` : '';
  const lines = [];

  if (normalized.validation !== undefined) {
    lines.push(`${toolName} → 参数被拒绝${took}`);
    lines.push(condenseValidation(normalized.validation));
    lines.push('提示：先用 wechatide_tools(query="<工具名>", full=true) 看该工具的完整参数，再重试。');
    return clamp(lines.join('\n'), maxBytes);
  }

  lines.push(`${toolName} → ${normalized.ok ? 'ok' : '失败'}${took}`);

  if (normalized.data !== undefined && normalized.data !== null) {
    const payload = normalized.data;
    lines.push(formatPayload(payload));
    const remedy = remedyFor(toolName, payload);
    if (remedy !== undefined) lines.push(`remedy: ${remedy}`);
  } else if (normalized.text !== '') {
    lines.push(normalized.text);
  } else {
    lines.push('(空结果：工具没有返回内容)');
  }
  return clamp(lines.join('\n'), maxBytes);
}

/** 美化打印负载，过大时退回紧凑 JSON。 */
export function formatPayload(payload) {
  if (typeof payload === 'string') return payload;
  let text;
  try {
    text = JSON.stringify(payload, escapeControlReplacer, 2);
  } catch {
    text = String(payload);
  }
  if (text.length <= 2400) return text;
  try {
    return JSON.stringify(payload);
  } catch {
    return text;
  }
}

function escapeControlReplacer(_key, value) {
  if (typeof value !== 'string') return value;
  return value.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, (char) => CTRL_ESCAPE[char] ?? '');
}

/** 保留 `MCP error -32602` 报告中可操作的开头部分。 */
export function condenseValidation(text) {
  const trimmed = String(text).trim();
  const heading = trimmed.split('\n')[0];
  const messages = [...trimmed.matchAll(/"message":\s*"((?:[^"\\]|\\.)*)"/g)].map((m) => m[1].replace(/\\"/g, '"'));
  const paths = [...trimmed.matchAll(/"path":\s*\[([^\]]*)\]/g)].map((m) => m[1].replace(/["\s]/g, ''));
  const pairs = messages.map((message, index) => (paths[index] ? `${paths[index]}: ${message}` : message));
  if (pairs.length === 0) return clamp(trimmed, 1200);
  return [heading, ...pairs.slice(0, 4).map((line) => `- ${line}`)].join('\n');
}

/** 针对该 IDE 实际产生的失败，给出工具级下一步。 */
export function remedyFor(toolName, payload) {
  if (payload === null || typeof payload !== 'object') return undefined;
  const error = String(payload.error ?? '');
  // IDE 把诊断拆在 `code` 和 `error` 两处（例如 APPID_ERROR 带一句中文），
  // 所以两处都要匹配。
  const signal = `${payload.code ?? ''} ${error}`;
  if (/project window not found|open the project first/i.test(signal)) {
    return `项目窗口还没打开：wechatide_call(tool="open_project_window", project="<项目绝对路径>")，再重试 ${toolName}`;
  }
  if (/cant find runtimeid|can't find runtimeid|runtimeid by projectpath/i.test(signal)) {
    return `这个项目当前没有运行中的运行时（窗口没开或未编译）：先 wechatide_call(tool="open_project_window")，再 simulator_refresh，然后重试 ${toolName}`;
  }
  if (/Cannot read properties of undefined \(reading 'winId'\)/i.test(signal)) {
    return '模拟器窗口不可用：先 open_project_window 打开项目（或 simulator_refresh 重新编译），再重试';
  }
  if (/APPID_ERROR|AppID/i.test(signal) && /不存在|invalid|错误/i.test(signal)) {
    return '这个 AppID 当前账号不可用（touristappid 之类打不开项目窗口）：换成 wechatide_call(tool="get_user_appids") 里列出的 AppID，或打开一个已导入的项目';
  }
  if (/PROJECT_PATH_NOT_FOUND/i.test(signal)) {
    return 'project 必须是小程序根目录的绝对路径（含 project.config.json）';
  }
  if (/loginExpired|not logged in/i.test(signal)) {
    return '开发者工具登录态过期：wechatide_connect 重新取授权，必要时 wechatide_call(tool="login") 扫码';
  }
  if (/tokenRequired/i.test(signal)) {
    return '该设备启用了 CLI 令牌：在 IDE「设置 → 安全」复制令牌，配置到插件的 token 字段';
  }
  return undefined;
}

/** 紧凑的 `name(required*, optional)` 签名。 */
export function toolSignature(tool) {
  const schema = tool?.inputSchema ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const names = Object.keys(schema.properties ?? {});
  if (names.length === 0) return `${tool?.name ?? '?'}()`;
  const args = names.map((name) => (required.has(name) ? `${name}*` : name)).join(', ');
  return `${tool?.name ?? '?'}(${args})`;
}

/**
 * 渲染 `tools/list`。
 *
 * 模式：
 * - 默认：只给分组名（47 个工具约 40 行）——低成本发现；
 * - `query`：匹配的工具，带一行描述 + 签名；
 * - `full`：匹配项的完整 JSON schema（先 query 再 full）。
 */
export function renderToolList(tools, { query, full = false, maxBytes = 6000 } = {}) {
  const list = Array.isArray(tools) ? tools : [];
  const needle = typeof query === 'string' ? query.trim().toLowerCase() : '';
  const matched = needle === ''
    ? list
    : list.filter((tool) => {
      const haystack = `${tool?.name ?? ''} ${tool?.description ?? ''}`.toLowerCase();
      return haystack.includes(needle);
    });

  if (list.length === 0) return '微信开发者工具没有返回任何 MCP 工具：IDE 可能尚未授权或版本过旧（需要 wechatide-skill ≥ 0.3）';

  const header = `${list.length} 个 wechatide MCP 工具${needle === '' ? '' : `（匹配 "${query}"：${matched.length}）`}`;

  if (matched.length === 0) {
    return `${header}\n没有匹配的工具。用 wechatide_tools() 看全部工具名，或换关键词（如 simulator / console / cloud）。`;
  }

  if (full) {
    const blocks = matched.slice(0, 6).map((tool) => renderToolSchema(tool));
    const more = matched.length > 6 ? `\n... 还有 ${matched.length - 6} 个匹配，缩小 query` : '';
    return clamp([header, ...blocks].join('\n\n') + more, maxBytes);
  }

  if (needle !== '') {
    const lines = matched.slice(0, 24).map((tool) => `- ${toolSignature(tool)}\n  ${oneLine(tool?.description)}`);
    const more = matched.length > 24 ? `\n... 还有 ${matched.length - 24} 个匹配` : '';
    return clamp([header, ...lines].join('\n') + more, maxBytes);
  }

  const groups = new Map();
  for (const tool of list) {
    const family = toolFamily(tool.name);
    if (!groups.has(family)) groups.set(family, []);
    groups.get(family).push(tool.name);
  }
  const lines = [header];
  for (const [family, names] of [...groups.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    lines.push(`${family}: ${names.join(' ')}`);
  }
  lines.push('取单个工具的完整参数：wechatide_tools(query="<工具名>", full=true)');
  return clamp(lines.join('\n'), maxBytes);
}

/** 单个工具的完整 schema 块：描述、必填参数、枚举、取值范围。 */
export function renderToolSchema(tool) {
  const schema = tool?.inputSchema ?? {};
  const required = new Set(Array.isArray(schema.required) ? schema.required : []);
  const lines = [`## ${tool?.name ?? '?'}`];
  if (tool?.description) lines.push(String(tool.description));
  const properties = schema.properties ?? {};
  const names = Object.keys(properties);
  if (names.length === 0) {
    lines.push('(无参数)');
    return lines.join('\n');
  }
  for (const name of names) {
    const spec = properties[name] ?? {};
    const bits = [spec.type ?? (spec.enum ? 'enum' : 'any')];
    if (required.has(name)) bits.push('required');
    if (Array.isArray(spec.enum)) bits.push(`enum=${spec.enum.join('|')}`);
    if (typeof spec.minimum === 'number' || typeof spec.maximum === 'number') {
      bits.push(`range=${spec.minimum ?? '-∞'}..${spec.maximum ?? '∞'}`);
    }
    if (typeof spec.minLength === 'number') bits.push(`minLength=${spec.minLength}`);
    const description = spec.description ? ` — ${oneLine(spec.description, 120)}` : '';
    lines.push(`- ${name} (${bits.join(', ')})${description}`);
  }
  return lines.join('\n');
}

/** 首行、合并空白、限制长度。 */
export function oneLine(text, maxChars = 96) {
  const value = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (value === '') return '';
  return value.length <= maxChars ? value : `${value.slice(0, maxChars - 1)}…`;
}

export function formatMs(ms) {
  if (!Number.isFinite(ms)) return '?';
  if (ms < 1000) return `${Math.round(ms)}ms`;
  return `${(ms / 1000).toFixed(1)}s`;
}
