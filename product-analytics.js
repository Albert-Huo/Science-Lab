(function productAnalyticsModule(root, factory) {
  'use strict';
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.ScienceProductAnalytics = api;
})(typeof globalThis === 'object' ? globalThis : this, function buildProductAnalytics() {
  'use strict';

  const SOURCES = new Set(['direct', 'internal', 'search', 'external']);
  const ACTIONS = new Set(['catalog_open', 'profile_open', 'experiment_previous', 'experiment_next']);
  const SEARCH_HOSTS = [
    'baidu.com', 'bing.com', 'google.com', 'google.com.hk', 'sogou.com', 'so.com', 'sm.cn', 'yahoo.com',
  ];

  function isHostOrSubdomain(hostname, domain) {
    return hostname === domain || hostname.endsWith('.' + domain);
  }

  function classifySource(referrer, origin) {
    if (!referrer) return 'direct';
    try {
      const source = new URL(referrer);
      const site = new URL(origin);
      if (source.origin === site.origin) return 'internal';
      if (SEARCH_HOSTS.some(domain => isHostOrSubdomain(source.hostname.toLowerCase(), domain))) return 'search';
    } catch {
      return 'external';
    }
    return 'external';
  }

  async function experimentId(path, cryptoImpl) {
    if (typeof path !== 'string' || path.length < 1 || path.length > 300 || path.includes('\\')) {
      throw new Error('invalid_experiment_path');
    }
    if (!cryptoImpl || !cryptoImpl.subtle || typeof cryptoImpl.subtle.digest !== 'function') {
      throw new Error('crypto_unavailable');
    }
    const bytes = new TextEncoder().encode(path);
    const digest = new Uint8Array(await cryptoImpl.subtle.digest('SHA-256', bytes));
    return Array.from(digest, byte => byte.toString(16).padStart(2, '0')).join('');
  }

  function createClient({ endpoint = '/api/analytics/events', fetchImpl = globalThis.fetch,
    cryptoImpl = globalThis.crypto } = {}) {
    async function send(body) {
      if (typeof fetchImpl !== 'function') return false;
      try {
        const response = await fetchImpl(endpoint, {
          method: 'POST',
          credentials: 'omit',
          referrerPolicy: 'no-referrer',
          keepalive: true,
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        return response.status === 204;
      } catch {
        return false;
      }
    }

    return Object.freeze({
      pageView(source) {
        if (!SOURCES.has(source)) return false;
        return send({ v: 1, event: 'page_view', page_id: 'home', source });
      },
      async experimentOpen(path) {
        try {
          return await send({ v: 1, event: 'experiment_open', experiment_id: await experimentId(path, cryptoImpl) });
        } catch {
          return false;
        }
      },
      keyAction(action) {
        if (!ACTIONS.has(action)) return false;
        return send({ v: 1, event: 'key_action', page_id: 'home', action_id: action });
      },
    });
  }

  return Object.freeze({ ACTIONS, SOURCES, classifySource, experimentId, createClient });
});
