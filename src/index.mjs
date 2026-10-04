// The bare-package row: this package's client-half carrier.
//
// `client-modules` discovers a browser half by scanning live Loader entries and
// reading the owning package.json's `dsh.client` declaration. A package's half
// attaches to the row whose specifier is the BARE package name — a row mounted
// from a subpath export never carries a half. So this row must exist for
// lib/client.js, and therefore the settings page, to be served at
// /plugins/dsh-extra-prompt/client.js.
//
// The five real host plugins live on subpath rows, because their Cordis `inject`
// sets differ and no single plugin could serve all five. This row has no host
// behaviour, which matches the upstream pattern for a surface-only companion
// package: an empty apply keeps the row loadable.

/** Host plugin body — no host-side behavior for this surface row. */
export function apply() {}
