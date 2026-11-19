import { redirect } from 'next/navigation';

// 网络直播已关闭：访问 /web-live 重定向回首页。
export default function WebLiveRedirectPage() {
  redirect('/');
}
