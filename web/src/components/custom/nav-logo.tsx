'use client';

import Image from "next/image";

/**
 * SMJAR 品牌标识。
 * 资源来自品牌库 public/static/brand/（logo.webp 黑字用于浅色界面，
 * logo-dark.webp 白字用于深色界面），按主题切换，替换时保持同名同路径即可。
 */
export function NavLogo() {
  return (
    <div className="flex h-8 items-center gap-3 ml-3">
      <span className="flex items-center" aria-label="SMJAR">
        <Image
          src="/static/brand/logo.webp"
          alt="SMJAR"
          width={88}
          height={22}
          priority
          className="h-[22px] w-auto dark:hidden"
        />
        <Image
          src="/static/brand/logo-dark.webp"
          alt="SMJAR"
          width={88}
          height={22}
          priority
          className="hidden h-[22px] w-auto dark:block"
        />
      </span>
    </div>
  );
}
