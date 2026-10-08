import "./globals.css";
import { PlaygroundStateProvider } from "@/hooks/use-playground-state";
import { ConnectionProvider } from "@/hooks/use-connection";
import { DemoProvider } from "@/hooks/use-demo";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toaster";
import { PHProvider } from "@/hooks/posthog-provider";
import {
  Barlow,
  Barlow_Semi_Condensed,
  IBM_Plex_Mono,
  Noto_Sans_SC,
} from "next/font/google";
import PostHogPageView from "@/components/posthog-pageview";
import { ThemeProvider } from "@/components/theme-provider";
import {
  SidebarProvider,
  Sidebar,
  SidebarInset,
  SidebarHeader,
  SidebarFooter,
  SidebarContent,
} from "@/components/ui/sidebar";
import { NavLogo } from "@/components/custom/nav-logo";
import { ThemeToggle } from "@/components/custom/theme-toggle";
import { RoomWrapper } from "@/components/room-wrapper";
import { ConfigurationForm } from "@/components/configuration-form";

// 字体按 BIS B15 / B16：西文与数字 Barlow，标题 Barlow Semi Condensed，
// 数据 IBM Plex Mono，中文思源黑体（Noto Sans SC）。均为 OFL 开源字体，随站点自带。
const barlow = Barlow({
  subsets: ["latin"],
  weight: ["400", "500", "600"],
  display: "swap",
  variable: "--font-barlow",
});
const barlowCondensed = Barlow_Semi_Condensed({
  subsets: ["latin"],
  weight: ["600", "700"],
  display: "swap",
  variable: "--font-barlow-condensed",
});
const plexMono = IBM_Plex_Mono({
  subsets: ["latin"],
  weight: ["400", "500"],
  display: "swap",
  variable: "--font-plex-mono",
});
// 中文字形按用到的片段下载，不预加载
const notoSansSC = Noto_Sans_SC({
  subsets: ["latin"],
  display: "swap",
  preload: false,
  variable: "--font-noto-sc",
});
const fontVariables = [barlow, barlowCondensed, plexMono, notoSansSC]
  .map((f) => f.variable)
  .join(" ");

import "@livekit/components-styles";

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-CN" suppressHydrationWarning>
      <body className={`${fontVariables} font-sans`}>
        <ThemeProvider attribute="class" defaultTheme="light" enableSystem>
          <PHProvider>
            <PlaygroundStateProvider>
              <ConnectionProvider>
                <TooltipProvider>
                  <DemoProvider>
                  <RoomWrapper>
                    <SidebarProvider defaultOpen={true}>
                      <Sidebar className="bg-bg1">
                        <SidebarHeader>
                          <NavLogo />
                        </SidebarHeader>
                        <SidebarContent className="px-4">
                          <ConfigurationForm />
                        </SidebarContent>
                        <SidebarFooter className="p-4">
                          <ThemeToggle />
                        </SidebarFooter>
                      </Sidebar>
                      <SidebarInset>
                        <PostHogPageView />
                        {children}
                        <Toaster />
                      </SidebarInset>
                    </SidebarProvider>
                  </RoomWrapper>
                  </DemoProvider>
                </TooltipProvider>
              </ConnectionProvider>
            </PlaygroundStateProvider>
          </PHProvider>
        </ThemeProvider>
      </body>
    </html>
  );
}
