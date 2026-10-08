'use client';

import Image from "next/image";

/**
 * SMJ 品牌标识：签名组合（SMJ + 斯米伽）。
 * 浅色主题用标准双色，深色主题用反白双色（BIS B8）；两个文件在
 * public/static/brand/，替换时保持同名同路径，来源见该目录的 README。
 * 文件是矢量图，不经过 next/image 的位图优化。
 */
export function NavLogo() {
  return (
    <div className="flex h-8 items-center gap-3 ml-3">
      <span className="flex items-center" aria-label="SMJ 斯米伽">
        <Image
          src="/static/brand/smj-signature.svg"
          alt="SMJ 斯米伽"
          width={137}
          height={26}
          unoptimized
          priority
          className="h-[26px] w-auto dark:hidden"
        />
        <Image
          src="/static/brand/smj-signature-reverse.svg"
          alt="SMJ 斯米伽"
          width={137}
          height={26}
          unoptimized
          priority
          className="hidden h-[26px] w-auto dark:block"
        />
      </span>
    </div>
  );
}
