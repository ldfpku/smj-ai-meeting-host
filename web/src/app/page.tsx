import { Metadata } from "next";
import Image from "next/image";

import { Chat } from "@/components/chat";

import { defaultPresets } from "@/data/presets";
import { PresetSave } from "@/components/preset-save";
import { PresetSelector } from "@/components/preset-selector";

export async function generateMetadata({
  searchParams,
}: {
  searchParams: Promise<{ [key: string]: string | string[] | undefined }>;
}): Promise<Metadata> {
  let title = "SMJ | AI 会议主持人";
  let description =
    "SMJ 会议制度执行器：装载公司真实会议模板，严格控时、跑题即刻打断、按名单点名征询、催办四要素决议并生成正式纪要。";

  const params = await searchParams;
  const presetId = params?.preset;
  if (presetId) {
    const selectedPreset = defaultPresets.find(
      (preset) => preset.id === presetId
    );
    if (selectedPreset) {
      title = `SMJ | ${selectedPreset.name}`;
      description = `与「${selectedPreset.name}」实时语音对话。SMJ 内部工具。`;
    }
  }

  return {
    title,
    description,
    icons: {
      icon: [
        { url: "/static/brand/smj-icon.svg", type: "image/svg+xml" },
        { url: "/static/brand/favicon.ico", sizes: "48x48" },
      ],
      apple: "/static/brand/smj-icon-180.png",
    },
    openGraph: {
      title,
      description,
      type: "website",
    },
  };
}

export default function Dashboard() {
  return (
    <div className="flex flex-col h-screen bg-bg0 overflow-x-hidden">
      <header className="flex flex-col md:flex-row flex-shrink-0 gap-3 md:h-16 items-center justify-between px-4 md:px-8 py-4 w-full border-b border-separator1 min-w-0">
        <div className="flex items-center min-w-0 flex-shrink">
          <span className="text-lg font-light truncate">
            AI 会议主持人
          </span>
        </div>
        <div className="inline-flex flex-row items-center space-x-2 flex-shrink-0">
          <PresetSelector />
          <PresetSave />
        </div>
      </header>
      <main className="flex flex-col flex-1 min-h-0 min-w-0 overflow-hidden p-4 w-full">
        <div className="w-full h-full flex flex-col mx-auto rounded-2xl bg-bg1 border border-separator1 min-w-0 overflow-hidden">
          <Chat />
        </div>
      </main>
      <footer className="hidden md:flex md:items-center md:justify-between gap-4 py-3 px-8 text-xs text-fg3 w-full border-t border-separator1">
        <div className="flex items-center gap-2 min-w-0">
          <Image
            src="/static/brand/smj-icon-16.svg"
            alt=""
            aria-hidden
            width={16}
            height={16}
            unoptimized
            className="h-4 w-4 object-contain"
          />
          <span className="font-medium text-fg2">SMJ 斯米伽</span>
          <span className="text-separator1">|</span>
          <span className="truncate">井下工具 · 制造 / 租赁 / 维保</span>
        </div>
        <div className="flex items-center gap-3 shrink-0">
          <span className="hidden lg:inline">
            天津 · 成都 · 新疆 · 惠州
          </span>
          <span className="hidden lg:inline text-separator1">|</span>
          <span className="text-fg2">内部资料 · 请勿外传</span>
        </div>
      </footer>
    </div>
  );
}
