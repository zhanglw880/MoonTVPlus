// 前端代理地址工具（接入 MoonTVPlus 时放到 src/lib/media-proxy.ts）
// 环境变量 NEXT_PUBLIC_PROXY_WORKER_BASE：
//   - 独立 Worker：填 https://proxy.你的域名
//   - 代理并入主 Worker（推荐）：留空，自动走同源 /proxy

export const PROXY_WORKER_BASE = process.env.NEXT_PUBLIC_PROXY_WORKER_BASE || '';

// 与 Worker 侧 CDN 白名单保持一致
const CDN_WHITELIST = [
  'qpic.cn', 'gtimg.cn', 'myqcloud.com', 'alicdn.com', 'aliyuncs.com',
  'qiniu.com', 'qiniucdn.com', 'bilivideo.com', 'bilivideo.cn', 'hdslb.com',
  '126.net', '163.com', 'douyinvod.com', 'bytecdntp.com', 'kdsl.net', 'ks-cdn.com',
];

function inWhitelist(hostname: string) {
  const h = hostname.toLowerCase();
  return CDN_WHITELIST.some((d) => h === d || h.endsWith('.' + d));
}

/**
 * 把外部片源地址改写为代理地址；
 * 内部地址、data/blob、白名单 CDN 原样返回。
 */
export function mediaProxyUrl(raw: string, source?: string): string {
  if (!raw) return raw;
  if (/^(data:|blob:|\/|#|mailto:)/.test(raw)) return raw;
  if (!PROXY_WORKER_BASE) return raw;

  let u: URL;
  try {
    u = new URL(raw, window.location.origin);
  } catch {
    return raw;
  }
  if (!/^https?:$/.test(u.protocol)) return raw;
  if (inWhitelist(u.hostname)) return raw;

  const q = `url=${encodeURIComponent(u.href)}&source=${encodeURIComponent(source || 'directplay')}`;
  return `${PROXY_WORKER_BASE || ''}/proxy?${q}`;
}
