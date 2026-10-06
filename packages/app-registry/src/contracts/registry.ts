/** Public app listings identify a chosen Git revision, without package versions or dependency resolution. */
import { Schema, type Effect } from "effect";
import { ApiError } from "@executor-js/utils/api-error";
import { appSlug, SourceCommit, SourceFiles } from "@executor-js/sdk/core";

/** The hosted Executor origin: the default public registry and the hosted sign-in host. */
export const hostedExecutorOrigin = "https://v2.executor.sh";

/** Public name inside a publishing owner's namespace. */
export const PackageName = Schema.String.check(
  Schema.isPattern(/^@[a-z0-9][a-z0-9-]{0,79}\/[a-z0-9][a-z0-9-]{0,62}$/),
);
/** Standard npm metadata remains source; only name and description identify a public listing. */
export const PackageManifest = Schema.Struct({
  name: PackageName,
  description: Schema.optional(Schema.String.check(Schema.isMaxLength(2000))),
  executor: Schema.optional(
    Schema.Struct({
      dependencies: Schema.optional(Schema.Record(Schema.String, Schema.String)),
    }),
  ),
});
/** Derive a public name from an authenticated publishing namespace and an app label. */
export const publicPackageName = (namespace: string, name: string) => {
  const label = Schema.is(PackageName)(name) ? name.slice(name.indexOf("/") + 1) : name;
  return Schema.decodeUnknownOption(PackageName)(`@${namespace}/${appSlug(label)}`);
};

/** A source or ownership issue that the author can repair before publishing. */
export class PublicationIssue extends Schema.TaggedError<PublicationIssue>()("PublicationIssue", {
  reason: Schema.Literals([
    "missing-manifest",
    "invalid-json",
    "missing-name",
    "unscoped-name",
    "invalid-name",
    "invalid-metadata",
    "unsupported-dependencies",
    "invalid-source",
    "limit",
    "forbidden-scope",
    "name-taken",
  ]),
  name: Schema.NullOr(Schema.String),
}) {}

/** Read-only publication checks for this app and owner; publishing rechecks the same rules. */
export const PublicationReadiness = Schema.Union([
  Schema.Struct({ status: Schema.Literal("ready"), manifest: PackageManifest }),
  Schema.Struct({
    status: Schema.Literal("blocked"),
    issue: PublicationIssue,
    suggestedName: Schema.NullOr(PackageName),
  }),
]);

/** One current public listing. The commit is the author's selected Git revision. */
export const Publication = Schema.Struct({
  name: PackageName,
  commit: SourceCommit,
  description: Schema.String,
  publishedAt: Schema.String,
});
/** A complete source copy, with no private Git history, credentials, or app data. */
export const PublicationSnapshot = Schema.Struct({ publication: Publication, files: SourceFiles });
/** Public copies identify the exact revision the user reviewed. */
export const PublicationReference = Schema.Struct({
  package: PackageName,
  commit: SourceCommit,
});
const registryFailures = {
  "not-found": "The public app listing or its selected commit does not exist.",
  forbidden: "This publisher may not use this package scope or change this public listing.",
  conflict: "Another app already publishes this package name.",
  changed:
    "The public listing changed since its commit was reviewed. Review the current listing before copying it.",
  "invalid-source": "The app source at this commit cannot be read as a public listing.",
  "invalid-manifest":
    "The app's package.json needs a valid package name in the publisher's scope and valid metadata.",
  "unsupported-dependencies": "The app declares dependencies that public listings do not support.",
  storage: "Executor could not read or write the public app catalog. Try again.",
  network: "Executor could not reach the public app registry. Try again.",
  status: "The public app registry returned an unexpected HTTP status.",
  "invalid-response": "The public app registry returned a response Executor could not read.",
  limit: "The public app registry's response exceeded Executor's size limit.",
} as const;
/** Safe public-catalog failures. */
export const RegistryError = ApiError.define({
  tag: "RegistryError",
  status: 400,
  fields: {
    reason: Schema.Literals([
      "not-found",
      "forbidden",
      "conflict",
      "changed",
      "invalid-source",
      "invalid-manifest",
      "unsupported-dependencies",
      "storage",
      "network",
      "status",
      "invalid-response",
      "limit",
    ]),
    /** The remote registry's HTTP status, for a `status` failure. */
    status: Schema.optional(Schema.Int),
  },
  message: ({ reason, status }) =>
    reason === "status" && status !== undefined
      ? `The public app registry responded with HTTP ${status}.`
      : registryFailures[reason],
});
export type RegistryError = typeof RegistryError.Type;
/** Public reads require a selected commit; a changed listing never silently selects newer code. */
export interface Registry {
  readonly origin: string;
  readonly list: (
    name?: string,
  ) => Effect.Effect<ReadonlyArray<typeof Publication.Type>, RegistryError>;
  readonly snapshot: (
    name: string,
    commit: string,
  ) => Effect.Effect<typeof PublicationSnapshot.Type, RegistryError>;
}

/** A public listing has one stable URL even when its selected commit changes. */
export const registryPublicationPath = (name: string): string =>
  `/apps/${name.slice(1).split("/").map(encodeURIComponent).join("/")}`;
