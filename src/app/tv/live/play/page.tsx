import { redirect } from 'next/navigation';

// TV 直播播放页已关闭：访问 /tv/live/play 重定向回首页。
export default function TvLivePlayRedirectPage() {
  redirect('/');
}
