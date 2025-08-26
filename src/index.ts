import FrameLoop from './frameloop'
import * as interpolate from './tw-interpolate'
;(function (Scratch) {
  if (Scratch.extensions.unsandboxed === false) {
    throw new Error('Sandboxed mode is not supported')
  }
  const vm = Scratch.vm
  const runtime = vm.runtime as VM.Runtime & {
    screenRefreshTime?: number
    _renderInterpolatedPositions(): void
  }
  function getThread() {
    const thread = vm.runtime._pushThread(
      '',
      {
        blocks: {
          getBlock() {
            return {}
          }
        }
      } as any,
      { updateMonitor: true }
    )
    vm.runtime.sequencer.retireThread(thread)
    return thread.constructor as unknown as {
      STATUS_RUNNING: 0
      STATUS_PROMISE_WAIT: 1
      STATUS_YIELD: 2
      STATUS_YIELD_TICK: 3
      STATUS_DONE: 4
    }
  }
  const Thread = getThread()
  /**
   * Screen refresh time speculated from screen refresh rate, in milliseconds.
   * Indicates time passed between two screen refreshments.
   * Based on site isolation status, the resolution could be ~0.1ms or lower.
   * @type {!number}
   */
  runtime.screenRefreshTime = 0
  delete runtime._lastStepTime
  Object.defineProperty(runtime, '_lastStepTime', {
    get() {
      return (runtime.frameLoop as any)._lastStepTime
    }
  })
  runtime._renderInterpolatedPositions = function () {
    const frameStarted = this.frameLoop._lastStepTime
    const now = this.frameLoop.now()
    const timeSinceStart = now - frameStarted
    const progressInFrame = Math.min(
      1,
      Math.max(0, timeSinceStart / this.currentStepTime)
    )

    interpolate.interpolate(this, progressInFrame)

    if (this.renderer) {
      this.renderer.draw()
    }
  }
  /**
   * Profiler frame name for stepping a single thread.
   * @const {string}
   */
  const stepThreadProfilerFrame = 'Sequencer.stepThread'

  /**
   * Profiler frame name for the inner loop of stepThreads.
   * @const {string}
   */
  const stepThreadsInnerProfilerFrame = 'Sequencer.stepThreads#inner'

  /**
   * Profiler frame ID for stepThreadProfilerFrame.
   * @type {number}
   */
  let stepThreadProfilerId: number = -1

  /**
   * Profiler frame ID for stepThreadsInnerProfilerFrame.
   * @type {number}
   */
  let stepThreadsInnerProfilerId: number = -1

  runtime.sequencer.stepThreads = function () {
    // Work time is 75% of the thread stepping interval.
    const WORK_TIME = 0.75 * this.runtime.currentStepTime
    // For compatibility with Scatch 2, update the millisecond clock
    // on the Runtime once per step (see Interpreter.as in Scratch 2
    // for original use of `currentMSecs`)
    this.runtime.updateCurrentMSecs()
    // Start counting toward WORK_TIME.
    this.timer.start()
    // Count of active threads.
    let numActiveThreads = Infinity
    // Whether `stepThreads` has run through a full single tick.
    let ranFirstTick = false
    const doneThreads = []

    // tw: If this happens, the runtime is in initialization, do not execute any thread.
    if (this.runtime.currentStepTime === 0) return []
    // Conditions for continuing to stepping threads:
    // 1. We must have threads in the list, and some must be active.
    // 2. Time elapsed must be less than WORK_TIME.
    // 3. Either turbo mode, or no redraw has been requested by a primitive.
    while (
      this.runtime.threads.length > 0 &&
      numActiveThreads > 0 &&
      (this.runtime.turboMode || !this.runtime.redrawRequested)
    ) {
      if (this.runtime.profiler !== null) {
        if (stepThreadsInnerProfilerId === -1) {
          stepThreadsInnerProfilerId = this.runtime.profiler.idByName(
            stepThreadsInnerProfilerFrame
          )
        }
        this.runtime.profiler.start(stepThreadsInnerProfilerId)
      }

      numActiveThreads = 0
      let stoppedThread = false
      // Attempt to run each thread one time.
      const threads = this.runtime.threads
      for (let i = 0; i < threads.length; i++) {
        const activeThread = (this.activeThread = threads[i])
        // Check if the thread is done so it is not executed.
        if (
          activeThread.stack.length === 0 ||
          activeThread.status === Thread.STATUS_DONE
        ) {
          // Finished with this thread.
          stoppedThread = true
          continue
        }
        if (activeThread.status === Thread.STATUS_YIELD_TICK && !ranFirstTick) {
          // Clear single-tick yield from the last call of `stepThreads`.
          activeThread.status = Thread.STATUS_RUNNING
        }
        if (
          activeThread.status === Thread.STATUS_RUNNING ||
          activeThread.status === Thread.STATUS_YIELD
        ) {
          // Normal-mode thread: step.
          if (this.runtime.profiler !== null) {
            if (stepThreadProfilerId === -1) {
              stepThreadProfilerId = this.runtime.profiler.idByName(
                stepThreadProfilerFrame
              )
            }

            // Increment the number of times stepThread is called.
            this.runtime.profiler.increment(stepThreadProfilerId)
          }
          this.stepThread(activeThread)
          activeThread.warpTimer = null
        }
        if (activeThread.status === Thread.STATUS_RUNNING) {
          numActiveThreads++
        }
        // Check if the thread completed while it just stepped to make
        // sure we remove it before the next iteration of all threads.
        if (
          activeThread.stack.length === 0 ||
          activeThread.status === Thread.STATUS_DONE
        ) {
          // Finished with this thread.
          stoppedThread = true
        }
      }
      // We successfully ticked once. Prevents running STATUS_YIELD_TICK
      // threads on the next tick.
      ranFirstTick = true

      if (this.runtime.profiler !== null) {
        this.runtime.profiler.stop()
      }

      // Filter inactive threads from `this.runtime.threads`.
      if (stoppedThread) {
        let nextActiveThread = 0
        for (let i = 0; i < this.runtime.threads.length; i++) {
          const thread = this.runtime.threads[i]
          if (
            thread.stack.length !== 0 &&
            thread.status !== Thread.STATUS_DONE
          ) {
            this.runtime.threads[nextActiveThread] = thread
            nextActiveThread++
          } else {
            this.runtime.threadMap.delete(thread.getId())
            doneThreads.push(thread)
          }
        }
        this.runtime.threads.length = nextActiveThread
      }

      // tw: Detect timer here so the sequencer won't break when FPS is greater than 1000
      // and performance.now() is not available.
      if (this.timer.timeElapsed() >= WORK_TIME) break
    }

    this.activeThread = null

    return doneThreads
  }
  /**
   * Numeric ID for Runtime._step in Profiler instances.
   * @type {number}
   */
  let stepProfilerId: number = -1

  /**
   * Numeric ID for Sequencer.stepThreads in Profiler instances.
   * @type {number}
   */
  let stepThreadsProfilerId: number = -1

  runtime._step = function () {
    if (this.interpolationEnabled) {
      interpolate.setupInitialState(this)
    }

    if (this.profiler !== null) {
      if (stepProfilerId === -1) {
        stepProfilerId = this.profiler.idByName('Runtime._step')
      }
      this.profiler.start(stepProfilerId)
    }

    // Clean up threads that were told to stop during or since the last step
    this.threads = this.threads.filter(thread => !thread.isKilled)
    this.updateThreadMap()

    // Find all edge-activated hats, and add them to threads to be evaluated.
    for (const hatType in this._hats) {
      if (!Object.prototype.hasOwnProperty.call(this._hats, hatType)) continue
      const hat = this._hats[hatType]
      if (hat.edgeActivated) {
        this.startHats(hatType)
      }
    }
    this.redrawRequested = false
    this._pushMonitors()
    if (this.profiler !== null) {
      if (stepThreadsProfilerId === -1) {
        stepThreadsProfilerId = this.profiler.idByName('Sequencer.stepThreads')
      }
      this.profiler.start(stepThreadsProfilerId)
    }
    this.emit((runtime.constructor as any).BEFORE_EXECUTE)
    const doneThreads = this.sequencer.stepThreads()
    if (this.profiler !== null) {
      this.profiler.stop()
    }
    this.emit((runtime.constructor as any).AFTER_EXECUTE)
    this._updateGlows(doneThreads)
    // Add done threads so that even if a thread finishes within 1 frame, the green
    // flag will still indicate that a script ran.
    this._emitProjectRunStatus(
      this.threads.length +
        doneThreads.length -
        this._getMonitorThreadCount([...this.threads, ...doneThreads])
    )
    // Store threads that completed this iteration for testing and other
    // internal purposes.
    this._lastStepDoneThreads = doneThreads

    if (this.profiler !== null) {
      this.profiler.stop()
      this.profiler.reportFrames()
    }
  }
  /**
   * tw: Change runtime target frames per second
   * @param {number} framerate Target frames per second
   */
  runtime.setFramerate = function (framerate: number) {
    // Convert negative framerates to 1FPS
    // Note that 0 is a special value which means "matching device screen refresh rate"
    if (framerate < 0) framerate = 1
    this.frameLoop.setFramerate(framerate)
    this.emit((runtime.constructor as any).FRAMERATE_CHANGED, framerate)
  }

  runtime.frameLoop.stop()
  runtime.frameLoop = new FrameLoop(runtime) as unknown as VM.FrameLoop
  runtime.frameLoop.start()

  class FrameloopNg implements Scratch.Extension {
    constructor() {}
    getInfo() {
      return {
        id: 'frameloopng',
        name: 'FrameLoop NextGen',
        blocks: [
          {
            blockType: Scratch.BlockType.LABEL,
            text: Scratch.translate('🐺 Powered by FurryR')
          },
          '---' as const,
          {
            blockType: Scratch.BlockType.REPORTER,
            opcode: 'refreshtime',
            text: Scratch.translate('screen refresh time')
          }
        ]
      }
    }
    refreshtime() {
      return (runtime.screenRefreshTime ?? 0) / 1000
    }
  }
  Scratch.extensions.register(new FrameloopNg())
})(Scratch)
