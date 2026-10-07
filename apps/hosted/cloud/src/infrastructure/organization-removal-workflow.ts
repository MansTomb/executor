/**
 * Organization removal as one durable workflow. It is the same mechanism as
 * `AppWorkflows`: an Alchemy `Cloudflare.Workflow` class hosted by the API
 * Worker. Deployed cloud runs it on Cloudflare Workflows; `alchemy dev` runs
 * the identical class in the local workerd runtime, so there is no second
 * implementation and no Node fallback. Self-host composes no removal route at
 * all, so it needs no workflow here.
 */
import * as Cloudflare from "alchemy/Cloudflare";
import { Cause, Context, Effect, Option, Schema } from "effect";
import { GroupDatabase } from "@executor-js/hosted-server/groups";
import {
  Authentication,
  HostedExecutor,
  OrganizationBilling,
  OrganizationIcons,
  OrganizationId,
  OrganizationRemovalFailed,
  OrganizationRemovals,
  OrganizationRemovalUnavailable,
  removeOrganizationDurably,
  type OrganizationRemovalStepRunner,
} from "@executor-js/hosted-server";
import { Billing } from "../contracts/billing.ts";
import { cloudSentry } from "../implementation/error-reporting.ts";
import { EventCleanup, sqlCancellation } from "./event-cleanup.ts";

/** One failed attempt. The engine retries only typed failures it can serialize. */
class RemovalAttemptFailed extends Schema.TaggedError<RemovalAttemptFailed>()(
  "RemovalAttemptFailed",
  {},
) {}

/**
 * One durable step. The engine owns the journal and the retries; a body that
 * still fails after them becomes a named failure, so the report and the failed
 * instance both say which step stopped and for which organization.
 */
const runner =
  (
    organization: OrganizationId,
  ): OrganizationRemovalStepRunner<Cloudflare.Workflows.WorkflowStep> =>
  <A>(
    name: Parameters<OrganizationRemovalStepRunner>[0],
    retries: Parameters<OrganizationRemovalStepRunner>[1],
    work: Effect.Effect<A, unknown>,
  ) =>
    Cloudflare.Workflows.task(
      name,
      work.pipe(
        Effect.withSpan("organization.removal.step", {
          attributes: { "executor.organization.id": organization, "executor.removal.step": name },
        }),
        Effect.catchCause((cause) =>
          Cause.hasInterrupts(cause)
            ? Effect.interrupt
            : Effect.logError("Organization removal step failed", cause).pipe(
                Effect.andThen(Effect.fail(new RemovalAttemptFailed())),
              ),
        ),
      ),
      { retries },
    ).pipe(Effect.mapError(() => new OrganizationRemovalFailed({ organization, step: name })));

export class OrganizationRemoval extends Cloudflare.Workflow<OrganizationRemoval>()(
  "OrganizationRemoval",
  Effect.gen(function* () {
    const reportErrors = yield* cloudSentry;
    // The Worker that yields this class supplies the services; Alchemy captures them. Only
    // these: the Worker's context also holds its own scope, and providing that to a run would
    // replace the run's scope, so per-execution resources would outlive the run.
    const services = yield* Effect.context<
      HostedExecutor | OrganizationIcons | OrganizationRemovals | Authentication | Billing
    >().pipe(
      Effect.map(
        Context.pick(
          HostedExecutor,
          OrganizationIcons,
          OrganizationRemovals,
          Authentication,
          Billing,
        ),
      ),
    );
    // Cancellation reaches the workflow as the host's billing service, not as a
    // branch on the deployment. A host without one keeps the inert default.
    const billing = Context.get(services, Billing);
    const cancellation = OrganizationBilling.of({
      cancel: (organization: OrganizationId) => billing.cancel(organization),
    });
    return (input: { organization: string }) =>
      Effect.suspend(() => {
        const organization = OrganizationId.make(input.organization);
        return removeOrganizationDurably(organization, runner(organization)).pipe(
          Effect.provide(services),
          Effect.provideService(OrganizationBilling, cancellation),
          // Report through the same Sentry boundary the API uses, carrying the
          // organization and the step in the failure itself, and then leave the
          // instance failed: nothing else watches a workflow that stops part
          // way through an irreversible erasure.
          reportErrors,
          Effect.orDie,
        );
      });
  }),
) {}

/** Start an organization's removal on the host's workflow binding. */
export class OrganizationRemovalStart extends Context.Service<
  OrganizationRemovalStart,
  (
    organization: OrganizationId,
    instance: string,
  ) => Effect.Effect<void, OrganizationRemovalUnavailable>
>()("executor/cloud/OrganizationRemovalStart") {}

/**
 * How long one Workflows call may take. A create or a status read normally answers in well under
 * a second, but about one create in a few hundred hangs for 12 or 30 seconds and then fails
 * without creating the instance. A call past this deadline counts as refused, so a stalled call
 * cannot use up the time a fresh one would need.
 */
const callDeadline = "3 seconds";

/**
 * Create the stable removal instance. A refused create may still have taken, its answer lost, or
 * an earlier start may already have made it, so the status read decides: only an instance
 * Workflows does not know is still pending.
 */
export const startOrganizationRemoval =
  (workflow: Effect.Success<typeof OrganizationRemoval>) =>
  (organization: OrganizationId, instance: string) =>
    workflow.create({ id: instance, params: { organization } }).pipe(
      Effect.timeout(callDeadline),
      Effect.asVoid,
      Effect.catchCause((cause) =>
        Cause.hasInterrupts(cause)
          ? Effect.interrupt
          : workflow.get(instance).pipe(
              Effect.flatMap((run) => run.status()),
              Effect.timeout(callDeadline),
              Effect.catchCause((cause) =>
                Cause.hasInterrupts(cause)
                  ? Effect.interrupt
                  : Effect.succeed({ status: "unknown" }),
              ),
              Effect.flatMap((state) =>
                state.status === "unknown"
                  ? Effect.fail(new OrganizationRemovalUnavailable())
                  : Effect.void,
              ),
            ),
      ),
      Effect.withSpan("organization.removal.start"),
    );

/**
 * Start a removal the request has just accepted, once its response is sent. The tombstone is
 * already the durable start record, so the owner never waits on the provider. Within the event's
 * cleanup window the start is dispatched again until the instance exists; the minute job takes
 * whatever is still pending after that. Cron alone is not enough: a deployment's Cron Triggers
 * take minutes to begin, and until then nothing else would start the removal.
 */
export const dispatchAcceptedRemoval = (
  start: OrganizationRemovalStart["Service"],
  organization: OrganizationId,
  instance: string,
) =>
  Effect.flatMap(EventCleanup, (cleanup) =>
    Effect.addFinalizer(() =>
      cleanup.deadline.pipe(
        Effect.flatMap((deadline) =>
          deadline.within(
            start(organization, instance).pipe(
              Effect.tapError(() => Effect.sleep("500 millis")),
              Effect.eventually,
            ),
            // The write's jobs and Better Auth's cleanup run after this in the same window.
            { max: "10 seconds", reserve: sqlCancellation },
          ),
        ),
        Effect.flatMap((started) =>
          Option.isSome(started)
            ? Effect.void
            : Effect.logWarning("Organization removal start pending", { organization }),
        ),
      ),
    ),
  );

/** Tombstones are the durable start journal; recover a provider refusal or process loss. */
export const dispatchOrganizationRemovals = Effect.gen(function* () {
  const start = yield* OrganizationRemovalStart;
  const sql = yield* Effect.flatten(GroupDatabase);
  const pending = yield* sql`select organization_id, instance_id from hosted_organization_removal
    where status = 'running' order by started_at limit 50`.pipe(
    Effect.flatMap(
      Schema.decodeUnknownEffect(
        Schema.Array(
          Schema.Struct({
            organization_id: OrganizationId,
            instance_id: Schema.NonEmptyString,
          }),
        ),
      ),
    ),
  );
  yield* Effect.forEach(
    pending,
    (record) =>
      start(record.organization_id, record.instance_id).pipe(
        Effect.catch(() =>
          Effect.logWarning("Organization removal start remains pending", {
            organization: record.organization_id,
          }),
        ),
      ),
    { concurrency: 2, discard: true },
  );
}).pipe(Effect.withSpan("job.organization-removal.dispatch"));
