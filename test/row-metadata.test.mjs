// Verification of the per-row display metadata the 「插件」 page reads.
//
// A row's title, description and icon do not come from the running plugin: DSH
// resolves `<specifier>/package.json` and every `<specifier>/locale/*.json` beside
// it through the module resolver and never imports the plugin code. The contract is
// written down twice — `docs/cookbook/adding-a-package.md` § "Add optional plugin
// display metadata" in the DSH checkout, and its implementation in
// `packages/boot/app-boot/src/package-meta.ts` (`readPluginMeta`). A missing export,
// a stray locale filename or an oversized icon therefore shows up as a nameless or
// blank row rather than as a load error — exactly the kind of failure no other test
// in this repository would catch.
//
// The limits below are the host's own, copied rather than imported: this package
// does not depend on DSH internals at test time, and a limit that moves upstream has
// to be re-read here.

import assert from 'node:assert/strict'
import { readFile, readdir, realpath, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { dirname, extname, relative, resolve, sep } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const ROOT = fileURLToPath(new URL('..', import.meta.url))
const manifest = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'))

/** The resolver DSH uses for a row's resources, anchored at the profile's install. */
const require = createRequire(new URL('../package.json', import.meta.url))

/** Maximum raw icon bytes admitted to plugin metadata. */
const MAX_ICON_BYTES = 256 * 1024

/** Icon file types the host accepts, by extension. */
const ICON_TYPES = new Set(['.svg', '.png', '.jpg', '.jpeg', '.webp'])

/** The shape a locale filename has to have: a language id, nothing else (the host's own `LANGUAGE_ID`). */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

/** Repository-relative path with forward slashes, the way `files` is written. */
const under = (path) => relative(ROOT, path).split(sep).join('/')

/**
 * Every row the bundle patch mounts, as `{ id, name }` in patch order.
 *
 * Read from the patch rather than from a list repeated here: a row added without
 * metadata is the failure this file exists to catch.
 */
async function patchRows() {
  const patch = await readFile(new URL('../cordis.patch.yml', import.meta.url), 'utf8')
  const rows = []
  let id = null
  for (const line of patch.split(/\r?\n/u)) {
    const idMatch = /^\s*-\s*id:\s*'?([^'\s]+)'?\s*$/u.exec(line)
    if (idMatch !== null) { id = idMatch[1]; continue }
    const nameMatch = /^\s*name:\s*'([^']+)'\s*$/u.exec(line)
    if (nameMatch !== null) { rows.push({ id, name: nameMatch[1] }); id = null }
  }
  return rows
}

/** Resolve one resource the way `readPluginMeta` does, failing the test if it is unreachable. */
function resource(specifier, why) {
  try {
    return require.resolve(specifier)
  } catch (error) {
    assert.fail(`${specifier} must resolve through the package exports (${why}): ${error.message}`)
  }
}

/** Parse a JSON file, reporting the path rather than a bare SyntaxError. */
async function json(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'))
  } catch (error) {
    assert.fail(`${file}: ${error.message}`)
  }
}

/** A non-empty display string, or a failure naming the field. */
function display(value, where) {
  assert.equal(typeof value, 'string', `${where} must be a string`)
  assert.notEqual(value.trim(), '', `${where} must not be empty`)
  return value
}

/**
 * The dictionaries the host will read for one row: the directory of the resolved
 * English resource, and every `.json` in it. Mirrors `dictionariesOf`, so a locale
 * file this package ships but cannot resolve fails here instead of being ignored at
 * runtime.
 */
async function dictionaries(specifier) {
  const english = resource(`${specifier}/locale/en.json`, 'English is the discovery entry')
  const directory = dirname(english)
  const entries = (await readdir(directory, { withFileTypes: true }))
    .filter(entry => entry.isFile() && entry.name.endsWith('.json'))
    .map(entry => entry.name)
    .sort()
  const parsed = new Map()
  for (const entry of entries) {
    const language = entry.slice(0, -'.json'.length)
    assert.match(language, LANGUAGE_ID, `${specifier}/locale/${entry} must be named after a language`)
    const file = resource(`${specifier}/locale/${entry}`, 'every locale file is read through its specifier')
    assert.equal(dirname(file), directory, `${specifier}/locale/${entry} must share the English directory`)
    parsed.set(language.toLowerCase(), { file, value: await json(file) })
  }
  return { directory, entries, parsed }
}

const rows = await patchRows()

test('the patch mounts every row this package ships metadata for', async () => {
  assert.deepEqual(rows.map(row => row.name), [
    manifest.name,
    `${manifest.name}/prompt-injection`,
    `${manifest.name}/subagent-routing`,
    `${manifest.name}/skill-installer`,
    `${manifest.name}/rtk-compact`,
    `${manifest.name}/mcp`,
    `${manifest.name}/settings-api`,
    `${manifest.name}/web-search-tavily`,
  ])
  // One directory per row: two rows sharing a manifest would share a title, a
  // description and an icon on the plugins page.
  const directories = rows.map(row => dirname(resource(`${row.name}/package.json`, 'the row manifest')))
  assert.equal(new Set(directories).size, rows.length)
  assert.ok(directories.every(directory => under(directory) === '.' || !under(directory).startsWith('..')))
})

test('every row declares the name, description and icon the host will admit', async () => {
  for (const row of rows) {
    const manifestPath = resource(`${row.name}/package.json`, 'row display metadata')
    const directory = dirname(manifestPath)
    const local = await json(manifestPath)

    // The manifest `name` is the title fallback for a language that has no
    // translation, so it names the row rather than the whole package.
    const expected = row.name === manifest.name ? manifest.name : row.id
    assert.equal(local.name, expected, `${row.name} metadata must carry the row id as its name`)
    display(local.description, `${under(manifestPath)}: description`)
    display(local.icon, `${under(manifestPath)}: icon`)

    // A relative, in-directory path: an absolute path, a URL or an escape makes the
    // host keep the text and drop the icon.
    assert.equal(/^[A-Za-z][A-Za-z\d+.-]*:/u.test(local.icon), false, `${row.name} icon must be a relative path`)
    const type = extname(local.icon).toLowerCase()
    assert.ok(ICON_TYPES.has(type), `${row.name} icon must be SVG, PNG, JPEG or WebP, got ${type}`)
    const iconPath = resolve(directory, local.icon)
    assert.equal(under(iconPath).startsWith('..'), false, `${row.name} icon must stay inside the package`)
    const resolvedDirectory = await realpath(directory)
    assert.ok((await realpath(iconPath)).startsWith(resolvedDirectory + sep), `${row.name} icon must stay in its directory`)

    const info = await stat(iconPath)
    assert.equal(info.isFile(), true)
    assert.ok(info.size <= MAX_ICON_BYTES, `${row.name} icon must stay under 256 KiB`)
    const bytes = await readFile(iconPath)
    assert.equal(bytes.length, info.size)

    if (type === '.svg') {
      const svg = bytes.toString('utf8')
      assert.match(svg.trimStart(), /^<svg[\s>]/u, `${row.name} icon must be an SVG document`)
      assert.match(svg, /viewBox=/u, `${row.name} icon needs a viewBox to scale`)
      // The host inlines the file as a data URL inside the shell, so it has to stand
      // alone: no fetch, no script, no foreign content.
      for (const forbidden of ['<script', '<image', 'xlink:href="http', 'href="http', 'url(http', '@import', '<foreignObject']) {
        assert.equal(svg.includes(forbidden), false, `${row.name} icon must not use ${forbidden}`)
      }
    }
  }
})

test('every row ships English and Chinese metadata the page can render', async () => {
  for (const row of rows) {
    const { entries, parsed } = await dictionaries(row.name)
    // Both shipped languages, so neither the English nor the Chinese plugins page
    // falls back to the row id or to an empty description.
    assert.deepEqual(entries, ['en.json', 'zh.json'], `${row.name} locale files`)
    for (const { file, value } of parsed.values()) {
      assert.equal(typeof value.meta, 'object', `${file} must carry a meta object`)
      display(value.meta.title, `${file}: meta.title`)
      display(value.meta.description, `${file}: meta.description`)
      // The bare row's title is the package name, which is what its card shows; a
      // subpath row must not fall back to the specifier, which reads like a path.
      if (row.name !== manifest.name) {
        assert.notEqual(value.meta.title, row.name, `${file}: meta.title must be display text, not the specifier`)
      }
    }
    // The languages must actually differ: a copied file would leave one of them
    // showing the other's text. The bare row's title is the package name in both,
    // which is correct, so only its description has to differ.
    if (row.name !== manifest.name) {
      assert.notEqual(
        parsed.get('en').value.meta.title,
        parsed.get('zh').value.meta.title,
        `${row.name} must translate its title rather than repeat it`,
      )
    }
    assert.notEqual(
      parsed.get('en').value.meta.description,
      parsed.get('zh').value.meta.description,
      `${row.name} must translate its description rather than repeat it`,
    )
  }
})

test('the package ships every metadata file it declares', async () => {
  // `files` decides what a published copy contains; a `link:` development install
  // hides a missing entry, a published install does not.
  const patterns = manifest.files.map(entry => entry.replace(/^\.\//u, ''))
  // Enough of npm's glob language for the two shapes this manifest uses: a bare
  // directory ("src") and a one-level wildcard ("locale/*.json").
  const shipped = (path) => patterns.some((pattern) => {
    const star = pattern.indexOf('*')
    if (star === -1) return path === pattern || path.startsWith(pattern + '/')
    const prefix = pattern.slice(0, star)
    return path.startsWith(prefix) && !path.slice(prefix.length).includes('/')
  })

  for (const row of rows) {
    const directory = dirname(resource(`${row.name}/package.json`, 'the row manifest'))
    const local = await json(resolve(directory, 'package.json'))
    for (const file of [
      resolve(directory, 'package.json'),
      resolve(directory, 'locale/en.json'),
      resolve(directory, 'locale/zh.json'),
      resolve(directory, local.icon),
    ]) {
      // package.json is always published by npm; the rest have to be listed.
      if (under(file) === 'package.json') continue
      assert.ok(shipped(under(file)), `${under(file)} must be listed through the manifest's files`)
    }
  }
})
