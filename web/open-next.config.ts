import { defineCloudflareConfig } from "@opennextjs/cloudflare";

// Nothing is cached between requests: the page is a client-side app and the
// API routes are all dynamic.
export default defineCloudflareConfig();
