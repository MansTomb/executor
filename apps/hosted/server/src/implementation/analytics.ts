import { Effect } from "effect";
import { HttpApiBuilder } from "effect/unstable/httpapi";
import { HostedApi } from "../contracts/api.ts";
import { HostedExecutor } from "../contracts/executor.ts";
import { currentOwner } from "./access.ts";
import { authorizeApp } from "./authorization.ts";
import { requireAppAccess } from "./resource-policy.ts";

export const hostedAnalyticsHandlers = HttpApiBuilder.group(HostedApi, "analytics", (handlers) =>
  handlers.handle("summary", ({ params, query }) =>
    Effect.gen(function* () {
      yield* authorizeApp(params.app);
      yield* requireAppAccess(params.app, "use");
      const owner = yield* currentOwner;
      const executor = yield* Effect.flatten(HostedExecutor);
      return yield* executor.analytics.summary({ ...query, app: params.app, owner });
    }),
  ),
);
