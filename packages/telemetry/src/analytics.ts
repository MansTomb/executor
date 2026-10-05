import { Cause, Clock, Effect, Exit, Logger, Option, Schema } from "effect";
import { captureTelemetry } from "./context.ts";
import type { TelemetryBatch } from "./relay.ts";

const Name = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_.-]{0,63}$/));
const Dimensions = {
  event: Name,
  operation: Schema.optional(Name),
  transport: Schema.optional(Schema.Literals(["rest", "mcp", "http", "executor", "internal"])),
  purpose: Schema.optional(Name),
};
export const AnalyticsEvent = Schema.Union([
  Schema.Struct({
    ...Dimensions,
    phase: Schema.optional(Schema.Never),
    outcome: Schema.optional(Schema.Never),
    statusCode: Schema.optional(Schema.Never),
    durationMs: Schema.optional(Schema.Never),
  }),
  Schema.Struct({ ...Dimensions, phase: Schema.Literal("started") }),
  Schema.Struct({
    ...Dimensions,
    phase: Schema.Literal("completed"),
    outcome: Schema.Literals(["success", "error", "cancelled"]),
    statusCode: Schema.optional(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }))),
    durationMs: Schema.optional(
      Schema.Number.check(Schema.isBetween({ minimum: 0, maximum: 86_400_000 })),
    ),
  }),
]);
export type AnalyticsEvent = typeof AnalyticsEvent.Type;
export const AnalyticsRecord = Schema.Struct({
  id: Schema.String.check(Schema.isPattern(/^[a-f0-9-]{36}$/)),
  timestamp: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  value: AnalyticsEvent,
});
export type AnalyticsRecord = typeof AnalyticsRecord.Type;

export const emitAnalytics = (event: AnalyticsEvent) =>
  Effect.gen(function* () {
    const value = yield* Schema.decodeUnknownEffect(AnalyticsEvent)(event, {
      onExcessProperty: "error",
    });
    const record = yield* Schema.encodeEffect(Schema.fromJsonString(AnalyticsRecord))({
      id: crypto.randomUUID(),
      timestamp: yield* Clock.currentTimeMillis,
      value,
    });
    yield* Effect.logInfo("App analytics event").pipe(
      Effect.annotateLogs({ "executor.analytics.record": record }),
    );
  }).pipe(Effect.catchCause(() => Effect.void));

export const analyticsEmitter = Effect.gen(function* () {
  const runtime = yield* captureTelemetry;
  return {
    emit: (event: AnalyticsEvent): Promise<void> =>
      Effect.runPromiseWith(runtime.context)(emitAnalytics(event)),
  };
});

export const measureAnalytics = <A, E, R>(
  dimensions: {
    event: string;
    operation?: string;
    transport?: "rest" | "mcp" | "http" | "executor" | "internal";
    purpose?: string;
  },
  work: Effect.Effect<A, E, R>,
  failed: (value: A) => boolean = () => false,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    yield* emitAnalytics({ ...dimensions, phase: "started" });
    return yield* work.pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          const outcome = Exit.isFailure(exit)
            ? Cause.hasInterruptsOnly(exit.cause)
              ? "cancelled"
              : "error"
            : failed(exit.value)
              ? "error"
              : "success";
          const status = Exit.isFailure(exit)
            ? Schema.decodeUnknownOption(
                Schema.Struct({
                  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
                }),
              )(Cause.squash(exit.cause))
            : Option.none();
          yield* emitAnalytics({
            ...dimensions,
            phase: "completed",
            outcome,
            ...(Option.isSome(status) ? { statusCode: status.value.status } : {}),
            durationMs: Math.max(0, (yield* Clock.currentTimeMillis) - started),
          });
        }),
      ),
    );
  });

export const collectAnalytics = <A, E, R>(
  work: Effect.Effect<A, E, R>,
  record: (records: readonly AnalyticsRecord[]) => Effect.Effect<void, unknown>,
): Effect.Effect<A, E, R> =>
  Effect.gen(function* () {
    const records: AnalyticsRecord[] = [];
    const logger = Logger.make((options) => {
      if (records.length >= 1000) return;
      const value = Schema.decodeUnknownOption(Schema.fromJsonString(AnalyticsRecord))(
        Logger.formatStructured.log(options).annotations["executor.analytics.record"],
      );
      if (Option.isSome(value)) records.push(value.value);
    });
    const loggers = new Set([...(yield* Logger.CurrentLoggers), logger]);
    return yield* work.pipe(
      Effect.provideService(Logger.CurrentLoggers, loggers),
      Effect.ensuring(
        Effect.suspend(() => record(records)).pipe(Effect.catchCause(() => Effect.void)),
      ),
    );
  });

const Logs = Schema.fromJsonString(
  Schema.Struct({
    resourceLogs: Schema.Array(
      Schema.Struct({
        scopeLogs: Schema.Array(
          Schema.Struct({
            logRecords: Schema.Array(
              Schema.Struct({
                attributes: Schema.optional(
                  Schema.Array(
                    Schema.Struct({
                      key: Schema.String,
                      value: Schema.Struct({ stringValue: Schema.optional(Schema.String) }),
                    }),
                  ),
                ),
              }),
            ),
          }),
        ),
      }),
    ),
  }),
);
export const analyticsRecords = (batch: TelemetryBatch): readonly AnalyticsRecord[] =>
  batch.logs
    .flatMap((body) => {
      const payload = Schema.decodeUnknownOption(Logs)(body);
      if (Option.isNone(payload)) return [];
      return payload.value.resourceLogs.flatMap((resource) =>
        resource.scopeLogs.flatMap((scope) =>
          scope.logRecords.flatMap((log) =>
            (log.attributes ?? []).flatMap((attribute) => {
              if (
                attribute.key !== "executor.analytics.record" ||
                attribute.value.stringValue === undefined
              )
                return [];
              const record = Schema.decodeUnknownOption(Schema.fromJsonString(AnalyticsRecord))(
                attribute.value.stringValue,
              );
              return Option.isSome(record) ? [record.value] : [];
            }),
          ),
        ),
      );
    })
    .slice(0, 1000);
