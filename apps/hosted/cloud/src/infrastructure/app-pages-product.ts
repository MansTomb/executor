/** App pages serve deployed builds and app data over the shared executor, and nothing else. */
import type * as Cloudflare from "alchemy/Cloudflare";
import { Effect } from "effect";
import { cloudProductServices } from "./product-services.ts";
import type { AppSources } from "./source.ts";
import type { AppDataSupervisor } from "./app-data.ts";

/**
 * Nothing app pages run reads or writes app source, so they upload no Git client. A source
 * operation here is a defect, not a missing repository.
 */
const noSource = (operation: string) =>
  Effect.die(new Error(`App pages do not serve app source (${operation})`));
const appPagesSources: AppSources = () => ({
  history: () => noSource("history"),
  create: () => noSource("create"),
  head: () => noSource("head"),
  read: () => noSource("read"),
  commit: () => noSource("commit"),
  request: () => noSource("request"),
});

/**
 * What app pages serve: apps, profiles, accounts, app data and build assets. This module never
 * imports `product.ts`, so the Worker uploads none of the source, management and provisioning
 * code the other Workers compose.
 */
export const cloudAppPagesProduct = (databases: Cloudflare.DurableObject<AppDataSupervisor>) =>
  cloudProductServices(databases, appPagesSources).pipe(Effect.map(({ services }) => services));
