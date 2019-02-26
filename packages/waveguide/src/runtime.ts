import { boundMethod } from "autobind-decorator";
import { array } from "fp-ts/lib/Array";
import { Either } from "fp-ts/lib/Either";
import { Abort, Cause, Raise } from "./cause";
import { Fuse } from "./fuse";
import { caused, IO, of, sync, syntax } from "./io";
import { Async, Caused } from "./iostep";
import { OneShot } from "./oneshot";
import { Completed, Failed, Killed, Result } from "./result";

export type Frame = ChainFrame | ErrorFrame | FinalizeFrame;

export interface Call {
  /**
   * Encodes the normal invocation of the call stack where a value is received
   * and the continuation must be processed
   */
  apply(a: unknown): IO<unknown, unknown>;
}

export class ChainFrame implements Call {
  public readonly _tag: "chain" = "chain";
  constructor(public readonly f: (a: unknown) => IO<unknown, unknown>) { }
  /**
   * Invoke the chain method
   */
  public apply(a: unknown): IO<unknown, unknown> {
    return this.f(a);
  }
}

export class ErrorFrame implements Call {
  public readonly _tag: "error" = "error";
  constructor(public readonly f: (cause: Cause<unknown>) => IO<unknown, unknown>) { }
  /**
   * Normal processing of error frames means pass the value through directly
   */
  public apply(a: unknown): IO<unknown, unknown> {
    return syntax<unknown>().of(a);
  }
}

/* I find this type deeply confusing, apologies. Basically, we are encoding an async boundary link.
 * In order to cross an async boundary we need a function (cont) that is able to receive an async callback
 * ((Either => void) => (() => void))
 * which is responsible for doing the linking
 */
type AsyncHop = (cont: (callback: (result: Either<Cause<unknown>, unknown>) => void) => (() => void)) => void;

export class FinalizeFrame implements Call {
  public readonly _tag: "finalize" = "finalize";
  constructor(public readonly io: IO<unknown, unknown>) { }
  /**
   * Normal processing of finalize frames means invoke the finalizer and then
   * return the the value
   */
  public apply(a: unknown): IO<unknown, unknown> {
    return this.io.as(a);
  }
}

export class Runtime<E, A> {
  public readonly result: OneShot<Result<E, A>> = new OneShot();

  private started: boolean = false;

  private fuse: Fuse<Either<Cause<unknown>, unknown>> | null = null;
  private readonly callFrames: Frame[] = [];

  private halting: boolean = false;

  public start(io: IO<E, A>): void {
    if (this.started) {
      throw new Error("Bug: Runtime may not be started more than once");
    }
    this.started = true;
    this.loop(io as IO<unknown, unknown>, this.asyncHop);
  }

  public halt(): void {
    console.log(this.result.isSet(), this.halting);
    if (!this.result.isSet() && !this.halting) {
      this.halting = true;
      /**
       * Assume that the only reason we aren't in the runloop and thus able to kill halt is
       * because we hit an async boundary. The side effect of an async boundary sets up a fuse
       */
      console.log("fuse.block");
      this.fuse!.block();
      this.result.set(new Killed());
    }
  }

  @boundMethod
  private loop(io: IO<unknown, unknown>, hop: AsyncHop): void {
    let boundary: Async<unknown, unknown> | undefined;
    let current: IO<unknown, unknown> | undefined = io;
    while (current) {
      if (current.step._tag === "of") {
        current = this.popFrame(current.step.value);
      } else if (current.step._tag === "failed") {
        current = this.unwindError(new Raise(current.step.error));
      } else if (current.step._tag === "raised") {
        current = this.unwindError(current.step.raise);
      } else if (current.step._tag === "suspend") {
        try {
          current = current.step.thunk();
        } catch (e) {
          current = new IO(new Caused(new Abort(e)));
        }
      } else if (current.step._tag === "async") {
        boundary = current.step;
        current = undefined;
      } else if (current.step._tag === "chain") {
        this.callFrames.push(new ChainFrame(current.step.chain));
        current = current.step.left;
      } else if (current.step._tag === "chainerror") {
        this.callFrames.push(new ErrorFrame(current.step.chain));
        current = current.step.left;
      } else if (current.step._tag === "finally") {
        this.callFrames.push(new FinalizeFrame(current.step.always));
        current = current.step.first;
      } else if (current.step._tag === "bracket") {
        const bracket = current.step;
        current = current.step.resource.chain((resource) => sync(() => {
          // Push these things onto the call stack to ensure that we can correctly consume them on subsequent runs
          this.callFrames.push(new FinalizeFrame(bracket.release(resource)));
          this.callFrames.push(new ChainFrame(bracket.consume));
          return resource;
        }));
      } else {
        throw new Error(`Bug: Unrecognized step tag: ${current.step}`);
      }
    }
    if (boundary) {
      hop(boundary.start);
    }
  }

  @boundMethod
  private asyncHop(continuation: (callback: (result: Either<Cause<unknown>, unknown>) => void) => (() => void)): void {
    this.fuse = new Fuse(continuation);
    this.fuse.adapted((result) => {
      const next = result.fold((cause) => this.unwindError(cause), (value) => this.popFrame(value));
      if (next) {
        this.loop(next, this.asyncHop);
      }
    });
  }

  @boundMethod
  private popFrame(result: unknown): IO<unknown, unknown> | undefined {
    const frame = this.callFrames.pop();
    if (frame) {
      return frame.apply(result);
    }
    this.result.set(new Completed(result as A));
    return;
  }

  @boundMethod
  private unwindError(cause: Cause<unknown>): IO<unknown, unknown> | undefined {
    const finalizers: FinalizeFrame[] = [];
    let frame: ErrorFrame | undefined;
    while (frame === null && this.callFrames.length > 0) {
      const candidate = this.callFrames.pop();
      if (candidate && candidate._tag === "error") {
        frame = candidate;
      } else if (candidate && candidate._tag === "finalize") {
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
    this.result.set(new Failed(cause as Cause<E>));
    return;
  }

  @boundMethod
  private unwindHalt(): IO<never, void> | undefined {
    const finalizers: FinalizeFrame[] = [];
    while (this.callFrames.length > 0) {
      const candidate = this.callFrames.pop();
      if (candidate && candidate._tag === "finalize") {
        finalizers.push(candidate);
      }
    }
    if (finalizers.length > 0) {
      const ios = finalizers.map((final) => final.io);
      return array.reduce(ios, of<{}>({}), (left, right) => left.applySecond(right.resurrect()).as({}))
        .empty();
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
  return array.reduce(finalizerIOs, of(cause), (before, after) =>
      of(compositeCause).ap_(before).ap_(after.resurrect()))
    .widenError<unknown>()
    .chain(caused);
}

const compositeCause = (base: Cause<unknown>) => (more: Either<Cause<unknown>, unknown>): Cause<unknown> =>
  more.fold((c) => base.and(c), (_) => base);