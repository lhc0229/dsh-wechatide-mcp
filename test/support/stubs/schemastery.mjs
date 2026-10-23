/**
 * @deepseek-ai/schemastery 的行为替身（仅测试用）。
 *
 * 只实现 Config 用到的构建器表面：`z.object`、`z.string/number/boolean`
 * 以及链式 `.default()`。测试给 `apply` 传的是普通配置对象，
 * 所以 schema 只需存在，无需校验。
 */
const chainable = (type) => {
  const node = {
    type,
    value: undefined,
    default(value) {
      node.value = value;
      return node;
    },
    description() {
      return node;
    },
    required() {
      return node;
    },
    toString() {
      return `${type}=${JSON.stringify(node.value)}`;
    },
  };
  return node;
};

const z = {
  string: () => chainable('string'),
  number: () => chainable('number'),
  integer: () => chainable('integer'),
  boolean: () => chainable('boolean'),
  object: (spec) => ({ kind: 'object', spec }),
  union: (list) => chainable(`union(${list.join('|')})`),
};

export default z;
export { z };
