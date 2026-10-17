// Host plugin: `skill-install`, a model-facing Skill installer.
//
// Upstream DSH registers and discovers Skills but ships no installer: there is
// no installer package, no tool, and no CLI verb. This plugin adds exactly that
// one tool, gated by the approval service.
//
// The tool is deliberately narrow:
//
// - Only HTTPS GitHub repository or `tree` directory URLs are accepted. The
//   parser rejects credentials, ports, query strings, and fragments, so a source
//   cannot be redirected to another host or to a local path.
// - The archive path never trusts the remote: the ZIP central directory is
//   parsed directly, and entries with absolute paths, `..`, backslashes, drive
//   letters, symlinks, device names, or unsupported compression are refused.
// - The install publishes by `rename` inside a staging directory next to the
//   destination, under a cross-process lock, so a concurrent install cannot
//   interleave and a crash cannot leave a half-written Skill.
//
// `defaultRef` and `defaultMethod` are `.volatile()` and read per call, so a
// change applies to the next installation without restarting the Host.
//
// The feature's on/off switch is the profile row's own: disabling
// `extra-skill-installer` in the 「插件」 page disposes the fiber, and the tool
// registration goes with it, which takes `skill-install` out of the model's tool
// list. A tool that stayed listed but always failed would advertise a capability
// that is not there, which is worse than not offering it.

import Schema from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import { installSkillFromSource, skillInstallGate } from './installer.mjs'
import { resolveDshProfileDir } from '../shared/dsh-home.mjs'

export const name = 'extra-skill-installer'
export const inject = ['tools']

export const Config = Schema.object({
  defaultRef: Schema.string().default('main')
    .description('Git ref used when the tool call omits `ref`')
    .volatile(),
  defaultMethod: Schema.union(['auto', 'download', 'git']).default('auto')
    .description('Preparation strategy when the tool call omits `method`')
    .volatile(),
})

export function apply(ctx, config) {
  // One definition per fiber: the row's switch decides whether a fiber exists at
  // all, so there is no registration cycle to rebuild for.
  const tool = defineTool({
    name: 'skill-install',
    description: 'Install a Skill from a GitHub repository or Skill directory URL into the current DSH user skill directory.',
    parameters: {
      source: {
        type: 'string',
        required: true,
        description: 'HTTPS GitHub repository or tree URL. A repository root is accepted when it contains one matching skill directory; mirrored skills/<repo> and .openclaw/skills/<repo> roots prefer skills/<repo>.',
      },
      path: {
        type: 'string',
        description: 'Optional relative Skill directory inside the repository, for example skills/taste-skill.',
      },
      ref: {
        type: 'string',
        description: 'Optional Git branch, tag, or commit. Defaults to the configured default ref.',
      },
      name: {
        type: 'string',
        description: 'Optional destination Skill name. Defaults to the selected directory name.',
      },
      method: {
        type: 'string',
        description: 'Download method: auto, download, or git. Defaults to the configured default method.',
      },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          skillName: { type: 'string', required: true },
          source: { type: 'string', required: true },
          ref: { type: 'string', required: true },
          path: { type: 'string', required: true },
          installPath: { type: 'string', required: true },
          method: { type: 'string', required: true },
          registered: { type: 'boolean', required: true },
          visibleInCurrentSession: { type: 'boolean', required: true },
          warnings: { type: 'array', required: true, items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `Installed ${value.skillName} at ${value.installPath}. Current session catalog visibility: ${value.visibleInCurrentSession ? 'yes' : 'refresh required'}.`,
      }],
    },
    timeoutMs: 120000,
    async execute(args, exec) {
      if (!exec.agent) throw new Error('skill-install requires an active agent session')
      const approval = ctx.get('approval')
      if (!approval?.request) throw new Error('skill-install requires the DSH approval service')
      const gate = skillInstallGate(approval, exec.agent.session)
      if (gate === 'reject') {
        throw new Error('Skill installation was rejected because approval prompts are disabled for delegated sessions; report this limitation to the parent instead of retrying.')
      }
      if (gate === 'ask') {
        const outcome = await approval.request({
          agent: exec.agent,
          toolName: 'skill-install',
          callId: exec.callId,
          reason: `Install Skill from ${args.source}`,
          signal: exec.signal,
        })
        if (outcome !== 'allowed-once') {
          const cause = outcome === 'unavailable'
            ? 'no approval answerer is available in this deployment'
            : `the request was ${outcome}`
          throw new Error(`Skill installation was not approved (${cause}). Ask the user to approve, or install the Skill from the prompt & skills settings page, which does not require approval.`)
        }
      }
      // gate === 'skip': the user's own never-approval policy (for example the
      // full-access preset) already records global consent, so no prompt.
      let committed = false
      const result = await installSkillFromSource({
        ...args,
        ref: args.ref ?? config.defaultRef.get(),
        method: args.method ?? config.defaultMethod.get(),
      }, {
        signal: exec.signal,
        // The managed-skill registry belongs to the profile the running Host
        // booted, not to a path this plugin re-derives.
        profileDir: resolveDshProfileDir(ctx),
        onCommit: () => { committed = true },
      })
      const skills = ctx.get('skills')
      try {
        const visibleInCurrentSession = skills
          ? (await skills.list({ cwd: exec.agent.session.header.cwd, signal: exec.signal, scope: exec.agent })).some(skill => skill.name === result.skillName)
          : false
        return { ...result, visibleInCurrentSession }
      } catch (error) {
        if (!committed) throw error
        return {
          ...result,
          visibleInCurrentSession: false,
          warnings: [...result.warnings, '当前会话 Skill 列表未能刷新；请开始新会话或手动刷新。'],
        }
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Install Skill ${args.source}`,
      kind: 'write',
      rawInput: args.source,
    }),
  })

  // Dies with the fiber — that disposal is exactly what the row's switch does.
  ctx.tools.register(tool)
}
