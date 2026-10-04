// Pure command-matching and content rules for rtk compaction.
//
// This module deliberately imports nothing: it holds the load-bearing logic
// (which command maps to which filter, and how a shell result's trailing status
// markers are preserved) so it can be tested without a DSH runtime.

/**
 * `rtk pipe` filter per supported command family, with the settings key that
 * switches it off.
 *
 * Matching is anchored on the executable name at the start of the command, so a
 * PowerShell alias or a mid-pipeline mention cannot select a filter by accident.
 * rtk's content-sniffing auto-detection is deliberately never used: a
 * misdetected filter would silently discard information.
 */
export const FILTER_RULES = [
  { key: 'gitStatus', pattern: /^\s*git\s+status\b/, filter: 'git-status' },
  { key: 'gitDiff', pattern: /^\s*git\s+diff\b/, filter: 'git-diff' },
  { key: 'gitLog', pattern: /^\s*git\s+log\b/, filter: 'git-log' },
  { key: 'rg', pattern: /^\s*rg\b/, filter: 'rg' },
  { key: 'grep', pattern: /^\s*grep\b/, filter: 'grep' },
]

/**
 * Markers the shell tool appends after the real output. They are stripped before
 * compression and re-appended verbatim afterwards, so the compressed text still
 * reports its own exit status and any truncation notice.
 */
export const TRAILING_MARKERS = [
  /\[exit code: -?\d+\][ \t]*\r?\n?$/,
  /\[shell exited: code -?\d+\][ \t]*\r?\n?$/,
  /\[shell killed by signal: [^\]]+\][ \t]*\r?\n?$/,
  /\[shell exited\][ \t]*\r?\n?$/,
  /\[output truncated; full output: [^\]]*\][ \t]*\r?\n?$/,
]

const MAX_TAIL_MARKERS = 8

/**
 * Split trailing status markers off a shell result body.
 *
 * The markers live inside the text block, so they must be removed before
 * compression and restored afterwards. They are returned verbatim rather than
 * reconstructed: the marker is not always the literal child exit code.
 *
 * @param text - the concatenated text body of a shell tool result.
 * @returns the body without its trailing markers, and the markers in order.
 */
export function splitTrailingMarkers(text) {
  let body = text
  const markers = []
  for (let round = 0; round < MAX_TAIL_MARKERS; round += 1) {
    let hit
    for (const pattern of TRAILING_MARKERS) {
      const match = body.match(pattern)
      if (match === null) continue
      hit = match[0].replace(/[ \t]*\r?\n?$/, '')
      body = body.slice(0, body.length - match[0].length)
      break
    }
    if (hit === undefined) break
    markers.unshift(hit)
  }
  return { body, markers }
}

/**
 * Replace the text of a content-block list while keeping every non-text block at
 * its original position and relative order.
 *
 * @param blocks - the original content blocks.
 * @param text - the replacement text.
 * @returns the rebuilt block list.
 */
export function rebuildTextBlocks(blocks, text) {
  const rebuilt = []
  let placed = false
  for (const block of blocks) {
    if (block?.type !== 'text') {
      rebuilt.push(block)
      continue
    }
    if (placed) continue
    rebuilt.push({ type: 'text', text })
    placed = true
  }
  if (!placed) rebuilt.push({ type: 'text', text })
  return rebuilt
}

/**
 * Pick the filter for a shell command, or `undefined` when nothing applies.
 *
 * @param command - the shell command string.
 * @param disabled - filter keys the user switched off; omitted enables every rule.
 * @returns the rtk filter name, or `undefined` for passthrough.
 */
export function filterForCommand(command, disabled) {
  for (const rule of FILTER_RULES) {
    if (disabled?.has(rule.key)) continue
    if (rule.pattern.test(command)) return rule.filter
  }
  return undefined
}
