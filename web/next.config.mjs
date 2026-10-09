import { initOpenNextCloudflareForDev } from "@opennextjs/cloudflare";

// Gives `next dev` the Cloudflare bindings of wrangler.jsonc. Off by default:
// the AI binding is always remote and uses the wrangler login of the process,
// which on a machine whose everyday login is another account would be the
// wrong one. Without it the AI routes (minutes, document import) answer "no AI
// binding" in development. To try them, start the dev server with
// OPENNEXT_DEV_BINDINGS=1 and the ZY login (see "Local development" in the README).
if (process.env.OPENNEXT_DEV_BINDINGS === "1") {
  initOpenNextCloudflareForDev();
}

/** @type {import('next').NextConfig} */
const nextConfig = {
  webpack(config) {
    config.module.rules.push({
      test: /\.svg$/, // Look for .svg files
      use: ["@svgr/webpack"], // Use @svgr/webpack to handle them
    });

    return config; // Always return the modified config
  },
};

export default nextConfig;
