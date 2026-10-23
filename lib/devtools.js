/**
 * 探测微信开发者工具的安装位置及其内部 MCP 服务。
 *
 * IDE 把 MCP 桥接作为 CLI 子命令提供——`wechatide mcp`（见 IDE 写入其 UserData
 * 目录的 `mcp.json`，它把这条命令原样注册给它接触的每个 MCP 客户端）。
 * 因此本模块只需回答三个问题：
 *
 *  1. `wechatide` 可执行文件在哪，
 *  2. IDE 是否在运行、监听哪个端口（UserData/<hash>/Default/.ide），
 *  3. 本次安装携带哪个 `wechatide-skill` 版本（CLI 会以它对照版本关系，
 *     并在首次状态调用时带上它）。
 *
 * 这里不涉及 MCP 通信，那是 bridge.js 的事。
 *
 * @module dsh-wechatide-mcp/devtools
 */
import { spawn as nodeSpawn } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** 常见的 macOS 应用包位置，最常用的在前。 */
const MAC_BUNDLES = [
  '/Applications/wechatwebdevtools.app',
  '/Applications/微信web开发者工具.app',
  join(homedir(), 'Applications/wechatwebdevtools.app'),
];

/**
 * 绝不能传给 IDE CLI 的环境变量键。桥接是本机可信进程，
 * 但子进程没有理由看到模型凭证。
 */
const SENSITIVE_ENV = /^(?:DEEPSEEK|OPENAI|ANTHROPIC|MINIMAX|VOLC|ARK|MOONSHOT|DASHSCOPE|GEMINI|GOOGLE_API)_?/i;

/** 经过清洗的环境变量副本。 */
export function safeEnv(base = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(base)) {
    if (value === undefined) continue;
    if (SENSITIVE_ENV.test(key)) continue;
    env[key] = value;
  }
  return env;
}

/** 当前平台的 `wechatide` 可执行文件候选，最优在前。 */
export function candidateBins(platform = process.platform, env = process.env) {
  const out = [];
  if (platform === 'darwin') {
    for (const bundle of MAC_BUNDLES) out.push(join(bundle, 'Contents/MacOS/wechatide'));
    out.push('/Applications/wechatwebdevtools.app/Contents/MacOS/cli');
    out.push('/usr/local/bin/wechatide');
    out.push('/opt/homebrew/bin/wechatide');
    return out;
  }
  if (platform !== 'win32') {
    return ['/usr/local/bin/wechatide', '/opt/wechatide/bin/wechatide', '/opt/bin/wechatide'];
  }

  // Windows：IDE 默认安装到 Program Files (x86)，但腾讯安装器也允许按用户安装。
  // 启动器名字随版本变化过（`cli.bat` → `wechatide.cmd`），所以每个安装根目录下两个都探。
  const roots = [];
  const push = (dir) => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };
  const programFiles86 = env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)';
  const programFiles64 = env.ProgramFiles ?? 'C:\\Program Files';
  for (const base of [programFiles86, programFiles64, env.LOCALAPPDATA && join(env.LOCALAPPDATA, 'Programs')]) {
    if (!base) continue;
    for (const app of ['微信web开发者工具', '微信开发者工具', 'wechatwebdevtools']) {
      push(join(base, 'Tencent', app));
      push(join(base, app));
    }
  }
  if (env.LOCALAPPDATA) push(join(env.LOCALAPPDATA, '微信开发者工具'));
  if (env.USERPROFILE) push(join(env.USERPROFILE, 'AppData', 'Local', '微信开发者工具'));

  for (const root of roots) {
    for (const launcher of ['wechatide.cmd', 'wechatide.exe', 'cli.bat', 'wechatide']) {
      out.push(join(root, launcher));
    }
  }
  return out;
}

/**
 * 解析要启动的 CLI。
 *
 * 优先级：显式配置，然后 `WECHAT_DEVTOOLS_CLI`，然后常见安装路径，
 * 最后是 PATH 上的裸 `wechatide`（交给调度器解析）。
 * 返回 `source` 是为了让失败信息能说明「为什么选了这条路径」，而不是靠猜。
 */
export function resolveBin(config = {}, platform = process.platform) {
  const explicit = typeof config.binPath === 'string' ? config.binPath.trim() : '';
  if (explicit) return { bin: explicit, source: 'config', exists: existsSync(explicit) };

  const fromEnv = (process.env.WECHAT_DEVTOOLS_CLI ?? '').trim();
  if (fromEnv) return { bin: fromEnv, source: 'env:WECHAT_DEVTOOLS_CLI', exists: existsSync(fromEnv) };

  for (const candidate of candidateBins(platform)) {
    if (existsSync(candidate)) return { bin: candidate, source: 'well-known', exists: true };
  }
  return { bin: platform === 'win32' ? 'wechatide.cmd' : 'wechatide', source: 'PATH', exists: false };
}

/**
 * 把 `(bin, args)` 变成操作系统真正能启动的东西。
 *
 * Windows 无法用 `spawn`/`execFile` 加 `shell: false` 启动 `.cmd`/`.bat` 启动器
 * ——自 2024 年命令注入修复起 Node 直接拒绝（EINVAL），而 Windows 上的
 * DevTools CLI 恰好就是这种启动器。可移植的答案是
 * `cmd.exe /d /s /c "<带引号的命令行>"`，cross-spawn 也是这么定的：
 * 每个 token 先加引号，整行再包一次，于是 `cmd /s` 正好剥掉最外层一对引号，
 * 参数保持原样。
 *
 * 保持纯函数（platform 和 ComSpec 由参数注入），因此可在非 Windows 上单测。
 */
export function spawnTarget(bin, args = [], { platform = process.platform, comspec = process.env.ComSpec || 'cmd.exe' } = {}) {
  const isWindowsScript = platform === 'win32' && /\.(?:cmd|bat)$/i.test(bin);
  if (!isWindowsScript) return { file: bin, args: [...args] };
  const quote = (token) => `"${String(token).replace(/"/g, '""')}"`;
  const line = [bin, ...args].map(quote).join(' ');
  return { file: comspec, args: ['/d', '/s', '/c', `"${line}"`] };
}

/** 各平台上可能存放 IDE `UserData` 树的根目录。 */
export function userDataRoots(platform = process.platform, env = process.env) {
  const roots = [];
  const push = (dir) => {
    if (dir && !roots.includes(dir)) roots.push(dir);
  };
  if (platform === 'darwin') {
    push(join(homedir(), 'Library', 'Application Support', '微信开发者工具'));
    push(join(homedir(), 'Library', 'Application Support', 'wechatwebdevtools'));
  } else if (platform === 'win32') {
    // Windows 上 IDE 会多嵌一层（…\微信开发者工具\User Data\<hash>\Default），
    // 所以根目录本身和它的 `User Data` 子目录都要扫描。
    for (const base of [env.APPDATA, env.LOCALAPPDATA, env.USERPROFILE && join(env.USERPROFILE, 'AppData', 'Roaming')]) {
      if (!base) continue;
      push(join(base, '微信开发者工具'));
      push(join(base, '微信开发者工具', 'User Data'));
      push(join(base, 'wechatwebdevtools'));
    }
  } else {
    push(join(homedir(), '.config', '微信开发者工具'));
    push(join(homedir(), '.config', 'wechatwebdevtools'));
  }
  return roots;
}

/**
 * 存放 IDE `Default/` 配置的目录，最新的在前（尽力而为）。
 *
 * 接受这几种形态，因为布局随平台和版本不同：
 * `<root>/<hash>/Default`、`<root>/User Data/<hash>/Default`、`<root>/Default`。
 */
export function defaultDirs(platform = process.platform, env = process.env, roots) {
  const found = [];
  for (const root of roots ?? userDataRoots(platform, env)) {
    if (!existsSync(root)) continue;
    const parents = [root];
    for (const nested of ['User Data', 'UserData']) {
      const dir = join(root, nested);
      if (existsSync(dir)) parents.push(dir);
    }
    for (const parent of parents) {
      if (existsSync(join(parent, 'Default'))) found.push(join(parent, 'Default'));
      let entries;
      try {
        entries = readdirSync(parent, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue;
        const dir = join(parent, entry.name, 'Default');
        if (existsSync(dir)) found.push(dir);
      }
    }
  }
  return [...new Set(found)].sort((a, b) => mtimeOf(b) - mtimeOf(a));
}

function mtimeOf(path) {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

/**
 * 读取 IDE 的磁盘控制文件。
 *
 * `.ide` 保存 IDE 为 CLI/MCP 流量开放的 HTTP 端口，`.ide-status` 保存
 * `On`/`Off`，`mcp.json` 是 IDE 向 MCP 客户端宣告的配置——本插件镜像的
 * 正是那条 stdio 命令的证据。
 */
export function readDevtoolsState({ platform = process.platform, env = process.env, dirs } = {}) {
  const candidates = dirs ?? defaultDirs(platform, env);
  for (const dir of candidates) {
    const portText = readText(join(dir, '.ide'));
    const status = readText(join(dir, '.ide-status'));
    const mcpJson = readText(join(dir, 'mcp.json'));
    const port = Number.parseInt((portText ?? '').trim(), 10);
    if (!Number.isFinite(port) && status === undefined && mcpJson === undefined) continue;
    return {
      found: true,
      dir,
      port: Number.isFinite(port) ? port : undefined,
      status: (status ?? '').trim() || undefined,
      running: (status ?? '').trim() === 'On',
      mcpJson: mcpJson ? safeJson(mcpJson) : undefined,
    };
  }
  return { found: false, running: false };
}

function readText(path) {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return undefined;
  }
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/**
 * 本安装携带的 `wechatide-skill` 版本。
 *
 * CLI 会拿调用方的 skill 版本与它比较（`versionRelation`），而 IDE 升级会
 * 悄悄改变工具注册表——因此插件只报告看到的版本，不写死某一个。
 */
export function readSkillVersion(binPath) {
  if (typeof binPath !== 'string' || binPath === '') return undefined;
  const dir = dirnameOf(binPath);
  // skill 文件的候选位置随安装布局不同：
  // macOS 是 <app>/Contents/MacOS/wechatide → <app>/Contents/Resources/app.asar.unpacked/…，
  // Windows 是 <install>/wechatide.cmd → <install>/resources/app.asar.unpacked/…
  const candidates = [
    join(dir, '..', 'Resources', 'app.asar.unpacked', 'wechatide-skill', 'SKILL.md'),
    join(dir, '..', 'resources', 'app.asar.unpacked', 'wechatide-skill', 'SKILL.md'),
    join(dir, 'resources', 'app.asar.unpacked', 'wechatide-skill', 'SKILL.md'),
    join(dir, 'app.asar.unpacked', 'wechatide-skill', 'SKILL.md'),
  ];
  for (const file of candidates) {
    const text = readText(file);
    const version = text?.match(/^version:\s*['"]?([^'"\s#]+)/m)?.[1];
    if (version) return version;
  }
  return undefined;
}

function dirnameOf(path) {
  const index = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return index > 0 ? path.slice(0, index) : '.';
}

/**
 * 运行一条 `wechatide` CLI 命令并解析其 JSON 信封。
 *
 * CLI 把诊断写到 stderr、把结果信封写到 stdout，所以宽容解析即可
 * （跳过开头的横幅行，取第一个 `{`）。信封形如 `{ ok, tool, clientName, result }`。
 *
 * 基于 `spawn(spawnTarget(...))` 而不是 `execFile`：Windows 上 CLI 是
 * `.cmd` 启动器，`execFile` 不带 shell 起不来。在这里统一收流也让超时、
 * 取消和输出上限在各平台保持一致。
 */
export function runCliJson(bin, argv, { timeoutMs = 60_000, cwd, signal, env, platform, comspec } = {}) {
  const MAX_OUTPUT = 16 * 1024 * 1024;
  return new Promise((resolvePromise, reject) => {
    const target = spawnTarget(bin, argv, { platform, comspec });
    let child;
    try {
      child = nodeSpawn(target.file, target.args, {
        cwd,
        env: env ?? safeEnv(),
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(error);
      return;
    }

    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    let overflow = false;

    const finish = (action) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      action();
    };
    const kill = () => {
      try {
        child.kill('SIGKILL');
      } catch {
        /* 已经退出 */
      }
    };
    const onAbort = () => {
      kill();
      const error = new Error('已取消');
      error.name = 'AbortError';
      finish(() => reject(error));
    };

    child.stdout?.on('data', (chunk) => {
      stdout += chunk;
      if (stdout.length > MAX_OUTPUT) {
        overflow = true;
        kill();
      }
    });
    child.stderr?.on('data', (chunk) => {
      stderr += chunk;
    });
    child.on('error', (error) => finish(() => reject(error)));
    child.on('close', (code) => {
      const parsed = parseJsonLoose(stdout);
      if (parsed !== undefined) {
        finish(() => resolvePromise({ ok: true, envelope: parsed, stdout, stderr, exitCode: code ?? 0 }));
        return;
      }
      if (overflow) {
        const error = new Error(`CLI 输出超过 ${MAX_OUTPUT} 字节上限`);
        error.code = 'OUTPUT_OVERFLOW';
        error.stderr = stderr;
        finish(() => reject(error));
        return;
      }
      if (code !== 0) {
        const error = new Error(`Command failed: ${bin} (exit ${code})`);
        error.code = code;
        error.stdout = stdout;
        error.stderr = stderr;
        finish(() => reject(error));
        return;
      }
      finish(() => resolvePromise({ ok: false, envelope: undefined, stdout, stderr, exitCode: 0 }));
    });

    if (signal?.aborted) {
      onAbort();
      return;
    }
    signal?.addEventListener?.('abort', onAbort, { once: true });
    timer = setTimeout(() => {
      kill();
      const error = new Error(`CLI 在 ${timeoutMs}ms 内没有返回`);
      error.code = 'ETIMEDOUT';
      error.stderr = stderr;
      finish(() => reject(error));
    }, timeoutMs);
  });
}

/** 解析 CLI 输出里内嵌的第一个 JSON 对象；没有则返回 `undefined`。 */
export function parseJsonLoose(text) {
  if (typeof text !== 'string') return undefined;
  const trimmed = text.trim();
  if (trimmed === '') return undefined;
  try {
    return JSON.parse(trimmed);
  } catch {
    /* 落到下面的扫描逻辑 */
  }
  const start = trimmed.indexOf('{');
  if (start === -1) return undefined;
  for (let end = trimmed.lastIndexOf('}'); end > start; end = trimmed.lastIndexOf('}', end - 1)) {
    try {
      return JSON.parse(trimmed.slice(start, end + 1));
    } catch {
      /* 继续缩小范围 */
    }
  }
  return undefined;
}
