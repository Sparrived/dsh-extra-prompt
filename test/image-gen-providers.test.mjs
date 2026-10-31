// Provider reuse for image_gen.
//
// The tool must be able to borrow the endpoint and credential reference of a
// provider the user already configured in DSH, without copying either into this
// plugin's own settings. These tests drive the resolver with plain context
// doubles: no Host package is needed to verify the precedence rules.

import test from 'node:test';
import assert from 'node:assert/strict';
import { listConfiguredProviders, resolveImageEndpoint } from '../src/image-gen/providers.mjs';

/** A context with the two optional services the resolver reads. */
function contextOf({ providers = undefined, settings = undefined, descriptors = undefined } = {}) {
  return {
    get(name) {
      if (name === 'llm') return providers === undefined ? undefined : { listConfigurableProviders: () => providers };
      if (name === 'settings') {
        if (settings !== undefined) return { get: ns => settings[ns] };
        if (descriptors !== undefined) return { describe: () => descriptors };
      }
      return undefined;
    },
  };
}

test('directory entries resolve the profile through settings namespace and path', () => {
  const ctx = contextOf({
    providers: [
      { provider: 'amkr', displayName: 'AMKR 网关', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'amkr'] },
      { provider: 'empty', displayName: 'Empty', settingsNs: 'llm-empty', settingsPath: [] },
    ],
    settings: {
      'llm-pi-ai': {
        providers: {
          amkr: {
            baseURL: 'https://amkr.sparrived.xyz/v1',
            apiKeyEnv: 'AMKR_API_KEY',
            models: [{ id: 'gpt-image-1', name: 'GPT Image' }, { id: 'deepseek-v4.1-flash' }],
          },
        },
      },
    },
  });

  const providers = listConfiguredProviders(ctx);
  assert.deepEqual(providers, [
    {
      provider: 'amkr',
      displayName: 'AMKR 网关',
      baseURL: 'https://amkr.sparrived.xyz/v1',
      apiKeyEnv: 'AMKR_API_KEY',
      models: [
        { id: 'gpt-image-1', name: 'GPT Image' },
        { id: 'deepseek-v4.1-flash', name: 'deepseek-v4.1-flash' },
      ],
    },
  ]);
});

test('settings descriptors answer when the Host has no configurable-provider directory', () => {
  const ctx = contextOf({
    descriptors: [
      {
        ns: 'llm-pi-ai',
        value: {
          providers: {
            'local-gateway': {
              displayName: 'Local',
              baseURL: 'http://127.0.0.1:8080/v1',
              apiKeyEnv: 'LOCAL_KEY',
            },
          },
        },
      },
      // Not a provider namespace: a coincidental `providers` key must be ignored.
      { ns: 'unrelated', value: { providers: { fake: { baseURL: 'https://fake' } } } },
    ],
  });

  assert.deepEqual(listConfiguredProviders(ctx), [{
    provider: 'local-gateway',
    displayName: 'Local',
    baseURL: 'http://127.0.0.1:8080/v1',
    apiKeyEnv: 'LOCAL_KEY',
    models: [],
  }]);
});

test('catalog defaults fill fields the stored profile leaves to the installed catalog', () => {
  const ctx = contextOf({
    providers: [{
      provider: 'catalog-route',
      displayName: 'Catalog route',
      settingsNs: 'llm-catalog',
      settingsPath: [],
      defaultBaseURL: 'https://catalog.example/v1',
      nativeAuth: { env: 'CATALOG_KEY' },
    }],
    settings: { 'llm-catalog': { models: [] } },
  });

  assert.deepEqual(listConfiguredProviders(ctx), [{
    provider: 'catalog-route',
    displayName: 'Catalog route',
    baseURL: 'https://catalog.example/v1',
    apiKeyEnv: 'CATALOG_KEY',
    models: [],
  }]);
});

test('a selected provider wins over the two manual fallback fields', () => {
  const ctx = contextOf({
    providers: [{ provider: 'amkr', displayName: 'AMKR', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'amkr'] }],
    settings: {
      'llm-pi-ai': {
        providers: {
          amkr: { baseURL: 'https://amkr.example/v1', apiKeyEnv: 'AMKR_API_KEY' },
        },
      },
    },
  });

  assert.deepEqual(resolveImageEndpoint(ctx, {
    provider: 'amkr',
    baseURL: 'https://manual.example/v1',
    apiKeyEnv: 'MANUAL_KEY',
  }), {
    provider: 'amkr',
    displayName: 'AMKR',
    baseURL: 'https://amkr.example/v1',
    apiKeyEnv: 'AMKR_API_KEY',
    models: [],
  });
});

test('a selected provider owns both fields and never borrows the hidden manual ones', () => {
  const ctx = contextOf({
    providers: [{ provider: 'bare', displayName: 'Bare', settingsNs: 'llm-bare', settingsPath: [] }],
    settings: { 'llm-bare': { baseURL: 'https://provider.example/v1', apiKeyEnv: '' } },
  });

  assert.deepEqual(resolveImageEndpoint(ctx, {
    provider: 'bare',
    baseURL: 'https://manual.example/v1',
    apiKeyEnv: 'MANUAL_KEY',
  }), {
    provider: 'bare',
    displayName: 'Bare',
    baseURL: 'https://provider.example/v1',
    apiKeyEnv: '',
    models: [],
  });

  const noEndpoint = contextOf({
    providers: [{ provider: 'bare', displayName: 'Bare', settingsNs: 'llm-bare', settingsPath: [] }],
    settings: { 'llm-bare': { baseURL: '', apiKeyEnv: '' } },
  });
  assert.throws(
    () => resolveImageEndpoint(noEndpoint, {
      provider: 'bare',
      baseURL: 'https://manual.example/v1',
      apiKeyEnv: 'MANUAL_KEY',
    }),
    /没有配置 base URL/,
  );
});

test('an unknown provider or a provider with no endpoint is refused instead of silently using a stale route', () => {
  const ctx = contextOf({
    providers: [{ provider: 'amkr', displayName: 'AMKR', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'amkr'] }],
    settings: { 'llm-pi-ai': { providers: { amkr: { baseURL: '', apiKeyEnv: '' } } } },
  });

  assert.throws(
    () => resolveImageEndpoint(ctx, { provider: 'deleted', baseURL: 'https://manual.example/v1' }),
    /找不到已配置的供应商/,
  );
  assert.throws(
    () => resolveImageEndpoint(ctx, { provider: 'amkr', baseURL: '', apiKeyEnv: '' }),
    /没有配置 base URL/,
  );
});

test('without a provider the manual endpoint is required and returned unchanged', () => {
  const ctx = contextOf();
  assert.deepEqual(resolveImageEndpoint(ctx, {
    provider: '',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'IMAGE_API_KEY',
  }), {
    provider: '',
    displayName: '',
    baseURL: 'https://api.openai.com/v1',
    apiKeyEnv: 'IMAGE_API_KEY',
    models: [],
  });
  assert.throws(() => resolveImageEndpoint(ctx, { provider: '', baseURL: '', apiKeyEnv: '' }), /接口地址未配置/);
});
