/**
 * 仅测试用的模块解析垫片。
 *
 * `lib/index.js` 会静态导入 dsh 宿主包（已发布插件必须如此）。这些包只存在于
 * DSH 安装内，因此测试运行会注册这个钩子：真实解析器找不到的说明符
 * 退回一个极小的行为替身。当真实包确实可解析时（在 DSH 内，或链接了宿主的
 * checkout 里），真实包胜出——垫片从不遮蔽它们。
 */
const stubs = {
  '@deepseek-ai/dsh-tools': new URL('./stubs/dsh-tools.mjs', import.meta.url).href,
  '@deepseek-ai/schemastery': new URL('./stubs/schemastery.mjs', import.meta.url).href,
  '@deepseek-ai/dsh-attachment': new URL('./stubs/dsh-attachment.mjs', import.meta.url).href,
};

export async function resolve(specifier, context, next) {
  try {
    return await next(specifier, context);
  } catch (error) {
    const stub = stubs[specifier];
    if (stub !== undefined) return { url: stub, shortCircuit: true };
    throw error;
  }
}
