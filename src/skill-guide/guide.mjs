// The `skill-create` guide body.
//
// Kept as a line array joined at the end so Markdown code fences need no
// escaping inside a template literal, and so a custom override can replace the
// body without touching the plugin.

/** Skill name registered by this plugin, and the name used in the guide's title. */
export const GUIDE_SKILL_NAME = 'skill-create'

export const GUIDE_DESCRIPTION = '指导在当前项目创建、编写、审查和验证可复用的 Agent Skill。'

export const GUIDE_WHEN_TO_USE = '当用户要求创建或修改 Skill，或需要把一类重复任务沉淀为 SKILL.md 时使用。'

/**
 * Build the runtime skill contribution for one configuration.
 *
 * `provider` and `invocation` are deliberately omitted: the registry owns the
 * runtime provider label, and an omitted invocation keeps the skill both
 * model-invocable and user-invocable.
 *
 * @param custom - the user-authored override from settings.
 * @returns the registration accepted by `ctx.skills.register()`.
 */
export function guideRegistration(custom) {
  return {
    name: GUIDE_SKILL_NAME,
    description: GUIDE_DESCRIPTION,
    whenToUse: GUIDE_WHEN_TO_USE,
    source: 'runtime',
    content: resolveGuideContent(custom),
  }
}

/**
 * Resolve the guide body.
 *
 * @param custom - the user-authored override from settings.
 * @returns the override when non-empty, otherwise the built-in guide.
 */
export function resolveGuideContent(custom) {
  const override = typeof custom === 'string' ? custom.trim() : ''
  return override === '' ? guideContent() : override
}

/** @returns the built-in guide body. */
export function guideContent() {
  return [
    '# SkillCreate：编写高质量 Skill',
    '',
    '## 目标与边界',
    '',
    'Skill 是给 Agent 的可复用工作说明，不是产品代码，也不是把系统提示词重复一遍。先明确它解决的任务、触发条件、输入输出和完成标准；只写对该任务真正有帮助的约束。',
    '',
    '## 存放位置',
    '',
    '- 只服务当前项目的 Skill 放在项目根的 `.dsh/skills/<skill-name>/SKILL.md`；`.agents/skills/` 是等价的官方目录。项目根由当前 cwd 向上找到最近的 `.git` 决定。',
    '- 跨项目复用的 Skill 才放到用户级 `~/.dsh/skills/` 或 `~/.agents/skills/`。不要把一个项目的私有规则写进用户级目录。',
    '- `<skill-name>` 使用小写 kebab-case，例如 `api-review`；目录名和 frontmatter 的 `name` 保持一致。',
    '- 可选资源放在同一 Skill 目录下的 `references/`、`scripts/`、`assets/`；在正文中用相对路径引用。',
    '- 验证时至少从当前项目加载一次，再换到另一个项目确认看不到它。',
    '',
    '## 最小文件格式',
    '',
    '`SKILL.md` 必须以 YAML frontmatter 开始：',
    '',
    '```markdown',
    '---',
    'name: api-review',
    'description: Review API changes for compatibility, security, and test coverage.',
    'whenToUse: Use when reviewing a public API or endpoint change.',
    '---',
    '',
    '# API Review',
    '',
    '按下面的步骤执行……',
    '```',
    '',
    '`name` 必须是 kebab-case；`description` 和 `whenToUse` 要说明能力和适用场景，而不是只写「帮助开发」。可按需使用 `disable-model-invocation: true` 或 `user-invocable: false` 控制调用入口。frontmatter 必须是扁平 `key: value`，写成嵌套结构会让整个 Skill 被忽略。',
    '',
    '## 推荐正文结构',
    '',
    '1. **触发与目标**：什么时候使用，最终交付什么。',
    '2. **前置检查**：需要读取哪些文件、确认哪些上下文、哪些情况应停止并提问。',
    '3. **执行流程**：按顺序写成可操作步骤；复杂分支用小节或决策表。',
    '4. **质量门槛**：验证命令、审查清单、失败处理和完成定义。',
    '5. **示例**：只保留能消除歧义的输入、输出或命令。',
    '6. **资源索引**：把较长参考资料移到 `references/`，不要把正文膨胀成百科全书。',
    '',
    '## 编写原则',
    '',
    '- 用祈使句和明确动作，避免「适当处理」「确保质量」这类不可验证的表述。',
    '- 先写最常见路径，再写例外；让 Agent 能在有限上下文中渐进式加载细节。',
    '- 不依赖隐含的工作目录、工具、环境变量或网络；没有这些条件时写出替代方案或明确失败信息。',
    '- 不在 Skill 中保存密钥、个人数据或与任务无关的项目规则。',
    '- 复用现有 Skill 的术语和工具名，避免同一事实出现多个互相矛盾的版本。',
    '',
    '## 发布前验证',
    '',
    '- 检查 frontmatter 能被解析，`name`、`description` 和目录名一致。',
    '- 从一个真实任务触发 Skill，确认步骤足够具体且不会覆盖用户意图。',
    '- 验证引用的文件、脚本和命令存在；脚本要说明输入、输出和错误码。',
    '- 检查正文是否能独立阅读，是否把长资料正确放入资源目录。',
    '- 用当前项目的 cwd 查询技能目录，再换到其他项目查询，确认没有跨项目泄漏。',
    '',
    '## 交付清单',
    '',
    '完成时报告 Skill 名称、`SKILL.md` 路径、适用触发条件、验证结果以及尚未覆盖的边界。',
  ].join('\n')
}
