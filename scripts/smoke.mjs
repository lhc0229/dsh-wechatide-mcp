/**
 * 实机冒烟测试：通过插件驱动真实的微信开发者工具。
 *
 *   node --import ./test/support/register.mjs scripts/smoke.mjs
 *
 * 这里的一切都是只读的（状态、工具注册表、项目列表、运行时信息、日志缓冲区）。
 * 它绝不打开项目窗口、上传或写云数据——那些是由用户在对话里决定的事。
 */
import { apply } from '../lib/index.js';

const definitions = new Map();
const providers = [];
const logger = {
  info: (message) => console.log(`[info] ${message}`),
  warn: (message) => console.log(`[warn] ${message}`),
  debug: () => {},
};

const ctx = {
  logger,
  effect: (run) => {
    run();
    return () => {};
  },
  tools: {
    register: (definition) => {
      definitions.set(definition.name, definition);
      return { dispose() {} };
    },
  },
  get: () => undefined,
  inject: (deps, callback) => {
    if (deps.includes('skills')) {
      callback({ skills: { registerProvider: (factory) => providers.push(factory()) } });
    }
  },
};

apply(ctx, {});

// 小程序项目路径：第一个命令行参数，缺省用当前工作目录
const EXEC = { agent: { session: { header: { cwd: process.argv[2] ?? process.cwd() } } } };

const run = async (name, args = {}) => {
  const definition = definitions.get(name);
  if (!definition) throw new Error(`tool ${name} not registered`);
  console.log(`\n=== ${name} ${JSON.stringify(args)}`);
  try {
    const value = await definition.execute(args, EXEC);
    console.log(value.summary);
    return value;
  } catch (error) {
    console.log(`[threw] ${error.message}`);
    return undefined;
  }
};

console.log(`registered: ${[...definitions.keys()].join(', ')}`);

const skill = providers[0];
if (skill) {
  const listed = await skill.list();
  const loaded = await skill.get(listed[0]);
  console.log(`skill: ${listed[0]?.name} (${loaded?.content?.length ?? 0} bytes)`);
}

await run('wechatide_status');
await run('wechatide_tools', { query: 'simulator' });
await run('wechatide_tools', { query: 'automation_runtime_info', full: true });
await run('wechatide_connect', { waitSeconds: 3 });
await run('wechatide_call', { tool: 'project_list' });
await run('wechatide_call', { tool: 'check_wechatide_status' });
await run('wechatide_call', { tool: 'automation_runtime_info', args: '{"action":"currentPage"}' });
await run('wechatide_logs', { mode: 'errors' });

process.exit(0);
