import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import {
  McpAuthorizationPending,
  McpRpcError,
  McpUnavailable,
  WechatideBridge,
  describeBridgeFailure,
} from '../lib/bridge.js';

const INIT_RESULT = {
  protocolVersion: '2025-06-18',
  capabilities: { tools: { listChanged: true } },
  serverInfo: { name: 'mcp-server', version: '0.1.0' },
};

class FakeStdin {
  constructor(onLine) {
    this.writable = true;
    this.onLine = onLine;
  }

  write(line) {
    if (!this.writable) throw new Error('write after end');
    this.onLine(line);
  }

  end() {
    this.writable = false;
  }

  on() {
    return this;
  }
}

/**
 * 假的 `wechatide mcp` 子进程：换行分隔的 JSON 进，换行分隔的 JSON 出。
 * `handler(message)` 返回 `{ result }`、`{ error }`、`undefined`（不应答 →
 * 请求超时）或 `{ exit: true }`。
 */
function makeChild(handler) {
  const child = new EventEmitter();
  child.exitCode = null;
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = new FakeStdin((line) => {
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    if (message.id === undefined) return; // 通知消息
    setImmediate(() => {
      const action = handler(message);
      if (action === undefined) return;
      if (action.exit === true) {
        child.exitCode = 1;
        child.stderr.emit('data', '[wechatide] Connected to WechatIDE on port 11782\n');
        child.emit('exit', 1, null);
        return;
      }
      child.stdout.emit('data', `${JSON.stringify({ jsonrpc: '2.0', id: message.id, ...action })}\n`);
    });
  });
  child.kill = () => {
    child.exitCode = 0;
    child.emit('exit', 0, null);
  };
  return child;
}

function bridgeWith(handler, options = {}) {
  let child;
  const bridge = new WechatideBridge({
    bin: '/fake/wechatide',
    clientName: 'DSH',
    timeoutMs: 2000,
    spawn: () => {
      child = makeChild(handler);
      return child;
    },
    ...options,
  });
  return { bridge, child: () => child };
}

const standardHandler = (message) => {
  if (message.method === 'initialize') return { result: INIT_RESULT };
  if (message.method === 'tools/list') {
    return { result: { tools: [{ name: 'check_wechatide_status', inputSchema: { type: 'object', properties: {} } }] } };
  }
  if (message.method === 'tools/call') {
    return { result: { content: [{ type: 'text', text: '{"success":true}' }], structuredContent: { success: true } } };
  }
  return { error: { code: -32601, message: `unknown method ${message.method}` } };
};

test('handshake exposes server identity, caches tools and calls them', async (t) => {
  const { bridge } = bridgeWith(standardHandler);
  t.after(() => bridge.close());

  const connection = await bridge.connect();
  assert.equal(connection.protocolVersion, '2025-06-18');
  assert.equal(bridge.serverLabel, 'mcp-server 0.1.0');
  assert.equal(bridge.ready, true);

  const tools = await bridge.listTools();
  assert.equal(tools.length, 1);
  assert.equal((await bridge.findTool('check_wechatide_status')).name, 'check_wechatide_status');
  assert.equal(await bridge.findTool('nope'), undefined);

  const result = await bridge.callTool('check_wechatide_status', {});
  assert.deepEqual(result.structuredContent, { success: true });
});

test('a pending authorization becomes a typed, actionable failure', async (t) => {
  const { bridge } = bridgeWith((message) => {
    if (message.method === 'initialize') return { error: { code: -32603, message: 'Client authorization pending' } };
    return { result: {} };
  });
  t.after(() => bridge.close());

  await assert.rejects(() => bridge.connect(), (error) => {
    assert.ok(error instanceof McpAuthorizationPending);
    assert.equal(error.code, 'MCP_AUTHORIZATION_PENDING');
    return true;
  });

  const described = describeBridgeFailure(new McpAuthorizationPending('Client authorization pending'));
  assert.equal(described.kind, 'authorization');
  assert.match(described.remedy, /wechatide_connect/);
});

test('requests are serialized: the second starts only after the first settles', async (t) => {
  const order = [];
  const { bridge } = bridgeWith((message) => {
    if (message.method === 'initialize') return { result: INIT_RESULT };
    if (message.method === 'tools/call') {
      order.push(`start:${message.params.arguments.n}`);
      const started = Date.now();
      while (Date.now() - started < 8) {
        /* 撑住发送与应答之间的间隙，若并行派发就会交错 */
      }
      order.push(`end:${message.params.arguments.n}`);
      return { result: { content: [] } };
    }
    return { result: { tools: [] } };
  });
  t.after(() => bridge.close());
  await bridge.connect();

  await Promise.all([
    bridge.callTool('t', { n: 1 }),
    bridge.callTool('t', { n: 2 }),
  ]);
  assert.deepEqual(order, ['start:1', 'end:1', 'start:2', 'end:2']);
});

test('non-JSON stdout noise is skipped instead of corrupting the session', async (t) => {
  const { bridge, child } = bridgeWith(standardHandler);
  t.after(() => bridge.close());
  await bridge.connect();
  const fake = child();
  fake.stdout.emit('data', '[wechatide] UserData: /Users/x/Default\n');

  const tools = await bridge.listTools();
  assert.equal(tools.length, 1);
  assert.equal(bridge.skippedLines, 1);
});

test('an unanswered request times out with a typed error', async (t) => {
  const { bridge } = bridgeWith((message) => (message.method === 'initialize' ? { result: INIT_RESULT } : undefined));
  t.after(() => bridge.close());
  await bridge.connect();

  await assert.rejects(() => bridge.callTool('simulator_screenshot', {}, { timeoutMs: 60 }), (error) => {
    assert.ok(error instanceof McpRpcError);
    assert.equal(error.rpcCode, 'TIMEOUT');
    assert.match(error.message, /超时/);
    return true;
  });
});

test('a child that dies mid-request surfaces as unavailable with its stderr', async (t) => {
  const { bridge } = bridgeWith((message) => (message.method === 'initialize' ? { result: INIT_RESULT } : { exit: true }));
  t.after(() => bridge.close());
  await bridge.connect();

  await assert.rejects(() => bridge.callTool('upload', {}), (error) => {
    assert.ok(error instanceof McpUnavailable);
    assert.match(error.message, /MCP 桥已退出/);
    assert.match(error.message, /port 11782/);
    return true;
  });
  assert.equal(bridge.ready, false);
});

test('an aborted request rejects without leaking a pending entry', async (t) => {
  const { bridge } = bridgeWith((message) => (message.method === 'initialize' ? { result: INIT_RESULT } : undefined));
  t.after(() => bridge.close());
  await bridge.connect();

  const controller = new AbortController();
  const pending = bridge.callTool('slow', {}, { signal: controller.signal, timeoutMs: 5000 });
  controller.abort();
  await assert.rejects(pending, (error) => error.name === 'AbortError');
  assert.equal(bridge.pending.size, 0);
});
