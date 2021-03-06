// Copyright (c) 2019 Ryan Zeigler
//
// This software is released under the MIT License.
// https://opensource.org/licenses/MIT

import { Option } from "fp-ts/lib/Option";
import { Runtime } from "./internal/runtime";
import { IO } from "./io";
import { Abort, FiberResult, Value } from "./result";

export class Fiber<E, A> {
  /**
   * Join on this fiber.
   *
   * Logically blocks calling fiber until a result is ready.
   * If the target fiber is interrupted this will trigger an abort.
   */
  public readonly join: IO<E, A>;

  /**
   * Wait for fiber completion by complete, failure, or interruption
   */
  public readonly wait: IO<never, FiberResult<E, A>>;

  /**
   * Interrupt the fiber
   *
   * This immediately returns (there are performance considerations when interrupting many fibers and waiting on them)
   * If you need to ensure that the target fiber has finished its cleanup use interruptAndWait
   */
  public readonly interrupt: IO<never, void>;

  /**
   * Interrupt the fiber and then await for its finalizers to run
   */
  public readonly interruptAndWait: IO<never, FiberResult<E, A>>;

  public readonly result: IO<never, Option<FiberResult<E, A>>>;

  constructor(public readonly runtime: Runtime<E, A>) {
    this.join = IO.async((contextSwitch) => {
      function listener(result: FiberResult<E, A>) {
        if (result._tag !== "interrupted") {
          contextSwitch.resume(result);
        }
        // Is this the correct way to handle this?
        contextSwitch.resume(new Abort(new Error("Join on interrupted fiber")));
      }
      runtime.result.listen(listener);
      contextSwitch.setAbort(() => {
        runtime.result.unlisten(listener);
      });
    });

    this.wait = IO.async((contextSwitch) => {
      function listener(r: FiberResult<E, A>) {
        contextSwitch.resume(new Value(r));
      }
      runtime.result.listen(listener);
      contextSwitch.setAbort(() => {
        runtime.result.unlisten(listener);
      });
    });

    // Implementation of kill signals the kill then awaits a result to confirm
    this.interrupt = IO.eval(() => {
      this.runtime.interrupt();
    });

    this.interruptAndWait = this.interrupt.applySecond(this.wait);

    this.result = IO.eval(() => {
      return runtime.result.get();
    });
  }
}
