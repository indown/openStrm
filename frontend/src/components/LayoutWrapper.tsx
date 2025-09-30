"use client";

import { usePathname } from "next/navigation";
import { SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { AppSidebar } from "@/components/app-sidebar";
import { Settings, Github } from "lucide-react";
import axios from "axios";
import {
  Menubar,
  MenubarContent,
  MenubarItem,
  MenubarMenu,
  MenubarTrigger,
} from "@/components/ui/menubar";
import { useRouter } from "next/navigation";

export default function LayoutWrapper({ children }: { children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  if (pathname === "/login") {
    return <>{children}</>; // 登录页不显示导航等
  }
  const logout = async () => {
    await axios.post("/api/auth/logout");
    router.push('/login') // 退出后跳转到登录页
  }
  return (
    <>
      <SidebarProvider>
          <AppSidebar />
          <SidebarTrigger />
          <div className="flex flex-col w-full min-h-screen pl-0">
            <header className="w-full border-b flex items-center p-2">
              <div className="ml-auto flex items-center gap-1">
                <a
                  href="https://github.com/indown/OpenStrm"
                  target="_blank"
                  rel="noreferrer"
                  className="inline-flex items-center justify-center rounded p-1 hover:bg-accent"
                  aria-label="GitHub"
                >
                  <Github className="h-5 w-5" />
                </a>
                <Menubar className="border-0 shadow-none">
                  <MenubarMenu>
                    <MenubarTrigger>
                      <Settings className="m-2" />
                    </MenubarTrigger>
                    <MenubarContent>
                      <MenubarItem onClick={() => logout()}>Sign Out</MenubarItem>
                    </MenubarContent>
                  </MenubarMenu>
                </Menubar>
              </div>
            </header>
            <div className="p-[20px]">{children}</div>
          </div>
        </SidebarProvider>
    </>
  );
}
