---
name: wechatide-mcp
description: >-
  用 wechatide_* 工具驱动机器上已安装的微信开发者工具（IDE 内部 MCP）：打开/导入小程序项目、编译与刷新、
  预览二维码与体验版上传、模拟器截图、console/network 取证、页面自动化（点击/输入/导航/求值）、云开发读写。
  当任务明确发生在微信小程序/小游戏项目里，或用户提到微信开发者工具、模拟器、预览/上传、真机调试、
  云函数/云数据库时加载。
whenToUse: >-
  用户要在本机小程序项目里执行 IDE 侧动作（开窗、编译、预览、上传、截图、看日志、点页面、查云端），
  或 wechatide_* 调用报错需要判断下一步时。
---

# 微信开发者工具 MCP：判断力部分

`wechatide_*` 六个工具负责把 IDE 的内部 MCP 接进来，机械规则（授权、超时、截断、图像预算）插件已经做掉。
这里只写它做不掉的部分：**该开哪个窗、按什么顺序做、失败时先怀疑什么**。

底层事实：IDE 把整套自动化能力暴露成 MCP 服务（`wechatide mcp`，stdio JSON-RPC），
**工具清单随 IDE 版本变化**。所以永远不要凭记忆写工具名——先 `wechatide_tools`，再 `wechatide_tools(full=true)` 看参数。

## 节奏：status → 具体动作 → 取证

1. **status**：会话里第一次动手前跑 `wechatide_status`。它一次性回答：CLI 在不在、IDE 起没起（端口）、
   登录态、本客户端有没有授权、IDE 暴露了多少工具。正常就直接往下走。
2. **act**：`wechatide_call(tool=..., args='{...}')`。一次一个动作。
3. **verify**：动作后的验证读——`wechatide_logs`（console/network）、`wechatide_screenshot`、
   `wechatide_call(tool="automation_runtime_info", args='{"action":"currentPage"}')`。
   没有验证读的动作不叫测试步骤，只能叫"希望它成功了"。

## 授权与端口

- `wechatide_status` 说 `Client authorization pending` 或 `mcp: 不可用` → 跑 `wechatide_connect`。
  它会拉起 IDE（没启动时）、触发授权弹窗、轮询任务，最后自己连一遍 MCP 验证。
- 弹窗要点「允许」。`wechatide_connect` 返回 `授权仍未完成（taskId …）` 就是还没点：
  **提醒用户去点**，然后重跑 `wechatide_connect`，不要连着空转。
- IDE 重启、升级、或换了客户端名（config.clientName）后需要重新 `wechatide_connect`；这是授权粒度，不是 bug。
- 别用 bash 直接调 `wechatide` 绕过插件：沙箱里跑不通，而且拿到的 JSON 没有错误映射。

## 常用路径（工具名以 `wechatide_tools` 的实际输出为准）

| 目标 | 调用 |
|---|---|
| 打开项目窗口（含模拟器） | `wechatide_call(tool="open_project_window")` — `project` 默认用会话 cwd |
| 只导入到项目列表、不开窗 | `wechatide_call(tool="project_import")` |
| 列出已导入项目 | `wechatide_call(tool="project_list")` |
| 重新编译/刷新当前页 | `wechatide_call(tool="simulator_refresh")` |
| 编译并打开某页 | `wechatide_call(tool="simulator_open_page", args='{"page":"pages/home/index"}')` |
| 构建 npm | `wechatide_call(tool="build_npm")` |
| 预览二维码 | `wechatide_call(tool="create_preview_qrcode")`；推手机用 `auto_preview` |
| 上传体验版 | `wechatide_call(tool="upload", args='{"upload-version":"1.0.0","upload-desc":"…"}')` |
| 截图（自动对齐机型尺寸） | `wechatide_screenshot(waitForSelector=".list")` |
| 截图（要 IDE 原始长边 1300） | `wechatide_screenshot(matchDevice=false)` |
| console / network | `wechatide_logs(source="console")` / `wechatide_logs(source="network", mode="all")` |
| 点元素/输入 | `wechatide_call(tool="automation_element_action", args='{"action":"tap","selector":".submit"}')` |
| 导航 | `wechatide_call(tool="automation_navigate", args='{"action":"navigateTo","url":"/pages/home/index"}')` |
| 页面/系统信息 | `wechatide_call(tool="automation_runtime_info", args='{"action":"currentPage"}')`（action 只有 `pageStack`/`currentPage`/`systemInfo`） |
| 运行时求值 | `wechatide_call(tool="automation_evaluate", args='{"fnSource":"function(){return getApp().globalData}"}')` |
| 云环境/云函数 | `wechatide_call(tool="cloud_env_list")` → `cloud_fn_list` → `cloud_fn_info` |

`project` 参数默认由插件填会话 cwd；跨项目操作时才显式传绝对路径。
动作参数先查：`wechatide_tools(query="automation_element_action", full=true)`——枚举值就写在那里。

## 异步任务（pending + taskId）

上传、删除、云写这类要用户在 IDE 里确认的操作会返回 `pending` + `taskId`：

- **不要**重发原操作，也不要循环轮询。告诉用户「去开发者工具里确认」，把 taskId 记下来。
- 用户说"好了/继续"时，先用 `wechatide_call(tool="polling_task_result", args='{"taskId":"…"}')` 查旧任务。
- 只有登录（`login`）是例外：可以主动轮询，因为扫码是用户明确在等的动作。

## 失败快表

| 现象 | 先怀疑 | 处理 |
|---|---|---|
| `project window not found, open the project first` | 项目窗口没开 | `open_project_window` 后重试原动作；不要反复截图 |
| `Cannot read properties of undefined (reading 'winId')` | 模拟器窗口不可用/未编译 | `open_project_window` 或 `simulator_refresh` 后重试 |
| `PROJECT_PATH_NOT_FOUND` | `project` 不是小程序根目录 | 用含 `project.config.json` 的绝对路径 |
| `APPID_ERROR：登录用户不是该小程序的开发者` / `不存在此 AppID` | 项目 appid 无效或不属于本账号 | 换成本账号的正式 AppID 或测试号 AppID；这不是代码问题 |
| `MCP error -32602 … Invalid arguments` | 参数/枚举值不对 | `wechatide_tools(query="<工具>", full=true)` 对着改 |
| 工具名不存在 | IDE 版本差异 | `wechatide_tools()` 全量看一遍，用 `query` 缩小 |
| 登录态过期 | IDE 需要重新扫码 | `wechatide_connect`；必要时 `wechatide_call(tool="login")` 然后 `polling_task_result` |

## 边界

- **上传/发布、云写入、删除**是不可逆外发动作：只在用户明确要求时执行，并把 taskId / 结果原样回报。
- 截图只有在路由接受图像输入时才会真正进入上下文；插件会明确告诉你"图像已附加"还是"文件在磁盘上但不在你的上下文"。
- 截图默认先读 `automation_runtime_info(systemInfo)` 拿机型宽高，再把像素归一化到该尺寸（iPhone X 375×812、iPhone 12/13 Pro 390×844），
  所以**输出尺寸本身就是机型尺寸**，不必再让用户后处理。机型只能用 IDE 模拟器下拉切换，IDE 没有暴露选择机型的工具。
  纯文本路由下，用 `wechatide_logs` 和 `automation_runtime_info` 做可断言的验证。
- 一次会话只用一个 IDE 桥：动作会串行执行。批量操作写成顺序步骤，别并发发。
