// 登录页不需要侧栏和顶栏；根 layout 已经渲染了 <html>/<body>，这里只能是普通容器
export default function LoginLayout({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}
