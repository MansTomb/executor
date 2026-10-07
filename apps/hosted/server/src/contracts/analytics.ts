import {
  AnalyticsQuery,
  AnalyticsSummary,
  AppId,
  AppNotFound,
  RequestInvalid,
  StorageError,
} from "@executor-js/sdk/core";
import { HttpApiEndpoint, HttpApiGroup } from "effect/unstable/httpapi";
import { OrganizationReference, RequireOrganization } from "./organization.ts";
import { RequiredAction } from "./authorization.ts";

export const HostedAnalytics = HttpApiGroup.make("analytics")
  .add(
    HttpApiEndpoint.get("summary", "/api/organizations/:organization/apps/:app/analytics", {
      params: { organization: OrganizationReference, app: AppId },
      query: AnalyticsQuery,
      success: AnalyticsSummary,
      error: [AppNotFound, RequestInvalid, StorageError],
    }).annotate(RequiredAction, "discover"),
  )
  .middleware(RequireOrganization);
