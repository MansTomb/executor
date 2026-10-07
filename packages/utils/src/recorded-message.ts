import { Predicate } from "effect";

/**
 * What traces and error reports record for an error in place of its message. An error declares
 * one when its message can carry text from outside Executor: an app's own error or output, or an
 * error a service stated through an app. That text still reaches the caller the error is for;
 * Executor's telemetry records only this fixed sentence, beside the error's name.
 */
export const RecordedMessage: unique symbol = Symbol.for("@executor-js/utils/RecordedMessage");

/** The fixed sentence an error declares for telemetry, if it declares one. */
export const recordedMessage = (error: unknown): string | undefined => {
  if (!Predicate.hasProperty(error, RecordedMessage)) return undefined;
  const message = error[RecordedMessage];
  return typeof message === "string" ? message : undefined;
};

/**
 * Declare a recorded message on one error that Executor did not define the text of, such as an
 * error decoded from an app's reply. An error class's own declaration is kept. The error's fields
 * and wire encoding are unchanged.
 */
export const recordAs = <E>(error: E, message: string): E => {
  if (typeof error === "object" && error !== null && recordedMessage(error) === undefined)
    Object.defineProperty(error, RecordedMessage, { value: message });
  return error;
};
