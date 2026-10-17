// The bare-package row: this package's client-half carrier.
//
// `client-modules` discovers a browser half by scanning live Loader entries and
// reading the owning package.json's `dsh.client` declaration. A package's half
// attaches to the row whose specifier is the BARE package name — a row mounted
// from a subpath export never carries a half. So this row must exist for
// lib/client.js, and therefore the settings page and the in-session dashboard, to
// be served at /plugins/dsh-extra-prompt/client.js. Switching this row off on the
// 「插件」 page takes both of them with it.
//
// Every real feature lives on a subpath row (five of them, plus the settings
// page's data channel and the Tavily search provider), because their Cordis
// `inject` sets differ and no single plugin could serve them all. This row has no
// host behaviour, which matches the upstream pattern for a surface-only companion
// package: an empty apply keeps the row loadable.

/** Host plugin body — no host-side behavior for this surface row. */
export function apply() {}
