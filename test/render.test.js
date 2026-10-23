import assert from 'node:assert/strict';
import test from 'node:test';
import {
  clamp,
  formatMs,
  normalizeCallResult,
  oneLine,
  renderCall,
  renderToolList,
  toolFamily,
  toolSignature,
} from '../lib/render.js';

const TOOLS = [
  {
    name: 'open_project_window',
    description: '打开包含模拟器的项目窗口',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, windowMode: { type: 'string', enum: ['liteMode', 'fullMode'] } }, required: ['project'] },
  },
  {
    name: 'automation_runtime_info',
    description: '读取当前小程序运行时信息',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, action: { type: 'string', enum: ['pageStack', 'currentPage', 'systemInfo'] } }, required: ['project', 'action'] },
  },
  {
    name: 'get_simulator_console',
    description: '对小程序 console 缓冲区执行 grep 过滤',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, command: { type: 'string' } }, required: ['project', 'command'] },
  },
];

test('clamp keeps short text intact and marks truncation', () => {
  assert.equal(clamp('short', 100), 'short');
  const long = clamp('x'.repeat(500), 200);
  assert.ok(Buffer.byteLength(long) <= 240);
  assert.match(long, /truncated/);
});

test('normalizeCallResult prefers structuredContent and treats success:false as failure', () => {
  const ok = normalizeCallResult({
    content: [{ type: 'text', text: '{"success":true,"path":"/tmp/a.jpg"}' }],
    structuredContent: { success: true, path: '/tmp/a.jpg' },
  });
  assert.equal(ok.ok, true);
  assert.equal(ok.data.path, '/tmp/a.jpg');

  const failed = normalizeCallResult({ content: [], structuredContent: { success: false, error: 'project window not found' } });
  assert.equal(failed.ok, false);

  const noStructured = normalizeCallResult({ content: [{ type: 'text', text: '{"success":true,"n":1}' }] });
  assert.deepEqual(noStructured.data, { success: true, n: 1 });
});

test('renderCall reports the IDE business failure plus the one fix', () => {
  const text = renderCall('simulator_screenshot', {
    content: [{ type: 'text', text: '{"success":false,"error":"project window not found, open the project first"}' }],
    structuredContent: { success: false, error: 'project window not found, open the project first' },
  }, { elapsedMs: 2129 });

  assert.match(text, /^simulator_screenshot → 失败 \(2\.1s\)/);
  assert.match(text, /project window not found/);
  assert.match(text, /remedy: 项目窗口还没打开/);
});

test('renderCall condenses a schema validation report into field/message pairs', () => {
  const validation = [
    'MCP error -32602: Input validation error: Invalid arguments for tool automation_runtime_info: [',
    '  {',
    '    "code": "invalid_value",',
    '    "values": ["pageStack", "currentPage", "systemInfo"],',
    '    "path": ["action"],',
    '    "message": "Invalid option: expected one of \\"pageStack\\"|\\"currentPage\\"|\\"systemInfo\\""',
    '  }',
    ']',
  ].join('\n');
  const text = renderCall('automation_runtime_info', { content: [{ type: 'text', text: validation }], isError: true });
  assert.match(text, /参数被拒绝/);
  assert.match(text, /action: Invalid option/);
  assert.match(text, /wechatide_tools\(query="<工具名>", full=true\)/);
});

test('renderCall pretty-prints a successful payload', () => {
  const text = renderCall('check_wechatide_status', {
    content: [],
    structuredContent: { success: true, loginExpired: false, loginUser: { nickName: 'ada' } },
  });
  assert.match(text, /^check_wechatide_status → ok/);
  assert.match(text, /"nickName": "ada"/);
});

test('toolSignature marks required arguments', () => {
  assert.equal(
    toolSignature(TOOLS[1]),
    'automation_runtime_info(project*, action*)',
  );
  assert.equal(toolSignature({ name: 'quit', inputSchema: { type: 'object', properties: {} } }), 'quit()');
});

test('renderToolList groups by family, filters by query and expands schemas', () => {
  const grouped = renderToolList(TOOLS);
  assert.match(grouped, /3 个 wechatide MCP 工具/);
  assert.match(grouped, /simulator 模拟器: get_simulator_console/);
  assert.match(grouped, /wechatide_tools\(query=/);

  const filtered = renderToolList(TOOLS, { query: 'console' });
  assert.match(filtered, /匹配 "console"：1/);
  assert.match(filtered, /get_simulator_console\(project\*, command\*\)/);

  const full = renderToolList(TOOLS, { query: 'runtime', full: true });
  assert.match(full, /## automation_runtime_info/);
  assert.match(full, /action \(string, required, enum=pageStack\|currentPage\|systemInfo\)/);

  assert.match(renderToolList(TOOLS, { query: 'zzz' }), /没有匹配的工具/);
  assert.match(renderToolList([], {}), /没有返回任何 MCP 工具/);
});

test('families and helpers stay honest', () => {
  assert.equal(toolFamily('cloud_db_write_doc'), 'cloud 云开发');
  assert.equal(toolFamily('mystery_tool'), 'other 其他');
  assert.equal(oneLine('  a\n\n b  '), 'a b');
  assert.equal(formatMs(628), '628ms');
  assert.equal(formatMs(2129), '2.1s');
});
