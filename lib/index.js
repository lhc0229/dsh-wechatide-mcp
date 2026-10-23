/**
 * `dsh-wechatide-mcp` —— 通过微信开发者工具自带的内部 MCP 服务驱动 IDE。
 *
 * IDE 把整套自动化能力（项目打开/导入、编译、预览/上传、模拟器截图、
 * console/network 缓冲区、页面自动化、云开发）暴露成一个 MCP 服务：`wechatide mcp`，
 * 一条基于 stdio 的换行分隔 JSON-RPC 桥；IDE 自己在
 * `…/Default/mcp.json` 里以 `{"command":"wechatide","args":["mcp"]}` 的形式宣告它。
 *
 * 由此形成几项设计取舍：
 *
 * - **一个多路复用的调用工具，而不是 47 个原生工具。** 工具注册表属于 IDE，
 *   每次升级都会变；固定的工具面让 prompt 前缀（及其 KV 缓存）保持稳定，
 *   而 `wechatide_tools` 按需读取实时注册表。少数值得独立 schema 的流程
 *   （状态、授权、截图、日志过滤）才单独建模。
 * - **授权是产品流程，不是重试循环。** 新的客户端名会得到
 *   `Client authorization pending`；只有 CLI 的 `check_wechatide_status` →
 *   `polling_task_result` 这一对能弹出 IDE 授权框并完成授权，
 *   因此这段流程由 `wechatide_connect` 负责，并如实报出它等待的 taskId。
 * - **诚实的失败。** IDE 把业务错误放在 *成功* 的 JSON-RPC 结果里的
 *   `{success:false,error}`，而「窗口没打开」的消息读起来像崩溃。
 *   两者都映射成一句结论，外加唯一能修好它的那次调用。
 * - **输出有界。** 每个结果都截断（默认 6 KB）：MCP 负载是冗长的
 *   富 JSON，在压缩之前都要为它付 token。
 *
 * @module dsh-wechatide-mcp
 */
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { fileURLToPath } from 'node:url';
import z from '@deepseek-ai/schemastery';
import { defineTool } from '@deepseek-ai/dsh-tools';
import { AttachmentId } from '@deepseek-ai/dsh-attachment';
import { WechatideBridge, McpAuthorizationPending, McpRpcError, describeBridgeFailure } from './bridge.js';
import { readDevtoolsState, readSkillVersion, resolveBin, runCliJson } from './devtools.js';
import { clamp, formatMs, renderCall, renderToolList } from './render.js';

export const name = 'wechatide-mcp';
export const inject = ['tools'];

/** 插件配置。 */
export const Config = z.object({
  /** `wechatide` CLI 的绝对路径；留空 = 自动探测 IDE 安装位置。 */
  binPath: z.string().default(''),
  /** IDE 授权的客户端身份（必须与其弹窗中显示的名称一致）。 */
  clientName: z.string().default('DSH'),
  /** 用会话 cwd 补全工具的必填 `project` 参数。 */
  projectFromCwd: z.boolean().default(true),
  /** `tools/call` 的单请求默认超时。 */
  toolCallTimeoutMs: z.number().default(90_000),
  /** 渲染结果的默认截断字节数。 */
  maxResultBytes: z.number().default(6000),
  /** 每个会话以真实图像块形式附加的截图数（0 表示禁用）。 */
  imageBudget: z.number().default(3),
  /** 把内置 skill 发布到会话目录。 */
  exposeSkill: z.boolean().default(true),
});

const SKILL_PROVIDER = 'dsh-wechatide-mcp';
const SKILL_NAME = 'wechatide-mcp';
const SKILL_DESCRIPTION =
  '在 DSH 里驱动微信开发者工具（wechatide）时加载：打开/导入小程序项目、编译与刷新、预览二维码与体验版上传、' +
  '模拟器截图、console/network 取证、页面自动化（点击/输入/导航/求值）、云开发读写。通过 wechatide_* 工具与 IDE 内部 MCP 通信。';

const textOutput = {
  schema: { type: 'object', additionalProperties: false, properties: { summary: { type: 'string', required: true } } },
  render: (_args, value) => [{ type: 'text', text: value.summary }],
};

const imageOutput = {
  schema: {
    type: 'object',
    additionalProperties: false,
    properties: {
      summary: { type: 'string', required: true },
      image: {
        type: 'object',
        additionalProperties: false,
        properties: {
          attachmentId: { type: 'string', required: true },
          mediaType: { type: 'string', required: true },
          bytes: { type: 'integer', required: true },
          width: { type: 'integer', required: true },
          height: { type: 'integer', required: true },
          name: { type: 'string' },
        },
      },
    },
  },
  render: (_args, value) => {
    const blocks = [{ type: 'text', text: value.summary }];
    if (value.image) {
      blocks.push({
        type: 'image',
        attachment: {
          attachmentId: AttachmentId(value.image.attachmentId),
          mediaType: value.image.mediaType,
          bytes: value.image.bytes,
          width: value.image.width,
          height: value.image.height,
          ...(value.image.name ? { name: value.image.name } : {}),
        },
      });
    }
    return blocks;
  },
};

export function apply(ctx, config = {}) {
  const cfg = {
    binPath: config.binPath ?? '',
    clientName: typeof config.clientName === 'string' && config.clientName !== '' ? config.clientName : 'DSH',
    projectFromCwd: config.projectFromCwd !== false,
    toolCallTimeoutMs: positive(config.toolCallTimeoutMs, 90_000),
    maxResultBytes: positive(config.maxResultBytes, 6000),
    imageBudget: Number.isFinite(Number(config.imageBudget)) ? Math.max(0, Math.floor(Number(config.imageBudget))) : 3,
    exposeSkill: config.exposeSkill !== false,
  };

  /** 必须跨调用保留的授权状态（taskId、截止时间）。 */
  let pendingAuth;
  /** 已安装 IDE 的 skill 版本缓存（升级后会变）。 */
  let skillVersionCache;

  const skillVersion = () => {
    if (skillVersionCache === undefined) {
      const { bin } = resolveBin({ binPath: cfg.binPath });
      skillVersionCache = readSkillVersion(bin) ?? null;
    }
    return skillVersionCache ?? undefined;
  };

  // ---- 桥接 ---------------------------------------------------------------
  // 测试接缝：harness 注入假的桥接工厂，于是工具「接线」
  // （project 自动补全、授权流程、渲染）无需 IDE 即可测试。
  const makeBridge = typeof config._bridgeFactory === 'function'
    ? config._bridgeFactory
    : (options) => new WechatideBridge(options);

  /** cwd 不同的会话仍共享同一个 IDE 桥接：IDE 是全局的。 */
  let bridge;
  function getBridge() {
    if (bridge === undefined) {
      const { bin } = resolveBin({ binPath: cfg.binPath });
      bridge = makeBridge({
        bin,
        clientName: cfg.clientName,
        timeoutMs: cfg.toolCallTimeoutMs,
        logger: ctx.logger,
      });
      ctx.logger?.info?.(`wechatide-mcp: bridge → ${bin} (client ${cfg.clientName})`);
    }
    return bridge;
  }

  ctx.effect(() => () => {
    bridge?.close();
    bridge = undefined;
  }, 'wechatide-mcp: close MCP bridge');

  function sessionCwd(exec_) {
    const cwd = exec_?.agent?.session?.header?.cwd;
    if (typeof cwd === 'string' && cwd !== '') return cwd;
    return process.cwd();
  }

  // ---- 授权 ---------------------------------------------------------------
  /**
   * 以能弹出 IDE 授权框的方式运行 CLI 状态调用。
   * 客户端未知时 CLI 会自动串上 `toolCall:auth`，然后返回
   * `{status:"pending", taskId}` —— 轮询该 taskId 才是完成授权的手段。
   */
  async function cliStatus({ signal } = {}) {
    const { bin, source, exists } = resolveBin({ binPath: cfg.binPath });
    if (!exists && source !== 'PATH') {
      throw new CliMissing(`${bin} 不存在（来源：${source}）`);
    }
    const argv = ['-c', cfg.clientName, 'check_wechatide_status'];
    const version = skillVersion();
    if (version !== undefined) argv.push('--skill-version', version);
    const started = Date.now();
    try {
      const { envelope } = await runCliJson(bin, argv, { timeoutMs: 60_000, signal });
      return { envelope: envelope ?? {}, bin, elapsedMs: Date.now() - started };
    } catch (error) {
      if (error?.code === 'ENOENT') throw new CliMissing(`找不到 wechatide CLI（${bin}）`);
      throw error;
    }
  }

  async function cliPoll(taskId, { signal } = {}) {
    const { bin } = resolveBin({ binPath: cfg.binPath });
    const { envelope } = await runCliJson(bin, ['-c', cfg.clientName, 'polling_task_result', '--task-id', taskId], {
      timeoutMs: 60_000,
      signal,
    });
    return envelope?.result ?? envelope ?? {};
  }

  const delay = (ms, signal) =>
    new Promise((resolvePromise, reject) => {
      const timer = setTimeout(resolvePromise, ms);
      signal?.addEventListener?.(
        'abort',
        () => {
          clearTimeout(timer);
          reject(Object.assign(new Error('已取消'), { name: 'AbortError' }));
        },
        { once: true },
      );
    });

  /**
   * 授权本客户端并端到端验证桥接。
   * 返回报告而不是抛错，好让模型总能拿到状态
   * （包括「仍在等待，请点允许」）。
   */
  async function authorize({ waitSeconds = 30, signal } = {}) {
    const deadline = Date.now() + Math.max(0, waitSeconds) * 1000;
    let status;
    try {
      status = await cliStatus({ signal });
    } catch (error) {
      if (error instanceof CliMissing) return { ok: false, reason: 'cli-missing', detail: error.message };
      throw error;
    }

    const result = status.envelope?.result ?? status.envelope ?? {};
    let taskId = typeof result.taskId === 'string' ? result.taskId : undefined;
    // 已授权的客户端返回 `{success:true, loginUser…}`，根本没有 `status`
    // 字段——只有 pending/failed 分支才带。
    let state = typeof result.status === 'string' ? result.status : result.success === true ? 'success' : 'unknown';

    while (state === 'pending' && Date.now() < deadline) {
      pendingAuth = { taskId, startedAt: Date.now() };
      await delay(1200, signal);
      const polled = await cliPoll(taskId, { signal });
      state = typeof polled.status === 'string' ? polled.status : state;
      if (state === 'success' || state === 'failed' || state === 'cancelled') break;
    }
    if (state === 'success') pendingAuth = undefined;

    // 用工具实际走的同一条通道验证——只信 CLI 的授权步骤
    // 仍会因名称不匹配让 `wechatide_call` 失败。
    let bridgeReport;
    try {
      const connection = await getBridge().connect();
      const tools = await getBridge().listTools({ refresh: true, signal });
      bridgeReport = { ok: true, protocolVersion: connection.protocolVersion, server: getBridge().serverLabel, toolCount: tools.length };
    } catch (error) {
      bridgeReport = { ok: false, ...describeBridgeFailure(error) };
    }

    return { ok: state === 'success' && bridgeReport.ok, state, taskId, cli: result, bridge: bridgeReport, elapsedMs: status.elapsedMs };
  }

  // ---- 图像 ---------------------------------------------------------------
  /** 按会话统计附加次数（预算 + 上次哈希），与宿主工具一致。 */
  const imageState = new WeakMap();
  const imageStateFallback = {};
  const imageKeyOf = (exec_) => exec_?.agent?.session ?? imageStateFallback;

  async function attachImage(path, exec_) {
    const attachments = ctx.get('attachments');
    if (!attachments) return { status: 'no attachment service mounted' };
    const llm = ctx.get('llm');
    if (!llm) return { status: 'no llm service' };
    const routed = exec_?.agent?.session?.requestHeader?.()?.config;
    const provider = routed?.provider ?? exec_?.agent?.options?.provider;
    const model = routed?.model ?? exec_?.agent?.options?.model;
    if (!provider || !model) return { status: `route unresolved (provider=${provider ?? '?'} model=${model ?? '?'})` };

    let data;
    try {
      data = await readFile(path);
    } catch (error) {
      return { status: `无法读取截图文件：${error?.message ?? error}` };
    }
    const info = await llm.resolveModelInfo(provider, model, exec_?.signal);
    if (!info?.inputModalities?.includes('image')) {
      return { status: `model ${model} declares [${(info?.inputModalities ?? []).join(',')}] — no image input`, canSee: false, showedImage: true };
    }
    const mediaType = /\.jpe?g$/i.test(path) ? 'image/jpeg' : 'image/png';
    if (!attachments.imageLimits.mediaTypes.includes(mediaType)) return { status: `deployment rejects ${mediaType}`, canSee: true, showedImage: true };
    const byteCap = Math.min(attachments.imageLimits.maxImageBytes, attachments.imageLimits.maxMessageImageBytes);
    if (data.length > byteCap) return { status: `${mediaType} ${data.length}B exceeds cap ${byteCap}B`, canSee: true, showedImage: true };

    const key = imageKeyOf(exec_);
    const state = imageState.get(key) ?? { used: 0, lastHash: undefined };
    const hash = createHash('sha256').update(data).digest('hex');
    if (hash === state.lastHash) {
      return { status: 'unchanged since the last attached screenshot — image NOT re-attached（同一画面不重复计费）', canSee: true, showedImage: true };
    }
    if (cfg.imageBudget === 0) return { status: 'image attaching disabled by configuration (imageBudget 0)', canSee: true, showedImage: true };
    if (state.used >= cfg.imageBudget) {
      return { status: `image budget exhausted (${state.used}/${cfg.imageBudget}) — 放大 imageBudget 仅在确实需要像素时`, canSee: true, showedImage: true };
    }
    const ref = await attachments.saveImage({ data, mediaType, name: basename(path) });
    imageState.set(key, { used: state.used + 1, lastHash: hash });
    return {
      image: {
        attachmentId: String(ref.attachmentId),
        mediaType: ref.mediaType,
        bytes: ref.bytes,
        width: ref.width,
        height: ref.height,
        name: basename(path),
      },
      status: `attached (${state.used + 1}/${cfg.imageBudget} image budget)`,
      canSee: true,
      showedImage: true,
    };
  }

  // ---- 共享管线 -----------------------------------------------------------
  function guarded(run) {
    return async (args, exec_) => {
      try {
        const value = await run(args ?? {}, exec_ ?? {});
        return { ...value, summary: clamp(value.summary, cfg.maxResultBytes) };
      } catch (error) {
        const text = failureText(error);
        ctx.logger?.warn?.(`wechatide-mcp: ${text}`);
        throw new Error(clamp(text, cfg.maxResultBytes));
      }
    };
  }

  function failureText(error) {
    if (error instanceof CliMissing) {
      return `${error.message}\nremedy: 安装微信开发者工具，或用 config.binPath 指向 wechatide CLI（macOS: /Applications/wechatwebdevtools.app/Contents/MacOS/wechatide）`;
    }
    const described = describeBridgeFailure(error);
    if (described.kind === 'authorization' || described.kind === 'unavailable') {
      return `${described.text}${described.remedy ? `\nremedy: ${described.remedy}` : ''}`;
    }
    if (error instanceof McpRpcError) return `微信开发者工具返回错误：${error.message}`;
    if (error?.name === 'AbortError') return '已取消';
    return String(error?.message ?? error);
  }

  function parseArgs(relative) {
    if (relative === undefined || relative === null || String(relative).trim() === '') return {};
    let parsed;
    try {
      parsed = JSON.parse(String(relative));
    } catch (error) {
      throw new Error(`args 不是合法 JSON：${error.message}\nargs 必须是 JSON 对象字符串，例如 '{"project":"/path/to/miniprogram"}'`);
    }
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error("args 必须是 JSON 对象（例如 '{\"action\":\"currentPage\"}'），不能是数组或标量");
    }
    return parsed;
  }

  /** 工具声明的必填参数，便于提前告知调用方缺什么。 */
  function requiredArgs(tool) {
    return Array.isArray(tool?.inputSchema?.required) ? tool.inputSchema.required : [];
  }

  async function withProjectArg(toolName, rawArgs, project, exec_) {
    const args = { ...rawArgs };
    const tool = await getBridge().findTool(toolName, { signal: exec_?.signal });
    if (!tool) {
      const tools = await getBridge().listTools({ signal: exec_?.signal });
      const near = tools
        .map((candidate) => candidate.name)
        .filter((candidate) => candidate.includes(String(toolName)) || String(toolName).includes(candidate.split('_')[0]))
        .slice(0, 8);
      const hint = near.length > 0 ? `相近的工具名：${near.join(', ')}` : '用 wechatide_tools() 查看全部工具名';
      throw new Error(`未知工具 "${toolName}"。${hint}`);
    }
    const required = requiredArgs(tool);
    if (cfg.projectFromCwd && required.includes('project') && args.project === undefined) {
      const fromParam = typeof project === 'string' && project.trim() !== '' ? project.trim() : undefined;
      args.project = fromParam ?? sessionCwd(exec_);
    }
    const missing = required.filter((key) => args[key] === undefined || args[key] === '');
    if (missing.length > 0) {
      throw new Error(
        `${toolName} 缺少必填参数：${missing.join(', ')}\n完整参数：wechatide_tools(query="${toolName}", full=true)`,
      );
    }
    return { tool, args };
  }

  const register = (tool, { concurrencySafe = false } = {}) =>
    ctx.tools.register(defineTool({ isConcurrencySafe: () => concurrencySafe, ...tool }));

  // ---- wechatide_status ---------------------------------------------------
  register(
    {
      name: 'wechatide_status',
      description:
        'Diagnose the WeChat DevTools (wechatide) path end to end: CLI binary, IDE process/port, login state, ' +
        'whether THIS client is authorized, and how many MCP tools the IDE exposes. Read-only with respect to the ' +
        'project; the probe only opens the MCP handshake (no scan, no build). ' +
        'When something is off the result names the single next action.',
      parameters: {
        probe: { type: 'boolean', description: 'actually open the MCP bridge to count tools (default true); false = cheap file/CLI-free checks only' },
      },
      output: textOutput,
      timeoutMs: 60_000,
      presentCall: () => ({ card: 'generic', title: 'wechatide status', kind: 'read' }),
      execute: async (args, exec_) => {
        const probe = args?.probe !== false;
        const { bin, source, exists } = resolveBin({ binPath: cfg.binPath });
        const state = readDevtoolsState();
        const lines = [];
        const actions = [];

        lines.push(`wechatide: ${exists || source === 'PATH' ? 'CLI 已定位' : 'CLI 未找到'}`);
        lines.push(`binary: ${bin} (${source}${exists ? '' : ', 未验证'})`);
        if (!exists && source !== 'PATH') actions.push('安装微信开发者工具，或设置 config.binPath 指向 wechatide');

        if (state.found) {
          lines.push(`DevTools: ${state.running ? '运行中' : `未运行（.ide-status=${state.status ?? '未知'}）`} port=${state.port ?? '未知'}`);
          if (state.mcpJson?.mcpServers !== undefined) {
            const advertised = Object.keys(state.mcpJson.mcpServers).join(',');
            lines.push(`mcp.json: ${advertised || '(空)'}`);
          }
        } else {
          lines.push('DevTools: 未找到 UserData（从未启动过开发者工具？）');
          actions.push('先打开微信开发者工具并登录');
        }

        if (probe) {
          try {
            const connection = await getBridge().connect();
            const tools = await getBridge().listTools({ signal: exec_?.signal });
            lines.push(`mcp: 已连接 ${getBridge().serverLabel} (protocol ${connection.protocolVersion}), ${tools.length} 个工具`);
            const version = skillVersion();
            if (version !== undefined) lines.push(`skill: ${version}`);
            if (tools.length === 0) actions.push('IDE 返回 0 个工具：升级开发者工具，或先 wechatide_connect');
          } catch (error) {
            const described = describeBridgeFailure(error);
            lines.push(`mcp: 不可用 — ${described.text}`);
            if (described.remedy) actions.push(described.remedy);
          }
        } else {
          lines.push('mcp: 未探测（probe=false）');
        }

        if (pendingAuth?.taskId) lines.push(`pendingAuth: ${pendingAuth.taskId}（等待在开发者工具弹窗点「允许」）`);
        lines.push(actions.length > 0 ? `next: ${actions[0]}` : 'next: 直接 wechatide_tools / wechatide_call');
        return { summary: lines.join('\n') };
      },
    },
    { concurrencySafe: true },
  );

  // ---- wechatide_connect --------------------------------------------------
  register({
    name: 'wechatide_connect',
    description:
      'Authorize this DSH client with WeChat DevTools and verify the MCP bridge. Runs the IDE CLI status call (which ' +
      'raises the authorization dialog in the IDE), polls the pending task, then connects and counts tools. ' +
      'Call this once after install/upgrade, whenever wechatide_status reports "Client authorization pending", ' +
      'or when the IDE was restarted. It also launches the IDE if it is not running.',
    parameters: {
      waitSeconds: { type: 'number', description: 'how long to wait for the IDE dialog to be approved, in seconds (default 30)' },
    },
    output: textOutput,
    timeoutMs: 180_000,
    presentCall: () => ({ card: 'generic', title: 'wechatide connect', kind: 'execute' }),
    execute: guarded(async (args, exec_) => {
      const waitSeconds = Number.isFinite(Number(args.waitSeconds)) ? Math.max(0, Math.min(300, Number(args.waitSeconds))) : 30;
      const report = await authorize({ waitSeconds, signal: exec_.signal });
      if (report.reason === 'cli-missing') {
        throw new CliMissing(report.detail);
      }
      const lines = [];
      const login = report.cli.loginUser?.nickName ? `登录用户 ${report.cli.loginUser.nickName}` : undefined;
      const expired = report.cli.loginExpired === true ? '⚠ 登录态已过期，需要重新扫码' : undefined;

      if (report.ok) {
        lines.push(`已授权并连通：${login ?? '未知用户'}${expired ? `（${expired}）` : ''}`);
        lines.push(`mcp: ${report.bridge.server} (protocol ${report.bridge.protocolVersion}), ${report.bridge.toolCount} 个工具`);
        if (report.cli.versionRelation && report.cli.versionRelation !== 'equal') {
          lines.push(`skillVersion: ${report.cli.skillVersion ?? '?'} (${report.cli.versionRelation})`);
        }
        lines.push('next: wechatide_tools() 看工具；wechatide_call 执行具体操作');
        return { summary: lines.join('\n') };
      }

      if (report.state === 'pending') {
        lines.push(`授权仍未完成（taskId ${report.taskId}）：请在微信开发者工具弹出的授权窗口里点「允许」，然后再次调用 wechatide_connect`);
        if (report.bridge?.text) lines.push(`mcp: ${report.bridge.text}`);
        return { summary: lines.join('\n') };
      }
      if (report.state === 'failed' || report.state === 'cancelled') {
        lines.push(`授权被拒绝或取消（${report.state}，taskId ${report.taskId ?? '-'}）：在 IDE 里重新允许后再试`);
        return { summary: lines.join('\n') };
      }
      lines.push(`CLI 上报状态 ${report.state}，但 MCP 桥未连通：${report.bridge?.text ?? 'unknown'}`);
      if (report.bridge?.remedy) lines.push(`remedy: ${report.bridge.remedy}`);
      lines.push(`detail: ${JSON.stringify(report.cli).slice(0, 800)}`);
      return { summary: lines.join('\n') };
    }),
  });

  // ---- wechatide_tools ----------------------------------------------------
  register(
    {
      name: 'wechatide_tools',
      description:
        'List the tools the installed WeChat DevTools actually exposes (its MCP registry is version-dependent, so ' +
        'never assume). No query → grouped tool names. query → matching signatures with one-line descriptions. ' +
        'full=true → the complete parameter schema for a specific tool; read it before calling an unfamiliar tool.',
      parameters: {
        query: { type: 'string', description: 'case-insensitive substring over tool name and description, e.g. "console", "cloud", "element"' },
        full: { type: 'boolean', description: 'return full parameter schemas for the matches (narrow with query first)' },
        refresh: { type: 'boolean', description: 'bypass the cached list (after an IDE upgrade or reload)' },
      },
      output: textOutput,
      timeoutMs: 60_000,
      presentCall: (args) => ({ card: 'generic', title: `wechatide tools ${args.query ?? ''}`.trim(), kind: 'read' }),
      execute: guarded(async (args, exec_) => {
        const tools = await getBridge().listTools({ refresh: args.refresh === true, signal: exec_.signal });
        return { summary: renderToolList(tools, { query: args.query, full: args.full === true, maxBytes: cfg.maxResultBytes }) };
      }),
    },
    { concurrencySafe: true },
  );

  // ---- wechatide_call -----------------------------------------------------
  register({
    name: 'wechatide_call',
    description:
      'Call any WeChat DevTools MCP tool by name. This is the general execution path: compile/preview/upload, project ' +
      'open/import, page automation, CloudBase reads and writes all go through here. A required "project" argument is ' +
      'filled from the session cwd when you omit it, so one-liners work from inside the mini program repo. ' +
      'Discover names with wechatide_tools and read parameters with wechatide_tools(full=true) first.',
    parameters: {
      tool: { type: 'string', required: true, description: 'exact MCP tool name, e.g. open_project_window / simulator_refresh / automation_element_action' },
      args: { type: 'string', description: 'arguments as a JSON object string, e.g. \'{"action":"navigateTo","url":"/pages/home/index"}\'' },
      project: { type: 'string', description: 'absolute mini program root; overrides the session cwd when the tool requires project' },
      timeoutMs: { type: 'number', description: 'override the per-call timeout (ms); uploads and previews need more than the 60s default' },
    },
    output: textOutput,
    timeoutMs: 300_000,
    presentCall: (args) => ({ card: 'generic', title: `wechatide ${args.tool}`, kind: 'execute', rawInput: args.args ?? '' }),
    execute: guarded(async (args, exec_) => {
      const toolName = String(args.tool ?? '').trim();
      if (toolName === '') throw new Error('tool 不能为空：用 wechatide_tools() 查名称');
      const parsed = parseArgs(args.args);
      // IDE 自己的状态工具会比对调用方的 skill 版本，缺失时告警；
      // 填入本安装实际携带的版本。
      if (toolName === 'check_wechatide_status' && parsed['skill-version'] === undefined) {
        const version = skillVersion();
        if (version !== undefined) parsed['skill-version'] = version;
      }
      const { args: finalArgs } = await withProjectArg(toolName, parsed, args.project, exec_);
      const timeoutMs = Number.isFinite(Number(args.timeoutMs)) ? Math.max(1000, Math.min(300_000, Number(args.timeoutMs))) : cfg.toolCallTimeoutMs;
      const started = Date.now();
      const result = await getBridge().callTool(toolName, finalArgs, { timeoutMs, signal: exec_.signal });
      return { summary: renderCall(toolName, result, { elapsedMs: Date.now() - started, maxBytes: cfg.maxResultBytes }) };
    }),
  });

  // ---- wechatide_screenshot -----------------------------------------------
  register({
    name: 'wechatide_screenshot',
    description:
      'Capture the mini program simulator. Returns the file path plus width/height; on routes that accept image input ' +
      'the JPEG is also attached as a real image block (budgeted per session), otherwise the result states plainly that ' +
      'the pixels are NOT in context. waitForSelector is the reliable way to capture a page that is still rendering.',
    parameters: {
      project: { type: 'string', description: 'absolute mini program root (defaults to the session cwd)' },
      waitForSelector: { type: 'string', description: 'wait for this selector before capturing (preferred over a fixed wait)' },
      wait: { type: 'number', description: 'fixed extra wait in seconds before capturing (0-10)' },
      path: { type: 'string', description: 'absolute output path; omit to let the IDE write into a temp dir' },
      raw: { type: 'boolean', description: 'true = unoptimized PNG; false/omitted = optimized JPEG (long edge 1280)' },
      quality: { type: 'number', description: 'JPEG quality 1-100 (only when raw is false)' },
    },
    output: imageOutput,
    timeoutMs: 180_000,
    presentCall: (args) => ({ card: 'generic', title: `wechatide screenshot ${args.waitForSelector ?? ''}`.trim(), kind: 'execute' }),
    execute: guarded(async (args, exec_) => {
      const callArgs = {
        project: typeof args.project === 'string' && args.project !== '' ? args.project : sessionCwd(exec_),
        optimize: args.raw !== true,
      };
      if (typeof args.path === 'string' && args.path !== '') callArgs.path = args.path;
      if (typeof args.waitForSelector === 'string' && args.waitForSelector !== '') callArgs.waitForSelector = args.waitForSelector;
      if (Number.isFinite(Number(args.wait))) callArgs.wait = Math.max(0, Math.min(10, Number(args.wait)));
      if (Number.isFinite(Number(args.quality))) callArgs.quality = Math.max(1, Math.min(100, Number(args.quality)));

      const started = Date.now();
      const result = await getBridge().callTool('simulator_screenshot', callArgs, { signal: exec_.signal });
      const rendered = renderCall('simulator_screenshot', result, { elapsedMs: Date.now() - started, maxBytes: cfg.maxResultBytes });
      const payload = extractStructured(result);
      const shotPath = typeof payload?.path === 'string' ? payload.path : undefined;
      if (payload?.success === false || shotPath === undefined) {
        return { summary: `${rendered}\n（截图失败，未附加图像）` };
      }

      let attach = { status: 'screenshot path only' };
      try {
        attach = await attachImage(shotPath, exec_);
      } catch (error) {
        attach = { status: `degraded: ${error?.message ?? error}` };
      }

      let note;
      if (attach.image === undefined) {
        if (attach.canSee === true) note = `图像未附加：${attach.status}（文件在磁盘上，但不在你的上下文里）`;
        else if (attach.canSee === false) note = `本路由不接受图像输入：${attach.status}（用 wechatide_logs / automation_runtime_info 取证）`;
        else note = `图像能力未知：${attach.status}；截图文件：${shotPath}`;
      } else {
        note = `图像已附加：${attach.status}`;
      }
      const summary = `${rendered}\n${note}`;
      return attach.image === undefined ? { summary } : { summary, image: attach.image };
    }),
  });

  // ---- wechatide_logs -----------------------------------------------------
  register({
    name: 'wechatide_logs',
    description:
      'Read the mini program console or network buffer through the IDE. This is a cached buffer read, not a live ' +
      'stream: call it after an action to see what that action logged. Defaults to errors/exceptions; use mode="all" ' +
      'for the tail of everything, or mode="pattern" with a grep -E pattern.',
    parameters: {
      source: { type: 'string', enum: ['console', 'network'], description: 'which buffer (default console)' },
      mode: { type: 'string', enum: ['errors', 'all', 'pattern'], description: 'errors (default) | all | pattern — pattern requires pattern' },
      pattern: { type: 'string', description: 'extended regex used with mode="pattern", e.g. "request|status|401"' },
      project: { type: 'string', description: 'absolute mini program root (defaults to the session cwd)' },
    },
    output: textOutput,
    timeoutMs: 120_000,
    presentCall: (args) => ({ card: 'generic', title: `wechatide ${args.source ?? 'console'} logs`, kind: 'read' }),
    execute: guarded(async (args, exec_) => {
      const source = args.source === 'network' ? 'network' : 'console';
      const mode = args.mode === 'all' || args.mode === 'pattern' ? args.mode : 'errors';
      let command;
      if (mode === 'pattern') {
        const pattern = String(args.pattern ?? '').trim();
        if (pattern === '') throw new Error('mode="pattern" 需要 pattern（grep -E 正则）');
        command = `grep -n -i -E ${shellQuote(pattern)}`;
      } else if (mode === 'all') {
        command = 'grep -n .';
      } else {
        command = 'grep -n -i -E "error|exception|fail|timeout|unhandled"';
      }
      const toolName = source === 'network' ? 'get_simulator_network' : 'get_simulator_console';
      const callArgs = {
        project: typeof args.project === 'string' && args.project !== '' ? args.project : sessionCwd(exec_),
        command,
      };
      const started = Date.now();
      const result = await getBridge().callTool(toolName, callArgs, { signal: exec_.signal });
      return {
        summary: `${renderCall(toolName, result, { elapsedMs: Date.now() - started, maxBytes: cfg.maxResultBytes })}\ncommand: ${command}`,
      };
    }),
  });

  // ---- 内置 skill ---------------------------------------------------------
  if (cfg.exposeSkill) {
    const skillDir = fileURLToPath(new URL('../skills/' + SKILL_NAME, import.meta.url));
    const skillPath = `${skillDir}/SKILL.md`;
    const provider = {
      name: SKILL_PROVIDER,
      async list() {
        return [
          {
            name: SKILL_NAME,
            description: SKILL_DESCRIPTION,
            invocation: { modelInvocable: true, userInvocable: true },
            provider: SKILL_PROVIDER,
            source: 'bundled',
            rank: 600,
            resourceBase: { kind: 'directory', path: skillDir },
            locator: { path: skillPath, directory: skillDir },
          },
        ];
      },
      async get(candidate) {
        if (candidate?.name !== SKILL_NAME) return undefined;
        const content = await readFile(skillPath, 'utf8');
        return {
          name: SKILL_NAME,
          description: SKILL_DESCRIPTION,
          invocation: { modelInvocable: true, userInvocable: true },
          provider: SKILL_PROVIDER,
          source: 'bundled',
          resourceBase: { kind: 'directory', path: skillDir },
          content,
        };
      },
    };
    try {
      ctx.inject(['skills'], (skillsCtx) => {
        skillsCtx.skills.registerProvider(() => provider);
      });
    } catch (error) {
      ctx.logger?.warn?.(`wechatide-mcp: skill provider not registered: ${error?.message ?? error}`);
    }
  }

  ctx.logger?.info?.(`wechatide-mcp: 6 tools registered (client ${cfg.clientName}, bridge lazily connected)`);
}

/** CLI 既不在配置指定的位置，也不在常见安装路径上。 */
class CliMissing extends Error {
  constructor(message) {
    super(message);
    this.name = 'CliMissing';
    this.code = 'WECHATIDE_CLI_MISSING';
  }
}

function positive(value, fallback) {
  const num = Number(value);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

function extractStructured(result) {
  if (result?.structuredContent !== undefined) return result.structuredContent;
  const text = Array.isArray(result?.content) ? result.content.find((block) => block?.type === 'text')?.text : undefined;
  if (typeof text !== 'string' || !text.trim().startsWith('{')) return undefined;
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** 为 IDE 执行的 `grep -E` 字符串安全地引用一个值（跨平台）。 */
function shellQuote(value) {
  // 双引号在 POSIX shell 和 cmd.exe 里都有效（macOS 上 IDE 自己跑 grep，
  // Windows 上则经 shell 执行）。换行被压平，因此 pattern 永远
  // 无法夹带第二条命令。
  const flat = String(value).replace(/[\r\n]+/g, ' ');
  return `"${flat.replace(/"/g, '\\"')}"`;
}

export default { name, inject, Config, apply, formatMs };
