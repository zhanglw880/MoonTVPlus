import { redirect } from 'next/navigation';

// 电视直播已关闭：访问 /live 重定向回首页。
export default function LiveRedirectPage() {
  redirect('/');
}
