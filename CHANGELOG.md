# Changelog

## 0.2.0

截图尺寸对齐机型：

- `wechatide_screenshot` 默认先调用 `automation_runtime_info(action=systemInfo)`
  读模拟器当前机型的逻辑宽高，再把 IDE 输出的截图（长边钳在 1280/1300、
  宽度按机型比例反推）重采样成机型尺寸：iPhone X → 375×812，iPhone 12/13 Pro → 390×844。
  归一化是「等比缩放到机型宽度 + 底部补/裁 ≤3px」，不拉伸画面。
- 新参数 `matchDevice` 与新配置 `matchDevice`（默认 `true`）：
  置 `false` 时保留 IDE 原始尺寸，行为与 0.1.x 一致。
- 归一化需要无损输入，因此开启时强制 `optimize=false`（PNG），
  输出与 IDE 原图分开落盘（IDE 原图保留，便于对照）。
- 新增 `lib/image.js`：零依赖 PNG 编解码（8 bit，颜色类型 0/2/4/6，非隔行）
  + Lanczos3 缩放 + 机型尺寸对齐 + systemInfo 解析；`package.json` 增加 `./image` 导出。
- 降级路径明确：机型探测失败 → 保持 IDE 尺寸并说明原因；
  截图比例与机型差超 3%（例如带工具条的长图）→ 保留等比结果并如实报告；
  PNG 解码失败 → 回退到 IDE 原图。
- 测试：新增 `test/image.test.js`，并在 `test/index.test.js` 覆盖
  探测→截图→归一化的调用顺序、`matchDevice=false`、解码失败降级。
- 文档：README 新增「前提：小程序 AppID 必须有效」——正式 AppID 与本账号测试号 AppID
  都可用，空值 / 游客模式 / 他人 AppID 会让截图、自动化、预览、上传全部失败。

## 0.1.1

跨平台修正（Windows）：

- 子进程启动统一走 `spawnTarget()`：`.cmd`/`.bat` 启动器用
  `cmd.exe /d /s /c ""<bin>" "<arg>""` 包装——Node 在 `shell:false` 下已禁止直接
  spawn `.cmd`，旧实现会在 Windows 上直接 EINVAL。桥接与 CLI 调用两处都改了。
- `runCliJson` 由 `execFile` 改为 `spawn` + 自行收流：超时、取消、输出上限三平台一致。
- Windows 安装路径探测扩展到 `Program Files (x86)` / `Program Files` /
  `LOCALAPPDATA\Programs`，并同时探 `wechatide.cmd`、`wechatide.exe`、`cli.bat`。
- Windows UserData 支持多一层的 `…\微信开发者工具\User Data\<hash>\Default\`。
- `wechatide_logs` 的 grep 模式改用双引号（POSIX shell 与 cmd 都认），并压平换行
  以防模式里夹带第二条命令。

发布准备：

- 全部代码注释统一为中文。
- 打包控制改用 `.npmignore`（移除 `package.json` 的 `files` 白名单）；
  补 `repository` / `homepage` / `bugs` 元数据。
- `peerDependencies` 对齐公共 registry 上实际存在的版本：`dsh-tools` 与
  `dsh-attachment` 由 `>=0.1.0` 改为 `>=0.1.0-rc.5`（这两个包目前只发布过
  `0.x` 预发布，`>=0.1.0` 匹配不到任何版本）。
- `scripts/smoke.mjs` 去掉硬编码的个人项目路径，改为命令行参数 / 当前工作目录。
- README 按 npm 包规范重写：徽章、环境要求、三种安装方式、工具与配置表、编程接口、许可证。
- `npm run smoke` 补上 `--import test/support/register.mjs`，无 DSH 的机器也能跑。

## 0.1.0

首个版本：把微信开发者工具的内部 MCP 接成 DSH 工具。

- **传输**：`wechatide mcp`（IDE 自己在 `mcp.json` 里公布的 stdio JSON-RPC 服务），
  自研轻量 MCP 客户端：换行分隔 JSON、非 JSON banner 退化、请求串行化、超时/取消、
  子进程退出即分类上报。
- **授权**：`wechatide_connect` 复刻 IDE 的授权链（`check_wechatide_status` 触发
  `auth` 任务 → 轮询 `polling_task_result` → 再用 MCP 通道验证），授权按 clientName 记账。
- **工具面**：6 个固定工具（status / connect / tools / call / screenshot / logs），
  47 个 IDE 工具通过 `wechatide_call` + 运行时 `wechatide_tools` 发现，prompt 前缀稳定。
- **渲染**：`structuredContent` 优先、`success:false` 识别为失败、`-32602` 校验报告
  压成「字段：原因」、常见 IDE 失败附下一步动作、结果按字节截断（默认 6KB）。
- **截图**：模拟器截图按路由能力附加真实图像（每会话预算 + 去重），纯文本路由明确
  告知「文件在磁盘上但不在上下文里」。
- **项目参数**：工具声明 `project` 必填时自动填会话 cwd，跨项目才需要显式路径。
- **内置 skill**：`skills/wechatide-mcp/SKILL.md`（路由表、异步任务规则、失败快表）。
- **测试**：33 个单测覆盖桥接协议、路径发现、渲染与工具装配；`scripts/smoke.mjs`
  与 `scripts/e2e.mjs` 提供真机只读/端到端联调。
