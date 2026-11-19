/**
 * 挂载到现有主 Worker（moontv-plus）的代理路由模块。
 *
 * 与独立版 proxy-worker.js 逻辑一致，区别：
 *   - 作为 ES 模块被 cloudflare-worker.ts 引入；
 *   - 复用主站域名，路由前缀 /proxy，无需新建 Worker / 新域名；
 *   - 不绑定 D1 / ASSETS / DO，只做 HTTP 转发与 m3u8 改写。
 *
 * 挂载方式见同目录 cloudflare-worker.mount.md。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

const REQUEST_TIMEOUT_MS = 10000;
const MAX_RETRY = 1;

// 国内常见 CDN 白名单：命中的 m3u8/分片保留原直链，不走代理
const CDN_WHITELIST = [
  'qpic.cn', 'gtimg.cn', 'myqcloud.com', 'alicdn.com', 'aliyuncs.com',
  'qiniu.com', 'qiniucdn.com', 'bilivideo.com', 'bilivideo.cn', 'hdslb.com',
  '126.net', '163.com', 'douyinvod.com', 'bytecdntp.com', 'kdsl.net', 'ks-cdn.com',
];

const PRIVATE_HOSTNAMES = ['localhost', '::1', '0.0.0.0'];

function parseUrl(input, base) {
  try {
    return new URL(input, base);
  } catch {
    return null;
  }
}

function isPrivateIpv4(host) {
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
    const [a, b] = host.split('.').map(Number);
    if (a === 10 || a === 127) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 169 && b === 254) return true;
  }
  return false;
}

function hostAllowed(hostname) {
  const h = hostname.toLowerCase();
  if (PRIVATE_HOSTNAMES.includes(h)) return false;
  if (isPrivateIpv4(h)) return false;
  if (h.endsWith('.local') || h.endsWith('.lan') || h.endsWith('.internal')) return false;
  return true;
}

function inWhitelist(hostname) {
  const h = hostname.toLowerCase();
  return CDN_WHITELIST.some((d) => h === d || h.endsWith('.' + d));
}

function corsHeaders() {
  const h = new Headers();
  h.set('Access-Control-Allow-Origin', '*');
  h.set('Access-Control-Allow-Methods', 'GET, OPTIONS');
  h.set('Access-Control-Allow-Headers', '*');
  h.set('Access-Control-Max-Age', '86400');
  return h;
}

function jsonResponse(status, obj) {
  const h = corsHeaders();
  h.set('Content-Type', 'application/json; charset=utf-8');
  return new Response(JSON.stringify(obj), { status, headers: h });
}

function buildProxyLink(absUrl, source, origin) {
  const q = `url=${encodeURIComponent(absUrl)}&source=${encodeURIComponent(source || 'directplay')}`;
  return `${origin}/proxy?${q}`;
}

function rewriteM3u8(text, finalUrl, origin, source) {
  return text
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) return line;

      const abs = parseUrl(trimmed, finalUrl);
      if (!abs) return line;

      const absHref = abs.href;
      if (inWhitelist(abs.hostname)) return absHref; // 白名单直连
      return buildProxyLink(absHref, source, origin);
    })
    .join('\n');
}

async function fetchWithRetry(target, upstreamHeaders, request) {
  let lastError = null;

  for (let attempt = 0; attempt <= MAX_RETRY; attempt += 1) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const headers = new Headers(upstreamHeaders);
      const range = request.headers.get('Range');
      if (range) headers.set('Range', range);

      const res = await fetch(target, {
        redirect: 'follow',
        headers,
        signal: controller.signal,
        cache: 'no-store',
      });
      if (res.status < 500) return res;
      lastError = new Error(`upstream status ${res.status}`);
    } catch (err) {
      lastError = err;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError || new Error('upstream failed');
}

/**
 * 代理路由入口。cloudflare-worker.ts 在 pathname 命中 /proxy 或 /proxy/* 时调用。
 * @param {Request} request
 * @returns {Promise<Response>}
 */
export async function handleProxyRequest(request) {
  const url = new URL(request.url);

  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (url.pathname === '/proxy/health') {
    return new Response('ok', { headers: corsHeaders() });
  }

  if (url.pathname !== '/proxy') {
    return jsonResponse(404, { error: 'Not Found' });
  }

  if (request.method !== 'GET') {
    return jsonResponse(405, { error: 'Method Not Allowed' });
  }

  const rawTarget = url.searchParams.get('url');
  const source = url.searchParams.get('source') || 'directplay';

  if (!rawTarget) return jsonResponse(400, { error: 'Missing url' });

  const targetUrl = parseUrl(decodeURIComponent(rawTarget));
  if (!targetUrl || !/^https?:$/.test(targetUrl.protocol)) {
    return jsonResponse(400, { error: 'Invalid url' });
  }
  if (!hostAllowed(targetUrl.hostname)) {
    return jsonResponse(403, { error: 'Private or invalid target forbidden' });
  }

  const ua = url.searchParams.get('ua') || DEFAULT_UA;
  const referer = url.searchParams.get('referer') || `${targetUrl.protocol}//${targetUrl.host}/`;

  const upstreamHeaders = {
    'User-Agent': ua,
    Referer: referer,
    Accept: '*/*',
    'Accept-Language': 'zh-CN,zh;q=0.9',
  };

  let res;
  try {
    res = await fetchWithRetry(targetUrl.href, upstreamHeaders, request);
  } catch (err) {
    return jsonResponse(502, {
      error: 'upstream unreachable',
      detail: err && err.name === 'AbortError' ? 'timeout' : 'fetch failed',
    });
  }

  const contentType = (res.headers.get('Content-Type') || '').toLowerCase();
  const isM3u8 =
    contentType.includes('mpegurl') ||
    contentType.includes('octet-stream') ||
    targetUrl.pathname.toLowerCase().endsWith('.m3u8');

  const outHeaders = corsHeaders();
  ['Content-Type', 'Content-Length', 'Accept-Ranges', 'Last-Modified', 'ETag'].forEach((k) => {
    const v = res.headers.get(k);
    if (v) outHeaders.set(k, v);
  });

  if (isM3u8) {
    const text = await res.text();
    const origin = `${url.protocol}//${url.host}`;
    const rewritten = rewriteM3u8(text, res.url || targetUrl.href, origin, source);

    outHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
    outHeaders.set('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
    return new Response(rewritten, { status: res.status, headers: outHeaders });
  }

  outHeaders.set('Cache-Control', 'no-store, no-cache, must-revalidate, max-age=0');
  return new Response(res.body, { status: res.status, headers: outHeaders });
}
