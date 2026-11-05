import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";

const referenceSidebarPath = fileURLToPath(new URL("../reference/typedoc-sidebar.json", import.meta.url));
const referenceSidebar = existsSync(referenceSidebarPath)
  ? JSON.parse(readFileSync(referenceSidebarPath, "utf8"))
  : [];

export default defineConfig({
  title: "CAHMLS SDK",
  description: "Run and talk to Cordn MLS coordinators over Nostr and ContextVM, from a browser tab or Node.js.",
  cleanUrls: true,
  themeConfig: {
    nav: [
      { text: "Guide", link: "/guide/getting-started" },
      { text: "Entry points", link: "/api/" },
      { text: "Reference", link: "/reference/" },
    ],
    sidebar: {
      "/guide/": [
        {
          text: "Introduction",
          items: [
            { text: "Getting started", link: "/guide/getting-started" },
            { text: "Architecture", link: "/guide/architecture" },
          ],
        },
        {
          text: "Using the SDK",
          items: [
            { text: "Hosting a coordinator", link: "/guide/hosting" },
            { text: "Coordinator runtime", link: "/guide/runtime" },
            { text: "Rooms and clients", link: "/guide/rooms" },
            { text: "Storage and environment", link: "/guide/environment" },
            { text: "Bundling for browsers", link: "/guide/bundling" },
          ],
        },
        {
          text: "Operations",
          items: [
            { text: "Security", link: "/guide/security" },
            { text: "Testing", link: "/guide/testing" },
          ],
        },
      ],
      "/api/": [{ text: "Entry points", items: [{ text: "Overview", link: "/api/" }] }],
      "/reference/": [{ text: "API reference", items: referenceSidebar }],
    },
    search: { provider: "local" },
    socialLinks: [{ icon: "github", link: "https://github.com/sandwichfarm/CAHMLS" }],
  },
});
