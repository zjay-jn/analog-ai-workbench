export type MainBuildProfileV1 = "production" | "development";

export type MainBuildProfileDescriptorV1 = Readonly<{
  viteConfig: string;
  entry: string;
  reviewedRegistry: "empty" | "synthetic-flat-basic-raw";
  agentBackend: "empty" | "synthetic-approved-raw";
  fixtureLoaderReachable: boolean;
}>;

export const MAIN_BUILD_PROFILES_V1: Readonly<
  Record<MainBuildProfileV1, MainBuildProfileDescriptorV1>
> = Object.freeze({
  production: Object.freeze({
    viteConfig: "apps/desktop/vite.main.config.mts",
    entry: "apps/desktop/src/main/index.ts",
    reviewedRegistry: "empty",
    agentBackend: "empty",
    fixtureLoaderReachable: false,
  }),
  development: Object.freeze({
    viteConfig: "apps/desktop/vite.main.dev.config.mts",
    entry: "apps/desktop/src/main/index.dev.ts",
    reviewedRegistry: "synthetic-flat-basic-raw",
    agentBackend: "synthetic-approved-raw",
    fixtureLoaderReachable: true,
  }),
});
