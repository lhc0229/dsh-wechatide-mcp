/** @deepseek-ai/dsh-tools 的行为替身（仅测试用）。 */
export function defineTool(definition) {
  return definition;
}

export class ToolRegistry {
  constructor() {
    this.tools = new Map();
  }

  register(definition) {
    this.tools.set(definition.name, definition);
    return { dispose: () => this.tools.delete(definition.name) };
  }
}

export default { defineTool };
