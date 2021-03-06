// Copyright (c) 2019 Ryan Zeigler
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

import { boundMethod } from "autobind-decorator";
import { none, Option, some } from "fp-ts/lib/Option";
import { ContextSwitch, IO } from "../io";
import { Abort, Cause, FiberResult, interrupted, Raise, Result, Value } from "../result";
import { OneShot } from "./oneshot";

type Frame = ChainFrame | ErrorFrame | FinalizeFrame | InterruptFrame;

interface Call {
  /**
   * Encodes the normal invocation of the call stack where a value is received
   * and the continuation must be processed
   */
  apply(a: unknown): IO<unknown, unknown>;
}

class ChainFrame implements Call {
  public readonly _tag: "chain" = "chain";
  constructor(public readonly f: (a: unknown) => IO<unknown, unknown>) { }
  /**
   * Invoke the chain method
   */
  public apply(a: unknown): IO<unknown, unknown> {
    return this.f(a);
  }
}

class ErrorFrame implements Call {
  public readonly _tag: "error" = "error";
  constructor(public readonly f: (cause: Cause<unknown>) => IO<unknown, unknown>) { }
  /**
   * Normal processing of error frames means pass the value through directly
   */
  public apply(a: unknown): IO<unknown, unknown> {
    return IO.pure(a);
  }
}

class InterruptFrame implements Call {
  public readonly _tag: "interrupt" = "interrupt";
  constructor(public readonly io: IO<unknown, unknown>) { }
  /**
   * Normal processing of interrupt frames mean we do nothign
   */
  public apply(a: unknown): IO<unknown, unknown> {
    return IO.pure(a);
  }
}

class FinalizeFrame implements Call {
  public readonly _tag: "finalize" = "finalize";
  /**
   * Construct a finalize frame.
   * The contract is that this IO should interoperate with the runtime critical segments
   * @param io
   */
  constructor(public readonly io: IO<unknown, unknown>) { }
  /**
   * Normal processing of finalize frames means invoke the finalizer and then
   * return the the value
   */
  public apply(a: unknown): IO<unknown, unknown> {
    return this.io.as(a);
  }
}

class ContextSwitchImpl implements ContextSwitch<unknown, unknown> {
  private delivered: boolean = false;
  private aborted: boolean = false;
  private abort: OneShot<() => void> = new OneShot();

  constructor(private readonly go: (result: Result<unknown, unknown>) => void) { }

  public resume(result: Result<unknown, unknown>): void {
    if (!this.aborted && !this.delivered) {
      this.delivered = true;
      this.go(result);
    }
  }

  public resumeLater(result: Result<unknown, unknown>): void {
    if (!this.aborted && !this.delivered) {
      this.delivered = true;
      setTimeout(() => {
        this.go(result);
      }, 0);
    }
  }

  public setAbort(cancel: () => void): void {
    this.abort.set(cancel);

  }

  public interrupt(): void {
    if (this.abort.isSet()) {
      this.aborted = true;
      this.abort.unsafeGet()();
    } else {
      throw new Error("Bug: Cannot cancel a ContextSwitch with no cancellation");
    }
  }

  public isInterruptible(): boolean {
    return this.abort.isSet();
  }
}

export class Runtime<E, A> {
  public readonly result: OneShot<FiberResult<E, A>> = new OneShot();

  private started: boolean = false;
  private cSwitch: Option<ContextSwitchImpl> = none;
  private readonly callFrames: Frame[] = [];
  private criticalSections: number = 0;
  private interrupted: boolean = false;
  private suspended: boolean = true;

  private enterCritical: IO<never, unknown> = IO.eval(() => {
    this.criticalSections++;
  });

  private leaveCritical: IO<never, unknown> = IO.eval(() => {
    this.criticalSections--;
  });

  public start(io: IO<E, A>): void {
    if (this.started) {
      throw new Error("Bug: Runtime may not be started more than once");
    }
    this.started = true;
    this.loopResume(io as IO<unknown, unknown>);
  }

  public interrupt(): void {
    // Only interrupt when not complete and this is the first interrupt
    if (!this.result.isSet() && !this.interrupted) {
      this.interrupted = true;
      if (this.criticalSections === 0) {
        // It is possible we were interrupted before the runloop started
        // If so then we just allow the runloop to start and immediately interrupt itself
        if (this.suspended && this.cSwitch.isSome() && this.cSwitch.value.isInterruptible()) {
          this.cSwitch.value.interrupt();
          this.interruptFinalize();
        }
      }
    }
  }

  @boundMethod
  private loopResume(next: IO<unknown, unknown>): void {
    this.loop(next, this.loopResume);
  }

  @boundMethod
  private interruptLoopResume(next: IO<unknown, unknown>): void {
    this.interruptLoop(next, this.interruptLoopResume);
  }

  @boundMethod
  private loop(io: IO<unknown, unknown>, resume: (next: IO<unknown, unknown>) => void): void {
    let current: IO<unknown, unknown> | undefined = io;
    // Using do ensures that we resume at least one step in the face of an interrupted resumeLater
    // which is the case of an interrupt being delivered after the resumeLater is queued.
    // Thus, we are technically past and if there is a critical section coming as the next io we can enter it
    do {
      current = this.step(current, resume, this.complete);
    } while (current && (!this.interrupted || this.criticalSections > 0));
    /**
     * We were interrupted so determine if we need to switch to the finalize loop
     */
    if (current) {
      /**
       * Ensure that if current is an ensuring or interrupt we have pushed the cleanup action before we finalize.
       * TODO: Share this code with the runloop?
       */
      if (current.step._tag === "oninterrupted") {
        this.callFrames.push(new InterruptFrame(
          this.enterCritical
          .applySecond(current.step.interupted)
          .applySecond(this.leaveCritical) as unknown as IO<unknown, unknown>));
      } else if (current.step._tag === "ondone") {
        this.callFrames.push(new FinalizeFrame(
          this.enterCritical
            .applySecond(current.step.always)
            .applySecond(this.leaveCritical) as unknown as IO<unknown, unknown>));
      }
      this.interruptFinalize();
    }
  }

  @boundMethod
  private interruptFinalize(): void {
    const finalize = this.unwindInterrupt();
    if (finalize) {
      this.interruptLoopResume(finalize);
    } else {
      this.result.set(interrupted);
    }
  }

  @boundMethod
  private interruptLoop(io: IO<unknown, unknown>, resume: (next: IO<unknown, unknown>) => void): void {
    let current: IO<unknown, unknown> | undefined = io;
    while (current) {
      current = this.step(current, resume, this.interruptComplete);
    }
  }

  @boundMethod
  private complete(result: Result<unknown, unknown>): void {
    /**
     * If a result is already set, don't do anything.
     * This happens for instance, in the case of race, where setting the deferred synchronously advances
     * the supervisor fiber which will then cause a cancellation.
     * On unwind, the supervised fiber will attempt to complete here and get a multiple sets error
     */
    if (this.result.isUnset()) {
      this.result.set(result as Result<E, A>);
    }
  }

  @boundMethod
  private interruptComplete(_: Result<unknown, unknown>): void {
    this.result.set(interrupted);
  }

  private step(current: IO<unknown, unknown>,
               resume: (next: IO<unknown, unknown>) => void,
               complete: (result: Result<unknown, unknown>) => void): IO<unknown, unknown> | undefined {
    try {
      if (current.step._tag === "of") {
        return this.popFrame(current.step.value, complete);
      } else if (current.step._tag === "failed") {
        return this.unwindError(new Raise(current.step.error), complete);
      } else if (current.step._tag === "raised") {
        return this.unwindError(current.step.raise, complete);
      } else if (current.step._tag === "suspend") {
        return current.step.thunk();
      } else if (current.step._tag === "async") {
        this.contextSwitch(current.step.start, resume, complete);
        return;
      } else if (current.step._tag === "critical") {
        // Once enter critical completes we are guaranteed leave critical
        return (this.enterCritical as unknown as IO<unknown, unknown>)
        .applySecond(current.step.io.onComplete(this.leaveCritical as unknown as IO<never, unknown>));
      } else if (current.step._tag === "chain") {
        this.callFrames.push(new ChainFrame(current.step.chain));
        return current.step.left;
      } else if (current.step._tag === "chainerror") {
        this.callFrames.push(new ErrorFrame(current.step.chain));
        return current.step.left;
      } else if (current.step._tag === "ondone") {
        this.callFrames.push(new FinalizeFrame(
          this.enterCritical
            .applySecond(current.step.always)
            .applySecond(this.leaveCritical) as unknown as IO<unknown, unknown>));
        return current.step.first;
      } else if (current.step._tag === "oninterrupted") {
        this.callFrames.push(new InterruptFrame(
          this.enterCritical
          .applySecond(current.step.interupted)
          .applySecond(this.leaveCritical) as unknown as IO<unknown, unknown>));
        return current.step.first;
      } else {
        throw new Error(`Bug: Unrecognized step tag: ${(current.step as any)._tag}`);
      }
    } catch (e) {
      return IO.aborted(new Abort(e)) as unknown as IO<unknown, unknown>;
    }
  }

  @boundMethod
  private contextSwitch(
    go: (cSwitch: ContextSwitch<unknown, unknown>) => void,
    resume: (next: IO<unknown, unknown>) => void,
    complete: (result: Result<unknown, unknown>) => void): void {
    const cSwitch = new ContextSwitchImpl((result) => {
      this.suspended = false;
      this.cSwitch = none;
      const next = result._tag === "value" ? this.popFrame(result.value, complete) : this.unwindError(result, complete);
      if (next) {
        resume(next);
      }
    });
    this.cSwitch = some(cSwitch);
    this.suspended = true;
    go(cSwitch);
  }

  @boundMethod
  private popFrame(result: unknown,
                   complete: (result: Result<unknown, unknown>) => void): IO<unknown, unknown> | undefined {
    const frame = this.callFrames.pop();
    if (frame) {
      return frame.apply(result);
    }
    complete(new Value(result));
    return;
  }

  @boundMethod
  private unwindError(cause: Cause<unknown>,
                      complete: (result: Result<unknown, unknown>) => void): IO<unknown, unknown> | undefined {
    const finalizers: FinalizeFrame[] = [];
    let frame: ErrorFrame | undefined;
    while (!frame && this.callFrames.length > 0) {
      const candidate = this.callFrames.pop()!;
      if (candidate._tag === "error") {
        frame = candidate;
      } else if (candidate._tag === "finalize") {
        finalizers.push(candidate);
      }
    }
    if (finalizers.length > 0) {
      // If there are finalizers, create a composite finalizer action that rethrows and then repush the error
      const io = createCompositeFinalizer(cause, finalizers);
      // If we have an error handler, push it back onto the stack to handle the rethrow from the finalizer
      if (frame) {
        this.callFrames.push(frame);
      }
      return io;
    } else if (frame) {
      // If we have only a handler, invoke it here
      return frame.f(cause);
    }
    // We are done, so time to explode with a failure
    complete(cause);
    return;
  }

  @boundMethod
  private unwindInterrupt(): IO<unknown, unknown> | undefined {
    const finalizers: Array<FinalizeFrame | InterruptFrame> = [];
    while (this.callFrames.length > 0) {
      const candidate = this.callFrames.pop();
      if (candidate && (candidate._tag === "finalize" || candidate._tag === "interrupt")) {
        finalizers.push(candidate);
      }
    }
    if (finalizers.length > 0) {
      const ios = finalizers.map((final) => final.io);
      const combined: IO<never, void> =
        ios.reduce((first, second) => first.applySecond(second.resurrect()).as(undefined), IO.of(undefined));
      return combined as unknown as IO<unknown, unknown>;
    }
    return;
  }
  }

/**
 * Create a single composite uninterruptible finalizer
 * @param  cause [description] The initial cause to rethrow
 * @param  array [description] A non-empty array of FinalizeFrames
 * @return       [description] and IO action that executes all of the finalizers
 */
function createCompositeFinalizer(cause: Cause<unknown>,
                                  finalizers: FinalizeFrame[]): IO<unknown, unknown> {
  const finalizerIOs = finalizers.map((final) => final.io);
  return finalizerIOs.reduce((before, after) => IO.of(compositeCause).ap_(before).ap_(after.resurrect()), IO.of(cause))
  .widenError<unknown>()
  .chain(IO.caused);
}

const compositeCause = (base: Cause<unknown>) => (more: Result<unknown, unknown>): Cause<unknown> =>
  more._tag === "value" ? base : base.and(more);
