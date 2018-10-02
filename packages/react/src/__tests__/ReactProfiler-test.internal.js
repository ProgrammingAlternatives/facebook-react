/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 * @jest-environment node
 */

'use strict';

let JestScheduler;
let React;
let ReactFeatureFlags;
let ReactNoop;
let ReactTestRenderer;
let advanceTimeBy;
let SchedulerTracing;
let mockNow;
let AdvanceTime;

function loadModules({
  enableProfilerTimer = true,
  enableSuspense = false,
  enableSchedulerTracing = true,
  replayFailedUnitOfWorkWithInvokeGuardedCallback = false,
  useNoopRenderer = false,
} = {}) {
  let currentTime = 0;

  mockNow = jest.fn().mockImplementation(() => currentTime);

  global.Date.now = mockNow;

  ReactFeatureFlags = require('shared/ReactFeatureFlags');
  ReactFeatureFlags.debugRenderPhaseSideEffects = false;
  ReactFeatureFlags.debugRenderPhaseSideEffectsForStrictMode = false;
  ReactFeatureFlags.enableProfilerTimer = enableProfilerTimer;
  ReactFeatureFlags.enableSchedulerTracing = enableSchedulerTracing;
  ReactFeatureFlags.enableSuspense = enableSuspense;
  ReactFeatureFlags.replayFailedUnitOfWorkWithInvokeGuardedCallback = replayFailedUnitOfWorkWithInvokeGuardedCallback;

  React = require('react');
  SchedulerTracing = require('scheduler/tracing');
  JestScheduler = require('jest-scheduler');

  if (useNoopRenderer) {
    ReactNoop = require('react-noop-renderer');
    ReactTestRenderer = null;
  } else {
    ReactNoop = null;
    ReactTestRenderer = require('react-test-renderer');
    ReactTestRenderer.unstable_setNowImplementation(mockNow);
  }

  advanceTimeBy = amount => {
    currentTime += amount;
  };

  AdvanceTime = class extends React.Component {
    static defaultProps = {
      byAmount: 10,
      shouldComponentUpdate: true,
    };
    shouldComponentUpdate(nextProps) {
      return nextProps.shouldComponentUpdate;
    }
    render() {
      // Simulate time passing when this component is rendered
      advanceTimeBy(this.props.byAmount);
      return this.props.children || null;
    }
  };
}

const mockDevToolsForTest = () => {
  jest.mock('react-reconciler/src/ReactFiberDevToolsHook', () => ({
    injectInternals: () => {},
    onCommitRoot: () => {},
    onCommitUnmount: () => {},
    isDevToolsPresent: true,
  }));
};

describe('Profiler', () => {
  describe('works in profiling and non-profiling bundles', () => {
    [true, false].forEach(enableSchedulerTracing => {
      [true, false].forEach(enableProfilerTimer => {
        describe(`enableSchedulerTracing:${
          enableSchedulerTracing ? 'enabled' : 'disabled'
        } enableProfilerTimer:${
          enableProfilerTimer ? 'enabled' : 'disabled'
        }`, () => {
          beforeEach(() => {
            jest.resetModules();

            loadModules({enableSchedulerTracing, enableProfilerTimer});
          });

          // This will throw in production too,
          // But the test is only interested in verifying the DEV error message.
          if (__DEV__ && enableProfilerTimer) {
            it('should warn if required params are missing', () => {
              expect(() => {
                expect(() => {
                  ReactTestRenderer.create(<React.unstable_Profiler />);
                }).toThrow('onRender is not a function');
              }).toWarnDev(
                'Profiler must specify an "id" string and "onRender" function as props',
                {withoutStack: true},
              );
            });
          }

          it('should support an empty Profiler (with no children)', () => {
            // As root
            expect(
              ReactTestRenderer.create(
                <React.unstable_Profiler id="label" onRender={jest.fn()} />,
              ).toJSON(),
            ).toMatchSnapshot();

            // As non-root
            expect(
              ReactTestRenderer.create(
                <div>
                  <React.unstable_Profiler id="label" onRender={jest.fn()} />
                </div>,
              ).toJSON(),
            ).toMatchSnapshot();
          });

          it('should render children', () => {
            const FunctionalComponent = ({label}) => <span>{label}</span>;
            const renderer = ReactTestRenderer.create(
              <div>
                <span>outside span</span>
                <React.unstable_Profiler id="label" onRender={jest.fn()}>
                  <span>inside span</span>
                  <FunctionalComponent label="functional component" />
                </React.unstable_Profiler>
              </div>,
            );
            expect(renderer.toJSON()).toMatchSnapshot();
          });

          it('should support nested Profilers', () => {
            const FunctionalComponent = ({label}) => <div>{label}</div>;
            class ClassComponent extends React.Component {
              render() {
                return <block>{this.props.label}</block>;
              }
            }
            const renderer = ReactTestRenderer.create(
              <React.unstable_Profiler id="outer" onRender={jest.fn()}>
                <FunctionalComponent label="outer functional component" />
                <React.unstable_Profiler id="inner" onRender={jest.fn()}>
                  <ClassComponent label="inner class component" />
                  <span>inner span</span>
                </React.unstable_Profiler>
              </React.unstable_Profiler>,
            );
            expect(renderer.toJSON()).toMatchSnapshot();
          });
        });
      });
    });
  });

  [true, false].forEach(enableSchedulerTracing => {
    describe('onRender callback', () => {
      beforeEach(() => {
        jest.resetModules();

        loadModules({enableSchedulerTracing});
      });

      it('should handle errors thrown', () => {
        const callback = jest.fn(id => {
          if (id === 'throw') {
            throw Error('expected');
          }
        });

        let didMount = false;
        class ClassComponent extends React.Component {
          componentDidMount() {
            didMount = true;
          }
          render() {
            return this.props.children;
          }
        }

        // Errors thrown from onRender should not break the commit phase,
        // Or prevent other lifecycles from being called.
        expect(() =>
          ReactTestRenderer.create(
            <ClassComponent>
              <React.unstable_Profiler id="do-not-throw" onRender={callback}>
                <React.unstable_Profiler id="throw" onRender={callback}>
                  <div />
                </React.unstable_Profiler>
              </React.unstable_Profiler>
            </ClassComponent>,
          ),
        ).toThrow('expected');
        expect(didMount).toBe(true);
        expect(callback).toHaveBeenCalledTimes(2);
      });

      it('is not invoked until the commit phase', () => {
        const callback = jest.fn();

        const Yield = ({value}) => {
          ReactTestRenderer.unstable_yield(value);
          return null;
        };

        const renderer = ReactTestRenderer.create(
          <React.unstable_Profiler id="test" onRender={callback}>
            <Yield value="first" />
            <Yield value="last" />
          </React.unstable_Profiler>,
          {
            unstable_isConcurrent: true,
          },
        );

        // Times are logged until a render is committed.
        expect(renderer).toFlushThrough(['first']);
        expect(callback).toHaveBeenCalledTimes(0);
        expect(renderer).toFlushAll(['last']);
        expect(callback).toHaveBeenCalledTimes(1);
      });

      it('does not record times for components outside of Profiler tree', () => {
        ReactTestRenderer.create(
          <div>
            <AdvanceTime />
            <AdvanceTime />
            <AdvanceTime />
            <AdvanceTime />
            <AdvanceTime />
          </div>,
        );

        // Should be called two times:
        // 2. To compute the update expiration time
        // 3. To record the commit time
        // No additional calls from ProfilerTimer are expected.
        expect(mockNow).toHaveBeenCalledTimes(2);
      });

      it('logs render times for both mount and update', () => {
        const callback = jest.fn();

        advanceTimeBy(5); // 0 -> 5

        const renderer = ReactTestRenderer.create(
          <React.unstable_Profiler id="test" onRender={callback}>
            <AdvanceTime />
          </React.unstable_Profiler>,
        );

        expect(callback).toHaveBeenCalledTimes(1);

        let [call] = callback.mock.calls;

        expect(call).toHaveLength(enableSchedulerTracing ? 7 : 6);
        expect(call[0]).toBe('test');
        expect(call[1]).toBe('mount');
        expect(call[2]).toBe(10); // actual time
        expect(call[3]).toBe(10); // base time
        expect(call[4]).toBe(5); // start time
        expect(call[5]).toBe(15); // commit time
        expect(call[6]).toEqual(enableSchedulerTracing ? new Set() : undefined); // interaction events

        callback.mockReset();

        advanceTimeBy(20); // 15 -> 35

        renderer.update(
          <React.unstable_Profiler id="test" onRender={callback}>
            <AdvanceTime />
          </React.unstable_Profiler>,
        );

        expect(callback).toHaveBeenCalledTimes(1);

        [call] = callback.mock.calls;

        expect(call).toHaveLength(enableSchedulerTracing ? 7 : 6);
        expect(call[0]).toBe('test');
        expect(call[1]).toBe('update');
        expect(call[2]).toBe(10); // actual time
        expect(call[3]).toBe(10); // base time
        expect(call[4]).toBe(35); // start time
        expect(call[5]).toBe(45); // commit time
        expect(call[6]).toEqual(enableSchedulerTracing ? new Set() : undefined); // interaction events

        callback.mockReset();

        advanceTimeBy(20); // 45 -> 65

        renderer.update(
          <React.unstable_Profiler id="test" onRender={callback}>
            <AdvanceTime byAmount={4} />
          </React.unstable_Profiler>,
        );

        expect(callback).toHaveBeenCalledTimes(1);

        [call] = callback.mock.calls;

        expect(call).toHaveLength(enableSchedulerTracing ? 7 : 6);
        expect(call[0]).toBe('test');
        expect(call[1]).toBe('update');
        expect(call[2]).toBe(4); // actual time
        expect(call[3]).toBe(4); // base time
        expect(call[4]).toBe(65); // start time
        expect(call[5]).toBe(69); // commit time
        expect(call[6]).toEqual(enableSchedulerTracing ? new Set() : undefined); // interaction events
      });

      it('includes render times of nested Profilers in their parent times', () => {
        const callback = jest.fn();

        advanceTimeBy(5); // 0 -> 5

        ReactTestRenderer.create(
          <React.Fragment>
            <React.unstable_Profiler id="parent" onRender={callback}>
              <AdvanceTime byAmount={10}>
                <React.unstable_Profiler id="child" onRender={callback}>
                  <AdvanceTime byAmount={20} />
                </React.unstable_Profiler>
              </AdvanceTime>
            </React.unstable_Profiler>
          </React.Fragment>,
        );

        expect(callback).toHaveBeenCalledTimes(2);

        // Callbacks bubble (reverse order).
        const [childCall, parentCall] = callback.mock.calls;
        expect(childCall[0]).toBe('child');
        expect(parentCall[0]).toBe('parent');

        // Parent times should include child times
        expect(childCall[2]).toBe(20); // actual time
        expect(childCall[3]).toBe(20); // base time
        expect(childCall[4]).toBe(15); // start time
        expect(childCall[5]).toBe(35); // commit time
        expect(parentCall[2]).toBe(30); // actual time
        expect(parentCall[3]).toBe(30); // base time
        expect(parentCall[4]).toBe(5); // start time
        expect(parentCall[5]).toBe(35); // commit time
      });

      it('traces sibling Profilers separately', () => {
        const callback = jest.fn();

        advanceTimeBy(5); // 0 -> 5

        ReactTestRenderer.create(
          <React.Fragment>
            <React.unstable_Profiler id="first" onRender={callback}>
              <AdvanceTime byAmount={20} />
            </React.unstable_Profiler>
            <React.unstable_Profiler id="second" onRender={callback}>
              <AdvanceTime byAmount={5} />
            </React.unstable_Profiler>
          </React.Fragment>,
        );

        expect(callback).toHaveBeenCalledTimes(2);

        const [firstCall, secondCall] = callback.mock.calls;
        expect(firstCall[0]).toBe('first');
        expect(secondCall[0]).toBe('second');

        // Parent times should include child times
        expect(firstCall[2]).toBe(20); // actual time
        expect(firstCall[3]).toBe(20); // base time
        expect(firstCall[4]).toBe(5); // start time
        expect(firstCall[5]).toBe(30); // commit time
        expect(secondCall[2]).toBe(5); // actual time
        expect(secondCall[3]).toBe(5); // base time
        expect(secondCall[4]).toBe(25); // start time
        expect(secondCall[5]).toBe(30); // commit time
      });

      it('does not include time spent outside of profile root', () => {
        const callback = jest.fn();

        advanceTimeBy(5); // 0 -> 5

        ReactTestRenderer.create(
          <React.Fragment>
            <AdvanceTime byAmount={20} />
            <React.unstable_Profiler id="test" onRender={callback}>
              <AdvanceTime byAmount={5} />
            </React.unstable_Profiler>
            <AdvanceTime byAmount={20} />
          </React.Fragment>,
        );

        expect(callback).toHaveBeenCalledTimes(1);

        const [call] = callback.mock.calls;
        expect(call[0]).toBe('test');
        expect(call[2]).toBe(5); // actual time
        expect(call[3]).toBe(5); // base time
        expect(call[4]).toBe(25); // start time
        expect(call[5]).toBe(50); // commit time
      });

      it('is not called when blocked by sCU false', () => {
        const callback = jest.fn();

        let instance;
        class Updater extends React.Component {
          state = {};
          render() {
            instance = this;
            return this.props.children;
          }
        }

        class Pure extends React.PureComponent {
          render() {
            return this.props.children;
          }
        }

        const renderer = ReactTestRenderer.create(
          <React.unstable_Profiler id="outer" onRender={callback}>
            <Updater>
              <React.unstable_Profiler id="middle" onRender={callback}>
                <Pure>
                  <React.unstable_Profiler id="inner" onRender={callback}>
                    <div />
                  </React.unstable_Profiler>
                </Pure>
              </React.unstable_Profiler>
            </Updater>
          </React.unstable_Profiler>,
        );

        // All profile callbacks are called for initial render
        expect(callback).toHaveBeenCalledTimes(3);

        callback.mockReset();

        renderer.unstable_flushSync(() => {
          instance.setState({
            count: 1,
          });
        });

        // Only call profile updates for paths that have re-rendered
        // Since "inner" is beneath a pure compoent, it isn't called
        expect(callback).toHaveBeenCalledTimes(2);
        expect(callback.mock.calls[0][0]).toBe('middle');
        expect(callback.mock.calls[1][0]).toBe('outer');
      });

      it('decreases actual time but not base time when sCU prevents an update', () => {
        const callback = jest.fn();

        advanceTimeBy(5); // 0 -> 5

        const renderer = ReactTestRenderer.create(
          <React.unstable_Profiler id="test" onRender={callback}>
            <AdvanceTime byAmount={10}>
              <AdvanceTime byAmount={13} shouldComponentUpdate={false} />
            </AdvanceTime>
          </React.unstable_Profiler>,
        );

        expect(callback).toHaveBeenCalledTimes(1);

        advanceTimeBy(30); // 28 -> 58

        renderer.update(
          <React.unstable_Profiler id="test" onRender={callback}>
            <AdvanceTime byAmount={4}>
              <AdvanceTime byAmount={7} shouldComponentUpdate={false} />
            </AdvanceTime>
          </React.unstable_Profiler>,
        );

        expect(callback).toHaveBeenCalledTimes(2);

        const [mountCall, updateCall] = callback.mock.calls;

        expect(mountCall[1]).toBe('mount');
        expect(mountCall[2]).toBe(23); // actual time
        expect(mountCall[3]).toBe(23); // base time
        expect(mountCall[4]).toBe(5); // start time
        expect(mountCall[5]).toBe(28); // commit time

        expect(updateCall[1]).toBe('update');
        expect(updateCall[2]).toBe(4); // actual time
        expect(updateCall[3]).toBe(17); // base time
        expect(updateCall[4]).toBe(58); // start time
        expect(updateCall[5]).toBe(62); // commit time
      });

      it('includes time spent in render phase lifecycles', () => {
        class WithLifecycles extends React.Component {
          state = {};
          static getDerivedStateFromProps() {
            advanceTimeBy(3);
            return null;
          }
          shouldComponentUpdate() {
            advanceTimeBy(7);
            return true;
          }
          render() {
            advanceTimeBy(5);
            return null;
          }
        }

        const callback = jest.fn();

        advanceTimeBy(5); // 0 -> 5

        const renderer = ReactTestRenderer.create(
          <React.unstable_Profiler id="test" onRender={callback}>
            <WithLifecycles />
          </React.unstable_Profiler>,
        );

        advanceTimeBy(15); // 13 -> 28

        renderer.update(
          <React.unstable_Profiler id="test" onRender={callback}>
            <WithLifecycles />
          </React.unstable_Profiler>,
        );

        expect(callback).toHaveBeenCalledTimes(2);

        const [mountCall, updateCall] = callback.mock.calls;

        expect(mountCall[1]).toBe('mount');
        expect(mountCall[2]).toBe(8); // actual time
        expect(mountCall[3]).toBe(8); // base time
        expect(mountCall[4]).toBe(5); // start time
        expect(mountCall[5]).toBe(13); // commit time

        expect(updateCall[1]).toBe('update');
        expect(updateCall[2]).toBe(15); // actual time
        expect(updateCall[3]).toBe(15); // base time
        expect(updateCall[4]).toBe(28); // start time
        expect(updateCall[5]).toBe(43); // commit time
      });

      describe('with regard to interruptions', () => {
        it('should accumulate actual time after a scheduling interruptions', () => {
          const callback = jest.fn();

          const Yield = ({renderTime}) => {
            advanceTimeBy(renderTime);
            ReactTestRenderer.unstable_yield('Yield:' + renderTime);
            return null;
          };

          advanceTimeBy(5); // 0 -> 5

          // Render partially, but run out of time before completing.
          const renderer = ReactTestRenderer.create(
            <React.unstable_Profiler id="test" onRender={callback}>
              <Yield renderTime={2} />
              <Yield renderTime={3} />
            </React.unstable_Profiler>,
            {unstable_isConcurrent: true},
          );
          expect(renderer).toFlushThrough(['Yield:2']);
          expect(callback).toHaveBeenCalledTimes(0);

          // Resume render for remaining children.
          expect(renderer).toFlushAll(['Yield:3']);

          // Verify that logged times include both durations above.
          expect(callback).toHaveBeenCalledTimes(1);
          const [call] = callback.mock.calls;
          expect(call[2]).toBe(5); // actual time
          expect(call[3]).toBe(5); // base time
          expect(call[4]).toBe(5); // start time
          expect(call[5]).toBe(10); // commit time
        });

        it('should not include time between frames', () => {
          const callback = jest.fn();

          const Yield = ({renderTime}) => {
            advanceTimeBy(renderTime);
            ReactTestRenderer.unstable_yield('Yield:' + renderTime);
            return null;
          };

          advanceTimeBy(5); // 0 -> 5

          // Render partially, but don't finish.
          // This partial render should take 5ms of simulated time.
          const renderer = ReactTestRenderer.create(
            <React.unstable_Profiler id="outer" onRender={callback}>
              <Yield renderTime={5} />
              <Yield renderTime={10} />
              <React.unstable_Profiler id="inner" onRender={callback}>
                <Yield renderTime={17} />
              </React.unstable_Profiler>
            </React.unstable_Profiler>,
            {unstable_isConcurrent: true},
          );
          expect(renderer).toFlushThrough(['Yield:5']);
          expect(callback).toHaveBeenCalledTimes(0);

          // Simulate time moving forward while frame is paused.
          advanceTimeBy(50); // 10 -> 60

          // Flush the remaninig work,
          // Which should take an additional 10ms of simulated time.
          expect(renderer).toFlushAll(['Yield:10', 'Yield:17']);
          expect(callback).toHaveBeenCalledTimes(2);

          const [innerCall, outerCall] = callback.mock.calls;

          // Verify that the actual time includes all work times,
          // But not the time that elapsed between frames.
          expect(innerCall[0]).toBe('inner');
          expect(innerCall[2]).toBe(17); // actual time
          expect(innerCall[3]).toBe(17); // base time
          expect(innerCall[4]).toBe(70); // start time
          expect(innerCall[5]).toBe(87); // commit time
          expect(outerCall[0]).toBe('outer');
          expect(outerCall[2]).toBe(32); // actual time
          expect(outerCall[3]).toBe(32); // base time
          expect(outerCall[4]).toBe(5); // start time
          expect(outerCall[5]).toBe(87); // commit time
        });

        it('should report the expected times when a high-pri update replaces a mount in-progress', () => {
          const callback = jest.fn();

          const Yield = ({renderTime}) => {
            advanceTimeBy(renderTime);
            ReactTestRenderer.unstable_yield('Yield:' + renderTime);
            return null;
          };

          advanceTimeBy(5); // 0 -> 5

          // Render a partially update, but don't finish.
          // This partial render should take 10ms of simulated time.
          const renderer = ReactTestRenderer.create(
            <React.unstable_Profiler id="test" onRender={callback}>
              <Yield renderTime={10} />
              <Yield renderTime={20} />
            </React.unstable_Profiler>,
            {unstable_isConcurrent: true},
          );
          expect(renderer).toFlushThrough(['Yield:10']);
          expect(callback).toHaveBeenCalledTimes(0);

          // Simulate time moving forward while frame is paused.
          advanceTimeBy(100); // 15 -> 115

          // Interrupt with higher priority work.
          // The interrupted work simulates an additional 5ms of time.
          renderer.unstable_flushSync(() => {
            renderer.update(
              <React.unstable_Profiler id="test" onRender={callback}>
                <Yield renderTime={5} />
              </React.unstable_Profiler>,
            );
          });
          expect(ReactTestRenderer).toClearYields(['Yield:5']);

          // The initial work was thrown away in this case,
          // So the actual and base times should only include the final rendered tree times.
          expect(callback).toHaveBeenCalledTimes(1);
          let call = callback.mock.calls[0];
          expect(call[2]).toBe(5); // actual time
          expect(call[3]).toBe(5); // base time
          expect(call[4]).toBe(115); // start time
          expect(call[5]).toBe(120); // commit time

          callback.mockReset();

          // Verify no more unexpected callbacks from low priority work
          expect(renderer).toFlushAll([]);
          expect(callback).toHaveBeenCalledTimes(0);
        });

        it('should report the expected times when a high-priority update replaces a low-priority update', () => {
          const callback = jest.fn();

          const Yield = ({renderTime}) => {
            advanceTimeBy(renderTime);
            ReactTestRenderer.unstable_yield('Yield:' + renderTime);
            return null;
          };

          advanceTimeBy(5); // 0 -> 5

          const renderer = ReactTestRenderer.create(
            <React.unstable_Profiler id="test" onRender={callback}>
              <Yield renderTime={6} />
              <Yield renderTime={15} />
            </React.unstable_Profiler>,
            {unstable_isConcurrent: true},
          );

          // Render everything initially.
          // This should take 21 seconds of actual and base time.
          expect(renderer).toFlushAll(['Yield:6', 'Yield:15']);
          expect(callback).toHaveBeenCalledTimes(1);
          let call = callback.mock.calls[0];
          expect(call[2]).toBe(21); // actual time
          expect(call[3]).toBe(21); // base time
          expect(call[4]).toBe(5); // start time
          expect(call[5]).toBe(26); // commit time

          callback.mockReset();

          advanceTimeBy(30); // 26 -> 56

          // Render a partially update, but don't finish.
          // This partial render should take 3ms of simulated time.
          renderer.update(
            <React.unstable_Profiler id="test" onRender={callback}>
              <Yield renderTime={3} />
              <Yield renderTime={5} />
              <Yield renderTime={9} />
            </React.unstable_Profiler>,
          );
          expect(renderer).toFlushThrough(['Yield:3']);
          expect(callback).toHaveBeenCalledTimes(0);

          // Simulate time moving forward while frame is paused.
          advanceTimeBy(100); // 59 -> 159

          // Render another 5ms of simulated time.
          expect(renderer).toFlushThrough(['Yield:5']);
          expect(callback).toHaveBeenCalledTimes(0);

          // Simulate time moving forward while frame is paused.
          advanceTimeBy(100); // 164 -> 264

          // Interrupt with higher priority work.
          // The interrupted work simulates an additional 11ms of time.
          renderer.unstable_flushSync(() => {
            renderer.update(
              <React.unstable_Profiler id="test" onRender={callback}>
                <Yield renderTime={11} />
              </React.unstable_Profiler>,
            );
          });
          expect(ReactTestRenderer).toClearYields(['Yield:11']);

          // The actual time should include only the most recent render,
          // Because this lets us avoid a lot of commit phase reset complexity.
          // The base time includes only the final rendered tree times.
          expect(callback).toHaveBeenCalledTimes(1);
          call = callback.mock.calls[0];
          expect(call[2]).toBe(11); // actual time
          expect(call[3]).toBe(11); // base time
          expect(call[4]).toBe(264); // start time
          expect(call[5]).toBe(275); // commit time

          // Verify no more unexpected callbacks from low priority work
          expect(renderer).toFlushAll([]);
          expect(callback).toHaveBeenCalledTimes(1);
        });

        it('should report the expected times when a high-priority update interrupts a low-priority update', () => {
          const callback = jest.fn();

          const Yield = ({renderTime}) => {
            advanceTimeBy(renderTime);
            ReactTestRenderer.unstable_yield('Yield:' + renderTime);
            return null;
          };

          let first;
          class FirstComponent extends React.Component {
            state = {renderTime: 1};
            render() {
              first = this;
              advanceTimeBy(this.state.renderTime);
              ReactTestRenderer.unstable_yield(
                'FirstComponent:' + this.state.renderTime,
              );
              return <Yield renderTime={4} />;
            }
          }
          let second;
          class SecondComponent extends React.Component {
            state = {renderTime: 2};
            render() {
              second = this;
              advanceTimeBy(this.state.renderTime);
              ReactTestRenderer.unstable_yield(
                'SecondComponent:' + this.state.renderTime,
              );
              return <Yield renderTime={7} />;
            }
          }

          advanceTimeBy(5); // 0 -> 5

          const renderer = ReactTestRenderer.create(
            <React.unstable_Profiler id="test" onRender={callback}>
              <FirstComponent />
              <SecondComponent />
            </React.unstable_Profiler>,
            {unstable_isConcurrent: true},
          );

          // Render everything initially.
          // This simulates a total of 14ms of actual render time.
          // The base render time is also 14ms for the initial render.
          expect(renderer).toFlushAll([
            'FirstComponent:1',
            'Yield:4',
            'SecondComponent:2',
            'Yield:7',
          ]);
          expect(callback).toHaveBeenCalledTimes(1);
          let call = callback.mock.calls[0];
          expect(call[2]).toBe(14); // actual time
          expect(call[3]).toBe(14); // base time
          expect(call[4]).toBe(5); // start time
          expect(call[5]).toBe(19); // commit time

          callback.mockClear();

          advanceTimeBy(100); // 19 -> 119

          // Render a partially update, but don't finish.
          // This partial render will take 10ms of actual render time.
          first.setState({renderTime: 10});
          expect(renderer).toFlushThrough(['FirstComponent:10']);
          expect(callback).toHaveBeenCalledTimes(0);

          // Simulate time moving forward while frame is paused.
          advanceTimeBy(100); // 129 -> 229

          // Interrupt with higher priority work.
          // This simulates a total of 37ms of actual render time.
          renderer.unstable_flushSync(() => second.setState({renderTime: 30}));
          expect(ReactTestRenderer).toClearYields([
            'SecondComponent:30',
            'Yield:7',
          ]);

          // The actual time should include only the most recent render (37ms),
          // Because this greatly simplifies the commit phase logic.
          // The base time should include the more recent times for the SecondComponent subtree,
          // As well as the original times for the FirstComponent subtree.
          expect(callback).toHaveBeenCalledTimes(1);
          call = callback.mock.calls[0];
          expect(call[2]).toBe(37); // actual time
          expect(call[3]).toBe(42); // base time
          expect(call[4]).toBe(229); // start time
          expect(call[5]).toBe(266); // commit time

          callback.mockClear();

          // Simulate time moving forward while frame is paused.
          advanceTimeBy(100); // 266 -> 366

          // Resume the original low priority update, with rebased state.
          // This simulates a total of 14ms of actual render time,
          // And does not include the original (interrupted) 10ms.
          // The tree contains 42ms of base render time at this point,
          // Reflecting the most recent (longer) render durations.
          // TODO: This actual time should decrease by 10ms once the scheduler supports resuming.
          expect(renderer).toFlushAll(['FirstComponent:10', 'Yield:4']);
          expect(callback).toHaveBeenCalledTimes(1);
          call = callback.mock.calls[0];
          expect(call[2]).toBe(14); // actual time
          expect(call[3]).toBe(51); // base time
          expect(call[4]).toBe(366); // start time
          expect(call[5]).toBe(380); // commit time
        });

        [true, false].forEach(
          replayFailedUnitOfWorkWithInvokeGuardedCallback => {
            describe(`replayFailedUnitOfWorkWithInvokeGuardedCallback ${
              replayFailedUnitOfWorkWithInvokeGuardedCallback
                ? 'enabled'
                : 'disabled'
            }`, () => {
              beforeEach(() => {
                jest.resetModules();

                loadModules({
                  replayFailedUnitOfWorkWithInvokeGuardedCallback,
                });
              });

              it('should accumulate actual time after an error handled by componentDidCatch()', () => {
                const callback = jest.fn();

                const ThrowsError = () => {
                  advanceTimeBy(3);
                  throw Error('expected error');
                };

                class ErrorBoundary extends React.Component {
                  state = {error: null};
                  componentDidCatch(error) {
                    this.setState({error});
                  }
                  render() {
                    advanceTimeBy(2);
                    return this.state.error === null ? (
                      this.props.children
                    ) : (
                      <AdvanceTime byAmount={20} />
                    );
                  }
                }

                advanceTimeBy(5); // 0 -> 5

                ReactTestRenderer.create(
                  <React.unstable_Profiler id="test" onRender={callback}>
                    <ErrorBoundary>
                      <AdvanceTime byAmount={9} />
                      <ThrowsError />
                    </ErrorBoundary>
                  </React.unstable_Profiler>,
                );

                expect(callback).toHaveBeenCalledTimes(2);

                // Callbacks bubble (reverse order).
                let [mountCall, updateCall] = callback.mock.calls;

                // The initial mount only includes the ErrorBoundary (which takes 2)
                // But it spends time rendering all of the failed subtree also.
                expect(mountCall[1]).toBe('mount');
                // actual time includes: 2 (ErrorBoundary) + 9 (AdvanceTime) + 3 (ThrowsError)
                // We don't count the time spent in replaying the failed unit of work (ThrowsError)
                expect(mountCall[2]).toBe(14);
                // base time includes: 2 (ErrorBoundary)
                // Since the tree is empty for the initial commit
                expect(mountCall[3]).toBe(2);
                // start time
                expect(mountCall[4]).toBe(5);
                // commit time: 5 initially + 14 of work
                // Add an additional 3 (ThrowsError) if we replayed the failed work
                expect(mountCall[5]).toBe(
                  __DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback
                    ? 22
                    : 19,
                );

                // The update includes the ErrorBoundary and its fallback child
                expect(updateCall[1]).toBe('update');
                // actual time includes: 2 (ErrorBoundary) + 20 (AdvanceTime)
                expect(updateCall[2]).toBe(22);
                // base time includes: 2 (ErrorBoundary) + 20 (AdvanceTime)
                expect(updateCall[3]).toBe(22);
                // start time
                expect(updateCall[4]).toBe(
                  __DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback
                    ? 22
                    : 19,
                );
                // commit time: 19 (startTime) + 2 (ErrorBoundary) + 20 (AdvanceTime)
                // Add an additional 3 (ThrowsError) if we replayed the failed work
                expect(updateCall[5]).toBe(
                  __DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback
                    ? 44
                    : 41,
                );
              });

              it('should accumulate actual time after an error handled by getDerivedStateFromError()', () => {
                const callback = jest.fn();

                const ThrowsError = () => {
                  advanceTimeBy(10);
                  throw Error('expected error');
                };

                class ErrorBoundary extends React.Component {
                  state = {error: null};
                  static getDerivedStateFromError(error) {
                    return {error};
                  }
                  render() {
                    advanceTimeBy(2);
                    return this.state.error === null ? (
                      this.props.children
                    ) : (
                      <AdvanceTime byAmount={20} />
                    );
                  }
                }

                advanceTimeBy(5); // 0 -> 5

                ReactTestRenderer.create(
                  <React.unstable_Profiler id="test" onRender={callback}>
                    <ErrorBoundary>
                      <AdvanceTime byAmount={5} />
                      <ThrowsError />
                    </ErrorBoundary>
                  </React.unstable_Profiler>,
                );

                expect(callback).toHaveBeenCalledTimes(1);

                // Callbacks bubble (reverse order).
                let [mountCall] = callback.mock.calls;

                // The initial mount includes the ErrorBoundary's error state,
                // But it also spends actual time rendering UI that fails and isn't included.
                expect(mountCall[1]).toBe('mount');
                // actual time includes: 2 (ErrorBoundary) + 5 (AdvanceTime) + 10 (ThrowsError)
                // Then the re-render: 2 (ErrorBoundary) + 20 (AdvanceTime)
                // We don't count the time spent in replaying the failed unit of work (ThrowsError)
                expect(mountCall[2]).toBe(39);
                // base time includes: 2 (ErrorBoundary) + 20 (AdvanceTime)
                expect(mountCall[3]).toBe(22);
                // start time
                expect(mountCall[4]).toBe(5);
                // commit time
                expect(mountCall[5]).toBe(
                  __DEV__ && replayFailedUnitOfWorkWithInvokeGuardedCallback
                    ? 54
                    : 44,
                );
              });

              it('should reset the fiber stack correct after a "complete" phase error', () => {
                jest.resetModules();

                loadModules({
                  useNoopRenderer: true,
                  replayFailedUnitOfWorkWithInvokeGuardedCallback,
                });

                // Simulate a renderer error during the "complete" phase.
                // This mimics behavior like React Native's View/Text nesting validation.
                ReactNoop.render(
                  <React.unstable_Profiler id="profiler" onRender={jest.fn()}>
                    <errorInCompletePhase>hi</errorInCompletePhase>
                  </React.unstable_Profiler>,
                );
                expect(ReactNoop.flush).toThrow('Error in host config.');

                // A similar case we've seen caused by an invariant in ReactDOM.
                // It didn't reproduce without a host component inside.
                ReactNoop.render(
                  <React.unstable_Profiler id="profiler" onRender={jest.fn()}>
                    <errorInCompletePhase>
                      <span>hi</span>
                    </errorInCompletePhase>
                  </React.unstable_Profiler>,
                );
                expect(ReactNoop.flush).toThrow('Error in host config.');

                // So long as the profiler timer's fiber stack is reset correctly,
                // Subsequent renders should not error.
                ReactNoop.render(
                  <React.unstable_Profiler id="profiler" onRender={jest.fn()}>
                    <span>hi</span>
                  </React.unstable_Profiler>,
                );
                ReactNoop.flush();
              });
            });
          },
        );
      });

      it('reflects the most recently rendered id value', () => {
        const callback = jest.fn();

        advanceTimeBy(5); // 0 -> 5

        const renderer = ReactTestRenderer.create(
          <React.unstable_Profiler id="one" onRender={callback}>
            <AdvanceTime byAmount={2} />
          </React.unstable_Profiler>,
        );

        expect(callback).toHaveBeenCalledTimes(1);

        advanceTimeBy(20); // 7 -> 27

        renderer.update(
          <React.unstable_Profiler id="two" onRender={callback}>
            <AdvanceTime byAmount={1} />
          </React.unstable_Profiler>,
        );

        expect(callback).toHaveBeenCalledTimes(2);

        const [mountCall, updateCall] = callback.mock.calls;

        expect(mountCall[0]).toBe('one');
        expect(mountCall[1]).toBe('mount');
        expect(mountCall[2]).toBe(2); // actual time
        expect(mountCall[3]).toBe(2); // base time
        expect(mountCall[4]).toBe(5); // start time

        expect(updateCall[0]).toBe('two');
        expect(updateCall[1]).toBe('update');
        expect(updateCall[2]).toBe(1); // actual time
        expect(updateCall[3]).toBe(1); // base time
        expect(updateCall[4]).toBe(27); // start time
      });

      it('should not be called until after mutations', () => {
        let classComponentMounted = false;
        const callback = jest.fn(
          (id, phase, actualDuration, baseDuration, startTime, commitTime) => {
            // Don't call this hook until after mutations
            expect(classComponentMounted).toBe(true);
            // But the commit time should reflect pre-mutation
            expect(commitTime).toBe(2);
          },
        );

        class ClassComponent extends React.Component {
          componentDidMount() {
            advanceTimeBy(5);
            classComponentMounted = true;
          }
          render() {
            advanceTimeBy(2);
            return null;
          }
        }

        ReactTestRenderer.create(
          <React.unstable_Profiler id="test" onRender={callback}>
            <ClassComponent />
          </React.unstable_Profiler>,
        );

        expect(callback).toHaveBeenCalledTimes(1);
      });
    });
  });

  it('should handle interleaved async yields and batched commits', () => {
    jest.resetModules();
    mockDevToolsForTest();
    loadModules({useNoopRenderer: true});

    const Child = ({duration, id}) => {
      ReactNoop.advanceTime(duration);
      ReactNoop.yield(`Child:render:${id}`);
      return null;
    };

    class Parent extends React.Component {
      componentDidMount() {
        ReactNoop.yield(`Parent:componentDidMount:${this.props.id}`);
      }
      render() {
        const {duration, id} = this.props;
        return (
          <React.Fragment>
            <Child duration={duration} id={id} />
            <Child duration={duration} id={id} />
          </React.Fragment>
        );
      }
    }

    ReactNoop.advanceTime(50);

    ReactNoop.renderToRootWithID(<Parent duration={3} id="one" />, 'one');

    // Process up to the <Parent> component, but yield before committing.
    // This ensures that the profiler timer still has paused fibers.
    const commitFirstRender = ReactNoop.flushWithoutCommitting(
      ['Child:render:one', 'Child:render:one'],
      'one',
    );

    expect(ReactNoop.getRoot('one').current.actualDuration).toBe(0);

    ReactNoop.advanceTime(100);

    // Process some async work, but yield before committing it.
    ReactNoop.renderToRootWithID(<Parent duration={7} id="two" />, 'two');
    ReactNoop.flushThrough(['Child:render:two']);

    ReactNoop.advanceTime(150);

    // Commit the previously paused, batched work.
    commitFirstRender(['Parent:componentDidMount:one']);

    expect(ReactNoop.getRoot('one').current.actualDuration).toBe(6);
    expect(ReactNoop.getRoot('two').current.actualDuration).toBe(0);

    ReactNoop.advanceTime(200);

    ReactNoop.flush();

    expect(ReactNoop.getRoot('two').current.actualDuration).toBe(14);
  });

  describe('interaction tracing', () => {
    let subscriber;

    const getWorkForReactThreads = mockFn =>
      mockFn.mock.calls.filter(([interactions, threadID]) => threadID > 0);

    function loadModulesForTracing(params) {
      jest.resetModules();

      loadModules({
        enableSuspense: true,
        enableSchedulerTracing: true,
        ...params,
      });

      subscriber = JestScheduler.createMockSubscriber();

      // Verify interaction subscriber methods are called as expected.
      SchedulerTracing.unstable_subscribe(subscriber);
    }

    beforeEach(() => loadModulesForTracing());

    describe('error handling', () => {
      it('should cover errors thrown in onWorkScheduled', () => {
        function Component({children}) {
          ReactTestRenderer.unstable_yield('Component:' + children);
          return children;
        }

        let renderer;

        // Errors that happen inside of a subscriber should throw,
        subscriber.onWorkScheduled.mockImplementationOnce(() => {
          throw Error('Expected error onWorkScheduled');
        });
        expect(() => {
          SchedulerTracing.unstable_trace('event', mockNow(), () => {
            renderer = ReactTestRenderer.create(<Component>fail</Component>, {
              unstable_isConcurrent: true,
            });
          });
        }).toThrow('Expected error onWorkScheduled');
        expect(subscriber.onWorkScheduled).toHaveBeenCalled();

        // But should not leave React in a broken state for subsequent renders.
        renderer = ReactTestRenderer.create(<Component>succeed</Component>, {
          unstable_isConcurrent: true,
        });
        expect(renderer).toFlushAll(['Component:succeed']);
        const tree = renderer.toTree();
        expect(tree.type).toBe(Component);
        expect(tree.props.children).toBe('succeed');
      });

      it('should cover errors thrown in onWorkStarted', () => {
        function Component({children}) {
          ReactTestRenderer.unstable_yield('Component:' + children);
          return children;
        }

        let renderer;
        SchedulerTracing.unstable_trace('event', mockNow(), () => {
          renderer = ReactTestRenderer.create(<Component>text</Component>, {
            unstable_isConcurrent: true,
          });
        });
        subscriber.onWorkStarted.mockClear();

        // Errors that happen inside of a subscriber should throw,
        subscriber.onWorkStarted.mockImplementationOnce(() => {
          throw Error('Expected error onWorkStarted');
        });
        expect(() => {
          expect(renderer).toFlushAll(['Component:text']);
        }).toThrow('Expected error onWorkStarted');
        expect(subscriber.onWorkStarted).toHaveBeenCalled();

        // But the React work should have still been processed.
        expect(renderer).toFlushAll([]);
        const tree = renderer.toTree();
        expect(tree.type).toBe(Component);
        expect(tree.props.children).toBe('text');
      });

      it('should cover errors thrown in onWorkStopped', () => {
        function Component({children}) {
          ReactTestRenderer.unstable_yield('Component:' + children);
          return children;
        }

        let renderer;
        SchedulerTracing.unstable_trace('event', mockNow(), () => {
          renderer = ReactTestRenderer.create(<Component>text</Component>, {
            unstable_isConcurrent: true,
          });
        });
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();

        // Errors that happen in an on-stopped callback,
        subscriber.onWorkStopped.mockImplementationOnce(() => {
          throw Error('Expected error onWorkStopped');
        });
        expect(() => {
          renderer.unstable_flushAll(['Component:text']);
        }).toThrow('Expected error onWorkStopped');
        expect(subscriber.onWorkStopped).toHaveBeenCalledTimes(2);

        // Should still commit the update,
        const tree = renderer.toTree();
        expect(tree.type).toBe(Component);
        expect(tree.props.children).toBe('text');

        // And still call subscriber.onInteractionScheduledWorkCompleted if the interaction is finished.
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);
      });

      it('should cover errors thrown in onInteractionScheduledWorkCompleted', () => {
        function Component({children}) {
          ReactTestRenderer.unstable_yield('Component:' + children);
          return children;
        }

        const eventOne = {
          id: 0,
          name: 'event one',
          timestamp: mockNow(),
        };
        const eventTwo = {
          id: 1,
          name: 'event two',
          timestamp: mockNow(),
        };

        let renderer;
        SchedulerTracing.unstable_trace(eventOne.name, mockNow(), () => {
          SchedulerTracing.unstable_trace(eventTwo.name, mockNow(), () => {
            renderer = ReactTestRenderer.create(<Component>text</Component>, {
              unstable_isConcurrent: true,
            });
          });
        });
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();

        subscriber.onInteractionScheduledWorkCompleted.mockImplementationOnce(
          () => {
            throw Error('Expected error onInteractionScheduledWorkCompleted');
          },
        );
        expect(() => {
          renderer.unstable_flushAll(['Component:text']);
        }).toThrow('Expected error onInteractionScheduledWorkCompleted');

        // Even though an error is thrown for one completed interaction,
        // The completed callback should be called for all completed interactions.
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(2);
      });
    });

    it('should properly trace work scheduled during the begin render phase', () => {
      const callback = jest.fn();
      let wrapped;
      const Component = jest.fn(() => {
        wrapped = SchedulerTracing.unstable_wrap(callback);
        return null;
      });

      let interaction;
      SchedulerTracing.unstable_trace('event', mockNow(), () => {
        const interactions = SchedulerTracing.unstable_getCurrent();
        expect(interactions.size).toBe(1);
        interaction = Array.from(interactions)[0];
        ReactTestRenderer.create(<Component />);
      });

      expect(Component).toHaveBeenCalledTimes(1);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).not.toHaveBeenCalled();
      expect(callback).not.toHaveBeenCalled();

      wrapped();
      expect(callback).toHaveBeenCalledTimes(1);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(1);
      expect(
        subscriber,
      ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(interaction);
    });

    it('should associate traced events with their subsequent commits', () => {
      let instance = null;

      const Yield = ({duration = 10, value}) => {
        advanceTimeBy(duration);
        ReactTestRenderer.unstable_yield(value);
        return null;
      };

      class Example extends React.Component {
        state = {
          count: 0,
        };
        render() {
          instance = this;
          return (
            <React.Fragment>
              <Yield value="first" />
              {this.state.count}
              <Yield value="last" />
            </React.Fragment>
          );
        }
      }

      advanceTimeBy(1);

      const interactionCreation = {
        id: 0,
        name: 'creation event',
        timestamp: mockNow(),
      };

      const onRender = jest.fn();
      let renderer;
      SchedulerTracing.unstable_trace(
        interactionCreation.name,
        mockNow(),
        () => {
          renderer = ReactTestRenderer.create(
            <React.unstable_Profiler id="test-profiler" onRender={onRender}>
              <Example />
            </React.unstable_Profiler>,
            {
              unstable_isConcurrent: true,
            },
          );
        },
      );

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
      expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(
        interactionCreation,
      );
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).not.toHaveBeenCalled();

      // The scheduler/tracing package will notify of work started for the default thread,
      // But React shouldn't notify until it's been flushed.
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(0);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(0);

      // Work may have been scheduled multiple times.
      // We only care that the subscriber was notified at least once.
      // As for the thread ID- the actual value isn't important, only that there was one.
      expect(subscriber.onWorkScheduled).toHaveBeenCalled();
      expect(subscriber.onWorkScheduled.mock.calls[0][0]).toMatchInteractions([
        interactionCreation,
      ]);
      expect(subscriber.onWorkScheduled.mock.calls[0][1] > 0).toBe(true);

      // Mount
      renderer.unstable_flushAll(['first', 'last']);
      expect(onRender).toHaveBeenCalledTimes(1);
      let call = onRender.mock.calls[0];
      expect(call[0]).toEqual('test-profiler');
      expect(call[5]).toEqual(mockNow());
      if (ReactFeatureFlags.enableSchedulerTracing) {
        expect(call[6]).toMatchInteractions([interactionCreation]);
      }

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(1);
      expect(
        subscriber,
      ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
        interactionCreation,
      );
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(1);
      expect(
        getWorkForReactThreads(subscriber.onWorkStarted)[0][0],
      ).toMatchInteractions([interactionCreation]);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(1);
      expect(
        getWorkForReactThreads(subscriber.onWorkStopped)[0][0],
      ).toMatchInteractions([interactionCreation]);

      onRender.mockClear();
      subscriber.onWorkScheduled.mockClear();
      subscriber.onWorkStarted.mockClear();
      subscriber.onWorkStopped.mockClear();

      advanceTimeBy(3);

      let didRunCallback = false;

      const interactionOne = {
        id: 1,
        name: 'initial event',
        timestamp: mockNow(),
      };
      SchedulerTracing.unstable_trace(interactionOne.name, mockNow(), () => {
        instance.setState({count: 1});

        // Update state again to verify our traced interaction isn't registered twice
        instance.setState({count: 2});

        // The scheduler/tracing package will notify of work started for the default thread,
        // But React shouldn't notify until it's been flushed.
        expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(
          0,
        );
        expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(
          0,
        );

        // Work may have been scheduled multiple times.
        // We only care that the subscriber was notified at least once.
        // As for the thread ID- the actual value isn't important, only that there was one.
        expect(subscriber.onWorkScheduled).toHaveBeenCalled();
        expect(subscriber.onWorkScheduled.mock.calls[0][0]).toMatchInteractions(
          [interactionOne],
        );
        expect(subscriber.onWorkScheduled.mock.calls[0][1] > 0).toBe(true);

        expect(renderer).toFlushThrough(['first']);
        expect(onRender).not.toHaveBeenCalled();

        expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(2);
        expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(
          interactionOne,
        );
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);
        expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(
          1,
        );
        expect(
          getWorkForReactThreads(subscriber.onWorkStarted)[0][0],
        ).toMatchInteractions([interactionOne]);
        expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(
          0,
        );

        renderer.unstable_flushAll(['last']);
        expect(onRender).toHaveBeenCalledTimes(1);

        call = onRender.mock.calls[0];
        expect(call[0]).toEqual('test-profiler');
        expect(call[5]).toEqual(mockNow());
        if (ReactFeatureFlags.enableSchedulerTracing) {
          expect(call[6]).toMatchInteractions([interactionOne]);
        }

        didRunCallback = true;

        expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(
          1,
        );
        expect(
          getWorkForReactThreads(subscriber.onWorkStarted)[0][0],
        ).toMatchInteractions([interactionOne]);
        expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(
          1,
        );
        expect(
          getWorkForReactThreads(subscriber.onWorkStopped)[0][0],
        ).toMatchInteractions([interactionOne]);
      });

      expect(didRunCallback).toBe(true);

      onRender.mockClear();
      subscriber.onWorkScheduled.mockClear();
      subscriber.onWorkStarted.mockClear();
      subscriber.onWorkStopped.mockClear();

      advanceTimeBy(17);

      // Verify that updating state again does not re-log our interaction.
      instance.setState({count: 3});
      renderer.unstable_flushAll(['first', 'last']);

      expect(onRender).toHaveBeenCalledTimes(1);
      call = onRender.mock.calls[0];
      expect(call[0]).toEqual('test-profiler');
      expect(call[5]).toEqual(mockNow());
      if (ReactFeatureFlags.enableSchedulerTracing) {
        expect(call[6]).toMatchInteractions([]);
      }

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(2);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(2);
      expect(
        subscriber,
      ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
        interactionOne,
      );
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(0);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(0);

      onRender.mockClear();

      advanceTimeBy(3);

      // Verify that root updates are also associated with traced events.
      const interactionTwo = {
        id: 2,
        name: 'root update event',
        timestamp: mockNow(),
      };
      SchedulerTracing.unstable_trace(interactionTwo.name, mockNow(), () => {
        renderer.update(
          <React.unstable_Profiler id="test-profiler" onRender={onRender}>
            <Example />
          </React.unstable_Profiler>,
        );
      });

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(3);
      expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(
        interactionTwo,
      );
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(2);

      // The scheduler/tracing package will notify of work started for the default thread,
      // But React shouldn't notify until it's been flushed.
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(0);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(0);

      // Work may have been scheduled multiple times.
      // We only care that the subscriber was notified at least once.
      // As for the thread ID- the actual value isn't important, only that there was one.
      expect(subscriber.onWorkScheduled).toHaveBeenCalled();
      expect(subscriber.onWorkScheduled.mock.calls[0][0]).toMatchInteractions([
        interactionTwo,
      ]);
      expect(subscriber.onWorkScheduled.mock.calls[0][1] > 0).toBe(true);

      renderer.unstable_flushAll(['first', 'last']);

      expect(onRender).toHaveBeenCalledTimes(1);
      call = onRender.mock.calls[0];
      expect(call[0]).toEqual('test-profiler');
      expect(call[5]).toEqual(mockNow());
      if (ReactFeatureFlags.enableSchedulerTracing) {
        expect(call[6]).toMatchInteractions([interactionTwo]);
      }

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(3);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(3);
      expect(
        subscriber,
      ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
        interactionTwo,
      );
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(1);
      expect(
        getWorkForReactThreads(subscriber.onWorkStarted)[0][0],
      ).toMatchInteractions([interactionTwo]);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(1);
      expect(
        getWorkForReactThreads(subscriber.onWorkStopped)[0][0],
      ).toMatchInteractions([interactionTwo]);
    });

    it('should report the expected times when a high-priority update interrupts a low-priority update', () => {
      const onRender = jest.fn();

      let first;
      class FirstComponent extends React.Component {
        state = {count: 0};
        render() {
          first = this;
          ReactTestRenderer.unstable_yield('FirstComponent');
          return null;
        }
      }
      let second;
      class SecondComponent extends React.Component {
        state = {count: 0};
        render() {
          second = this;
          ReactTestRenderer.unstable_yield('SecondComponent');
          return null;
        }
      }

      advanceTimeBy(5);

      const renderer = ReactTestRenderer.create(
        <React.unstable_Profiler id="test" onRender={onRender}>
          <FirstComponent />
          <SecondComponent />
        </React.unstable_Profiler>,
        {unstable_isConcurrent: true},
      );

      // Initial mount.
      renderer.unstable_flushAll(['FirstComponent', 'SecondComponent']);

      expect(subscriber.onInteractionTraced).not.toHaveBeenCalled();
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).not.toHaveBeenCalled();

      onRender.mockClear();

      advanceTimeBy(100);

      const interactionLowPri = {
        id: 0,
        name: 'lowPri',
        timestamp: mockNow(),
      };

      SchedulerTracing.unstable_trace(interactionLowPri.name, mockNow(), () => {
        // Render a partially update, but don't finish.
        first.setState({count: 1});

        expect(subscriber.onWorkScheduled).toHaveBeenCalled();
        expect(subscriber.onWorkScheduled.mock.calls[0][0]).toMatchInteractions(
          [interactionLowPri],
        );

        expect(renderer).toFlushThrough(['FirstComponent']);
        expect(onRender).not.toHaveBeenCalled();

        expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
        expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(
          interactionLowPri,
        );
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();
        expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(
          1,
        );
        expect(
          getWorkForReactThreads(subscriber.onWorkStarted)[0][0],
        ).toMatchInteractions([interactionLowPri]);
        expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(
          0,
        );

        advanceTimeBy(100);

        const interactionHighPri = {
          id: 1,
          name: 'highPri',
          timestamp: mockNow(),
        };

        // Interrupt with higher priority work.
        // This simulates a total of 37ms of actual render time.
        renderer.unstable_flushSync(() => {
          SchedulerTracing.unstable_trace(
            interactionHighPri.name,
            mockNow(),
            () => {
              second.setState({count: 1});

              expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(2);
              expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(
                interactionHighPri,
              );
              expect(
                subscriber.onInteractionScheduledWorkCompleted,
              ).not.toHaveBeenCalled();

              expect(
                getWorkForReactThreads(subscriber.onWorkStarted),
              ).toHaveLength(1);
              expect(
                getWorkForReactThreads(subscriber.onWorkStopped),
              ).toHaveLength(0);
            },
          );
        });
        expect(ReactTestRenderer).toClearYields(['SecondComponent']);

        expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(2);
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);
        expect(
          subscriber,
        ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
          interactionHighPri,
        );

        // Verify the high priority update was associated with the high priority event.
        expect(onRender).toHaveBeenCalledTimes(1);
        let call = onRender.mock.calls[0];
        expect(call[0]).toEqual('test');
        expect(call[5]).toEqual(mockNow());
        expect(call[6]).toMatchInteractions(
          ReactFeatureFlags.enableSchedulerTracing
            ? [interactionLowPri, interactionHighPri]
            : [],
        );

        onRender.mockClear();

        advanceTimeBy(100);

        // Resume the original low priority update, with rebased state.
        // Verify the low priority update was retained.
        renderer.unstable_flushAll(['FirstComponent']);
        expect(onRender).toHaveBeenCalledTimes(1);
        call = onRender.mock.calls[0];
        expect(call[0]).toEqual('test');
        expect(call[5]).toEqual(mockNow());
        expect(call[6]).toMatchInteractions(
          ReactFeatureFlags.enableSchedulerTracing ? [interactionLowPri] : [],
        );

        expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(2);
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);

        // Work might be started multiple times before being completed.
        // This is okay; it's part of the scheduler/tracing contract.
        expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(
          3,
        );
        expect(
          getWorkForReactThreads(subscriber.onWorkStarted)[1][0],
        ).toMatchInteractions([interactionLowPri, interactionHighPri]);
        expect(
          getWorkForReactThreads(subscriber.onWorkStarted)[2][0],
        ).toMatchInteractions([interactionLowPri]);
        expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(
          2,
        );
        expect(
          getWorkForReactThreads(subscriber.onWorkStopped)[0][0],
        ).toMatchInteractions([interactionLowPri, interactionHighPri]);
        expect(
          getWorkForReactThreads(subscriber.onWorkStopped)[1][0],
        ).toMatchInteractions([interactionLowPri]);
      });

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(2);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(2);
      expect(
        subscriber,
      ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
        interactionLowPri,
      );
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(3);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(2);
    });

    it('should trace work spawned by a commit phase lifecycle and setState callback', () => {
      let instance;
      class Example extends React.Component {
        state = {
          count: 0,
        };
        componentDidMount() {
          advanceTimeBy(10); // Advance timer to keep commits separate
          this.setState({count: 1}); // Intentional cascading update
        }
        componentDidUpdate(prevProps, prevState) {
          if (this.state.count === 2 && prevState.count === 1) {
            advanceTimeBy(10); // Advance timer to keep commits separate
            this.setState({count: 3}); // Intentional cascading update
          }
        }
        render() {
          instance = this;
          ReactTestRenderer.unstable_yield('Example:' + this.state.count);
          return null;
        }
      }

      const interactionOne = {
        id: 0,
        name: 'componentDidMount test',
        timestamp: mockNow(),
      };

      // Initial mount.
      const onRender = jest.fn();
      let firstCommitTime = mockNow();
      let renderer;
      SchedulerTracing.unstable_trace(interactionOne.name, mockNow(), () => {
        renderer = ReactTestRenderer.create(
          <React.unstable_Profiler id="test" onRender={onRender}>
            <Example />
          </React.unstable_Profiler>,
          {unstable_isConcurrent: true},
        );
      });

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
      expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(
        interactionOne,
      );
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).not.toHaveBeenCalled();
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(0);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(0);

      renderer.unstable_flushAll(['Example:0', 'Example:1']);

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(1);
      expect(
        subscriber,
      ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
        interactionOne,
      );
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(2);
      expect(
        getWorkForReactThreads(subscriber.onWorkStarted)[0][0],
      ).toMatchInteractions([interactionOne]);
      expect(
        getWorkForReactThreads(subscriber.onWorkStarted)[1][0],
      ).toMatchInteractions([interactionOne]);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(2);
      expect(
        getWorkForReactThreads(subscriber.onWorkStopped)[0][0],
      ).toMatchInteractions([interactionOne]);
      expect(
        getWorkForReactThreads(subscriber.onWorkStopped)[1][0],
      ).toMatchInteractions([interactionOne]);

      expect(onRender).toHaveBeenCalledTimes(2);
      let call = onRender.mock.calls[0];
      expect(call[0]).toEqual('test');
      expect(call[5]).toEqual(firstCommitTime);
      expect(call[6]).toMatchInteractions(
        ReactFeatureFlags.enableSchedulerTracing ? [interactionOne] : [],
      );
      call = onRender.mock.calls[1];
      expect(call[0]).toEqual('test');
      expect(call[5]).toEqual(mockNow());
      expect(call[6]).toMatchInteractions(
        ReactFeatureFlags.enableSchedulerTracing ? [interactionOne] : [],
      );

      onRender.mockClear();

      const interactionTwo = {
        id: 1,
        name: 'componentDidUpdate test',
        timestamp: mockNow(),
      };

      // Cause an traced, async update
      SchedulerTracing.unstable_trace(interactionTwo.name, mockNow(), () => {
        instance.setState({count: 2});
      });
      expect(onRender).not.toHaveBeenCalled();
      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(2);
      expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(
        interactionTwo,
      );
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(1);
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(2);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(2);

      advanceTimeBy(5);

      // Flush async work (outside of traced scope)
      // This will cause an intentional cascading update from did-update
      firstCommitTime = mockNow();
      renderer.unstable_flushAll(['Example:2', 'Example:3']);

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(2);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(2);
      expect(
        subscriber,
      ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
        interactionTwo,
      );
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(4);
      expect(
        getWorkForReactThreads(subscriber.onWorkStarted)[2][0],
      ).toMatchInteractions([interactionTwo]);
      expect(
        getWorkForReactThreads(subscriber.onWorkStarted)[3][0],
      ).toMatchInteractions([interactionTwo]);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(4);
      expect(
        getWorkForReactThreads(subscriber.onWorkStopped)[2][0],
      ).toMatchInteractions([interactionTwo]);
      expect(
        getWorkForReactThreads(subscriber.onWorkStopped)[3][0],
      ).toMatchInteractions([interactionTwo]);

      // Verify the cascading commit is associated with the origin event
      expect(onRender).toHaveBeenCalledTimes(2);
      call = onRender.mock.calls[0];
      expect(call[0]).toEqual('test');
      expect(call[5]).toEqual(firstCommitTime);
      expect(call[6]).toMatchInteractions(
        ReactFeatureFlags.enableSchedulerTracing ? [interactionTwo] : [],
      );
      call = onRender.mock.calls[1];
      expect(call[0]).toEqual('test');
      expect(call[5]).toEqual(mockNow());
      expect(call[6]).toMatchInteractions(
        ReactFeatureFlags.enableSchedulerTracing ? [interactionTwo] : [],
      );

      onRender.mockClear();

      const interactionThree = {
        id: 2,
        name: 'setState callback test',
        timestamp: mockNow(),
      };

      // Cause a cascading update from the setState callback
      function callback() {
        instance.setState({count: 6});
      }
      SchedulerTracing.unstable_trace(interactionThree.name, mockNow(), () => {
        instance.setState({count: 5}, callback);
      });
      expect(onRender).not.toHaveBeenCalled();

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(3);
      expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(
        interactionThree,
      );
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(2);
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(4);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(4);

      // Flush async work (outside of traced scope)
      // This will cause an intentional cascading update from the setState callback
      firstCommitTime = mockNow();
      renderer.unstable_flushAll(['Example:5', 'Example:6']);

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(3);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(3);
      expect(
        subscriber,
      ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
        interactionThree,
      );
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(6);
      expect(
        getWorkForReactThreads(subscriber.onWorkStarted)[4][0],
      ).toMatchInteractions([interactionThree]);
      expect(
        getWorkForReactThreads(subscriber.onWorkStarted)[5][0],
      ).toMatchInteractions([interactionThree]);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(6);
      expect(
        getWorkForReactThreads(subscriber.onWorkStopped)[4][0],
      ).toMatchInteractions([interactionThree]);
      expect(
        getWorkForReactThreads(subscriber.onWorkStopped)[5][0],
      ).toMatchInteractions([interactionThree]);

      // Verify the cascading commit is associated with the origin event
      expect(onRender).toHaveBeenCalledTimes(2);
      call = onRender.mock.calls[0];
      expect(call[0]).toEqual('test');
      expect(call[5]).toEqual(firstCommitTime);
      expect(call[6]).toMatchInteractions(
        ReactFeatureFlags.enableSchedulerTracing ? [interactionThree] : [],
      );
      call = onRender.mock.calls[1];
      expect(call[0]).toEqual('test');
      expect(call[5]).toEqual(mockNow());
      expect(call[6]).toMatchInteractions(
        ReactFeatureFlags.enableSchedulerTracing ? [interactionThree] : [],
      );
    });

    it('should trace interactions associated with a parent component state update', () => {
      const onRender = jest.fn();
      let parentInstance = null;

      class Child extends React.Component {
        render() {
          ReactTestRenderer.unstable_yield('Child:', this.props.count);
          return null;
        }
      }

      class Parent extends React.Component {
        state = {
          count: 0,
        };
        render() {
          parentInstance = this;
          return (
            <React.unstable_Profiler id="test-profiler" onRender={onRender}>
              <Child count={this.state.count} />
            </React.unstable_Profiler>
          );
        }
      }

      advanceTimeBy(1);

      const renderer = ReactTestRenderer.create(<Parent />, {
        unstable_isConcurrent: true,
      });
      renderer.unstable_flushAll(['Child:0']);
      onRender.mockClear();

      const interaction = {
        id: 0,
        name: 'parent interaction',
        timestamp: mockNow(),
      };

      SchedulerTracing.unstable_trace(interaction.name, mockNow(), () => {
        parentInstance.setState({count: 1});
      });

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
      expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(interaction);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).not.toHaveBeenCalled();
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(0);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(0);

      expect(onRender).not.toHaveBeenCalled();
      renderer.unstable_flushAll(['Child:1']);
      expect(onRender).toHaveBeenCalledTimes(1);
      let call = onRender.mock.calls[0];
      expect(call[0]).toEqual('test-profiler');
      expect(call[6]).toMatchInteractions(
        ReactFeatureFlags.enableSchedulerTracing ? [interaction] : [],
      );

      expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
      expect(
        subscriber.onInteractionScheduledWorkCompleted,
      ).toHaveBeenCalledTimes(1);
      expect(
        subscriber,
      ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(interaction);
      expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(1);
      expect(
        getWorkForReactThreads(subscriber.onWorkStarted)[0][0],
      ).toMatchInteractions([interaction]);
      expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(1);
      expect(
        getWorkForReactThreads(subscriber.onWorkStopped)[0][0],
      ).toMatchInteractions([interaction]);
    });

    describe('suspense', () => {
      let AsyncText;
      let Text;
      let TextResource;
      let cache;
      let resourcePromise;

      function awaitableAdvanceTimers(ms) {
        jest.advanceTimersByTime(ms);
        // Wait until the end of the current tick
        return new Promise(resolve => {
          setImmediate(resolve);
        });
      }

      function yieldForRenderer(value) {
        if (ReactNoop) {
          ReactNoop.yield(value);
        } else {
          ReactTestRenderer.unstable_yield(value);
        }
      }

      beforeEach(() => {
        const ReactCache = require('react-cache');
        function invalidateCache() {
          cache = ReactCache.createCache(invalidateCache);
        }
        invalidateCache();

        resourcePromise = null;

        TextResource = ReactCache.createResource(([text, ms = 0]) => {
          resourcePromise = new Promise((resolve, reject) =>
            setTimeout(() => {
              yieldForRenderer(`Promise resolved [${text}]`);
              resolve(text);
            }, ms),
          );
          return resourcePromise;
        }, ([text, ms]) => text);

        AsyncText = ({ms, text}) => {
          try {
            TextResource.read(cache, [text, ms]);
            yieldForRenderer(`AsyncText [${text}]`);
            return text;
          } catch (promise) {
            if (typeof promise.then === 'function') {
              yieldForRenderer(`Suspend [${text}]`);
            } else {
              yieldForRenderer(`Error [${text}]`);
            }
            throw promise;
          }
        };

        Text = ({text}) => {
          yieldForRenderer(`Text [${text}]`);
          return text;
        };
      });

      it('traces both the temporary placeholder and the finished render for an interaction', async () => {
        loadModulesForTracing({useNoopRenderer: true});

        const interaction = {
          id: 0,
          name: 'initial render',
          timestamp: mockNow(),
        };

        const onRender = jest.fn();
        SchedulerTracing.unstable_trace(interaction.name, mockNow(), () => {
          ReactNoop.render(
            <React.unstable_Profiler id="test-profiler" onRender={onRender}>
              <React.Placeholder fallback={<Text text="Loading..." />}>
                <AsyncText text="Async" ms={20000} />
              </React.Placeholder>
              <Text text="Sync" />
            </React.unstable_Profiler>,
          );
        });

        expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
        expect(subscriber).toHaveBeenLastNotifiedOfInteractionTraced(
          interaction,
        );
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();
        expect(getWorkForReactThreads(subscriber.onWorkStarted)).toHaveLength(
          0,
        );
        expect(getWorkForReactThreads(subscriber.onWorkStopped)).toHaveLength(
          0,
        );

        expect(ReactNoop.flush()).toEqual([
          'Suspend [Async]',
          'Text [Loading...]',
          'Text [Sync]',
        ]);
        // The update hasn't expired yet, so we commit nothing.
        expect(ReactNoop.getChildren()).toEqual([]);
        expect(onRender).not.toHaveBeenCalled();

        // Advance both React's virtual time and Jest's timers by enough to expire
        // the update, but not by enough to flush the suspending promise.
        ReactNoop.expire(10000);
        await awaitableAdvanceTimers(10000);
        // No additional rendering work is required, since we already prepared
        // the placeholder.
        expect(ReactNoop.flushExpired()).toEqual([]);
        // Should have committed the placeholder.
        expect(ReactNoop.getChildren()).toEqual([
          {text: 'Loading...'},
          {text: 'Sync'},
        ]);
        expect(onRender).toHaveBeenCalledTimes(1);

        let call = onRender.mock.calls[0];
        expect(call[0]).toEqual('test-profiler');
        expect(call[6]).toMatchInteractions(
          ReactFeatureFlags.enableSchedulerTracing ? [interaction] : [],
        );

        expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();

        // Once the promise resolves, we render the suspended view
        await awaitableAdvanceTimers(10000);
        expect(ReactNoop.flush()).toEqual([
          'Promise resolved [Async]',
          'AsyncText [Async]',
        ]);
        expect(ReactNoop.getChildren()).toEqual([
          {text: 'Async'},
          {text: 'Sync'},
        ]);
        expect(onRender).toHaveBeenCalledTimes(2);

        call = onRender.mock.calls[1];
        expect(call[0]).toEqual('test-profiler');
        expect(call[6]).toMatchInteractions(
          ReactFeatureFlags.enableSchedulerTracing ? [interaction] : [],
        );

        expect(subscriber.onInteractionTraced).toHaveBeenCalledTimes(1);
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);
        expect(
          subscriber,
        ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
          interaction,
        );
      });

      it('does not prematurely complete for suspended sync renders', async () => {
        const interaction = {
          id: 0,
          name: 'initial render',
          timestamp: mockNow(),
        };

        const onRender = jest.fn();
        SchedulerTracing.unstable_trace(
          interaction.name,
          interaction.timestamp,
          () => {
            ReactTestRenderer.create(
              <React.unstable_Profiler id="app" onRender={onRender}>
                <React.Placeholder
                  delayMs={1000}
                  fallback={<Text text="loading" />}>
                  <AsyncText text="loaded" ms={2000} />
                </React.Placeholder>
              </React.unstable_Profiler>,
            );
          },
        );

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();

        jest.runAllTimers();
        await resourcePromise;

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);
        expect(
          subscriber,
        ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
          interaction,
        );
      });

      it('traces cascading work after suspended sync renders', async () => {
        let wrappedCascadingFn;
        class AsyncComponentWithCascadingWork extends React.Component {
          state = {
            hasMounted: false,
          };

          componentDidMount() {
            wrappedCascadingFn = SchedulerTracing.unstable_wrap(() => {
              this.setState({hasMounted: true});
            });
          }

          render() {
            const {ms, text} = this.props;
            TextResource.read(cache, [text, ms]);
            return <span prop={text}>{this.state.hasMounted}</span>;
          }
        }

        const interaction = {
          id: 0,
          name: 'initial render',
          timestamp: mockNow(),
        };

        const onRender = jest.fn();
        SchedulerTracing.unstable_trace(
          interaction.name,
          interaction.timestamp,
          () => {
            ReactTestRenderer.create(
              <React.unstable_Profiler id="app" onRender={onRender}>
                <React.Placeholder
                  delayMs={1000}
                  fallback={<Text text="loading" />}>
                  <AsyncComponentWithCascadingWork text="loaded" ms={2000} />
                </React.Placeholder>
              </React.unstable_Profiler>,
            );
          },
        );

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();

        jest.runAllTimers();
        await resourcePromise;

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();

        wrappedCascadingFn();

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);
        expect(
          subscriber,
        ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
          interaction,
        );
      });

      it('does not prematurely complete for suspended renders that have exceeded their deadline', async () => {
        const interaction = {
          id: 0,
          name: 'initial render',
          timestamp: mockNow(),
        };

        const onRender = jest.fn();
        let renderer;
        SchedulerTracing.unstable_trace(
          interaction.name,
          interaction.timestamp,
          () => {
            renderer = ReactTestRenderer.create(
              <React.unstable_Profiler id="app" onRender={onRender}>
                <React.Placeholder
                  delayMs={1000}
                  fallback={<Text text="loading" />}>
                  <AsyncText text="loaded" ms={2000} />
                </React.Placeholder>
              </React.unstable_Profiler>,
              {
                unstable_isConcurrent: true,
              },
            );
          },
        );

        advanceTimeBy(1500);
        await awaitableAdvanceTimers(1500);

        expect(renderer).toFlushAll(['Suspend [loaded]', 'Text [loading]']);
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();

        advanceTimeBy(2500);
        await awaitableAdvanceTimers(2500);

        expect(renderer).toFlushAll(['AsyncText [loaded]']);
        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);
        expect(
          subscriber,
        ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
          interaction,
        );
      });

      it('decrements interaction count correctly if suspense loads before placeholder is shown', async () => {
        const interaction = {
          id: 0,
          name: 'initial render',
          timestamp: mockNow(),
        };

        const onRender = jest.fn();
        let renderer;
        SchedulerTracing.unstable_trace(
          interaction.name,
          interaction.timestamp,
          () => {
            renderer = ReactTestRenderer.create(
              <React.unstable_Profiler id="app" onRender={onRender}>
                <React.Placeholder
                  delayMs={2000}
                  fallback={<Text text="loading" />}>
                  <AsyncText text="loaded" ms={1000} />
                </React.Placeholder>
              </React.unstable_Profiler>,
              {unstable_isConcurrent: true},
            );
          },
        );
        renderer.unstable_flushAll();

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();

        jest.advanceTimersByTime(1000);
        await resourcePromise;
        renderer.unstable_flushAll();

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);
        expect(
          subscriber,
        ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
          interaction,
        );
      });

      it('handles high-pri renderers between suspended and resolved (sync) trees', async () => {
        const initialRenderInteraction = {
          id: 0,
          name: 'initial render',
          timestamp: mockNow(),
        };

        const onRender = jest.fn();
        let renderer;
        SchedulerTracing.unstable_trace(
          initialRenderInteraction.name,
          initialRenderInteraction.timestamp,
          () => {
            renderer = ReactTestRenderer.create(
              <React.unstable_Profiler id="app" onRender={onRender}>
                <React.Placeholder
                  delayMs={2000}
                  fallback={<Text text="loading" />}>
                  <AsyncText text="loaded" ms={1000} />
                </React.Placeholder>
                <Text text="initial" />
              </React.unstable_Profiler>,
            );
          },
        );
        expect(renderer.toJSON()).toEqual(['loading', 'initial']);

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();
        expect(onRender).toHaveBeenCalledTimes(2); // Sync null commit, placeholder commit
        expect(onRender.mock.calls[0][6]).toMatchInteractions([
          initialRenderInteraction,
        ]);
        onRender.mockClear();

        const highPriUpdateInteraction = {
          id: 1,
          name: 'hiPriUpdate',
          timestamp: mockNow(),
        };

        const originalPromise = resourcePromise;

        renderer.unstable_flushSync(() => {
          SchedulerTracing.unstable_trace(
            highPriUpdateInteraction.name,
            highPriUpdateInteraction.timestamp,
            () => {
              renderer.update(
                <React.unstable_Profiler id="app" onRender={onRender}>
                  <React.Placeholder
                    delayMs={2000}
                    fallback={<Text text="loading" />}>
                    <AsyncText text="loaded" ms={1000} />
                  </React.Placeholder>
                  <Text text="updated" />
                </React.unstable_Profiler>,
              );
            },
          );
        });
        expect(renderer.toJSON()).toEqual(['loading', 'updated']);

        expect(onRender).toHaveBeenCalledTimes(2); // Sync null commit, placeholder commit
        expect(onRender.mock.calls[0][6]).toMatchInteractions([
          initialRenderInteraction,
          highPriUpdateInteraction,
        ]);
        onRender.mockClear();

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();

        advanceTimeBy(1000);
        jest.advanceTimersByTime(1000);
        await originalPromise;
        expect(renderer.toJSON()).toEqual(['loaded', 'updated']);

        expect(onRender).toHaveBeenCalledTimes(2);
        expect(onRender.mock.calls[0][6]).toMatchInteractions([
          initialRenderInteraction,
          highPriUpdateInteraction,
        ]);

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(2);
        expect(
          subscriber.onInteractionScheduledWorkCompleted.mock.calls[0][0],
        ).toMatchInteraction(initialRenderInteraction);
        expect(
          subscriber.onInteractionScheduledWorkCompleted.mock.calls[1][0],
        ).toMatchInteraction(highPriUpdateInteraction);
      });

      it('handles high-pri renderers between suspended and resolved (async) trees', async () => {
        const initialRenderInteraction = {
          id: 0,
          name: 'initial render',
          timestamp: mockNow(),
        };

        const onRender = jest.fn();
        let renderer;
        SchedulerTracing.unstable_trace(
          initialRenderInteraction.name,
          initialRenderInteraction.timestamp,
          () => {
            renderer = ReactTestRenderer.create(
              <React.unstable_Profiler id="app" onRender={onRender}>
                <React.Placeholder
                  delayMs={2000}
                  fallback={<Text text="loading" />}>
                  <AsyncText text="loaded" ms={1000} />
                </React.Placeholder>
                <Text text="initial" />
              </React.unstable_Profiler>,
              {unstable_isConcurrent: true},
            );
          },
        );
        expect(renderer).toFlushAll([
          'Suspend [loaded]',
          'Text [loading]',
          'Text [initial]',
        ]);

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).not.toHaveBeenCalled();
        expect(onRender).not.toHaveBeenCalled();

        advanceTimeBy(500);
        jest.advanceTimersByTime(500);

        const highPriUpdateInteraction = {
          id: 1,
          name: 'hiPriUpdate',
          timestamp: mockNow(),
        };

        const originalPromise = resourcePromise;

        renderer.unstable_flushSync(() => {
          SchedulerTracing.unstable_trace(
            highPriUpdateInteraction.name,
            highPriUpdateInteraction.timestamp,
            () => {
              renderer.update(
                <React.unstable_Profiler id="app" onRender={onRender}>
                  <React.Placeholder
                    delayMs={2000}
                    fallback={<Text text="loading" />}>
                    <AsyncText text="loaded" ms={1000} />
                  </React.Placeholder>
                  <Text text="updated" />
                </React.unstable_Profiler>,
              );
            },
          );
        });
        expect(renderer.toJSON()).toEqual(['loading', 'updated']);

        expect(onRender).toHaveBeenCalledTimes(1);
        expect(onRender.mock.calls[0][6]).toMatchInteractions([
          highPriUpdateInteraction,
        ]);
        onRender.mockClear();

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(1);
        expect(
          subscriber,
        ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
          highPriUpdateInteraction,
        );

        advanceTimeBy(500);
        jest.advanceTimersByTime(500);
        await originalPromise;
        expect(renderer).toFlushAll(['AsyncText [loaded]']);
        expect(renderer.toJSON()).toEqual(['loaded', 'updated']);

        expect(onRender).toHaveBeenCalledTimes(1);
        expect(onRender.mock.calls[0][6]).toMatchInteractions([
          initialRenderInteraction,
        ]);

        expect(
          subscriber.onInteractionScheduledWorkCompleted,
        ).toHaveBeenCalledTimes(2);
        expect(
          subscriber,
        ).toHaveBeenLastNotifiedOfInteractionsScheduledWorkCompleted(
          initialRenderInteraction,
        );
      });
    });
  });
});
