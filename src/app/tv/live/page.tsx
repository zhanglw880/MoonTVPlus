import { redirect } from 'next/navigation';

// TV 模式直播已关闭：访问 /tv/live 重定向回首页。
export default function TvLiveRedirectPage() {
  redirect('/');
}
