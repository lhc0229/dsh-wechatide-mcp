# dsh-wechatide-mcp

[![npm version](https://img.shields.io/npm/v/dsh-wechatide-mcp.svg)](https://www.npmjs.com/package/dsh-wechatide-mcp)
[![npm downloads](https://img.shields.io/npm/dm/dsh-wechatide-mcp.svg)](https://www.npmjs.com/package/dsh-wechatide-mcp)
[![node](https://img.shields.io/node/v/dsh-wechatide-mcp.svg)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/dsh-wechatide-mcp.svg)](https://github.com/lhc0229/dsh-wechatide-mcp/blob/main/LICENSE)

> 把微信开发者工具（wechatide）自带的内部 MCP 服务接进 DeepSeek Harness（DSH）的插件。

宿主机上的微信开发者工具本身就是一个 MCP 服务器：它在 UserData 目录里写下一份
`mcp.json`（`{"command":"wechatide","args":["mcp"]}`），用 stdio JSON-RPC 把整套自动化能力
——开窗/导入项目、编译、预览二维码、上传体验版、模拟器截图、console/network 缓冲区、
页面自动化、云开发读写——暴露给任意 MCP 客户端。

本插件就是那层客户端：负责**授权**（IDE 的客户端白名单）、**运行时发现工具**（IDE 的清单随版本变化）、
以及**把结果渲染成模型能用的形态**（结论先行、错误映射、按字节截断、截图附真实图像）。

```text
微信开发者工具 ──(stdio JSON-RPC: wechatide mcp)── dsh-wechatide-mcp ──> 6 个 wechatide_* 工具
      ↑ 授权弹窗 / 端口 / UserData               ↑ 桥接 · 错误映射 · 截断 · 图像预算
```

## 特性

- **6 个固定工具 + 运行时工具发现**：不为 IDE 的 40+ 个工具各占一份 prompt schema，`wechatide_tools` 按需读取实时清单。
- **授权是一条产品流程**：`wechatide_connect` 走完 `check_wechatide_status` → 触发 IDE 弹窗 → 轮询 `polling_task_result` → 用工具实际使用的 MCP 通道复验。
- **诚实的失败**：IDE 的业务错误、Schema 校验报告、未授权状态都渲染成「一句结论 + 下一步动作」。
- **输出有界**：单条结果默认截断到 6 KB；`structuredContent` 与重复的文本块只取一份。
- **截图按路由能力附加**：支持图像输入的路由附真实图像块（每会话预算 + 同画面去重），纯文本路由明确告知像素不在上下文里。
- **零运行时依赖**：只用 Node 内置模块；3 个宿主包为可选 peer，由 DSH 提供。

## 环境要求

| 依赖 | 要求 |
|---|---|
| Node.js | `>= 20` |
| DeepSeek Harness | 需提供 `@deepseek-ai/dsh-tools`、`@deepseek-ai/schemastery`、`@deepseek-ai/dsh-attachment`（可选 peer，宿主注入） |
| 微信开发者工具 | 提供 `wechatide mcp` 子命令的版本（`wechatide-skill ≥ 0.3`） |
| 操作系统 | macOS 已实机验证；Windows 按目录布局实现但未实机验证；Linux 未验证 |

> 只使用 `dsh-wechatide-mcp/bridge`、`/devtools`、`/render` 这三个子路径时不需要 DSH 宿主：
> 它们只依赖 Node 内置模块（见[编程接口](#编程接口)）。

## 安装

### 通过 DSH 插件管理器（推荐）

**图形界面**：DSH 侧栏「插件」→「添加插件」→ 输入包名 `dsh-wechatide-mcp`（可带版本，如
`dsh-wechatide-mcp@0.1.1`）→ 安装 → 按提示重启 DSH。

**命令行**（等价）：

```bash
dsh plugin add dsh-wechatide-mcp --profile desktop
```

插件管理器会同时处理依赖安装、`dsh.profile.bundles` 登记和 `cordis.patch.yml` 的 bundle patch。

### 从本地目录安装（开发用）

```bash
dsh plugin add link:/absolute/path/to/dsh-wechatide-mcp --profile desktop
```

### 只用 npm 安装

```bash
npm install dsh-wechatide-mcp
```

`npm install` 只把包放进 `node_modules`，**不会激活插件**：还需要把 `dsh-wechatide-mcp` 加进
profile 的 `package.json` 里的 `dsh.profile.bundles` 数组，然后重启 DSH。

装好后会话里出现 `wechatide_*` 六个工具。IDE 未启动时 `wechatide_connect` 会尝试拉起它。

## 快速开始

```text
1. wechatide_status      # CLI 在不在、IDE 起没起、登录态、本客户端是否已授权、IDE 有多少工具
2. wechatide_connect     # 没授权就调它：IDE 弹「是否允许 DSH 访问」→ 点「允许」
3. wechatide_tools       # 看这台 IDE 实际暴露了哪些工具
4. wechatide_call        # 开工：一次一个动作
```

授权按 **clientName** 记账（默认 `DSH`）。IDE 重启、升级或更换 clientName 后需要重新
`wechatide_connect`；这是授权粒度，不是故障。

推荐的工作节奏是 **status → 动作 → 取证**：每次 `wechatide_call` 之后用
`wechatide_logs`、`wechatide_screenshot` 或
`wechatide_call(tool="automation_runtime_info", args='{"action":"currentPage"}')` 读一次结果，再决定下一步。

## 工具

| 工具 | 主要参数 | 说明 |
|---|---|---|
| `wechatide_status` | `probe`（默认 `true`） | 端到端诊断：CLI 路径、IDE 进程/端口、登录态、授权状态、工具数量；`probe=false` 时跳过 MCP 探测 |
| `wechatide_connect` | `waitSeconds`（默认 `30`） | 授权本客户端并验证 MCP 桥接；返回 taskId 与桥接状态 |
| `wechatide_tools` | `query`、`full`、`refresh` | 读实时工具清单；无参按族分组，`query` 查签名+描述，`full=true` 出完整参数 schema |
| `wechatide_call` | `tool`（必填）、`args`、`project`、`timeoutMs` | 通用执行入口；`args` 是 JSON 对象字符串，缺 `project` 时自动填会话 cwd |
| `wechatide_screenshot` | `project`、`waitForSelector`、`wait`、`path`、`raw`、`quality` | 模拟器截图；能力允许时附真实图像块，否则返回路径与原因 |
| `wechatide_logs` | `source`、`mode`、`pattern`、`project` | 读 console/network 缓冲区：`errors`（默认）/ `all` / `pattern`（grep -E） |

典型调用：

```text
wechatide_call(tool="open_project_window", project="/path/to/miniprogram")
wechatide_call(tool="simulator_refresh")
wechatide_screenshot(waitForSelector=".list")
wechatide_logs(source="network", mode="pattern", pattern="401|status")
```

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖（下为默认值）：

```yaml
- id: wechatide-mcp
  name: dsh-wechatide-mcp
  config:
    clientName: DSH            # 授权身份，需与 IDE 弹窗中显示的名称一致
    binPath: ''                 # 空 = 自动探测；显式路径优先
    projectFromCwd: true        # 工具要求 project 时自动填会话 cwd
    toolCallTimeoutMs: 90000    # 单次 tools/call 默认超时（上传/预览用 timeoutMs 覆盖）
    maxResultBytes: 6000        # 单条结果截断字节数
    imageBudget: 3              # 每会话最多附加几张截图（0 = 只给路径）
    exposeSkill: true           # 把内置 skill 发布到会话技能目录
```

| 字段 | 类型 | 默认 | 说明 |
|---|---|---|---|
| `binPath` | `string` | `''` | `wechatide` 可执行文件绝对路径 |
| `clientName` | `string` | `'DSH'` | IDE 授权的客户端身份 |
| `projectFromCwd` | `boolean` | `true` | 用会话 cwd 补全必填的 `project` 参数 |
| `toolCallTimeoutMs` | `number` | `90000` | `tools/call` 默认超时（毫秒） |
| `maxResultBytes` | `number` | `6000` | 渲染结果截断上限 |
| `imageBudget` | `number` | `3` | 每会话图像块预算 |
| `exposeSkill` | `boolean` | `true` | 是否发布内置 skill |

找不到 CLI 时也可以临时用环境变量指定（优先级低于 `binPath`，高于自动探测）：

```bash
export WECHAT_DEVTOOLS_CLI="/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide"
```

## 失败与诊断

插件不会把 IDE 的原始报错直接抛给模型，而是渲染成「结论 + 下一步」：

| IDE 返回 | 渲染结果 |
|---|---|
| `project window not found, open the project first` | 失败 + `remedy: … open_project_window …` |
| `cant find runtimeid by projectpath …` | 失败 + 「先开窗、再 simulator_refresh」 |
| `Cannot read properties of undefined (reading 'winId')` | 失败 + 「模拟器窗口不可用」 |
| `APPID_ERROR` / `不存在此 AppID` | 失败 + 「换成本账号可管理的 AppID」 |
| `MCP error -32602 … Invalid arguments` | 参数被拒 + 逐字段原因 + 「先 wechatide_tools(full=true)」 |
| `Client authorization pending` | 未授权 + 「跑 wechatide_connect，去 IDE 弹窗点允许」 |
| `loginExpired` / `not logged in` | 登录态过期 + 「重新授权或 wechatide_call(tool="login") 扫码」 |

`wechatide_status` 在失败时也会给出 `next:` 一行，指明当前唯一该做的动作。

## 设计取舍

**为什么不是「每个 IDE 工具一个函数」。** IDE 的工具清单随版本变化，硬编码 40+ 个工具名要付两份代价：
每次请求都在 prompt 里买下一整套 schema（KV cache 还会因 IDE 升级失效），以及升级后的静默名字漂移。
因此注册面固定为 6 个，清单在运行时通过 `wechatide_tools` 读取。

**为什么授权要单独一个工具。** 新 clientName 首次连接只会得到 `Client authorization pending`；
只有 IDE CLI 的 `check_wechatide_status` → `polling_task_result` 这一对能弹出授权框并完成任务。
把它做成独立的 `wechatide_connect`，失败原因才能如实回报，而不是在通用调用里反复超时。

## 平台说明（Windows）

Windows 支持按 IDE 的实际布局实现，但**未在 Windows 实机验证**：

- **启动器**：Windows 上 CLI 是 `wechatide.cmd` / `cli.bat`，Node 在 `shell:false` 下拒绝直接
  spawn `.cmd`（EINVAL）。所有子进程经 `spawnTarget()` 包装为
  `cmd.exe /d /s /c ""<bin>" "<arg>""`，`/s` 只剥最外层引号，参数保持原样（有单测覆盖）。
- **安装路径**：探测 `%ProgramFiles(x86)%\Tencent\微信web开发者工具\`、`%ProgramFiles%\Tencent\…`、
  `%LOCALAPPDATA%\Programs\…` 下的 `wechatide.cmd` / `wechatide.exe` / `cli.bat` / `wechatide`。
- **UserData**：接受扁平 `<root>\<hash>\Default` 与多一层的 `<root>\User Data\<hash>\Default` 两种形状。
- **待确认**：安装目录名与启动器名历年变过。若 `wechatide_status` 报找不到 CLI，直接指定真实路径：

```powershell
$env:WECHAT_DEVTOOLS_CLI = "C:\Program Files (x86)\Tencent\微信web开发者工具\wechatide.cmd"
```

## 编程接口

包导出四个入口，供脚本或其它插件复用：

```js
// MCP 客户端（不依赖 DSH 宿主）
import { WechatideBridge } from 'dsh-wechatide-mcp/bridge';

const bridge = new WechatideBridge({
  bin: '/Applications/wechatwebdevtools.app/Contents/MacOS/wechatide',
  clientName: 'DSH',
});
const tools = await bridge.listTools();       // 实时清单
const result = await bridge.callTool('check_wechatide_status', {});
bridge.close();
```

| 子路径 | 导出 |
|---|---|
| `dsh-wechatide-mcp` | 插件入口：`apply`、`Config`、`name`、`inject` |
| `dsh-wechatide-mcp/bridge` | `WechatideBridge`、`McpAuthorizationPending`、`McpUnavailable`、`McpRpcError`、`describeBridgeFailure` |
| `dsh-wechatide-mcp/devtools` | `resolveBin`、`candidateBins`、`spawnTarget`、`userDataRoots`、`defaultDirs`、`readDevtoolsState`、`readSkillVersion`、`runCliJson`、`parseJsonLoose`、`safeEnv` |
| `dsh-wechatide-mcp/render` | `renderCall`、`renderToolList`、`renderToolSchema`、`normalizeCallResult`、`clamp`、`remedyFor`、`condenseValidation`、`toolFamily`、`toolSignature`、`formatPayload`、`oneLine`、`formatMs` |

## 开发

```bash
npm test   # 38 个单测：bridge / devtools / render / 工具装配
npm run smoke -- /path/to/miniprogram                          # 真机只读联调
node --import ./test/support/register.mjs scripts/e2e.mjs <项目>  # 开窗 → 截图 → 日志 → 关窗
```

- `scripts/smoke.mjs` 全部只读（状态、工具清单、项目列表、运行时信息、日志），不会开窗或上传。
- `scripts/e2e.mjs` 会打开项目窗口并触发编译，**只对一次性项目使用**。
- 单测通过 `test/support/host-shim.mjs` 解析 `@deepseek-ai/*`：解析到真包时用真包，否则回落到行为等价的 stub，
  因此没有 DSH 的机器也能跑测试，且在 DSH 内不会遮蔽真包。

## 已知边界

- 一个 IDE 只有一条 MCP 会话：动作串行执行（插件内部排队），不要指望并发操作两个页面。
- IDE 工具都在 `wechatide_call` 之后：模型需先 `wechatide_tools` 发现名字与参数，这是省 token 的有意取舍。
- 上传、发布、云写入与删除都是不可逆的外发动作：插件只负责如实执行与回报，是否执行由对话决定。
- 截图默认写入 IDE 的临时目录；需要固定路径时传 `path`。
- 工具清单与参数以 IDE 实际版本为准，本 README 不列举 IDE 的 40+ 个工具名。

## 相关

- [`dsh-mp-automator`](https://www.npmjs.com/package/dsh-mp-automator)：走 `vince-mp` CLI 的小程序自动化测试插件
  （构建新鲜度门、选择器重解析、几何断言），偏「测」。本插件走 IDE 官方内部 MCP，偏「用 IDE 干活」。两者可同时安装。

## 许可证

[MIT](https://github.com/lhc0229/dsh-wechatide-mcp/blob/main/LICENSE) © dsh-wechatide-mcp contributors

变更记录见 [CHANGELOG.md](https://github.com/lhc0229/dsh-wechatide-mcp/blob/main/CHANGELOG.md)。
