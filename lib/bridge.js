/**
 * 微信开发者工具 stdio 桥接的极简 MCP 客户端（零依赖）。
 *
 * 为什么手写而不用 `@deepseek-ai/dsh-mcp-client`：IDE 的桥接是以换行分隔的 stdio
 * JSON-RPC，按 IDE 会话拉起进程，需要「按客户端名授权」的握手（`check_wechatide_status` →
 * `polling_task_result`），并且把「尚未授权」当作 *工具调用形态* 的 JSON-RPC 错误上报，
 * 而不是传输层失败。这三点都是通用桥接不建模的产品行为——由本类负责，
 * 上层工具层才能如实反映状态。
 *
 * 契约要点（对照 wechatide-skill 0.3.9 验证）：
 * - stdout 只有 JSON 行，但横幅行仍然防御性跳过
 *   （升级后的 CLI 若往 stdout 打印，必须降级而不是破坏会话）。
 * - `initialize` 返回 `protocolVersion: 2025-06-18`、`capabilities.tools.listChanged`。
 * - `tools/call` 的结果把负载放在 `structuredContent`，并以 JSON 字符串在
 *   `content[0].text` 里重复一遍；参数校验失败则以
 *   `isError: true` 加一段 `MCP error -32602` 文本返回。
 *
 * @module dsh-wechatide-mcp/bridge
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { safeEnv, spawnTarget } from './devtools.js';

/** IDE 已启动，但该客户端名尚未获得授权。 */
export class McpAuthorizationPending extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'McpAuthorizationPending';
    this.code = 'MCP_AUTHORIZATION_PENDING';
    Object.assign(this, details);
  }
}

/** 桥接无法启动或已退出（IDE 已关闭、CLI 缺失、端口拒绝连接）。 */
export class McpUnavailable extends Error {
  constructor(message, details = {}) {
    super(message);
    this.name = 'McpUnavailable';
    this.code = 'MCP_UNAVAILABLE';
    Object.assign(this, details);
  }
}

/** 服务端针对单次请求返回的 JSON-RPC 错误。 */
export class McpRpcError extends Error {
  constructor(message, { code, data } = {}) {
    super(message);
    this.name = 'McpRpcError';
    this.rpcCode = code;
    this.data = data;
  }
}

const DEFAULT_PROTOCOL = '2025-06-18';
const STDERR_TAIL_BYTES = 4096;

export class WechatideBridge {
  /**
   * @param {object} options
   * @param {string} options.bin        `wechatide` 可执行文件
   * @param {string} [options.clientName] IDE 授权的客户端身份
   * @param {string} [options.cwd]
   * @param {number} [options.timeoutMs] 单请求默认超时
   * @param {string} [options.protocolVersion]
   * @param {object} [options.logger]   任何带 info/warn/debug 的对象
   * @param {Function} [options.spawn]  测试接缝
   */
  constructor({
    bin,
    clientName = 'DSH',
    cwd,
    timeoutMs = 90_000,
    protocolVersion = DEFAULT_PROTOCOL,
    logger,
    spawn = nodeSpawn,
  } = {}) {
    this.bin = bin;
    this.clientName = clientName;
    this.cwd = cwd;
    this.timeoutMs = timeoutMs;
    this.protocolVersion = protocolVersion;
    this.logger = logger;
    this.spawnImpl = spawn;

    this.child = undefined;
    this.session = undefined;
    this.serverInfo = undefined;
    this.capabilities = undefined;
    this.tools = undefined;
    this.pending = new Map();
    this.nextId = 1;
    this.buffer = '';
    this.stderrTail = '';
    this.skippedLines = 0;
    this.queue = Promise.resolve();
    this.disposed = false;
    this.lastExit = undefined;
    this.connectedAt = undefined;
  }

  /** 活动子进程上的 `initialize` 握手成功后才为 true。 */
  get ready() {
    return this.session !== undefined && this.child !== undefined && this.child.exitCode === null;
  }

  /** 供状态行使用的可读标识。 */
  get serverLabel() {
    if (!this.serverInfo) return 'unknown';
    return `${this.serverInfo.name ?? '?'} ${this.serverInfo.version ?? '?'}`.trim();
  }

  // ---- 进程生命周期 -------------------------------------------------------

  #spawn() {
    if (this.disposed) throw new McpUnavailable('bridge disposed');
    // Windows 上 `wechatide` 是 .cmd 启动器；spawnTarget 会用 `cmd /d /s /c`
    // 包裹它，使桥接在各平台都能启动。
    const target = spawnTarget(this.bin, ['mcp']);
    let child;
    try {
      child = this.spawnImpl(target.file, target.args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        cwd: this.cwd,
        env: safeEnv(),
        windowsHide: true,
      });
    } catch (error) {
      throw new McpUnavailable(`无法启动 ${this.bin} mcp：${error?.message ?? error}`, { cause: error });
    }
    this.child = child;
    this.buffer = '';
    this.stderrTail = '';
    this.session = undefined;

    child.stdout?.setEncoding?.('utf8');
    child.stderr?.setEncoding?.('utf8');
    child.stdout?.on('data', (chunk) => this.#onStdout(chunk));
    child.stderr?.on('data', (chunk) => {
      this.stderrTail = (this.stderrTail + String(chunk)).slice(-STDERR_TAIL_BYTES);
    });
    child.on('error', (error) => {
      this.#failAll(new McpUnavailable(`与微信开发者工具的连接失败：${error?.message ?? error}`, { cause: error }));
    });
    child.on('exit', (code, signal) => {
      this.lastExit = { code, signal, at: Date.now() };
      this.session = undefined;
      this.child = undefined;
      this.#failAll(exitError(code, signal, this.stderrTail));
    });
    // 死掉的子进程上写 stdin 会出现 EPIPE，不能变成未处理的 rejection。
    child.stdin?.on?.('error', () => {});
    return child;
  }

  #onStdout(chunk) {
    this.buffer += chunk;
    let index;
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index).trim();
      this.buffer = this.buffer.slice(index + 1);
      if (line === '') continue;
      if (!line.startsWith('{')) {
        // 横幅 / 升级噪音。只在日志里大声降级，绝不污染数据流。
        this.skippedLines += 1;
        if (this.skippedLines <= 3) this.logger?.debug?.(`wechatide bridge: ignored non-JSON stdout line: ${line.slice(0, 160)}`);
        continue;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        this.skippedLines += 1;
        continue;
      }
      this.#dispatch(message);
    }
  }

  #dispatch(message) {
    if (message.id !== undefined && this.pending.has(message.id)) {
      const entry = this.pending.get(message.id);
      this.pending.delete(message.id);
      entry.settle(message);
      return;
    }
    if (message.method === 'notifications/tools/list_changed') {
      this.tools = undefined;
      return;
    }
    // 服务端发起但我们未实现的请求：如实回绝，而不是让服务端一直等。
    if (message.id !== undefined && typeof message.method === 'string') {
      this.#write({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `unsupported: ${message.method}` } });
    }
  }

  #write(payload) {
    const child = this.child;
    if (!child?.stdin?.writable) throw new McpUnavailable('MCP 桥已关闭，无法发送请求');
    child.stdin.write(`${JSON.stringify(payload)}\n`);
  }

  #failAll(error) {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  // ---- 请求管线 -----------------------------------------------------------

  /**
   * 发送一条 JSON-RPC 请求。请求是串行的：IDE 桥接是单会话管道，
   * 对共享模拟器交错 `tools/call` 会产生令人困惑的超时，因此顺序本身是契约的一部分。
   */
  request(method, params, { timeoutMs = this.timeoutMs, signal } = {}) {
    if (this.disposed) return Promise.reject(new McpUnavailable('bridge disposed'));
    const run = () => this.#requestNow(method, params, { timeoutMs, signal });
    const chained = this.queue.then(run, run);
    this.queue = chained.then(
      () => undefined,
      () => undefined,
    );
    return chained;
  }

  async #requestNow(method, params, { timeoutMs, signal }) {
    if (signal?.aborted) throw abortError();
    if (!this.child || this.child.exitCode !== null) this.#spawn();
    const id = this.nextId++;
    const payload = { jsonrpc: '2.0', id, method };
    if (params !== undefined) payload.params = params;

    const response = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new McpRpcError(`${method} 超时（${timeoutMs}ms）— 微信开发者工具可能正忙`, { code: 'TIMEOUT' }));
      }, timeoutMs);
      const onAbort = () => {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(abortError());
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      this.pending.set(id, {
        timer,
        settle: (message) => {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          resolve(message);
        },
        reject: (error) => {
          clearTimeout(timer);
          signal?.removeEventListener?.('abort', onAbort);
          reject(error);
        },
      });
      try {
        this.#write(payload);
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error instanceof McpUnavailable ? error : new McpUnavailable(String(error?.message ?? error)));
      }
    });

    if (response.error) {
      const message = String(response.error.message ?? 'unknown MCP error');
      if (/authorization pending/i.test(message)) {
        throw new McpAuthorizationPending(message, { taskId: extractTaskId(response.error) });
      }
      throw new McpRpcError(message, { code: response.error.code, data: response.error.data });
    }
    return response.result;
  }

  notify(method, params) {
    try {
      this.#write(params === undefined ? { jsonrpc: '2.0', method } : { jsonrpc: '2.0', method, params });
    } catch {
      /* 死掉的子进程由下一次请求上报 */
    }
  }

  // ---- MCP 操作 -----------------------------------------------------------

  /**
   * 按需建立会话。已就绪时幂等且开销极小。
   * @returns {Promise<{serverInfo: object, capabilities: object, protocolVersion: string}>}
   */
  async connect() {
    if (this.ready) return { serverInfo: this.serverInfo, capabilities: this.capabilities, protocolVersion: this.protocolVersion };
    const result = await this.request('initialize', {
      protocolVersion: this.protocolVersion,
      capabilities: {},
      clientInfo: { name: this.clientName, version: 'dsh-wechatide-mcp' },
    });
    this.session = { protocolVersion: result?.protocolVersion ?? this.protocolVersion };
    this.serverInfo = result?.serverInfo;
    this.capabilities = result?.capabilities;
    this.connectedAt = Date.now();
    this.notify('notifications/initialized', {});
    return { serverInfo: this.serverInfo, capabilities: this.capabilities, protocolVersion: this.session.protocolVersion };
  }

  /** 缓存的 `tools/list`；IDE 升级或切换窗口后传 `refresh`。 */
  async listTools({ refresh = false, signal } = {}) {
    await this.connect();
    if (!refresh && this.tools !== undefined) return this.tools;
    const result = await this.request('tools/list', {}, { signal });
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    this.tools = tools;
    return tools;
  }

  async findTool(name, { signal } = {}) {
    const tools = await this.listTools({ signal });
    return tools.find((tool) => tool?.name === name);
  }

  /**
   * 调用单个工具。返回原始 MCP 结果；渲染在 render.js 中完成，
   * 以便这一层对测试和非模型调用方保持可用。
   */
  async callTool(name, args = {}, { timeoutMs, signal } = {}) {
    await this.connect();
    return this.request('tools/call', { name, arguments: args }, { timeoutMs, signal });
  }

  close() {
    this.disposed = true;
    const child = this.child;
    this.child = undefined;
    this.session = undefined;
    this.#failAll(new McpUnavailable('bridge closed'));
    try {
      child?.stdin?.end();
    } catch {
        /* 已经退出 */
    }
    if (child !== undefined) {
      const timer = setTimeout(() => {
        try {
          child.kill('SIGKILL');
        } catch {
          /* 已经退出 */
        }
      }, 1500);
      timer.unref?.();
      child.once?.('exit', () => clearTimeout(timer));
    }
  }
}

function extractTaskId(error) {
  const candidates = [error?.data?.taskId, error?.data?.task_id, error?.data?.data?.taskId];
  for (const value of candidates) if (typeof value === 'string' && value !== '') return value;
  return undefined;
}

function exitError(code, signal, stderrTail) {
  const tail = String(stderrTail ?? '').trim().split('\n').slice(-3).join(' | ');
  const reason = tail || (code === null ? `signal ${signal}` : `exit ${code}`);
  return new McpUnavailable(`MCP 桥已退出（${reason}）`, { exitCode: code, signal });
}

function abortError() {
  const error = new Error('已取消');
  error.name = 'AbortError';
  return error;
}

/** 针对 IDE 实际产生的一行式诊断。 */
export function describeBridgeFailure(error) {
  const code = error?.code;
  const name = error?.name;
  // 鸭子类型同样处理：跨越模块边界（或会话恢复）的错误
  // 仍然必须被归类，而不是当成 "unknown" 直接抛出。
  if (
    error instanceof McpAuthorizationPending ||
    code === 'MCP_AUTHORIZATION_PENDING' ||
    name === 'McpAuthorizationPending' ||
    /authorization pending/i.test(String(error?.message ?? ''))
  ) {
    return {
      kind: 'authorization',
      text: '本客户端尚未获得微信开发者工具授权（Client authorization pending）',
      remedy: '运行 wechatide_connect：它会触发授权请求，在开发者工具的弹窗里点「允许」',
    };
  }
  if (error instanceof McpUnavailable || code === 'MCP_UNAVAILABLE' || name === 'McpUnavailable') {
    return {
      kind: 'unavailable',
      text: error.message,
      remedy:
        '确认微信开发者工具已启动并登录；若工具刚安装/升级，先在 IDE「设置 → 安全设置」里开启服务端口，再重试 wechatide_connect',
    };
  }
  if (error instanceof McpRpcError) {
    return { kind: 'rpc', text: error.message };
  }
  return { kind: 'unknown', text: String(error?.message ?? error) };
}
