// mammoth 自带的浏览器版本没有类型声明；这里只声明用到的部分
declare module "mammoth/mammoth.browser.min.js" {
  interface Result {
    value: string;
    messages: { type: string; message: string }[];
  }
  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: { convertImage?: unknown }
  ): Promise<Result>;
  export const images: {
    imgElement(
      read: (image: unknown) => Promise<{ src: string }>
    ): unknown;
  };
}
