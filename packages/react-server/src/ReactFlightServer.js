/**
 * Copyright (c) Meta Platforms, Inc. and affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Chunk, BinaryChunk, Destination} from './ReactServerStreamConfig';

import type {Postpone} from 'react/src/ReactPostpone';

import type {TemporaryReferenceSet} from './ReactFlightServerTemporaryReferences';

import {
  enableBinaryFlight,
  enablePostpone,
  enableTaint,
  enableRefAsProp,
  enableServerComponentLogs,
  enableOwnerStacks,
} from 'shared/ReactFeatureFlags';

import {enableFlightReadableStream} from 'shared/ReactFeatureFlags';

import {
  scheduleWork,
  scheduleMicrotask,
  flushBuffered,
  beginWriting,
  writeChunkAndReturn,
  stringToChunk,
  typedArrayToBinaryChunk,
  byteLengthOfChunk,
  byteLengthOfBinaryChunk,
  completeWriting,
  close,
  closeWithError,
} from './ReactServerStreamConfig';

export type {Destination, Chunk} from './ReactServerStreamConfig';

import type {
  ClientManifest,
  ClientReferenceMetadata,
  ClientReference,
  ClientReferenceKey,
  ServerReference,
  ServerReferenceId,
  Hints,
  HintCode,
  HintModel,
} from './ReactFlightServerConfig';
import type {ThenableState} from './ReactFlightThenable';
import type {
  Wakeable,
  Thenable,
  PendingThenable,
  FulfilledThenable,
  RejectedThenable,
  ReactDebugInfo,
  ReactComponentInfo,
  ReactAsyncInfo,
  ReactStackTrace,
} from 'shared/ReactTypes';
import type {ReactElement} from 'shared/ReactElementType';
import type {LazyComponent} from 'react/src/ReactLazy';

import {
  resolveClientReferenceMetadata,
  getServerReferenceId,
  getServerReferenceBoundArguments,
  getClientReferenceKey,
  isClientReference,
  isServerReference,
  supportsRequestStorage,
  requestStorage,
  createHints,
  initAsyncDebugInfo,
  parseStackTrace,
  supportsComponentStorage,
  componentStorage,
} from './ReactFlightServerConfig';

import {
  resolveTemporaryReference,
  isOpaqueTemporaryReference,
} from './ReactFlightServerTemporaryReferences';

import {
  HooksDispatcher,
  prepareToUseHooksForRequest,
  prepareToUseHooksForComponent,
  getThenableStateAfterSuspending,
  resetHooksForRequest,
} from './ReactFlightHooks';
import {DefaultAsyncDispatcher} from './flight/ReactFlightAsyncDispatcher';

import {resolveOwner, setCurrentOwner} from './flight/ReactFlightCurrentOwner';

import {getOwnerStackByComponentInfoInDev} from 'shared/ReactComponentInfoStack';

import {
  callComponentInDEV,
  callLazyInitInDEV,
  callIteratorInDEV,
} from './ReactFlightCallUserSpace';

import {
  getIteratorFn,
  REACT_ELEMENT_TYPE,
  REACT_LEGACY_ELEMENT_TYPE,
  REACT_FORWARD_REF_TYPE,
  REACT_FRAGMENT_TYPE,
  REACT_LAZY_TYPE,
  REACT_MEMO_TYPE,
  REACT_POSTPONE_TYPE,
  ASYNC_ITERATOR,
} from 'shared/ReactSymbols';

import {
  describeObjectForErrorMessage,
  isSimpleObject,
  jsxPropsParents,
  jsxChildrenParents,
  objectName,
} from 'shared/ReactSerializationErrors';

import ReactSharedInternals from './ReactSharedInternalsServer';
import isArray from 'shared/isArray';
import getPrototypeOf from 'shared/getPrototypeOf';
import binaryToComparableString from 'shared/binaryToComparableString';

import {SuspenseException, getSuspendedThenable} from './ReactFlightThenable';

function defaultFilterStackFrame(
  filename: string,
  functionName: string,
): boolean {
  return (
    filename !== '' &&
    !filename.startsWith('node:') &&
    !filename.includes('node_modules')
  );
}

function filterStackTrace(
  request: Request,
  error: Error,
  skipFrames: number,
): ReactStackTrace {
  // Since stacks can be quite large and we pass a lot of them, we filter them out eagerly
  // to save bandwidth even in DEV. We'll also replay these stacks on the client so by
  // stripping them early we avoid that overhead. Otherwise we'd normally just rely on
  // the DevTools or framework's ignore lists to filter them out.
  const filterStackFrame = request.filterStackFrame;
  const stack = parseStackTrace(error, skipFrames);
  for (let i = 0; i < stack.length; i++) {
    const callsite = stack[i];
    const functionName = callsite[0];
    let url = callsite[1];
    if (url.startsWith('rsc://React/')) {
      // This callsite is a virtual fake callsite that came from another Flight client.
      // We need to reverse it back into the original location by stripping its prefix
      // and suffix. We don't need the environment name because it's available on the
      // parent object that will contain the stack.
      const envIdx = url.indexOf('/', 12);
      const suffixIdx = url.lastIndexOf('?');
      if (envIdx > -1 && suffixIdx > -1) {
        url = callsite[1] = url.slice(envIdx + 1, suffixIdx);
      }
    }
    if (!filterStackFrame(url, functionName)) {
      stack.splice(i, 1);
      i--;
    }
  }
  return stack;
}

initAsyncDebugInfo();

function patchConsole(consoleInst: typeof console, methodName: string) {
  const descriptor = Object.getOwnPropertyDescriptor(consoleInst, methodName);
  if (
    descriptor &&
    (descriptor.configurable || descriptor.writable) &&
    typeof descriptor.value === 'function'
  ) {
    const originalMethod = descriptor.value;
    const originalName = Object.getOwnPropertyDescriptor(
      // $FlowFixMe[incompatible-call]: We should be able to get descriptors from any function.
      originalMethod,
      'name',
    );
    const wrapperMethod = function (this: typeof console) {
      const request = resolveRequest();
      if (methodName === 'assert' && arguments[0]) {
        // assert doesn't emit anything unless first argument is falsy so we can skip it.
      } else if (request !== null) {
        // Extract the stack. Not all console logs print the full stack but they have at
        // least the line it was called from. We could optimize transfer by keeping just
        // one stack frame but keeping it simple for now and include all frames.
        const stack = filterStackTrace(
          request,
          new Error('react-stack-top-frame'),
          1,
        );
        request.pendingChunks++;
        // We don't currently use this id for anything but we emit it so that we can later
        // refer to previous logs in debug info to associate them with a component.
        const id = request.nextChunkId++;
        const owner: null | ReactComponentInfo = resolveOwner();
        emitConsoleChunk(request, id, methodName, owner, stack, arguments);
      }
      // $FlowFixMe[prop-missing]
      return originalMethod.apply(this, arguments);
    };
    if (originalName) {
      Object.defineProperty(
        wrapperMethod,
        // $FlowFixMe[cannot-write] yes it is
        'name',
        originalName,
      );
    }
    Object.defineProperty(consoleInst, methodName, {
      value: wrapperMethod,
    });
  }
}

if (
  enableServerComponentLogs &&
  __DEV__ &&
  typeof console === 'object' &&
  console !== null
) {
  // Instrument console to capture logs for replaying on the client.
  patchConsole(console, 'assert');
  patchConsole(console, 'debug');
  patchConsole(console, 'dir');
  patchConsole(console, 'dirxml');
  patchConsole(console, 'error');
  patchConsole(console, 'group');
  patchConsole(console, 'groupCollapsed');
  patchConsole(console, 'groupEnd');
  patchConsole(console, 'info');
  patchConsole(console, 'log');
  patchConsole(console, 'table');
  patchConsole(console, 'trace');
  patchConsole(console, 'warn');
}

function getCurrentStackInDEV(): string {
  if (__DEV__) {
    if (enableOwnerStacks) {
      const owner: null | ReactComponentInfo = resolveOwner();
      if (owner === null) {
        return '';
      }
      return getOwnerStackByComponentInfoInDev(owner);
    }
    // We don't have Parent Stacks in Flight.
    return '';
  }
  return '';
}

const ObjectPrototype = Object.prototype;

type JSONValue =
  | string
  | boolean
  | number
  | null
  | {+[key: string]: JSONValue}
  | $ReadOnlyArray<JSONValue>;

const stringify = JSON.stringify;

type ReactJSONValue =
  | string
  | boolean
  | number
  | null
  | $ReadOnlyArray<ReactClientValue>
  | ReactClientObject;

// Serializable values
export type ReactClientValue =
  // Server Elements and Lazy Components are unwrapped on the Server
  | React$Element<React$AbstractComponent<any, any>>
  | LazyComponent<ReactClientValue, any>
  // References are passed by their value
  | ClientReference<any>
  | ServerReference<any>
  // The rest are passed as is. Sub-types can be passed in but lose their
  // subtype, so the receiver can only accept once of these.
  | React$Element<string>
  | React$Element<ClientReference<any> & any>
  | ReactComponentInfo
  | string
  | boolean
  | number
  | symbol
  | null
  | void
  | bigint
  | ReadableStream
  | $AsyncIterable<ReactClientValue, ReactClientValue, void>
  | $AsyncIterator<ReactClientValue, ReactClientValue, void>
  | Iterable<ReactClientValue>
  | Iterator<ReactClientValue>
  | Array<ReactClientValue>
  | Map<ReactClientValue, ReactClientValue>
  | Set<ReactClientValue>
  | FormData
  | $ArrayBufferView
  | ArrayBuffer
  | Date
  | ReactClientObject
  | Promise<ReactClientValue>; // Thenable<ReactClientValue>

type ReactClientObject = {+[key: string]: ReactClientValue};

// task status
const PENDING = 0;
const COMPLETED = 1;
const ABORTED = 3;
const ERRORED = 4;
const RENDERING = 5;

type Task = {
  id: number,
  status: 0 | 1 | 3 | 4 | 5,
  model: ReactClientValue,
  ping: () => void,
  toJSON: (key: string, value: ReactClientValue) => ReactJSONValue,
  keyPath: null | string, // parent server component keys
  implicitSlot: boolean, // true if the root server component of this sequence had a null key
  thenableState: ThenableState | null,
  environmentName: string, // DEV-only. Used to track if the environment for this task changed.
  debugOwner: null | ReactComponentInfo, // DEV-only
  debugStack: null | Error, // DEV-only
  debugTask: null | ConsoleTask, // DEV-only
};

interface Reference {}

export type Request = {
  status: 0 | 1 | 2 | 3,
  flushScheduled: boolean,
  fatalError: mixed,
  destination: null | Destination,
  bundlerConfig: ClientManifest,
  cache: Map<Function, mixed>,
  nextChunkId: number,
  pendingChunks: number,
  hints: Hints,
  abortListeners: Set<(reason: mixed) => void>,
  abortableTasks: Set<Task>,
  pingedTasks: Array<Task>,
  completedImportChunks: Array<Chunk>,
  completedHintChunks: Array<Chunk>,
  completedRegularChunks: Array<Chunk | BinaryChunk>,
  completedErrorChunks: Array<Chunk>,
  writtenSymbols: Map<symbol, number>,
  writtenClientReferences: Map<ClientReferenceKey, number>,
  writtenServerReferences: Map<ServerReference<any>, number>,
  writtenObjects: WeakMap<Reference, string>,
  temporaryReferences: void | TemporaryReferenceSet,
  identifierPrefix: string,
  identifierCount: number,
  taintCleanupQueue: Array<string | bigint>,
  onError: (error: mixed) => ?string,
  onPostpone: (reason: string) => void,
  // DEV-only
  environmentName: () => string,
  filterStackFrame: (url: string, functionName: string) => boolean,
  didWarnForKey: null | WeakSet<ReactComponentInfo>,
};

const AbortSigil = {};

const {
  TaintRegistryObjects,
  TaintRegistryValues,
  TaintRegistryByteLengths,
  TaintRegistryPendingRequests,
} = ReactSharedInternals;

function throwTaintViolation(message: string) {
  // eslint-disable-next-line react-internal/prod-error-codes
  throw new Error(message);
}

function cleanupTaintQueue(request: Request): void {
  const cleanupQueue = request.taintCleanupQueue;
  TaintRegistryPendingRequests.delete(cleanupQueue);
  for (let i = 0; i < cleanupQueue.length; i++) {
    const entryValue = cleanupQueue[i];
    const entry = TaintRegistryValues.get(entryValue);
    if (entry !== undefined) {
      if (entry.count === 1) {
        TaintRegistryValues.delete(entryValue);
      } else {
        entry.count--;
      }
    }
  }
  cleanupQueue.length = 0;
}

function defaultErrorHandler(error: mixed) {
  console['error'](error);
  // Don't transform to our wrapper
}

function defaultPostponeHandler(reason: string) {
  // Noop
}

const OPEN = 0;
const ABORTING = 1;
const CLOSING = 2;
const CLOSED = 3;

function RequestInstance(
  this: $FlowFixMe,
  model: ReactClientValue,
  bundlerConfig: ClientManifest,
  onError: void | ((error: mixed) => ?string),
  identifierPrefix?: string,
  onPostpone: void | ((reason: string) => void),
  temporaryReferences: void | TemporaryReferenceSet,
  environmentName: void | string | (() => string), // DEV-only
  filterStackFrame: void | ((url: string, functionName: string) => boolean), // DEV-only
) {
  if (
    ReactSharedInternals.A !== null &&
    ReactSharedInternals.A !== DefaultAsyncDispatcher
  ) {
    throw new Error(
      'Currently React only supports one RSC renderer at a time.',
    );
  }
  ReactSharedInternals.A = DefaultAsyncDispatcher;
  if (__DEV__) {
    // Unlike Fizz or Fiber, we don't reset this and just keep it on permanently.
    // This lets it act more like the AsyncDispatcher so that we can get the
    // stack asynchronously too.
    ReactSharedInternals.getCurrentStack = getCurrentStackInDEV;
  }

  const abortSet: Set<Task> = new Set();
  const pingedTasks: Array<Task> = [];
  const cleanupQueue: Array<string | bigint> = [];
  if (enableTaint) {
    TaintRegistryPendingRequests.add(cleanupQueue);
  }
  const hints = createHints();
  this.status = OPEN;
  this.flushScheduled = false;
  this.fatalError = null;
  this.destination = null;
  this.bundlerConfig = bundlerConfig;
  this.cache = new Map();
  this.nextChunkId = 0;
  this.pendingChunks = 0;
  this.hints = hints;
  this.abortListeners = new Set();
  this.abortableTasks = abortSet;
  this.pingedTasks = pingedTasks;
  this.completedImportChunks = ([]: Array<Chunk>);
  this.completedHintChunks = ([]: Array<Chunk>);
  this.completedRegularChunks = ([]: Array<Chunk | BinaryChunk>);
  this.completedErrorChunks = ([]: Array<Chunk>);
  this.writtenSymbols = new Map();
  this.writtenClientReferences = new Map();
  this.writtenServerReferences = new Map();
  this.writtenObjects = new WeakMap();
  this.temporaryReferences = temporaryReferences;
  this.identifierPrefix = identifierPrefix || '';
  this.identifierCount = 1;
  this.taintCleanupQueue = cleanupQueue;
  this.onError = onError === undefined ? defaultErrorHandler : onError;
  this.onPostpone =
    onPostpone === undefined ? defaultPostponeHandler : onPostpone;

  if (__DEV__) {
    this.environmentName =
      environmentName === undefined
        ? () => 'Server'
        : typeof environmentName !== 'function'
          ? () => environmentName
          : environmentName;
    this.filterStackFrame =
      filterStackFrame === undefined
        ? defaultFilterStackFrame
        : filterStackFrame;
    this.didWarnForKey = null;
  }
  const rootTask = createTask(
    this,
    model,
    null,
    false,
    abortSet,
    null,
    null,
    null,
  );
  pingedTasks.push(rootTask);
}

export function createRequest(
  model: ReactClientValue,
  bundlerConfig: ClientManifest,
  onError: void | ((error: mixed) => ?string),
  identifierPrefix?: string,
  onPostpone: void | ((reason: string) => void),
  temporaryReferences: void | TemporaryReferenceSet,
  environmentName: void | string | (() => string), // DEV-only
  filterStackFrame: void | ((url: string, functionName: string) => boolean), // DEV-only
): Request {
  // $FlowFixMe[invalid-constructor]: the shapes are exact here but Flow doesn't like constructors
  return new RequestInstance(
    model,
    bundlerConfig,
    onError,
    identifierPrefix,
    onPostpone,
    temporaryReferences,
    environmentName,
    filterStackFrame,
  );
}

let currentRequest: null | Request = null;

export function resolveRequest(): null | Request {
  if (currentRequest) return currentRequest;
  if (supportsRequestStorage) {
    const store = requestStorage.getStore();
    if (store) return store;
  }
  return null;
}

function serializeThenable(
  request: Request,
  task: Task,
  thenable: Thenable<any>,
): number {
  const newTask = createTask(
    request,
    null,
    task.keyPath, // the server component sequence continues through Promise-as-a-child.
    task.implicitSlot,
    request.abortableTasks,
    __DEV__ ? task.debugOwner : null,
    __DEV__ && enableOwnerStacks ? task.debugStack : null,
    __DEV__ && enableOwnerStacks ? task.debugTask : null,
  );
  if (__DEV__) {
    // If this came from Flight, forward any debug info into this new row.
    const debugInfo: ?ReactDebugInfo = (thenable: any)._debugInfo;
    if (debugInfo) {
      forwardDebugInfo(request, newTask.id, debugInfo);
    }
  }

  switch (thenable.status) {
    case 'fulfilled': {
      // We have the resolved value, we can go ahead and schedule it for serialization.
      newTask.model = thenable.value;
      pingTask(request, newTask);
      return newTask.id;
    }
    case 'rejected': {
      const x = thenable.reason;
      if (
        enablePostpone &&
        typeof x === 'object' &&
        x !== null &&
        (x: any).$$typeof === REACT_POSTPONE_TYPE
      ) {
        const postponeInstance: Postpone = (x: any);
        logPostpone(request, postponeInstance.message, newTask);
        emitPostponeChunk(request, newTask.id, postponeInstance);
      } else {
        const digest = logRecoverableError(request, x, null);
        emitErrorChunk(request, newTask.id, digest, x);
      }
      return newTask.id;
    }
    default: {
      if (request.status === ABORTING) {
        // We can no longer accept any resolved values
        newTask.status = ABORTED;
        const errorId: number = (request.fatalError: any);
        const model = stringify(serializeByValueID(errorId));
        emitModelChunk(request, newTask.id, model);
        request.abortableTasks.delete(newTask);
        return newTask.id;
      }
      if (typeof thenable.status === 'string') {
        // Only instrument the thenable if the status if not defined. If
        // it's defined, but an unknown value, assume it's been instrumented by
        // some custom userspace implementation. We treat it as "pending".
        break;
      }
      const pendingThenable: PendingThenable<mixed> = (thenable: any);
      pendingThenable.status = 'pending';
      pendingThenable.then(
        fulfilledValue => {
          if (thenable.status === 'pending') {
            const fulfilledThenable: FulfilledThenable<mixed> = (thenable: any);
            fulfilledThenable.status = 'fulfilled';
            fulfilledThenable.value = fulfilledValue;
          }
        },
        (error: mixed) => {
          if (thenable.status === 'pending') {
            const rejectedThenable: RejectedThenable<mixed> = (thenable: any);
            rejectedThenable.status = 'rejected';
            rejectedThenable.reason = error;
          }
        },
      );
      break;
    }
  }

  thenable.then(
    value => {
      newTask.model = value;
      pingTask(request, newTask);
    },
    reason => {
      if (
        enablePostpone &&
        typeof reason === 'object' &&
        reason !== null &&
        (reason: any).$$typeof === REACT_POSTPONE_TYPE
      ) {
        const postponeInstance: Postpone = (reason: any);
        logPostpone(request, postponeInstance.message, newTask);
        emitPostponeChunk(request, newTask.id, postponeInstance);
      } else {
        newTask.status = ERRORED;
        const digest = logRecoverableError(request, reason, newTask);
        emitErrorChunk(request, newTask.id, digest, reason);
      }
      request.abortableTasks.delete(newTask);
      enqueueFlush(request);
    },
  );

  return newTask.id;
}

function serializeReadableStream(
  request: Request,
  task: Task,
  stream: ReadableStream,
): string {
  // Detect if this is a BYOB stream. BYOB streams should be able to be read as bytes on the
  // receiving side. It also implies that different chunks can be split up or merged as opposed
  // to a readable stream that happens to have Uint8Array as the type which might expect it to be
  // received in the same slices.
  // $FlowFixMe: This is a Node.js extension.
  let supportsBYOB: void | boolean = stream.supportsBYOB;
  if (supportsBYOB === undefined) {
    try {
      // $FlowFixMe[extra-arg]: This argument is accepted.
      stream.getReader({mode: 'byob'}).releaseLock();
      supportsBYOB = true;
    } catch (x) {
      supportsBYOB = false;
    }
  }

  const reader = stream.getReader();

  // This task won't actually be retried. We just use it to attempt synchronous renders.
  const streamTask = createTask(
    request,
    task.model,
    task.keyPath,
    task.implicitSlot,
    request.abortableTasks,
    __DEV__ ? task.debugOwner : null,
    __DEV__ && enableOwnerStacks ? task.debugStack : null,
    __DEV__ && enableOwnerStacks ? task.debugTask : null,
  );
  request.abortableTasks.delete(streamTask);

  request.pendingChunks++; // The task represents the Start row. This adds a Stop row.

  const startStreamRow =
    streamTask.id.toString(16) + ':' + (supportsBYOB ? 'r' : 'R') + '\n';
  request.completedRegularChunks.push(stringToChunk(startStreamRow));

  // There's a race condition between when the stream is aborted and when the promise
  // resolves so we track whether we already aborted it to avoid writing twice.
  let aborted = false;
  function progress(entry: {done: boolean, value: ReactClientValue, ...}) {
    if (aborted) {
      return;
    }

    if (entry.done) {
      request.abortListeners.delete(error);
      const endStreamRow = streamTask.id.toString(16) + ':C\n';
      request.completedRegularChunks.push(stringToChunk(endStreamRow));
      enqueueFlush(request);
      aborted = true;
    } else {
      try {
        streamTask.model = entry.value;
        request.pendingChunks++;
        tryStreamTask(request, streamTask);
        enqueueFlush(request);
        reader.read().then(progress, error);
      } catch (x) {
        error(x);
      }
    }
  }
  function error(reason: mixed) {
    if (aborted) {
      return;
    }
    aborted = true;
    request.abortListeners.delete(error);
    if (
      enablePostpone &&
      typeof reason === 'object' &&
      reason !== null &&
      (reason: any).$$typeof === REACT_POSTPONE_TYPE
    ) {
      const postponeInstance: Postpone = (reason: any);
      logPostpone(request, postponeInstance.message, streamTask);
      emitPostponeChunk(request, streamTask.id, postponeInstance);
    } else {
      const digest = logRecoverableError(request, reason, streamTask);
      emitErrorChunk(request, streamTask.id, digest, reason);
    }
    enqueueFlush(request);
    // $FlowFixMe should be able to pass mixed
    reader.cancel(reason).then(error, error);
  }
  request.abortListeners.add(error);
  reader.read().then(progress, error);
  return serializeByValueID(streamTask.id);
}

function serializeAsyncIterable(
  request: Request,
  task: Task,
  iterable: $AsyncIterable<ReactClientValue, ReactClientValue, void>,
  iterator: $AsyncIterator<ReactClientValue, ReactClientValue, void>,
): string {
  // Generators/Iterators are Iterables but they're also their own iterator
  // functions. If that's the case, we treat them as single-shot. Otherwise,
  // we assume that this iterable might be a multi-shot and allow it to be
  // iterated more than once on the client.
  const isIterator = iterable === iterator;

  // This task won't actually be retried. We just use it to attempt synchronous renders.
  const streamTask = createTask(
    request,
    task.model,
    task.keyPath,
    task.implicitSlot,
    request.abortableTasks,
    __DEV__ ? task.debugOwner : null,
    __DEV__ && enableOwnerStacks ? task.debugStack : null,
    __DEV__ && enableOwnerStacks ? task.debugTask : null,
  );
  request.abortableTasks.delete(streamTask);

  request.pendingChunks++; // The task represents the Start row. This adds a Stop row.

  const startStreamRow =
    streamTask.id.toString(16) + ':' + (isIterator ? 'x' : 'X') + '\n';
  request.completedRegularChunks.push(stringToChunk(startStreamRow));

  if (__DEV__) {
    const debugInfo: ?ReactDebugInfo = (iterable: any)._debugInfo;
    if (debugInfo) {
      forwardDebugInfo(request, streamTask.id, debugInfo);
    }
  }

  // There's a race condition between when the stream is aborted and when the promise
  // resolves so we track whether we already aborted it to avoid writing twice.
  let aborted = false;
  function progress(
    entry:
      | {done: false, +value: ReactClientValue, ...}
      | {done: true, +value: ReactClientValue, ...},
  ) {
    if (aborted) {
      return;
    }

    if (entry.done) {
      request.abortListeners.delete(error);
      let endStreamRow;
      if (entry.value === undefined) {
        endStreamRow = streamTask.id.toString(16) + ':C\n';
      } else {
        // Unlike streams, the last value may not be undefined. If it's not
        // we outline it and encode a reference to it in the closing instruction.
        try {
          const chunkId = outlineModel(request, entry.value);
          endStreamRow =
            streamTask.id.toString(16) +
            ':C' +
            stringify(serializeByValueID(chunkId)) +
            '\n';
        } catch (x) {
          error(x);
          return;
        }
      }
      request.completedRegularChunks.push(stringToChunk(endStreamRow));
      enqueueFlush(request);
      aborted = true;
    } else {
      try {
        streamTask.model = entry.value;
        request.pendingChunks++;
        tryStreamTask(request, streamTask);
        enqueueFlush(request);
        if (__DEV__) {
          callIteratorInDEV(iterator, progress, error);
        } else {
          iterator.next().then(progress, error);
        }
      } catch (x) {
        error(x);
        return;
      }
    }
  }
  function error(reason: mixed) {
    if (aborted) {
      return;
    }
    aborted = true;
    request.abortListeners.delete(error);
    if (
      enablePostpone &&
      typeof reason === 'object' &&
      reason !== null &&
      (reason: any).$$typeof === REACT_POSTPONE_TYPE
    ) {
      const postponeInstance: Postpone = (reason: any);
      logPostpone(request, postponeInstance.message, streamTask);
      emitPostponeChunk(request, streamTask.id, postponeInstance);
    } else {
      const digest = logRecoverableError(request, reason, streamTask);
      emitErrorChunk(request, streamTask.id, digest, reason);
    }
    enqueueFlush(request);
    if (typeof (iterator: any).throw === 'function') {
      // The iterator protocol doesn't necessarily include this but a generator do.
      // $FlowFixMe should be able to pass mixed
      iterator.throw(reason).then(error, error);
    }
  }
  request.abortListeners.add(error);
  if (__DEV__) {
    callIteratorInDEV(iterator, progress, error);
  } else {
    iterator.next().then(progress, error);
  }
  return serializeByValueID(streamTask.id);
}

export function emitHint<Code: HintCode>(
  request: Request,
  code: Code,
  model: HintModel<Code>,
): void {
  emitHintChunk(request, code, model);
  enqueueFlush(request);
}

export function getHints(request: Request): Hints {
  return request.hints;
}

export function getCache(request: Request): Map<Function, mixed> {
  return request.cache;
}

function readThenable<T>(thenable: Thenable<T>): T {
  if (thenable.status === 'fulfilled') {
    return thenable.value;
  } else if (thenable.status === 'rejected') {
    throw thenable.reason;
  }
  throw thenable;
}

function createLazyWrapperAroundWakeable(wakeable: Wakeable) {
  // This is a temporary fork of the `use` implementation until we accept
  // promises everywhere.
  const thenable: Thenable<mixed> = (wakeable: any);
  switch (thenable.status) {
    case 'fulfilled':
    case 'rejected':
      break;
    default: {
      if (typeof thenable.status === 'string') {
        // Only instrument the thenable if the status if not defined. If
        // it's defined, but an unknown value, assume it's been instrumented by
        // some custom userspace implementation. We treat it as "pending".
        break;
      }
      const pendingThenable: PendingThenable<mixed> = (thenable: any);
      pendingThenable.status = 'pending';
      pendingThenable.then(
        fulfilledValue => {
          if (thenable.status === 'pending') {
            const fulfilledThenable: FulfilledThenable<mixed> = (thenable: any);
            fulfilledThenable.status = 'fulfilled';
            fulfilledThenable.value = fulfilledValue;
          }
        },
        (error: mixed) => {
          if (thenable.status === 'pending') {
            const rejectedThenable: RejectedThenable<mixed> = (thenable: any);
            rejectedThenable.status = 'rejected';
            rejectedThenable.reason = error;
          }
        },
      );
      break;
    }
  }
  const lazyType: LazyComponent<any, Thenable<any>> = {
    $$typeof: REACT_LAZY_TYPE,
    _payload: thenable,
    _init: readThenable,
  };
  if (__DEV__) {
    // If this came from React, transfer the debug info.
    lazyType._debugInfo = (thenable: any)._debugInfo || [];
  }
  return lazyType;
}

function callWithDebugContextInDEV<A, T>(
  request: Request,
  task: Task,
  callback: A => T,
  arg: A,
): T {
  // We don't have a Server Component instance associated with this callback and
  // the nearest context is likely a Client Component being serialized. We create
  // a fake owner during this callback so we can get the stack trace from it.
  // This also gets sent to the client as the owner for the replaying log.
  const componentDebugInfo: ReactComponentInfo = {
    name: '',
    env: task.environmentName,
    owner: task.debugOwner,
  };
  if (enableOwnerStacks) {
    // $FlowFixMe[cannot-write]
    componentDebugInfo.stack =
      task.debugStack === null
        ? null
        : filterStackTrace(request, task.debugStack, 1);
    // $FlowFixMe[cannot-write]
    componentDebugInfo.debugStack = task.debugStack;
    // $FlowFixMe[cannot-write]
    componentDebugInfo.debugTask = task.debugTask;
  }
  const debugTask = task.debugTask;
  // We don't need the async component storage context here so we only set the
  // synchronous tracking of owner.
  setCurrentOwner(componentDebugInfo);
  try {
    if (enableOwnerStacks && debugTask) {
      return debugTask.run(callback.bind(null, arg));
    }
    return callback(arg);
  } finally {
    setCurrentOwner(null);
  }
}

function renderFunctionComponent<Props>(
  request: Request,
  task: Task,
  key: null | string,
  Component: (p: Props, arg: void) => any,
  props: Props,
  validated: number, // DEV-only
): ReactJSONValue {
  // Reset the task's thenable state before continuing, so that if a later
  // component suspends we can reuse the same task object. If the same
  // component suspends again, the thenable state will be restored.
  const prevThenableState = task.thenableState;
  task.thenableState = null;

  let result;

  let componentDebugInfo: ReactComponentInfo;
  if (__DEV__) {
    if (debugID === null) {
      // We don't have a chunk to assign debug info. We need to outline this
      // component to assign it an ID.
      return outlineTask(request, task);
    } else if (prevThenableState !== null) {
      // This is a replay and we've already emitted the debug info of this component
      // in the first pass. We skip emitting a duplicate line.
      // As a hack we stashed the previous component debug info on this object in DEV.
      componentDebugInfo = (prevThenableState: any)._componentDebugInfo;
    } else {
      // This is a new component in the same task so we can emit more debug info.
      const componentDebugID = debugID;
      const componentName =
        (Component: any).displayName || Component.name || '';
      const componentEnv = (0, request.environmentName)();
      request.pendingChunks++;
      componentDebugInfo = ({
        name: componentName,
        env: componentEnv,
        owner: task.debugOwner,
      }: ReactComponentInfo);
      if (enableOwnerStacks) {
        // $FlowFixMe[cannot-write]
        componentDebugInfo.stack =
          task.debugStack === null
            ? null
            : filterStackTrace(request, task.debugStack, 1);
        // $FlowFixMe[cannot-write]
        componentDebugInfo.debugStack = task.debugStack;
        // $FlowFixMe[cannot-write]
        componentDebugInfo.debugTask = task.debugTask;
      }
      // We outline this model eagerly so that we can refer to by reference as an owner.
      // If we had a smarter way to dedupe we might not have to do this if there ends up
      // being no references to this as an owner.
      outlineModel(request, componentDebugInfo);
      emitDebugChunk(request, componentDebugID, componentDebugInfo);

      // We've emitted the latest environment for this task so we track that.
      task.environmentName = componentEnv;

      if (enableOwnerStacks && validated === 2) {
        warnForMissingKey(request, key, componentDebugInfo, task.debugTask);
      }
    }
    prepareToUseHooksForComponent(prevThenableState, componentDebugInfo);
    if (supportsComponentStorage) {
      // Run the component in an Async Context that tracks the current owner.
      if (enableOwnerStacks && task.debugTask) {
        result = task.debugTask.run(
          // $FlowFixMe[method-unbinding]
          componentStorage.run.bind(
            componentStorage,
            componentDebugInfo,
            callComponentInDEV,
            Component,
            props,
            componentDebugInfo,
          ),
        );
      } else {
        result = componentStorage.run(
          componentDebugInfo,
          callComponentInDEV,
          Component,
          props,
          componentDebugInfo,
        );
      }
    } else {
      if (enableOwnerStacks && task.debugTask) {
        result = task.debugTask.run(
          callComponentInDEV.bind(null, Component, props, componentDebugInfo),
        );
      } else {
        result = callComponentInDEV(Component, props, componentDebugInfo);
      }
    }
  } else {
    prepareToUseHooksForComponent(prevThenableState, null);
    // The secondArg is always undefined in Server Components since refs error early.
    const secondArg = undefined;
    result = Component(props, secondArg);
  }

  if (request.status === ABORTING) {
    // If we aborted during rendering we should interrupt the render but
    // we don't need to provide an error because the renderer will encode
    // the abort error as the reason.
    throw AbortSigil;
  }

  if (
    typeof result === 'object' &&
    result !== null &&
    !isClientReference(result)
  ) {
    if (typeof result.then === 'function') {
      // When the return value is in children position we can resolve it immediately,
      // to its value without a wrapper if it's synchronously available.
      const thenable: Thenable<any> = result;
      if (__DEV__) {
        // If the thenable resolves to an element, then it was in a static position,
        // the return value of a Server Component. That doesn't need further validation
        // of keys. The Server Component itself would have had a key.
        thenable.then(
          resolvedValue => {
            if (
              typeof resolvedValue === 'object' &&
              resolvedValue !== null &&
              resolvedValue.$$typeof === REACT_ELEMENT_TYPE
            ) {
              resolvedValue._store.validated = 1;
            }
          },
          () => {},
        );
      }
      if (thenable.status === 'fulfilled') {
        return thenable.value;
      }
      // TODO: Once we accept Promises as children on the client, we can just return
      // the thenable here.
      result = createLazyWrapperAroundWakeable(result);
    }

    // Normally we'd serialize an Iterator/AsyncIterator as a single-shot which is not compatible
    // to be rendered as a React Child. However, because we have the function to recreate
    // an iterable from rendering the element again, we can effectively treat it as multi-
    // shot. Therefore we treat this as an Iterable/AsyncIterable, whether it was one or not, by
    // adding a wrapper so that this component effectively renders down to an AsyncIterable.
    const iteratorFn = getIteratorFn(result);
    if (iteratorFn) {
      const iterableChild = result;
      result = {
        [Symbol.iterator]: function () {
          const iterator = iteratorFn.call(iterableChild);
          if (__DEV__) {
            // If this was an Iterator but not a GeneratorFunction we warn because
            // it might have been a mistake. Technically you can make this mistake with
            // GeneratorFunctions and even single-shot Iterables too but it's extra
            // tempting to try to return the value from a generator.
            if (iterator === iterableChild) {
              const isGeneratorComponent =
                // $FlowIgnore[method-unbinding]
                Object.prototype.toString.call(Component) ===
                  '[object GeneratorFunction]' &&
                // $FlowIgnore[method-unbinding]
                Object.prototype.toString.call(iterableChild) ===
                  '[object Generator]';
              if (!isGeneratorComponent) {
                callWithDebugContextInDEV(request, task, () => {
                  console.error(
                    'Returning an Iterator from a Server Component is not supported ' +
                      'since it cannot be looped over more than once. ',
                  );
                });
              }
            }
          }
          return (iterator: any);
        },
      };
      if (__DEV__) {
        (result: any)._debugInfo = iterableChild._debugInfo;
      }
    } else if (
      enableFlightReadableStream &&
      typeof (result: any)[ASYNC_ITERATOR] === 'function' &&
      (typeof ReadableStream !== 'function' ||
        !(result instanceof ReadableStream))
    ) {
      const iterableChild = result;
      result = {
        [ASYNC_ITERATOR]: function () {
          const iterator = (iterableChild: any)[ASYNC_ITERATOR]();
          if (__DEV__) {
            // If this was an AsyncIterator but not an AsyncGeneratorFunction we warn because
            // it might have been a mistake. Technically you can make this mistake with
            // AsyncGeneratorFunctions and even single-shot AsyncIterables too but it's extra
            // tempting to try to return the value from a generator.
            if (iterator === iterableChild) {
              const isGeneratorComponent =
                // $FlowIgnore[method-unbinding]
                Object.prototype.toString.call(Component) ===
                  '[object AsyncGeneratorFunction]' &&
                // $FlowIgnore[method-unbinding]
                Object.prototype.toString.call(iterableChild) ===
                  '[object AsyncGenerator]';
              if (!isGeneratorComponent) {
                callWithDebugContextInDEV(request, task, () => {
                  console.error(
                    'Returning an AsyncIterator from a Server Component is not supported ' +
                      'since it cannot be looped over more than once. ',
                  );
                });
              }
            }
          }
          return iterator;
        },
      };
      if (__DEV__) {
        (result: any)._debugInfo = iterableChild._debugInfo;
      }
    } else if (__DEV__ && (result: any).$$typeof === REACT_ELEMENT_TYPE) {
      // If the server component renders to an element, then it was in a static position.
      // That doesn't need further validation of keys. The Server Component itself would
      // have had a key.
      (result: any)._store.validated = 1;
    }
  }
  // Track this element's key on the Server Component on the keyPath context..
  const prevKeyPath = task.keyPath;
  const prevImplicitSlot = task.implicitSlot;
  if (key !== null) {
    // Append the key to the path. Technically a null key should really add the child
    // index. We don't do that to hold the payload small and implementation simple.
    task.keyPath = prevKeyPath === null ? key : prevKeyPath + ',' + key;
  } else if (prevKeyPath === null) {
    // This sequence of Server Components has no keys. This means that it was rendered
    // in a slot that needs to assign an implicit key. Even if children below have
    // explicit keys, they should not be used for the outer most key since it might
    // collide with other slots in that set.
    task.implicitSlot = true;
  }
  const json = renderModelDestructive(request, task, emptyRoot, '', result);
  task.keyPath = prevKeyPath;
  task.implicitSlot = prevImplicitSlot;
  return json;
}

function warnForMissingKey(
  request: Request,
  key: null | string,
  componentDebugInfo: ReactComponentInfo,
  debugTask: null | ConsoleTask,
): void {
  if (__DEV__) {
    let didWarnForKey = request.didWarnForKey;
    if (didWarnForKey == null) {
      didWarnForKey = request.didWarnForKey = new WeakSet();
    }
    const parentOwner = componentDebugInfo.owner;
    if (parentOwner != null) {
      if (didWarnForKey.has(parentOwner)) {
        // We already warned for other children in this parent.
        return;
      }
      didWarnForKey.add(parentOwner);
    }

    // Call with the server component as the currently rendering component
    // for context.
    const logKeyError = () => {
      console.error(
        'Each child in a list should have a unique "key" prop.' +
          '%s%s See https://react.dev/link/warning-keys for more information.',
        '',
        '',
      );
    };

    if (supportsComponentStorage) {
      // Run the component in an Async Context that tracks the current owner.
      if (enableOwnerStacks && debugTask) {
        debugTask.run(
          // $FlowFixMe[method-unbinding]
          componentStorage.run.bind(
            componentStorage,
            componentDebugInfo,
            callComponentInDEV,
            logKeyError,
            null,
            componentDebugInfo,
          ),
        );
      } else {
        componentStorage.run(
          componentDebugInfo,
          callComponentInDEV,
          logKeyError,
          null,
          componentDebugInfo,
        );
      }
    } else {
      if (enableOwnerStacks && debugTask) {
        debugTask.run(
          callComponentInDEV.bind(null, logKeyError, null, componentDebugInfo),
        );
      } else {
        callComponentInDEV(logKeyError, null, componentDebugInfo);
      }
    }
  }
}

function renderFragment(
  request: Request,
  task: Task,
  children: $ReadOnlyArray<ReactClientValue>,
): ReactJSONValue {
  if (__DEV__) {
    for (let i = 0; i < children.length; i++) {
      const child = children[i];
      if (
        child !== null &&
        typeof child === 'object' &&
        child.$$typeof === REACT_ELEMENT_TYPE
      ) {
        const element: ReactElement = (child: any);
        if (element.key === null && !element._store.validated) {
          element._store.validated = 2;
        }
      }
    }
  }

  if (task.keyPath !== null) {
    // We have a Server Component that specifies a key but we're now splitting
    // the tree using a fragment.
    const fragment = __DEV__
      ? enableOwnerStacks
        ? [
            REACT_ELEMENT_TYPE,
            REACT_FRAGMENT_TYPE,
            task.keyPath,
            {children},
            null,
            null,
            0,
          ]
        : [
            REACT_ELEMENT_TYPE,
            REACT_FRAGMENT_TYPE,
            task.keyPath,
            {children},
            null,
          ]
      : [REACT_ELEMENT_TYPE, REACT_FRAGMENT_TYPE, task.keyPath, {children}];
    if (!task.implicitSlot) {
      // If this was keyed inside a set. I.e. the outer Server Component was keyed
      // then we need to handle reorders of the whole set. To do this we need to wrap
      // this array in a keyed Fragment.
      return fragment;
    }
    // If the outer Server Component was implicit but then an inner one had a key
    // we don't actually need to be able to move the whole set around. It'll always be
    // in an implicit slot. The key only exists to be able to reset the state of the
    // children. We could achieve the same effect by passing on the keyPath to the next
    // set of components inside the fragment. This would also allow a keyless fragment
    // reconcile against a single child.
    // Unfortunately because of JSON.stringify, we can't call the recursive loop for
    // each child within this context because we can't return a set with already resolved
    // values. E.g. a string would get double encoded. Returning would pop the context.
    // So instead, we wrap it with an unkeyed fragment and inner keyed fragment.
    return [fragment];
  }
  // Since we're yielding here, that implicitly resets the keyPath context on the
  // way up. Which is what we want since we've consumed it. If this changes to
  // be recursive serialization, we need to reset the keyPath and implicitSlot,
  // before recursing here.
  if (__DEV__) {
    const debugInfo: ?ReactDebugInfo = (children: any)._debugInfo;
    if (debugInfo) {
      // If this came from Flight, forward any debug info into this new row.
      if (debugID === null) {
        // We don't have a chunk to assign debug info. We need to outline this
        // component to assign it an ID.
        return outlineTask(request, task);
      } else {
        // Forward any debug info we have the first time we see it.
        // We do this after init so that we have received all the debug info
        // from the server by the time we emit it.
        forwardDebugInfo(request, debugID, debugInfo);
      }
      // Since we're rendering this array again, create a copy that doesn't
      // have the debug info so we avoid outlining or emitting debug info again.
      children = Array.from(children);
    }
  }
  return children;
}

function renderAsyncFragment(
  request: Request,
  task: Task,
  children: $AsyncIterable<ReactClientValue, ReactClientValue, void>,
  getAsyncIterator: () => $AsyncIterator<any, any, any>,
): ReactJSONValue {
  if (task.keyPath !== null) {
    // We have a Server Component that specifies a key but we're now splitting
    // the tree using a fragment.
    const fragment = __DEV__
      ? enableOwnerStacks
        ? [
            REACT_ELEMENT_TYPE,
            REACT_FRAGMENT_TYPE,
            task.keyPath,
            {children},
            null,
            null,
            0,
          ]
        : [
            REACT_ELEMENT_TYPE,
            REACT_FRAGMENT_TYPE,
            task.keyPath,
            {children},
            null,
          ]
      : [REACT_ELEMENT_TYPE, REACT_FRAGMENT_TYPE, task.keyPath, {children}];
    if (!task.implicitSlot) {
      // If this was keyed inside a set. I.e. the outer Server Component was keyed
      // then we need to handle reorders of the whole set. To do this we need to wrap
      // this array in a keyed Fragment.
      return fragment;
    }
    // If the outer Server Component was implicit but then an inner one had a key
    // we don't actually need to be able to move the whole set around. It'll always be
    // in an implicit slot. The key only exists to be able to reset the state of the
    // children. We could achieve the same effect by passing on the keyPath to the next
    // set of components inside the fragment. This would also allow a keyless fragment
    // reconcile against a single child.
    // Unfortunately because of JSON.stringify, we can't call the recursive loop for
    // each child within this context because we can't return a set with already resolved
    // values. E.g. a string would get double encoded. Returning would pop the context.
    // So instead, we wrap it with an unkeyed fragment and inner keyed fragment.
    return [fragment];
  }

  // Since we're yielding here, that implicitly resets the keyPath context on the
  // way up. Which is what we want since we've consumed it. If this changes to
  // be recursive serialization, we need to reset the keyPath and implicitSlot,
  // before recursing here.
  const asyncIterator = getAsyncIterator.call(children);
  return serializeAsyncIterable(request, task, children, asyncIterator);
}

function renderClientElement(
  request: Request,
  task: Task,
  type: any,
  key: null | string,
  props: any,
  validated: number, // DEV-only
): ReactJSONValue {
  // We prepend the terminal client element that actually gets serialized with
  // the keys of any Server Components which are not serialized.
  const keyPath = task.keyPath;
  if (key === null) {
    key = keyPath;
  } else if (keyPath !== null) {
    key = keyPath + ',' + key;
  }
  const element = __DEV__
    ? enableOwnerStacks
      ? [
          REACT_ELEMENT_TYPE,
          type,
          key,
          props,
          task.debugOwner,
          task.debugStack === null
            ? null
            : filterStackTrace(request, task.debugStack, 1),
          validated,
        ]
      : [REACT_ELEMENT_TYPE, type, key, props, task.debugOwner]
    : [REACT_ELEMENT_TYPE, type, key, props];
  if (task.implicitSlot && key !== null) {
    // The root Server Component had no key so it was in an implicit slot.
    // If we had a key lower, it would end up in that slot with an explicit key.
    // We wrap the element in a fragment to give it an implicit key slot with
    // an inner explicit key.
    return [element];
  }
  // Since we're yielding here, that implicitly resets the keyPath context on the
  // way up. Which is what we want since we've consumed it. If this changes to
  // be recursive serialization, we need to reset the keyPath and implicitSlot,
  // before recursing here. We also need to reset it once we render into an array
  // or anything else too which we also get implicitly.
  return element;
}

// The chunk ID we're currently rendering that we can assign debug data to.
let debugID: null | number = null;

function outlineTask(request: Request, task: Task): ReactJSONValue {
  const newTask = createTask(
    request,
    task.model, // the currently rendering element
    task.keyPath, // unlike outlineModel this one carries along context
    task.implicitSlot,
    request.abortableTasks,
    __DEV__ ? task.debugOwner : null,
    __DEV__ && enableOwnerStacks ? task.debugStack : null,
    __DEV__ && enableOwnerStacks ? task.debugTask : null,
  );

  retryTask(request, newTask);
  if (newTask.status === COMPLETED) {
    // We completed synchronously so we can refer to this by reference. This
    // makes it behaves the same as prod during deserialization.
    return serializeByValueID(newTask.id);
  }
  // This didn't complete synchronously so it wouldn't have even if we didn't
  // outline it, so this would reduce to a lazy reference even in prod.
  return serializeLazyID(newTask.id);
}

function renderElement(
  request: Request,
  task: Task,
  type: any,
  key: null | string,
  ref: mixed,
  props: any,
  validated: number, // DEV only
): ReactJSONValue {
  if (ref !== null && ref !== undefined) {
    // When the ref moves to the regular props object this will implicitly
    // throw for functions. We could probably relax it to a DEV warning for other
    // cases.
    // TODO: `ref` is now just a prop when `enableRefAsProp` is on. Should we
    // do what the above comment says?
    throw new Error(
      'Refs cannot be used in Server Components, nor passed to Client Components.',
    );
  }
  if (__DEV__) {
    jsxPropsParents.set(props, type);
    if (typeof props.children === 'object' && props.children !== null) {
      jsxChildrenParents.set(props.children, type);
    }
  }
  if (
    typeof type === 'function' &&
    !isClientReference(type) &&
    !isOpaqueTemporaryReference(type)
  ) {
    // This is a Server Component.
    return renderFunctionComponent(request, task, key, type, props, validated);
  } else if (type === REACT_FRAGMENT_TYPE && key === null) {
    // For key-less fragments, we add a small optimization to avoid serializing
    // it as a wrapper.
    if (__DEV__ && enableOwnerStacks && validated === 2) {
      // Create a fake owner node for the error stack.
      const componentDebugInfo: ReactComponentInfo = {
        name: 'Fragment',
        env: (0, request.environmentName)(),
        owner: task.debugOwner,
        stack:
          task.debugStack === null
            ? null
            : filterStackTrace(request, task.debugStack, 1),
        debugStack: task.debugStack,
        debugTask: task.debugTask,
      };
      warnForMissingKey(request, key, componentDebugInfo, task.debugTask);
    }
    const prevImplicitSlot = task.implicitSlot;
    if (task.keyPath === null) {
      task.implicitSlot = true;
    }
    const json = renderModelDestructive(
      request,
      task,
      emptyRoot,
      '',
      props.children,
    );
    task.implicitSlot = prevImplicitSlot;
    return json;
  } else if (
    type != null &&
    typeof type === 'object' &&
    !isClientReference(type)
  ) {
    switch (type.$$typeof) {
      case REACT_LAZY_TYPE: {
        let wrappedType;
        if (__DEV__) {
          wrappedType = callLazyInitInDEV(type);
        } else {
          const payload = type._payload;
          const init = type._init;
          wrappedType = init(payload);
        }
        if (request.status === ABORTING) {
          // lazy initializers are user code and could abort during render
          // we don't wan to return any value resolved from the lazy initializer
          // if it aborts so we interrupt rendering here
          throw AbortSigil;
        }
        return renderElement(
          request,
          task,
          wrappedType,
          key,
          ref,
          props,
          validated,
        );
      }
      case REACT_FORWARD_REF_TYPE: {
        return renderFunctionComponent(
          request,
          task,
          key,
          type.render,
          props,
          validated,
        );
      }
      case REACT_MEMO_TYPE: {
        return renderElement(
          request,
          task,
          type.type,
          key,
          ref,
          props,
          validated,
        );
      }
      case REACT_ELEMENT_TYPE: {
        // This is invalid but we'll let the client determine that it is.
        if (__DEV__) {
          // Disable the key warning that would happen otherwise because this
          // element gets serialized inside an array. We'll error later anyway.
          type._store.validated = 1;
        }
      }
    }
  }
  // For anything else, try it on the client instead.
  // We don't know if the client will support it or not. This might error on the
  // client or error during serialization but the stack will point back to the
  // server.
  return renderClientElement(request, task, type, key, props, validated);
}

function pingTask(request: Request, task: Task): void {
  const pingedTasks = request.pingedTasks;
  pingedTasks.push(task);
  if (pingedTasks.length === 1) {
    request.flushScheduled = request.destination !== null;
    scheduleMicrotask(() => performWork(request));
  }
}

function createTask(
  request: Request,
  model: ReactClientValue,
  keyPath: null | string,
  implicitSlot: boolean,
  abortSet: Set<Task>,
  debugOwner: null | ReactComponentInfo, // DEV-only
  debugStack: null | Error, // DEV-only
  debugTask: null | ConsoleTask, // DEV-only
): Task {
  request.pendingChunks++;
  const id = request.nextChunkId++;
  if (typeof model === 'object' && model !== null) {
    // If we're about to write this into a new task we can assign it an ID early so that
    // any other references can refer to the value we're about to write.
    if (keyPath !== null || implicitSlot) {
      // If we're in some kind of context we can't necessarily reuse this object depending
      // what parent components are used.
    } else {
      request.writtenObjects.set(model, serializeByValueID(id));
    }
  }
  const task: Task = (({
    id,
    status: PENDING,
    model,
    keyPath,
    implicitSlot,
    ping: () => pingTask(request, task),
    toJSON: function (
      this:
        | {+[key: string | number]: ReactClientValue}
        | $ReadOnlyArray<ReactClientValue>,
      parentPropertyName: string,
      value: ReactClientValue,
    ): ReactJSONValue {
      const parent = this;
      // Make sure that `parent[parentPropertyName]` wasn't JSONified before `value` was passed to us
      if (__DEV__) {
        // $FlowFixMe[incompatible-use]
        const originalValue = parent[parentPropertyName];
        if (
          typeof originalValue === 'object' &&
          originalValue !== value &&
          !(originalValue instanceof Date)
        ) {
          // Call with the server component as the currently rendering component
          // for context.
          callWithDebugContextInDEV(request, task, () => {
            if (objectName(originalValue) !== 'Object') {
              const jsxParentType = jsxChildrenParents.get(parent);
              if (typeof jsxParentType === 'string') {
                console.error(
                  '%s objects cannot be rendered as text children. Try formatting it using toString().%s',
                  objectName(originalValue),
                  describeObjectForErrorMessage(parent, parentPropertyName),
                );
              } else {
                console.error(
                  'Only plain objects can be passed to Client Components from Server Components. ' +
                    '%s objects are not supported.%s',
                  objectName(originalValue),
                  describeObjectForErrorMessage(parent, parentPropertyName),
                );
              }
            } else {
              console.error(
                'Only plain objects can be passed to Client Components from Server Components. ' +
                  'Objects with toJSON methods are not supported. Convert it manually ' +
                  'to a simple value before passing it to props.%s',
                describeObjectForErrorMessage(parent, parentPropertyName),
              );
            }
          });
        }
      }
      return renderModel(request, task, parent, parentPropertyName, value);
    },
    thenableState: null,
  }: Omit<
    Task,
    'environmentName' | 'debugOwner' | 'debugStack' | 'debugTask',
  >): any);
  if (__DEV__) {
    task.environmentName = request.environmentName();
    task.debugOwner = debugOwner;
    if (enableOwnerStacks) {
      task.debugStack = debugStack;
      task.debugTask = debugTask;
    }
  }
  abortSet.add(task);
  return task;
}

function serializeByValueID(id: number): string {
  return '$' + id.toString(16);
}

function serializeLazyID(id: number): string {
  return '$L' + id.toString(16);
}

function serializeInfinitePromise(): string {
  return '$@';
}

function serializePromiseID(id: number): string {
  return '$@' + id.toString(16);
}

function serializeServerReferenceID(id: number): string {
  return '$F' + id.toString(16);
}

function serializeSymbolReference(name: string): string {
  return '$S' + name;
}

function serializeLimitedObject(): string {
  return '$Y';
}

function serializeNumber(number: number): string | number {
  if (Number.isFinite(number)) {
    if (number === 0 && 1 / number === -Infinity) {
      return '$-0';
    } else {
      return number;
    }
  } else {
    if (number === Infinity) {
      return '$Infinity';
    } else if (number === -Infinity) {
      return '$-Infinity';
    } else {
      return '$NaN';
    }
  }
}

function serializeUndefined(): string {
  return '$undefined';
}

function serializeDateFromDateJSON(dateJSON: string): string {
  // JSON.stringify automatically calls Date.prototype.toJSON which calls toISOString.
  // We need only tack on a $D prefix.
  return '$D' + dateJSON;
}

function serializeBigInt(n: bigint): string {
  return '$n' + n.toString(10);
}

function serializeRowHeader(tag: string, id: number) {
  return id.toString(16) + ':' + tag;
}

function encodeReferenceChunk(
  request: Request,
  id: number,
  reference: string,
): Chunk {
  const json = stringify(reference);
  const row = id.toString(16) + ':' + json + '\n';
  return stringToChunk(row);
}

function serializeClientReference(
  request: Request,
  parent:
    | {+[propertyName: string | number]: ReactClientValue}
    | $ReadOnlyArray<ReactClientValue>,
  parentPropertyName: string,
  clientReference: ClientReference<any>,
): string {
  const clientReferenceKey: ClientReferenceKey =
    getClientReferenceKey(clientReference);
  const writtenClientReferences = request.writtenClientReferences;
  const existingId = writtenClientReferences.get(clientReferenceKey);
  if (existingId !== undefined) {
    if (parent[0] === REACT_ELEMENT_TYPE && parentPropertyName === '1') {
      // If we're encoding the "type" of an element, we can refer
      // to that by a lazy reference instead of directly since React
      // knows how to deal with lazy values. This lets us suspend
      // on this component rather than its parent until the code has
      // loaded.
      return serializeLazyID(existingId);
    }
    return serializeByValueID(existingId);
  }
  try {
    const clientReferenceMetadata: ClientReferenceMetadata =
      resolveClientReferenceMetadata(request.bundlerConfig, clientReference);
    request.pendingChunks++;
    const importId = request.nextChunkId++;
    emitImportChunk(request, importId, clientReferenceMetadata);
    writtenClientReferences.set(clientReferenceKey, importId);
    if (parent[0] === REACT_ELEMENT_TYPE && parentPropertyName === '1') {
      // If we're encoding the "type" of an element, we can refer
      // to that by a lazy reference instead of directly since React
      // knows how to deal with lazy values. This lets us suspend
      // on this component rather than its parent until the code has
      // loaded.
      return serializeLazyID(importId);
    }
    return serializeByValueID(importId);
  } catch (x) {
    request.pendingChunks++;
    const errorId = request.nextChunkId++;
    const digest = logRecoverableError(request, x, null);
    emitErrorChunk(request, errorId, digest, x);
    return serializeByValueID(errorId);
  }
}

function outlineModel(request: Request, value: ReactClientValue): number {
  const newTask = createTask(
    request,
    value,
    null, // The way we use outlining is for reusing an object.
    false, // It makes no sense for that use case to be contextual.
    request.abortableTasks,
    null, // TODO: Currently we don't associate any debug information with
    null, // this object on the server. If it ends up erroring, it won't
    null, // have any context on the server but can on the client.
  );
  retryTask(request, newTask);
  return newTask.id;
}

function serializeServerReference(
  request: Request,
  serverReference: ServerReference<any>,
): string {
  const writtenServerReferences = request.writtenServerReferences;
  const existingId = writtenServerReferences.get(serverReference);
  if (existingId !== undefined) {
    return serializeServerReferenceID(existingId);
  }

  const bound: null | Array<any> = getServerReferenceBoundArguments(
    request.bundlerConfig,
    serverReference,
  );
  const serverReferenceMetadata: {
    id: ServerReferenceId,
    bound: null | Promise<Array<any>>,
  } = {
    id: getServerReferenceId(request.bundlerConfig, serverReference),
    bound: bound ? Promise.resolve(bound) : null,
  };
  const metadataId = outlineModel(request, serverReferenceMetadata);
  writtenServerReferences.set(serverReference, metadataId);
  return serializeServerReferenceID(metadataId);
}

function serializeTemporaryReference(
  request: Request,
  reference: string,
): string {
  return '$T' + reference;
}

function serializeLargeTextString(request: Request, text: string): string {
  request.pendingChunks++;
  const textId = request.nextChunkId++;
  emitTextChunk(request, textId, text);
  return serializeByValueID(textId);
}

function serializeMap(
  request: Request,
  map: Map<ReactClientValue, ReactClientValue>,
): string {
  const entries = Array.from(map);
  const id = outlineModel(request, entries);
  return '$Q' + id.toString(16);
}

function serializeFormData(request: Request, formData: FormData): string {
  const entries = Array.from(formData.entries());
  const id = outlineModel(request, (entries: any));
  return '$K' + id.toString(16);
}

function serializeSet(request: Request, set: Set<ReactClientValue>): string {
  const entries = Array.from(set);
  const id = outlineModel(request, entries);
  return '$W' + id.toString(16);
}

function serializeConsoleMap(
  request: Request,
  counter: {objectCount: number},
  map: Map<ReactClientValue, ReactClientValue>,
): string {
  // Like serializeMap but for renderConsoleValue.
  const entries = Array.from(map);
  const id = outlineConsoleValue(request, counter, entries);
  return '$Q' + id.toString(16);
}

function serializeConsoleSet(
  request: Request,
  counter: {objectCount: number},
  set: Set<ReactClientValue>,
): string {
  // Like serializeMap but for renderConsoleValue.
  const entries = Array.from(set);
  const id = outlineConsoleValue(request, counter, entries);
  return '$W' + id.toString(16);
}

function serializeIterator(
  request: Request,
  iterator: Iterator<ReactClientValue>,
): string {
  const id = outlineModel(request, Array.from(iterator));
  return '$i' + id.toString(16);
}

function serializeTypedArray(
  request: Request,
  tag: string,
  typedArray: $ArrayBufferView,
): string {
  request.pendingChunks++;
  const bufferId = request.nextChunkId++;
  emitTypedArrayChunk(request, bufferId, tag, typedArray);
  return serializeByValueID(bufferId);
}

function serializeBlob(request: Request, blob: Blob): string {
  const model: Array<string | Uint8Array> = [blob.type];
  const newTask = createTask(
    request,
    model,
    null,
    false,
    request.abortableTasks,
    null, // TODO: Currently we don't associate any debug information with
    null, // this object on the server. If it ends up erroring, it won't
    null, // have any context on the server but can on the client.
  );

  const reader = blob.stream().getReader();

  let aborted = false;
  function progress(
    entry: {done: false, value: Uint8Array} | {done: true, value: void},
  ): Promise<void> | void {
    if (aborted) {
      return;
    }
    if (entry.done) {
      request.abortListeners.delete(error);
      aborted = true;
      pingTask(request, newTask);
      return;
    }
    // TODO: Emit the chunk early and refer to it later by dedupe.
    model.push(entry.value);
    // $FlowFixMe[incompatible-call]
    return reader.read().then(progress).catch(error);
  }

  function error(reason: mixed) {
    if (aborted) {
      return;
    }
    aborted = true;
    request.abortListeners.delete(error);
    const digest = logRecoverableError(request, reason, newTask);
    emitErrorChunk(request, newTask.id, digest, reason);
    request.abortableTasks.delete(newTask);
    enqueueFlush(request);
    // $FlowFixMe should be able to pass mixed
    reader.cancel(reason).then(error, error);
  }

  request.abortListeners.add(error);

  // $FlowFixMe[incompatible-call]
  reader.read().then(progress).catch(error);

  return '$B' + newTask.id.toString(16);
}

function escapeStringValue(value: string): string {
  if (value[0] === '$') {
    // We need to escape $ prefixed strings since we use those to encode
    // references to IDs and as special symbol values.
    return '$' + value;
  } else {
    return value;
  }
}

function isReactComponentInfo(value: any): boolean {
  // TODO: We don't currently have a brand check on ReactComponentInfo. Reconsider.
  return (
    ((typeof value.debugTask === 'object' &&
      value.debugTask !== null &&
      // $FlowFixMe[method-unbinding]
      typeof value.debugTask.run === 'function') ||
      value.debugStack instanceof Error) &&
    (enableOwnerStacks
      ? isArray((value: any).stack)
      : typeof (value: any).stack === 'undefined') &&
    typeof value.name === 'string' &&
    typeof value.env === 'string' &&
    value.owner !== undefined
  );
}

let modelRoot: null | ReactClientValue = false;

function renderModel(
  request: Request,
  task: Task,
  parent:
    | {+[key: string | number]: ReactClientValue}
    | $ReadOnlyArray<ReactClientValue>,
  key: string,
  value: ReactClientValue,
): ReactJSONValue {
  const prevKeyPath = task.keyPath;
  const prevImplicitSlot = task.implicitSlot;
  try {
    return renderModelDestructive(request, task, parent, key, value);
  } catch (thrownValue) {
    // If the suspended/errored value was an element or lazy it can be reduced
    // to a lazy reference, so that it doesn't error the parent.
    const model = task.model;
    const wasReactNode =
      typeof model === 'object' &&
      model !== null &&
      ((model: any).$$typeof === REACT_ELEMENT_TYPE ||
        (model: any).$$typeof === REACT_LAZY_TYPE);

    const x =
      thrownValue === SuspenseException
        ? // This is a special type of exception used for Suspense. For historical
          // reasons, the rest of the Suspense implementation expects the thrown
          // value to be a thenable, because before `use` existed that was the
          // (unstable) API for suspending. This implementation detail can change
          // later, once we deprecate the old API in favor of `use`.
          getSuspendedThenable()
        : thrownValue;

    if (typeof x === 'object' && x !== null) {
      // $FlowFixMe[method-unbinding]
      if (typeof x.then === 'function') {
        if (request.status === ABORTING) {
          task.status = ABORTED;
          const errorId: number = (request.fatalError: any);
          if (wasReactNode) {
            return serializeLazyID(errorId);
          }
          return serializeByValueID(errorId);
        }
        // Something suspended, we'll need to create a new task and resolve it later.
        const newTask = createTask(
          request,
          task.model,
          task.keyPath,
          task.implicitSlot,
          request.abortableTasks,
          __DEV__ ? task.debugOwner : null,
          __DEV__ && enableOwnerStacks ? task.debugStack : null,
          __DEV__ && enableOwnerStacks ? task.debugTask : null,
        );
        const ping = newTask.ping;
        (x: any).then(ping, ping);
        newTask.thenableState = getThenableStateAfterSuspending();

        // Restore the context. We assume that this will be restored by the inner
        // functions in case nothing throws so we don't use "finally" here.
        task.keyPath = prevKeyPath;
        task.implicitSlot = prevImplicitSlot;

        if (wasReactNode) {
          return serializeLazyID(newTask.id);
        }
        return serializeByValueID(newTask.id);
      } else if (enablePostpone && x.$$typeof === REACT_POSTPONE_TYPE) {
        // Something postponed. We'll still send everything we have up until this point.
        // We'll replace this element with a lazy reference that postpones on the client.
        const postponeInstance: Postpone = (x: any);
        request.pendingChunks++;
        const postponeId = request.nextChunkId++;
        logPostpone(request, postponeInstance.message, task);
        emitPostponeChunk(request, postponeId, postponeInstance);

        // Restore the context. We assume that this will be restored by the inner
        // functions in case nothing throws so we don't use "finally" here.
        task.keyPath = prevKeyPath;
        task.implicitSlot = prevImplicitSlot;

        if (wasReactNode) {
          return serializeLazyID(postponeId);
        }
        return serializeByValueID(postponeId);
      }
    }

    if (thrownValue === AbortSigil) {
      task.status = ABORTED;
      const errorId: number = (request.fatalError: any);
      if (wasReactNode) {
        return serializeLazyID(errorId);
      }
      return serializeByValueID(errorId);
    }

    // Restore the context. We assume that this will be restored by the inner
    // functions in case nothing throws so we don't use "finally" here.
    task.keyPath = prevKeyPath;
    task.implicitSlot = prevImplicitSlot;

    // Something errored. We'll still send everything we have up until this point.
    request.pendingChunks++;
    const errorId = request.nextChunkId++;
    const digest = logRecoverableError(request, x, task);
    emitErrorChunk(request, errorId, digest, x);
    if (wasReactNode) {
      // We'll replace this element with a lazy reference that throws on the client
      // once it gets rendered.
      return serializeLazyID(errorId);
    }
    // If we don't know if it was a React Node we render a direct reference and let
    // the client deal with it.
    return serializeByValueID(errorId);
  }
}

function renderModelDestructive(
  request: Request,
  task: Task,
  parent:
    | {+[propertyName: string | number]: ReactClientValue}
    | $ReadOnlyArray<ReactClientValue>,
  parentPropertyName: string,
  value: ReactClientValue,
): ReactJSONValue {
  // Set the currently rendering model
  task.model = value;

  // Special Symbol, that's very common.
  if (value === REACT_ELEMENT_TYPE) {
    return '$';
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'object') {
    switch ((value: any).$$typeof) {
      case REACT_ELEMENT_TYPE: {
        let elementReference = null;
        const writtenObjects = request.writtenObjects;
        if (task.keyPath !== null || task.implicitSlot) {
          // If we're in some kind of context we can't reuse the result of this render or
          // previous renders of this element. We only reuse elements if they're not wrapped
          // by another Server Component.
        } else {
          const existingReference = writtenObjects.get(value);
          if (existingReference !== undefined) {
            if (modelRoot === value) {
              // This is the ID we're currently emitting so we need to write it
              // once but if we discover it again, we refer to it by id.
              modelRoot = null;
            } else {
              // We've already emitted this as an outlined object, so we can refer to that by its
              // existing ID. TODO: We should use a lazy reference since, unlike plain objects,
              // elements might suspend so it might not have emitted yet even if we have the ID for
              // it. However, this creates an extra wrapper when it's not needed. We should really
              // detect whether this already was emitted and synchronously available. In that
              // case we can refer to it synchronously and only make it lazy otherwise.
              // We currently don't have a data structure that lets us see that though.
              return existingReference;
            }
          } else if (parentPropertyName.indexOf(':') === -1) {
            // TODO: If the property name contains a colon, we don't dedupe. Escape instead.
            const parentReference = writtenObjects.get(parent);
            if (parentReference !== undefined) {
              // If the parent has a reference, we can refer to this object indirectly
              // through the property name inside that parent.
              elementReference = parentReference + ':' + parentPropertyName;
              writtenObjects.set(value, elementReference);
            }
          }
        }

        const element: ReactElement = (value: any);

        if (__DEV__) {
          const debugInfo: ?ReactDebugInfo = (value: any)._debugInfo;
          if (debugInfo) {
            // If this came from Flight, forward any debug info into this new row.
            if (debugID === null) {
              // We don't have a chunk to assign debug info. We need to outline this
              // component to assign it an ID.
              return outlineTask(request, task);
            } else {
              // Forward any debug info we have the first time we see it.
              forwardDebugInfo(request, debugID, debugInfo);
            }
          }
        }

        const props = element.props;
        let ref;
        if (enableRefAsProp) {
          // TODO: This is a temporary, intermediate step. Once the feature
          // flag is removed, we should get the ref off the props object right
          // before using it.
          const refProp = props.ref;
          ref = refProp !== undefined ? refProp : null;
        } else {
          ref = element.ref;
        }

        // Attempt to render the Server Component.

        if (__DEV__) {
          task.debugOwner = element._owner;
          if (enableOwnerStacks) {
            task.debugStack = element._debugStack;
            task.debugTask = element._debugTask;
          }
          // TODO: Pop this. Since we currently don't have a point where we can pop the stack
          // this debug information will be used for errors inside sibling properties that
          // are not elements. Leading to the wrong attribution on the server. We could fix
          // that if we switch to a proper stack instead of JSON.stringify's trampoline.
          // Attribution on the client is still correct since it has a pop.
        }

        const newChild = renderElement(
          request,
          task,
          element.type,
          // $FlowFixMe[incompatible-call] the key of an element is null | string
          element.key,
          ref,
          props,
          __DEV__ && enableOwnerStacks ? element._store.validated : 0,
        );
        if (
          typeof newChild === 'object' &&
          newChild !== null &&
          elementReference !== null
        ) {
          // If this element renders another object, we can now refer to that object through
          // the same location as this element.
          if (!writtenObjects.has(newChild)) {
            writtenObjects.set(newChild, elementReference);
          }
        }
        return newChild;
      }
      case REACT_LAZY_TYPE: {
        // Reset the task's thenable state before continuing. If there was one, it was
        // from suspending the lazy before.
        task.thenableState = null;

        const lazy: LazyComponent<any, any> = (value: any);
        let resolvedModel;
        if (__DEV__) {
          resolvedModel = callLazyInitInDEV(lazy);
        } else {
          const payload = lazy._payload;
          const init = lazy._init;
          resolvedModel = init(payload);
        }
        if (request.status === ABORTING) {
          // lazy initializers are user code and could abort during render
          // we don't wan to return any value resolved from the lazy initializer
          // if it aborts so we interrupt rendering here
          throw AbortSigil;
        }
        if (__DEV__) {
          const debugInfo: ?ReactDebugInfo = lazy._debugInfo;
          if (debugInfo) {
            // If this came from Flight, forward any debug info into this new row.
            if (debugID === null) {
              // We don't have a chunk to assign debug info. We need to outline this
              // component to assign it an ID.
              return outlineTask(request, task);
            } else {
              // Forward any debug info we have the first time we see it.
              // We do this after init so that we have received all the debug info
              // from the server by the time we emit it.
              forwardDebugInfo(request, debugID, debugInfo);
            }
          }
        }
        return renderModelDestructive(
          request,
          task,
          emptyRoot,
          '',
          resolvedModel,
        );
      }
      case REACT_LEGACY_ELEMENT_TYPE: {
        throw new Error(
          'A React Element from an older version of React was rendered. ' +
            'This is not supported. It can happen if:\n' +
            '- Multiple copies of the "react" package is used.\n' +
            '- A library pre-bundled an old copy of "react" or "react/jsx-runtime".\n' +
            '- A compiler tries to "inline" JSX instead of using the runtime.',
        );
      }
    }

    if (isClientReference(value)) {
      return serializeClientReference(
        request,
        parent,
        parentPropertyName,
        (value: any),
      );
    }

    if (request.temporaryReferences !== undefined) {
      const tempRef = resolveTemporaryReference(
        request.temporaryReferences,
        value,
      );
      if (tempRef !== undefined) {
        return serializeTemporaryReference(request, tempRef);
      }
    }

    if (enableTaint) {
      const tainted = TaintRegistryObjects.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted);
      }
    }

    const writtenObjects = request.writtenObjects;
    const existingReference = writtenObjects.get(value);
    // $FlowFixMe[method-unbinding]
    if (typeof value.then === 'function') {
      if (existingReference !== undefined) {
        if (task.keyPath !== null || task.implicitSlot) {
          // If we're in some kind of context we can't reuse the result of this render or
          // previous renders of this element. We only reuse Promises if they're not wrapped
          // by another Server Component.
          const promiseId = serializeThenable(request, task, (value: any));
          return serializePromiseID(promiseId);
        } else if (modelRoot === value) {
          // This is the ID we're currently emitting so we need to write it
          // once but if we discover it again, we refer to it by id.
          modelRoot = null;
        } else {
          // We've seen this promise before, so we can just refer to the same result.
          return existingReference;
        }
      }
      // We assume that any object with a .then property is a "Thenable" type,
      // or a Promise type. Either of which can be represented by a Promise.
      const promiseId = serializeThenable(request, task, (value: any));
      const promiseReference = serializePromiseID(promiseId);
      writtenObjects.set(value, promiseReference);
      return promiseReference;
    }

    if (existingReference !== undefined) {
      if (modelRoot === value) {
        // This is the ID we're currently emitting so we need to write it
        // once but if we discover it again, we refer to it by id.
        modelRoot = null;
      } else {
        // We've already emitted this as an outlined object, so we can
        // just refer to that by its existing ID.
        return existingReference;
      }
    } else if (parentPropertyName.indexOf(':') === -1) {
      // TODO: If the property name contains a colon, we don't dedupe. Escape instead.
      const parentReference = writtenObjects.get(parent);
      if (parentReference !== undefined) {
        // If the parent has a reference, we can refer to this object indirectly
        // through the property name inside that parent.
        let propertyName = parentPropertyName;
        if (isArray(parent) && parent[0] === REACT_ELEMENT_TYPE) {
          // For elements, we've converted it to an array but we'll have converted
          // it back to an element before we read the references so the property
          // needs to be aliased.
          switch (parentPropertyName) {
            case '1':
              propertyName = 'type';
              break;
            case '2':
              propertyName = 'key';
              break;
            case '3':
              propertyName = 'props';
              break;
          }
        }
        writtenObjects.set(value, parentReference + ':' + propertyName);
      }
    }

    if (isArray(value)) {
      return renderFragment(request, task, value);
    }

    if (value instanceof Map) {
      return serializeMap(request, value);
    }
    if (value instanceof Set) {
      return serializeSet(request, value);
    }
    // TODO: FormData is not available in old Node. Remove the typeof later.
    if (typeof FormData === 'function' && value instanceof FormData) {
      return serializeFormData(request, value);
    }

    if (enableBinaryFlight) {
      if (value instanceof ArrayBuffer) {
        return serializeTypedArray(request, 'A', new Uint8Array(value));
      }
      if (value instanceof Int8Array) {
        // char
        return serializeTypedArray(request, 'O', value);
      }
      if (value instanceof Uint8Array) {
        // unsigned char
        return serializeTypedArray(request, 'o', value);
      }
      if (value instanceof Uint8ClampedArray) {
        // unsigned clamped char
        return serializeTypedArray(request, 'U', value);
      }
      if (value instanceof Int16Array) {
        // sort
        return serializeTypedArray(request, 'S', value);
      }
      if (value instanceof Uint16Array) {
        // unsigned short
        return serializeTypedArray(request, 's', value);
      }
      if (value instanceof Int32Array) {
        // long
        return serializeTypedArray(request, 'L', value);
      }
      if (value instanceof Uint32Array) {
        // unsigned long
        return serializeTypedArray(request, 'l', value);
      }
      if (value instanceof Float32Array) {
        // float
        return serializeTypedArray(request, 'G', value);
      }
      if (value instanceof Float64Array) {
        // double
        return serializeTypedArray(request, 'g', value);
      }
      if (value instanceof BigInt64Array) {
        // number
        return serializeTypedArray(request, 'M', value);
      }
      if (value instanceof BigUint64Array) {
        // unsigned number
        // We use "m" instead of "n" since JSON can start with "null"
        return serializeTypedArray(request, 'm', value);
      }
      if (value instanceof DataView) {
        return serializeTypedArray(request, 'V', value);
      }
      // TODO: Blob is not available in old Node. Remove the typeof check later.
      if (typeof Blob === 'function' && value instanceof Blob) {
        return serializeBlob(request, value);
      }
    }

    const iteratorFn = getIteratorFn(value);
    if (iteratorFn) {
      // TODO: Should we serialize the return value as well like we do for AsyncIterables?
      const iterator = iteratorFn.call(value);
      if (iterator === value) {
        // Iterator, not Iterable
        return serializeIterator(request, (iterator: any));
      }
      return renderFragment(request, task, Array.from((iterator: any)));
    }

    if (enableFlightReadableStream) {
      // TODO: Blob is not available in old Node. Remove the typeof check later.
      if (
        typeof ReadableStream === 'function' &&
        value instanceof ReadableStream
      ) {
        return serializeReadableStream(request, task, value);
      }
      const getAsyncIterator: void | (() => $AsyncIterator<any, any, any>) =
        (value: any)[ASYNC_ITERATOR];
      if (typeof getAsyncIterator === 'function') {
        // We treat AsyncIterables as a Fragment and as such we might need to key them.
        return renderAsyncFragment(
          request,
          task,
          (value: any),
          getAsyncIterator,
        );
      }
    }

    // Verify that this is a simple plain object.
    const proto = getPrototypeOf(value);
    if (
      proto !== ObjectPrototype &&
      (proto === null || getPrototypeOf(proto) !== null)
    ) {
      throw new Error(
        'Only plain objects, and a few built-ins, can be passed to Client Components ' +
          'from Server Components. Classes or null prototypes are not supported.' +
          describeObjectForErrorMessage(parent, parentPropertyName),
      );
    }
    if (__DEV__) {
      if (isReactComponentInfo(value)) {
        // This looks like a ReactComponentInfo. We can't serialize the ConsoleTask object so we
        // need to omit it before serializing.
        const componentDebugInfo: Omit<
          ReactComponentInfo,
          'debugTask' | 'debugStack',
        > = {
          name: (value: any).name,
          env: (value: any).env,
          owner: (value: any).owner,
        };
        if (enableOwnerStacks) {
          // $FlowFixMe[cannot-write]
          componentDebugInfo.stack = (value: any).stack;
        }
        return componentDebugInfo;
      }

      if (objectName(value) !== 'Object') {
        callWithDebugContextInDEV(request, task, () => {
          console.error(
            'Only plain objects can be passed to Client Components from Server Components. ' +
              '%s objects are not supported.%s',
            objectName(value),
            describeObjectForErrorMessage(parent, parentPropertyName),
          );
        });
      } else if (!isSimpleObject(value)) {
        callWithDebugContextInDEV(request, task, () => {
          console.error(
            'Only plain objects can be passed to Client Components from Server Components. ' +
              'Classes or other objects with methods are not supported.%s',
            describeObjectForErrorMessage(parent, parentPropertyName),
          );
        });
      } else if (Object.getOwnPropertySymbols) {
        const symbols = Object.getOwnPropertySymbols(value);
        if (symbols.length > 0) {
          callWithDebugContextInDEV(request, task, () => {
            console.error(
              'Only plain objects can be passed to Client Components from Server Components. ' +
                'Objects with symbol properties like %s are not supported.%s',
              symbols[0].description,
              describeObjectForErrorMessage(parent, parentPropertyName),
            );
          });
        }
      }
    }

    // $FlowFixMe[incompatible-return]
    return value;
  }

  if (typeof value === 'string') {
    if (enableTaint) {
      const tainted = TaintRegistryValues.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted.message);
      }
    }
    // TODO: Maybe too clever. If we support URL there's no similar trick.
    if (value[value.length - 1] === 'Z') {
      // Possibly a Date, whose toJSON automatically calls toISOString
      // $FlowFixMe[incompatible-use]
      const originalValue = parent[parentPropertyName];
      if (originalValue instanceof Date) {
        return serializeDateFromDateJSON(value);
      }
    }
    if (value.length >= 1024 && byteLengthOfChunk !== null) {
      // For large strings, we encode them outside the JSON payload so that we
      // don't have to double encode and double parse the strings. This can also
      // be more compact in case the string has a lot of escaped characters.
      return serializeLargeTextString(request, value);
    }
    return escapeStringValue(value);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return serializeNumber(value);
  }

  if (typeof value === 'undefined') {
    return serializeUndefined();
  }

  if (typeof value === 'function') {
    if (isClientReference(value)) {
      return serializeClientReference(
        request,
        parent,
        parentPropertyName,
        (value: any),
      );
    }
    if (isServerReference(value)) {
      return serializeServerReference(request, (value: any));
    }
    if (request.temporaryReferences !== undefined) {
      const tempRef = resolveTemporaryReference(
        request.temporaryReferences,
        value,
      );
      if (tempRef !== undefined) {
        return serializeTemporaryReference(request, tempRef);
      }
    }

    if (enableTaint) {
      const tainted = TaintRegistryObjects.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted);
      }
    }

    if (isOpaqueTemporaryReference(value)) {
      throw new Error(
        'Could not reference an opaque temporary reference. ' +
          'This is likely due to misconfiguring the temporaryReferences options ' +
          'on the server.',
      );
    } else if (/^on[A-Z]/.test(parentPropertyName)) {
      throw new Error(
        'Event handlers cannot be passed to Client Component props.' +
          describeObjectForErrorMessage(parent, parentPropertyName) +
          '\nIf you need interactivity, consider converting part of this to a Client Component.',
      );
    } else if (
      __DEV__ &&
      (jsxChildrenParents.has(parent) ||
        (jsxPropsParents.has(parent) && parentPropertyName === 'children'))
    ) {
      const componentName = value.displayName || value.name || 'Component';
      throw new Error(
        'Functions are not valid as a child of Client Components. This may happen if ' +
          'you return ' +
          componentName +
          ' instead of <' +
          componentName +
          ' /> from render. ' +
          'Or maybe you meant to call this function rather than return it.' +
          describeObjectForErrorMessage(parent, parentPropertyName),
      );
    } else {
      throw new Error(
        'Functions cannot be passed directly to Client Components ' +
          'unless you explicitly expose it by marking it with "use server". ' +
          'Or maybe you meant to call this function rather than return it.' +
          describeObjectForErrorMessage(parent, parentPropertyName),
      );
    }
  }

  if (typeof value === 'symbol') {
    const writtenSymbols = request.writtenSymbols;
    const existingId = writtenSymbols.get(value);
    if (existingId !== undefined) {
      return serializeByValueID(existingId);
    }
    // $FlowFixMe[incompatible-type] `description` might be undefined
    const name: string = value.description;

    if (Symbol.for(name) !== value) {
      throw new Error(
        'Only global symbols received from Symbol.for(...) can be passed to Client Components. ' +
          `The symbol Symbol.for(${
            // $FlowFixMe[incompatible-type] `description` might be undefined
            value.description
          }) cannot be found among global symbols.` +
          describeObjectForErrorMessage(parent, parentPropertyName),
      );
    }

    request.pendingChunks++;
    const symbolId = request.nextChunkId++;
    emitSymbolChunk(request, symbolId, name);
    writtenSymbols.set(value, symbolId);
    return serializeByValueID(symbolId);
  }

  if (typeof value === 'bigint') {
    if (enableTaint) {
      const tainted = TaintRegistryValues.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted.message);
      }
    }
    return serializeBigInt(value);
  }

  throw new Error(
    `Type ${typeof value} is not supported in Client Component props.` +
      describeObjectForErrorMessage(parent, parentPropertyName),
  );
}

function logPostpone(
  request: Request,
  reason: string,
  task: Task | null, // DEV-only
): void {
  const prevRequest = currentRequest;
  // We clear the request context so that console.logs inside the callback doesn't
  // get forwarded to the client.
  currentRequest = null;
  try {
    const onPostpone = request.onPostpone;
    if (__DEV__ && task !== null) {
      if (supportsRequestStorage) {
        requestStorage.run(
          undefined,
          callWithDebugContextInDEV,
          request,
          task,
          onPostpone,
          reason,
        );
      } else {
        callWithDebugContextInDEV(request, task, onPostpone, reason);
      }
    } else if (supportsRequestStorage) {
      // Exit the request context while running callbacks.
      requestStorage.run(undefined, onPostpone, reason);
    } else {
      onPostpone(reason);
    }
  } finally {
    currentRequest = prevRequest;
  }
}

function logRecoverableError(
  request: Request,
  error: mixed,
  task: Task | null, // DEV-only
): string {
  const prevRequest = currentRequest;
  // We clear the request context so that console.logs inside the callback doesn't
  // get forwarded to the client.
  currentRequest = null;
  let errorDigest;
  try {
    const onError = request.onError;
    if (__DEV__ && task !== null) {
      if (supportsRequestStorage) {
        errorDigest = requestStorage.run(
          undefined,
          callWithDebugContextInDEV,
          request,
          task,
          onError,
          error,
        );
      } else {
        errorDigest = callWithDebugContextInDEV(request, task, onError, error);
      }
    } else if (supportsRequestStorage) {
      // Exit the request context while running callbacks.
      errorDigest = requestStorage.run(undefined, onError, error);
    } else {
      errorDigest = onError(error);
    }
  } finally {
    currentRequest = prevRequest;
  }
  if (errorDigest != null && typeof errorDigest !== 'string') {
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      `onError returned something with a type other than "string". onError should return a string and may return null or undefined but must not return anything else. It received something of type "${typeof errorDigest}" instead`,
    );
  }
  return errorDigest || '';
}

function fatalError(request: Request, error: mixed): void {
  if (enableTaint) {
    cleanupTaintQueue(request);
  }
  // This is called outside error handling code such as if an error happens in React internals.
  if (request.destination !== null) {
    request.status = CLOSED;
    closeWithError(request.destination, error);
  } else {
    request.status = CLOSING;
    request.fatalError = error;
  }
}

function emitPostponeChunk(
  request: Request,
  id: number,
  postponeInstance: Postpone,
): void {
  let row;
  if (__DEV__) {
    let reason = '';
    let stack: ReactStackTrace;
    const env = request.environmentName();
    try {
      // eslint-disable-next-line react-internal/safe-string-coercion
      reason = String(postponeInstance.message);
      stack = filterStackTrace(request, postponeInstance, 0);
    } catch (x) {
      stack = [];
    }
    row = serializeRowHeader('P', id) + stringify({reason, stack, env}) + '\n';
  } else {
    // No reason included in prod.
    row = serializeRowHeader('P', id) + '\n';
  }
  const processedChunk = stringToChunk(row);
  request.completedErrorChunks.push(processedChunk);
}

function emitErrorChunk(
  request: Request,
  id: number,
  digest: string,
  error: mixed,
): void {
  let errorInfo: any;
  if (__DEV__) {
    let message;
    let stack: ReactStackTrace;
    let env = (0, request.environmentName)();
    try {
      if (error instanceof Error) {
        // eslint-disable-next-line react-internal/safe-string-coercion
        message = String(error.message);
        stack = filterStackTrace(request, error, 0);
        const errorEnv = (error: any).environmentName;
        if (typeof errorEnv === 'string') {
          // This probably came from another FlightClient as a pass through.
          // Keep the environment name.
          env = errorEnv;
        }
      } else if (typeof error === 'object' && error !== null) {
        message = describeObjectForErrorMessage(error);
        stack = [];
      } else {
        // eslint-disable-next-line react-internal/safe-string-coercion
        message = String(error);
        stack = [];
      }
    } catch (x) {
      message = 'An error occurred but serializing the error message failed.';
      stack = [];
    }
    errorInfo = {digest, message, stack, env};
  } else {
    errorInfo = {digest};
  }
  const row = serializeRowHeader('E', id) + stringify(errorInfo) + '\n';
  const processedChunk = stringToChunk(row);
  request.completedErrorChunks.push(processedChunk);
}

function emitImportChunk(
  request: Request,
  id: number,
  clientReferenceMetadata: ClientReferenceMetadata,
): void {
  // $FlowFixMe[incompatible-type] stringify can return null
  const json: string = stringify(clientReferenceMetadata);
  const row = serializeRowHeader('I', id) + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedImportChunks.push(processedChunk);
}

function emitHintChunk<Code: HintCode>(
  request: Request,
  code: Code,
  model: HintModel<Code>,
): void {
  const json: string = stringify(model);
  const id = request.nextChunkId++;
  const row = serializeRowHeader('H' + code, id) + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedHintChunks.push(processedChunk);
}

function emitSymbolChunk(request: Request, id: number, name: string): void {
  const symbolReference = serializeSymbolReference(name);
  const processedChunk = encodeReferenceChunk(request, id, symbolReference);
  request.completedImportChunks.push(processedChunk);
}

function emitModelChunk(request: Request, id: number, json: string): void {
  const row = id.toString(16) + ':' + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedRegularChunks.push(processedChunk);
}

function emitDebugChunk(
  request: Request,
  id: number,
  debugInfo: ReactComponentInfo | ReactAsyncInfo,
): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'emitDebugChunk should never be called in production mode. This is a bug in React.',
    );
  }

  // We use the console encoding so that we can dedupe objects but don't necessarily
  // use the full serialization that requires a task.
  const counter = {objectCount: 0};
  function replacer(
    this:
      | {+[key: string | number]: ReactClientValue}
      | $ReadOnlyArray<ReactClientValue>,
    parentPropertyName: string,
    value: ReactClientValue,
  ): ReactJSONValue {
    return renderConsoleValue(
      request,
      counter,
      this,
      parentPropertyName,
      value,
    );
  }

  // $FlowFixMe[incompatible-type] stringify can return null
  const json: string = stringify(debugInfo, replacer);
  const row = serializeRowHeader('D', id) + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedRegularChunks.push(processedChunk);
}

function emitTypedArrayChunk(
  request: Request,
  id: number,
  tag: string,
  typedArray: $ArrayBufferView,
): void {
  if (enableTaint) {
    if (TaintRegistryByteLengths.has(typedArray.byteLength)) {
      // If we have had any tainted values of this length, we check
      // to see if these bytes matches any entries in the registry.
      const tainted = TaintRegistryValues.get(
        binaryToComparableString(typedArray),
      );
      if (tainted !== undefined) {
        throwTaintViolation(tainted.message);
      }
    }
  }
  request.pendingChunks++; // Extra chunk for the header.
  // TODO: Convert to little endian if that's not the server default.
  const binaryChunk = typedArrayToBinaryChunk(typedArray);
  const binaryLength = byteLengthOfBinaryChunk(binaryChunk);
  const row = id.toString(16) + ':' + tag + binaryLength.toString(16) + ',';
  const headerChunk = stringToChunk(row);
  request.completedRegularChunks.push(headerChunk, binaryChunk);
}

function emitTextChunk(request: Request, id: number, text: string): void {
  if (byteLengthOfChunk === null) {
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'Existence of byteLengthOfChunk should have already been checked. This is a bug in React.',
    );
  }
  request.pendingChunks++; // Extra chunk for the header.
  const textChunk = stringToChunk(text);
  const binaryLength = byteLengthOfChunk(textChunk);
  const row = id.toString(16) + ':T' + binaryLength.toString(16) + ',';
  const headerChunk = stringToChunk(row);
  request.completedRegularChunks.push(headerChunk, textChunk);
}

function serializeEval(source: string): string {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'serializeEval should never be called in production mode. This is a bug in React.',
    );
  }
  return '$E' + source;
}

// This is a forked version of renderModel which should never error, never suspend and is limited
// in the depth it can encode.
function renderConsoleValue(
  request: Request,
  counter: {objectCount: number},
  parent:
    | {+[propertyName: string | number]: ReactClientValue}
    | $ReadOnlyArray<ReactClientValue>,
  parentPropertyName: string,
  value: ReactClientValue,
): ReactJSONValue {
  // Make sure that `parent[parentPropertyName]` wasn't JSONified before `value` was passed to us
  // $FlowFixMe[incompatible-use]
  const originalValue = parent[parentPropertyName];
  if (
    typeof originalValue === 'object' &&
    originalValue !== value &&
    !(originalValue instanceof Date)
  ) {
  }

  if (value === null) {
    return null;
  }

  if (typeof value === 'object') {
    if (isClientReference(value)) {
      // We actually have this value on the client so we could import it.
      // This might be confusing though because on the Server it won't actually
      // be this value, so if you're debugging client references maybe you'd be
      // better with a place holder.
      return serializeClientReference(
        request,
        parent,
        parentPropertyName,
        (value: any),
      );
    }
    if (request.temporaryReferences !== undefined) {
      const tempRef = resolveTemporaryReference(
        request.temporaryReferences,
        value,
      );
      if (tempRef !== undefined) {
        return serializeTemporaryReference(request, tempRef);
      }
    }

    if (counter.objectCount > 500) {
      // We've reached our max number of objects to serialize across the wire so we serialize this
      // as a marker so that the client can error when this is accessed by the console.
      return serializeLimitedObject();
    }

    counter.objectCount++;

    const writtenObjects = request.writtenObjects;
    const existingReference = writtenObjects.get(value);
    // $FlowFixMe[method-unbinding]
    if (typeof value.then === 'function') {
      if (existingReference !== undefined) {
        // We've seen this promise before, so we can just refer to the same result.
        return existingReference;
      }

      const thenable: Thenable<any> = (value: any);
      switch (thenable.status) {
        case 'fulfilled': {
          return serializePromiseID(
            outlineConsoleValue(request, counter, thenable.value),
          );
        }
        case 'rejected': {
          const x = thenable.reason;
          request.pendingChunks++;
          const errorId = request.nextChunkId++;
          if (
            enablePostpone &&
            typeof x === 'object' &&
            x !== null &&
            (x: any).$$typeof === REACT_POSTPONE_TYPE
          ) {
            const postponeInstance: Postpone = (x: any);
            // We don't log this postpone.
            emitPostponeChunk(request, errorId, postponeInstance);
          } else {
            // We don't log these errors since they didn't actually throw into Flight.
            const digest = '';
            emitErrorChunk(request, errorId, digest, x);
          }
          return serializePromiseID(errorId);
        }
      }
      // If it hasn't already resolved (and been instrumented) we just encode an infinite
      // promise that will never resolve.
      return serializeInfinitePromise();
    }

    if (existingReference !== undefined) {
      // We've already emitted this as a real object, so we can
      // just refer to that by its existing reference.
      return existingReference;
    }

    if (isArray(value)) {
      return value;
    }

    if (value instanceof Map) {
      return serializeConsoleMap(request, counter, value);
    }
    if (value instanceof Set) {
      return serializeConsoleSet(request, counter, value);
    }
    // TODO: FormData is not available in old Node. Remove the typeof later.
    if (typeof FormData === 'function' && value instanceof FormData) {
      return serializeFormData(request, value);
    }

    if (enableBinaryFlight) {
      if (value instanceof ArrayBuffer) {
        return serializeTypedArray(request, 'A', new Uint8Array(value));
      }
      if (value instanceof Int8Array) {
        // char
        return serializeTypedArray(request, 'O', value);
      }
      if (value instanceof Uint8Array) {
        // unsigned char
        return serializeTypedArray(request, 'o', value);
      }
      if (value instanceof Uint8ClampedArray) {
        // unsigned clamped char
        return serializeTypedArray(request, 'U', value);
      }
      if (value instanceof Int16Array) {
        // sort
        return serializeTypedArray(request, 'S', value);
      }
      if (value instanceof Uint16Array) {
        // unsigned short
        return serializeTypedArray(request, 's', value);
      }
      if (value instanceof Int32Array) {
        // long
        return serializeTypedArray(request, 'L', value);
      }
      if (value instanceof Uint32Array) {
        // unsigned long
        return serializeTypedArray(request, 'l', value);
      }
      if (value instanceof Float32Array) {
        // float
        return serializeTypedArray(request, 'G', value);
      }
      if (value instanceof Float64Array) {
        // double
        return serializeTypedArray(request, 'g', value);
      }
      if (value instanceof BigInt64Array) {
        // number
        return serializeTypedArray(request, 'M', value);
      }
      if (value instanceof BigUint64Array) {
        // unsigned number
        // We use "m" instead of "n" since JSON can start with "null"
        return serializeTypedArray(request, 'm', value);
      }
      if (value instanceof DataView) {
        return serializeTypedArray(request, 'V', value);
      }
      // TODO: Blob is not available in old Node. Remove the typeof check later.
      if (typeof Blob === 'function' && value instanceof Blob) {
        return serializeBlob(request, value);
      }
    }

    const iteratorFn = getIteratorFn(value);
    if (iteratorFn) {
      return Array.from((value: any));
    }

    if (isReactComponentInfo(value)) {
      // This looks like a ReactComponentInfo. We can't serialize the ConsoleTask object so we
      // need to omit it before serializing.
      const componentDebugInfo: Omit<
        ReactComponentInfo,
        'debugTask' | 'debugStack',
      > = {
        name: (value: any).name,
        env: (value: any).env,
        owner: (value: any).owner,
      };
      if (enableOwnerStacks) {
        // $FlowFixMe[cannot-write]
        componentDebugInfo.stack = (value: any).stack;
      }
      return componentDebugInfo;
    }

    // $FlowFixMe[incompatible-return]
    return value;
  }

  if (typeof value === 'string') {
    if (value[value.length - 1] === 'Z') {
      // Possibly a Date, whose toJSON automatically calls toISOString
      if (originalValue instanceof Date) {
        return serializeDateFromDateJSON(value);
      }
    }
    if (value.length >= 1024) {
      // For large strings, we encode them outside the JSON payload so that we
      // don't have to double encode and double parse the strings. This can also
      // be more compact in case the string has a lot of escaped characters.
      return serializeLargeTextString(request, value);
    }
    return escapeStringValue(value);
  }

  if (typeof value === 'boolean') {
    return value;
  }

  if (typeof value === 'number') {
    return serializeNumber(value);
  }

  if (typeof value === 'undefined') {
    return serializeUndefined();
  }

  if (typeof value === 'function') {
    if (isClientReference(value)) {
      return serializeClientReference(
        request,
        parent,
        parentPropertyName,
        (value: any),
      );
    }
    if (request.temporaryReferences !== undefined) {
      const tempRef = resolveTemporaryReference(
        request.temporaryReferences,
        value,
      );
      if (tempRef !== undefined) {
        return serializeTemporaryReference(request, tempRef);
      }
    }

    // Serialize the body of the function as an eval so it can be printed.
    // $FlowFixMe[method-unbinding]
    return serializeEval('(' + Function.prototype.toString.call(value) + ')');
  }

  if (typeof value === 'symbol') {
    const writtenSymbols = request.writtenSymbols;
    const existingId = writtenSymbols.get(value);
    if (existingId !== undefined) {
      return serializeByValueID(existingId);
    }
    // $FlowFixMe[incompatible-type] `description` might be undefined
    const name: string = value.description;
    // We use the Symbol.for version if it's not a global symbol. Close enough.
    request.pendingChunks++;
    const symbolId = request.nextChunkId++;
    emitSymbolChunk(request, symbolId, name);
    return serializeByValueID(symbolId);
  }

  if (typeof value === 'bigint') {
    return serializeBigInt(value);
  }

  return 'unknown type ' + typeof value;
}

function outlineConsoleValue(
  request: Request,
  counter: {objectCount: number},
  model: ReactClientValue,
): number {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'outlineConsoleValue should never be called in production mode. This is a bug in React.',
    );
  }

  function replacer(
    this:
      | {+[key: string | number]: ReactClientValue}
      | $ReadOnlyArray<ReactClientValue>,
    parentPropertyName: string,
    value: ReactClientValue,
  ): ReactJSONValue {
    try {
      return renderConsoleValue(
        request,
        counter,
        this,
        parentPropertyName,
        value,
      );
    } catch (x) {
      return 'unknown value';
    }
  }

  // $FlowFixMe[incompatible-type] stringify can return null
  const json: string = stringify(model, replacer);

  request.pendingChunks++;
  const id = request.nextChunkId++;
  const row = id.toString(16) + ':' + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedRegularChunks.push(processedChunk);
  return id;
}

function emitConsoleChunk(
  request: Request,
  id: number,
  methodName: string,
  owner: null | ReactComponentInfo,
  stackTrace: ReactStackTrace,
  args: Array<any>,
): void {
  if (!__DEV__) {
    // These errors should never make it into a build so we don't need to encode them in codes.json
    // eslint-disable-next-line react-internal/prod-error-codes
    throw new Error(
      'emitConsoleChunk should never be called in production mode. This is a bug in React.',
    );
  }

  const counter = {objectCount: 0};
  function replacer(
    this:
      | {+[key: string | number]: ReactClientValue}
      | $ReadOnlyArray<ReactClientValue>,
    parentPropertyName: string,
    value: ReactClientValue,
  ): ReactJSONValue {
    try {
      return renderConsoleValue(
        request,
        counter,
        this,
        parentPropertyName,
        value,
      );
    } catch (x) {
      return 'unknown value';
    }
  }

  // TODO: Don't double badge if this log came from another Flight Client.
  const env = (0, request.environmentName)();
  const payload = [methodName, stackTrace, owner, env];
  // $FlowFixMe[method-unbinding]
  payload.push.apply(payload, args);
  // $FlowFixMe[incompatible-type] stringify can return null
  const json: string = stringify(payload, replacer);
  const row = serializeRowHeader('W', id) + json + '\n';
  const processedChunk = stringToChunk(row);
  request.completedRegularChunks.push(processedChunk);
}

function forwardDebugInfo(
  request: Request,
  id: number,
  debugInfo: ReactDebugInfo,
) {
  for (let i = 0; i < debugInfo.length; i++) {
    request.pendingChunks++;
    if (typeof debugInfo[i].name === 'string') {
      // We outline this model eagerly so that we can refer to by reference as an owner.
      // If we had a smarter way to dedupe we might not have to do this if there ends up
      // being no references to this as an owner.
      outlineModel(request, debugInfo[i]);
    }
    emitDebugChunk(request, id, debugInfo[i]);
  }
}

function emitChunk(
  request: Request,
  task: Task,
  value: ReactClientValue,
): void {
  const id = task.id;
  // For certain types we have special types, we typically outlined them but
  // we can emit them directly for this row instead of through an indirection.
  if (typeof value === 'string' && byteLengthOfChunk !== null) {
    if (enableTaint) {
      const tainted = TaintRegistryValues.get(value);
      if (tainted !== undefined) {
        throwTaintViolation(tainted.message);
      }
    }
    emitTextChunk(request, id, value);
    return;
  }
  if (enableBinaryFlight) {
    if (value instanceof ArrayBuffer) {
      emitTypedArrayChunk(request, id, 'A', new Uint8Array(value));
      return;
    }
    if (value instanceof Int8Array) {
      // char
      emitTypedArrayChunk(request, id, 'O', value);
      return;
    }
    if (value instanceof Uint8Array) {
      // unsigned char
      emitTypedArrayChunk(request, id, 'o', value);
      return;
    }
    if (value instanceof Uint8ClampedArray) {
      // unsigned clamped char
      emitTypedArrayChunk(request, id, 'U', value);
      return;
    }
    if (value instanceof Int16Array) {
      // sort
      emitTypedArrayChunk(request, id, 'S', value);
      return;
    }
    if (value instanceof Uint16Array) {
      // unsigned short
      emitTypedArrayChunk(request, id, 's', value);
      return;
    }
    if (value instanceof Int32Array) {
      // long
      emitTypedArrayChunk(request, id, 'L', value);
      return;
    }
    if (value instanceof Uint32Array) {
      // unsigned long
      emitTypedArrayChunk(request, id, 'l', value);
      return;
    }
    if (value instanceof Float32Array) {
      // float
      emitTypedArrayChunk(request, id, 'G', value);
      return;
    }
    if (value instanceof Float64Array) {
      // double
      emitTypedArrayChunk(request, id, 'g', value);
      return;
    }
    if (value instanceof BigInt64Array) {
      // number
      emitTypedArrayChunk(request, id, 'M', value);
      return;
    }
    if (value instanceof BigUint64Array) {
      // unsigned number
      // We use "m" instead of "n" since JSON can start with "null"
      emitTypedArrayChunk(request, id, 'm', value);
      return;
    }
    if (value instanceof DataView) {
      emitTypedArrayChunk(request, id, 'V', value);
      return;
    }
  }
  // For anything else we need to try to serialize it using JSON.
  // $FlowFixMe[incompatible-type] stringify can return null for undefined but we never do
  const json: string = stringify(value, task.toJSON);
  emitModelChunk(request, task.id, json);
}

const emptyRoot = {};

function retryTask(request: Request, task: Task): void {
  if (task.status !== PENDING) {
    // We completed this by other means before we had a chance to retry it.
    return;
  }

  const prevDebugID = debugID;
  task.status = RENDERING;

  try {
    // Track the root so we know that we have to emit this object even though it
    // already has an ID. This is needed because we might see this object twice
    // in the same toJSON if it is cyclic.
    modelRoot = task.model;

    if (__DEV__) {
      // Track the ID of the current task so we can assign debug info to this id.
      debugID = task.id;
    }

    // We call the destructive form that mutates this task. That way if something
    // suspends again, we can reuse the same task instead of spawning a new one.
    const resolvedModel = renderModelDestructive(
      request,
      task,
      emptyRoot,
      '',
      task.model,
    );

    if (__DEV__) {
      // We're now past rendering this task and future renders will spawn new tasks for their
      // debug info.
      debugID = null;
    }

    // Track the root again for the resolved object.
    modelRoot = resolvedModel;

    // The keyPath resets at any terminal child node.
    task.keyPath = null;
    task.implicitSlot = false;

    if (typeof resolvedModel === 'object' && resolvedModel !== null) {
      // We're not in a contextual place here so we can refer to this object by this ID for
      // any future references.
      request.writtenObjects.set(resolvedModel, serializeByValueID(task.id));

      if (__DEV__) {
        const currentEnv = (0, request.environmentName)();
        if (currentEnv !== task.environmentName) {
          // The environment changed since we last emitted any debug information for this
          // task. We emit an entry that just includes the environment name change.
          emitDebugChunk(request, task.id, {env: currentEnv});
        }
      }

      // Object might contain unresolved values like additional elements.
      // This is simulating what the JSON loop would do if this was part of it.
      emitChunk(request, task, resolvedModel);
    } else {
      // If the value is a string, it means it's a terminal value and we already escaped it
      // We don't need to escape it again so it's not passed the toJSON replacer.
      // $FlowFixMe[incompatible-type] stringify can return null for undefined but we never do
      const json: string = stringify(resolvedModel);

      if (__DEV__) {
        const currentEnv = (0, request.environmentName)();
        if (currentEnv !== task.environmentName) {
          // The environment changed since we last emitted any debug information for this
          // task. We emit an entry that just includes the environment name change.
          emitDebugChunk(request, task.id, {env: currentEnv});
        }
      }

      emitModelChunk(request, task.id, json);
    }

    request.abortableTasks.delete(task);
    task.status = COMPLETED;
  } catch (thrownValue) {
    const x =
      thrownValue === SuspenseException
        ? // This is a special type of exception used for Suspense. For historical
          // reasons, the rest of the Suspense implementation expects the thrown
          // value to be a thenable, because before `use` existed that was the
          // (unstable) API for suspending. This implementation detail can change
          // later, once we deprecate the old API in favor of `use`.
          getSuspendedThenable()
        : thrownValue;
    if (typeof x === 'object' && x !== null) {
      // $FlowFixMe[method-unbinding]
      if (typeof x.then === 'function') {
        if (request.status === ABORTING) {
          request.abortableTasks.delete(task);
          task.status = ABORTED;
          const errorId: number = (request.fatalError: any);
          const model = stringify(serializeByValueID(errorId));
          emitModelChunk(request, task.id, model);
          return;
        }
        // Something suspended again, let's pick it back up later.
        task.status = PENDING;
        task.thenableState = getThenableStateAfterSuspending();
        const ping = task.ping;
        x.then(ping, ping);
        return;
      } else if (enablePostpone && x.$$typeof === REACT_POSTPONE_TYPE) {
        request.abortableTasks.delete(task);
        task.status = ERRORED;
        const postponeInstance: Postpone = (x: any);
        logPostpone(request, postponeInstance.message, task);
        emitPostponeChunk(request, task.id, postponeInstance);
        return;
      }
    }

    if (x === AbortSigil) {
      request.abortableTasks.delete(task);
      task.status = ABORTED;
      const errorId: number = (request.fatalError: any);
      const model = stringify(serializeByValueID(errorId));
      emitModelChunk(request, task.id, model);
      return;
    }

    request.abortableTasks.delete(task);
    task.status = ERRORED;
    const digest = logRecoverableError(request, x, task);
    emitErrorChunk(request, task.id, digest, x);
  } finally {
    if (__DEV__) {
      debugID = prevDebugID;
    }
  }
}

function tryStreamTask(request: Request, task: Task): void {
  // This is used to try to emit something synchronously but if it suspends,
  // we emit a reference to a new outlined task immediately instead.
  const prevDebugID = debugID;
  if (__DEV__) {
    // We don't use the id of the stream task for debugID. Instead we leave it null
    // so that we instead outline the row to get a new debugID if needed.
    debugID = null;
  }
  try {
    emitChunk(request, task, task.model);
  } finally {
    if (__DEV__) {
      debugID = prevDebugID;
    }
  }
}

function performWork(request: Request): void {
  const prevDispatcher = ReactSharedInternals.H;
  ReactSharedInternals.H = HooksDispatcher;
  const prevRequest = currentRequest;
  currentRequest = request;
  prepareToUseHooksForRequest(request);

  try {
    const pingedTasks = request.pingedTasks;
    request.pingedTasks = [];
    for (let i = 0; i < pingedTasks.length; i++) {
      const task = pingedTasks[i];
      retryTask(request, task);
    }
    if (request.destination !== null) {
      flushCompletedChunks(request, request.destination);
    }
  } catch (error) {
    logRecoverableError(request, error, null);
    fatalError(request, error);
  } finally {
    ReactSharedInternals.H = prevDispatcher;
    resetHooksForRequest();
    currentRequest = prevRequest;
  }
}

function abortTask(task: Task, request: Request, errorId: number): void {
  if (task.status === RENDERING) {
    // This task will be aborted by the render
    return;
  }
  task.status = ABORTED;
  // Instead of emitting an error per task.id, we emit a model that only
  // has a single value referencing the error.
  const ref = serializeByValueID(errorId);
  const processedChunk = encodeReferenceChunk(request, task.id, ref);
  request.completedErrorChunks.push(processedChunk);
}

function flushCompletedChunks(
  request: Request,
  destination: Destination,
): void {
  beginWriting(destination);
  try {
    // We emit module chunks first in the stream so that
    // they can be preloaded as early as possible.
    const importsChunks = request.completedImportChunks;
    let i = 0;
    for (; i < importsChunks.length; i++) {
      request.pendingChunks--;
      const chunk = importsChunks[i];
      const keepWriting: boolean = writeChunkAndReturn(destination, chunk);
      if (!keepWriting) {
        request.destination = null;
        i++;
        break;
      }
    }
    importsChunks.splice(0, i);

    // Next comes hints.
    const hintChunks = request.completedHintChunks;
    i = 0;
    for (; i < hintChunks.length; i++) {
      const chunk = hintChunks[i];
      const keepWriting: boolean = writeChunkAndReturn(destination, chunk);
      if (!keepWriting) {
        request.destination = null;
        i++;
        break;
      }
    }
    hintChunks.splice(0, i);

    // Next comes model data.
    const regularChunks = request.completedRegularChunks;
    i = 0;
    for (; i < regularChunks.length; i++) {
      request.pendingChunks--;
      const chunk = regularChunks[i];
      const keepWriting: boolean = writeChunkAndReturn(destination, chunk);
      if (!keepWriting) {
        request.destination = null;
        i++;
        break;
      }
    }
    regularChunks.splice(0, i);

    // Finally, errors are sent. The idea is that it's ok to delay
    // any error messages and prioritize display of other parts of
    // the page.
    const errorChunks = request.completedErrorChunks;
    i = 0;
    for (; i < errorChunks.length; i++) {
      request.pendingChunks--;
      const chunk = errorChunks[i];
      const keepWriting: boolean = writeChunkAndReturn(destination, chunk);
      if (!keepWriting) {
        request.destination = null;
        i++;
        break;
      }
    }
    errorChunks.splice(0, i);
  } finally {
    request.flushScheduled = false;
    completeWriting(destination);
  }
  flushBuffered(destination);
  if (request.pendingChunks === 0) {
    // We're done.
    if (enableTaint) {
      cleanupTaintQueue(request);
    }
    request.status = CLOSED;
    close(destination);
    request.destination = null;
  }
}

export function startWork(request: Request): void {
  request.flushScheduled = request.destination !== null;
  if (supportsRequestStorage) {
    scheduleWork(() => requestStorage.run(request, performWork, request));
  } else {
    scheduleWork(() => performWork(request));
  }
}

function enqueueFlush(request: Request): void {
  if (
    request.flushScheduled === false &&
    // If there are pinged tasks we are going to flush anyway after work completes
    request.pingedTasks.length === 0 &&
    // If there is no destination there is nothing we can flush to. A flush will
    // happen when we start flowing again
    request.destination !== null
  ) {
    request.flushScheduled = true;
    scheduleWork(() => {
      request.flushScheduled = false;
      const destination = request.destination;
      if (destination) {
        flushCompletedChunks(request, destination);
      }
    });
  }
}

export function startFlowing(request: Request, destination: Destination): void {
  if (request.status === CLOSING) {
    request.status = CLOSED;
    closeWithError(destination, request.fatalError);
    return;
  }
  if (request.status === CLOSED) {
    return;
  }
  if (request.destination !== null) {
    // We're already flowing.
    return;
  }
  request.destination = destination;
  try {
    flushCompletedChunks(request, destination);
  } catch (error) {
    logRecoverableError(request, error, null);
    fatalError(request, error);
  }
}

export function stopFlowing(request: Request): void {
  request.destination = null;
}

// This is called to early terminate a request. It creates an error at all pending tasks.
export function abort(request: Request, reason: mixed): void {
  try {
    request.status = ABORTING;
    const abortableTasks = request.abortableTasks;
    // We have tasks to abort. We'll emit one error row and then emit a reference
    // to that row from every row that's still remaining.
    if (abortableTasks.size > 0) {
      request.pendingChunks++;
      const errorId = request.nextChunkId++;
      request.fatalError = errorId;
      if (
        enablePostpone &&
        typeof reason === 'object' &&
        reason !== null &&
        (reason: any).$$typeof === REACT_POSTPONE_TYPE
      ) {
        const postponeInstance: Postpone = (reason: any);
        logPostpone(request, postponeInstance.message, null);
        emitPostponeChunk(request, errorId, postponeInstance);
      } else {
        const error =
          reason === undefined
            ? new Error(
                'The render was aborted by the server without a reason.',
              )
            : typeof reason === 'object' &&
                reason !== null &&
                typeof reason.then === 'function'
              ? new Error(
                  'The render was aborted by the server with a promise.',
                )
              : reason;
        const digest = logRecoverableError(request, error, null);
        emitErrorChunk(request, errorId, digest, error);
      }
      abortableTasks.forEach(task => abortTask(task, request, errorId));
      abortableTasks.clear();
    }
    const abortListeners = request.abortListeners;
    if (abortListeners.size > 0) {
      let error;
      if (
        enablePostpone &&
        typeof reason === 'object' &&
        reason !== null &&
        (reason: any).$$typeof === REACT_POSTPONE_TYPE
      ) {
        // We aborted with a Postpone but since we're passing this to an
        // external handler, passing this object would leak it outside React.
        // We create an alternative reason for it instead.
        error = new Error('The render was aborted due to being postponed.');
      } else {
        error =
          reason === undefined
            ? new Error(
                'The render was aborted by the server without a reason.',
              )
            : typeof reason === 'object' &&
                reason !== null &&
                typeof reason.then === 'function'
              ? new Error(
                  'The render was aborted by the server with a promise.',
                )
              : reason;
      }
      abortListeners.forEach(callback => callback(error));
      abortListeners.clear();
    }
    if (request.destination !== null) {
      flushCompletedChunks(request, request.destination);
    }
  } catch (error) {
    logRecoverableError(request, error, null);
    fatalError(request, error);
  }
}
