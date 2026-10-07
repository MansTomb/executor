import { sentryVitePlugin } from "@sentry/vite-plugin";
import { dashboardViteConfig } from "@executor-js/hosted-web/vite";
import { mergeConfig } from "vite-plus";
import { browserOnlySettings } from "./browser-only-settings.ts";
import { cloudflareRoutes } from "./cloudflare-routes.ts";

const apiUrl = process.env.HOSTED_API_URL ?? "http://127.0.0.1:4411";

export default mergeConfig(
  dashboardViteConfig({
    apiUrl,
    port: 4412,
  }),
  {
    // Cloud's IaC serves documentation beside the dashboard on every stage.
    define: { "import.meta.env.VITE_EXECUTOR_DOCS_BASE_URL": JSON.stringify("/docs/") },
    environments: {
      ssr: {
        define: Object.fromEntries(
          browserOnlySettings.map((name) => [`import.meta.env.${name}`, "undefined"]),
        ),
      },
    },
    // The development dashboard delegates docs to the Worker's built static assets.
    server: { proxy: { "/docs": apiUrl } },
    build: { sourcemap: "hidden" },
    plugins: [
      cloudflareRoutes(),
      // The stack sets a release only for stages that report to Sentry. Every such build injects
      // the same code; only a build holding the upload token sends its source maps.
      ...(process.env.SENTRY_RELEASE
        ? [
            sentryVitePlugin({
              telemetry: false,
              sourcemaps: { filesToDeleteAfterUpload: ["./dist/**/*.map"] },
            }),
          ]
        : []),
    ],
  },
);
