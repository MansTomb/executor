/**
 * Failures as Executor's telemetry records them. An error whose message can carry an app's own
 * text declares a fixed sentence instead (see `RecordedMessage`); traces and error reports record
 * that sentence with the error's name. The error itself, and what its caller receives, are
 * unchanged.
 */
import { Cause } from "effect";
import { recordedMessage } from "@executor-js/utils/recorded-message";

/**
 * The error a trace or error report records in place of `error`. Its stack is generated here and
 * names no frames: the error's own stack begins with its message, which can span lines that look
 * like frames, so none of its text is kept. Traces still show where it failed through the
 * operation's own spans, which Effect appends to a recorded stack.
 */
export const recordedError = (error: unknown): unknown => {
  const message = recordedMessage(error);
  if (message === undefined || !(error instanceof Error)) return error;
  const recorded = new Error(message);
  recorded.name = error.name;
  recorded.stack = `${error.name}: ${message}`;
  return recorded;
};

/**
 * A failure's cause as traces record it. A defect is recorded the same way when it is an error that
 * declares a recorded message, such as a workflow failure a host turned into a defect; other
 * defects and interruptions are unchanged. Each reason keeps its annotations, which locate it.
 */
export const recordedCause = <E>(cause: Cause.Cause<E>): Cause.Cause<unknown> =>
  Cause.fromReasons(
    Cause.map(cause, recordedError).reasons.flatMap(
      (reason): ReadonlyArray<Cause.Reason<unknown>> =>
        Cause.isDieReason(reason) && recordedMessage(reason.defect) !== undefined
          ? Cause.annotate(Cause.die(recordedError(reason.defect)), Cause.reasonAnnotations(reason))
              .reasons
          : [reason],
    ),
  );
