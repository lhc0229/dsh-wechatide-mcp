/**
 * 针对一次性小程序的端到端检查。
 *
 *   node --import ./test/support/register.mjs scripts/e2e.mjs [/tmp/dsh-wechatide-demo]
 *
 * 它打开项目窗口、等待页面、截图、读取运行时上下文和 console，然后关闭窗口。
 * 请使用临时项目（插件自带的 /tmp 示例）——绝不要用你在意的仓库，
 * 因为打开窗口会让 IDE 编译它。
 */
import { apply } from '../lib/index.js';

const project = process.argv[2] ?? '/tmp/dsh-wechatide-demo';
const definitions = new Map();

const ctx = {
  logger: { info() {}, warn: (m) => console.log(`[warn] ${m}`), debug() {} },
  effect: (run) => {
    run();
    return () => {};
  },
  tools: { register: (definition) => definitions.set(definition.name, definition) },
  get: () => undefined,
  inject: () => {},
};

apply(ctx, { exposeSkill: false });
const EXEC = { agent: { session: { header: { cwd: project } } } };

const run = async (name, args) => {
  console.log(`\n### ${name} ${JSON.stringify(args)}`);
  try {
    const value = await definitions.get(name).execute(args, EXEC);
    console.log(value.summary);
    return value;
  } catch (error) {
    console.log(`[threw] ${error.message}`);
    return undefined;
  }
};

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

try {
  await run('wechatide_call', { tool: 'open_project_window' });
  await wait(6000);
  await run('wechatide_call', { tool: 'simulator_refresh' });
  await wait(4000);
  await run('wechatide_screenshot', { waitForSelector: '.tap-btn' });
  await run('wechatide_call', { tool: 'automation_runtime_info', args: '{"action":"currentPage"}' });
  await run('wechatide_logs', { mode: 'all' });
  await run('wechatide_call', {
    tool: 'automation_element_action',
    args: '{"action":"tap","selector":".tap-btn"}',
  });
  await wait(1200);
  await run('wechatide_screenshot', {});
} finally {
  await run('wechatide_call', { tool: 'close_project_window' });
}
process.exit(0);
