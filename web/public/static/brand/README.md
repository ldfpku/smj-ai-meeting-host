# 品牌资源

来自 SMJ 品牌识别系统 BIS（手册 v1.4；A、B、C 章与 v1.3 相同，标志源文件为 v1.3 导出）。
替换时从品牌库原文件复制，不要自行改色或缩放变形。

| 文件 | 品牌库来源 | 用在哪里 |
|---|---|---|
| `smj-signature.svg` | 01_Logo/SVG/smj-signature-color | 顶栏，浅色主题（标准双色） |
| `smj-signature-reverse.svg` | 01_Logo/SVG/smj-signature-reverse | 顶栏，深色主题（反白双色） |
| `smj-icon-16.svg` | 02_Icon/smj-icon-16 | 页脚 16 px |
| `smj-icon.svg`、`smj-icon-180.png`、`favicon.ico` | 02_Icon | 浏览器标签、主屏幕图标 |

选版依据：手册 B7（最小尺寸：签名 110 px、符号 20 px、图标 16 px）、B8（官网用标准/反白双色；
界面小图标、页脚、水印用单色蓝/单色白）。

中央动画（`src/components/visualizer/smjar-mark.tsx`）里的 S 直接内联 `01_Logo/SVG/smj-symbol-color.svg` 的两条路径；
标志只做等比缩放和平移，遵守 B11。
