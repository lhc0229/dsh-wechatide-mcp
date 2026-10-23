import assert from 'node:assert/strict';
import test from 'node:test';
import { apply } from '../lib/index.js';

const TOOLS = [
  {
    name: 'open_project_window',
    description: '打开包含模拟器的项目窗口',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, windowMode: { type: 'string', enum: ['liteMode', 'fullMode'] } },
      required: ['project'],
    },
  },
  {
    name: 'automation_navigate',
    description: '页面导航',
    inputSchema: {
      type: 'object',
      properties: { project: { type: 'string' }, action: { type: 'string', enum: ['navigateTo', 'navigateBack'] }, url: { type: 'string' } },
      required: ['project', 'action'],
    },
  },
  {
    name: 'get_simulator_console',
    description: 'console 缓冲区 grep',
    inputSchema: { type: 'object', properties: { project: { type: 'string' }, command: { type: 'string' } }, required: ['project', 'command'] },
  },
  {
    name: 'simulator_screenshot',
    description: '截图',
    inputSchema: { type: 'object', properties: { project: { type: 'string' } }, required: ['project'] },
  },
];

function makeCtx() {
  const definitions = new Map();
  const ctx = {
    logger: { info() {}, warn() {}, debug() {} },
    effect(run) {
      run();
      return () => {};
    },
    tools: {
      register(definition) {
        definitions.set(definition.name, definition);
        return { dispose() {} };
      },
    },
    get() {
      return undefined;
    },
    inject() {},
  };
  return { ctx, definitions };
}

function makeBridge({ calls = [], respond } = {}) {
  return {
    serverLabel: 'mcp-server 0.1.0',
    async connect() {
      return { protocolVersion: '2025-06-18', serverInfo: { name: 'mcp-server', version: '0.1.0' } };
    },
    async listTools() {
      return TOOLS;
    },
    async findTool(name) {
      return TOOLS.find((tool) => tool.name === name);
    },
    async callTool(name, args) {
      calls.push({ name, args });
      if (respond !== undefined) return respond(name, args);
      return { content: [], structuredContent: { success: true, echo: name } };
    },
    close() {},
  };
}

const EXEC = { agent: { session: { header: { cwd: '/tmp/proj' } } } };

function setup(options = {}) {
  const { ctx, definitions } = makeCtx();
  const calls = [];
  const bridge = makeBridge({ calls, respond: options.respond });
  apply(ctx, {
    exposeSkill: false,
    maxResultBytes: 6000,
    _bridgeFactory: () => bridge,
    ...options.config,
  });
  const run = async (tool, args = {}) => {
    const definition = definitions.get(tool);
    assert.ok(definition, `${tool} should be registered`);
    return definition.execute(args, EXEC);
  };
  return { definitions, run, calls, bridge };
}

test('registers exactly the six wechatide tools', () => {
  const { definitions } = setup();
  assert.deepEqual([...definitions.keys()].sort(), [
    'wechatide_call',
    'wechatide_connect',
    'wechatide_logs',
    'wechatide_screenshot',
    'wechatide_status',
    'wechatide_tools',
  ]);
  for (const [name, definition] of definitions) {
    assert.equal(typeof definition.description, 'string');
    assert.ok(definition.description.length > 40, `${name} needs a usable description`);
  }
});

test('wechatide_tools lists the live registry', async () => {
  const { run } = setup();
  const result = await run('wechatide_tools');
  assert.match(result.summary, /4 个 wechatide MCP 工具/);
  assert.match(result.summary, /open_project_window/);
});

test('wechatide_call fills project from the session cwd', async () => {
  const { run, calls } = setup();
  const result = await run('wechatide_call', { tool: 'open_project_window' });
  assert.equal(calls[0].args.project, '/tmp/proj');
  assert.match(result.summary, /open_project_window → ok/);
});

test('wechatide_call honours an explicit project and parsed args', async () => {
  const { run, calls } = setup();
  await run('wechatide_call', {
    tool: 'automation_navigate',
    project: '/tmp/other',
    args: '{"action":"navigateTo","url":"/pages/home/index"}',
  });
  assert.deepEqual(calls[0].args, { action: 'navigateTo', url: '/pages/home/index', project: '/tmp/other' });
});

test('wechatide_call rejects an unknown tool with close names', async () => {
  const { run } = setup();
  await assert.rejects(() => run('wechatide_call', { tool: 'simulator_screensho' }), (error) => {
    assert.match(error.message, /未知工具 "simulator_screensho"/);
    return true;
  });
});

test('wechatide_call names the missing required arguments instead of guessing', async () => {
  const { run } = setup();
  await assert.rejects(() => run('wechatide_call', { tool: 'automation_navigate' }), (error) => {
    assert.match(error.message, /缺少必填参数：action/);
    assert.match(error.message, /wechatide_tools\(query="automation_navigate", full=true\)/);
    return true;
  });
});

test('wechatide_call maps a business failure to a conclusion plus remedy', async () => {
  const { run } = setup({
    respond: () => ({ content: [], structuredContent: { success: false, error: 'project window not found, open the project first' } }),
  });
  const result = await run('wechatide_call', { tool: 'simulator_screenshot' });
  assert.match(result.summary, /simulator_screenshot → 失败/);
  assert.match(result.summary, /remedy: .*open_project_window/);
});

test('wechatide_logs builds the grep command instead of asking the model to', async () => {
  const { run, calls } = setup();
  const errors = await run('wechatide_logs', {});
  assert.equal(calls.at(-1).name, 'get_simulator_console');
  assert.match(calls.at(-1).args.command, /^grep -n -i -E "error/);
  assert.match(errors.summary, /command: grep -n -i -E "error/);

  await run('wechatide_logs', { source: 'network', mode: 'all' });
  assert.equal(calls.at(-1).name, 'get_simulator_network');
  assert.equal(calls.at(-1).args.command, 'grep -n .');

  await run('wechatide_logs', { mode: 'pattern', pattern: 'status|401' });
  assert.match(calls.at(-1).args.command, /^grep -n -i -E "status\|401"$/);

  await assert.rejects(() => run('wechatide_logs', { mode: 'pattern' }), /需要 pattern/);
});

test('wechatide_screenshot reports the path and states honestly that no pixels arrived', async () => {
  const { run, calls } = setup({
    respond: () => ({
      content: [],
      structuredContent: { success: true, path: '/tmp/dsh-shot.jpg', imageWidth: 750, imageHeight: 1334 },
    }),
  });
  const result = await run('wechatide_screenshot', { waitForSelector: '.list' });
  assert.equal(calls[0].name, 'simulator_screenshot');
  assert.equal(calls[0].args.waitForSelector, '.list');
  assert.equal(calls[0].args.optimize, true);
  assert.match(result.summary, /simulator_screenshot → ok/);
  assert.match(result.summary, /\/tmp\/dsh-shot\.jpg/);
  assert.match(result.summary, /no attachment service mounted/);
  assert.equal(result.image, undefined);
});

test('wechatide_connect fails loudly when the CLI cannot run', async () => {
  const { run } = setup({ config: { binPath: '/bin/false' } });
  await assert.rejects(() => run('wechatide_connect', {}), (error) => {
    assert.match(String(error.message), /false|wechatide/i);
    return true;
  });
});

test('wechatide_status still answers when the bridge is unreachable', async () => {
  const { ctx, definitions } = makeCtx();
  apply(ctx, {
    exposeSkill: false,
    _bridgeFactory: () => ({
      serverLabel: 'unknown',
      async connect() {
        const error = new Error('Client authorization pending');
        error.name = 'McpAuthorizationPending';
        throw error;
      },
      async listTools() {
        return [];
      },
      close() {},
    }),
  });
  const result = await definitions.get('wechatide_status').execute({ probe: true }, EXEC);
  assert.match(result.summary, /mcp: 不可用/);
  assert.match(result.summary, /next: .*wechatide_connect/);
});
