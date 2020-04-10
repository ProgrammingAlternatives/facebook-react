/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */

import type {Source} from 'shared/ReactElementType';
import type {LazyComponent} from 'react/src/ReactLazy';

import {enableComponentStackLocations} from 'shared/ReactFeatureFlags';

import {
  REACT_SUSPENSE_TYPE,
  REACT_SUSPENSE_LIST_TYPE,
  REACT_FORWARD_REF_TYPE,
  REACT_MEMO_TYPE,
  REACT_BLOCK_TYPE,
  REACT_LAZY_TYPE,
} from 'shared/ReactSymbols';

import {disableLogs, reenableLogs} from 'shared/ConsolePatchingDev';

import ReactSharedInternals from 'shared/ReactSharedInternals';

const {ReactCurrentDispatcher} = ReactSharedInternals;

let prefix;
export function describeBuiltInComponentFrame(
  name: string,
  source: void | null | Source,
  ownerFn: void | null | Function,
): string {
  if (enableComponentStackLocations) {
    if (prefix === undefined) {
      // Extract the VM specific prefix used by each line.
      const match = Error()
        .stack.trim()
        .match(/\n( *(at )?)/);
      prefix = (match && match[1]) || '';
    }
    // We use the prefix to ensure our stacks line up with native stack frames.
    return '\n' + prefix + name;
  } else {
    let ownerName = null;
    if (__DEV__ && ownerFn) {
      ownerName = ownerFn.displayName || ownerFn.name || null;
    }
    return describeComponentFrame(name, source, ownerName);
  }
}

let reentry = false;
let componentFrameCache;
if (__DEV__) {
  const PossiblyWeakMap = typeof WeakMap === 'function' ? WeakMap : Map;
  componentFrameCache = new PossiblyWeakMap();
}

export function describeNativeComponentFrame(
  fn: Function,
  construct: boolean,
): string {
  // If something asked for a stack inside a fake render, it should get ignored.
  if (!fn || reentry) {
    return '';
  }

  if (__DEV__) {
    const frame = componentFrameCache.get(fn);
    if (frame !== undefined) {
      return frame;
    }
  }

  const control = Error();

  reentry = true;
  let previousDispatcher;
  if (__DEV__) {
    previousDispatcher = ReactCurrentDispatcher.current;
    // Set the dispatcher in DEV because this might be call in the render function
    // for warnings.
    ReactCurrentDispatcher.current = null;
    disableLogs();
  }
  try {
    // This should throw.
    if (construct) {
      // Something should be setting the props in the constructor.
      const Fake = function() {};
      // $FlowFixMe
      Object.defineProperty(Fake.prototype, 'props', {
        set: function() {
          // We use a throwing setter instead of frozen or non-writable props
          // because that won't throw in a non-strict mode function.
          throw Error();
        },
      });
      if (typeof Reflect === 'object' && Reflect.construct) {
        Reflect.construct(fn, [], Fake);
      } else {
        fn.call(new Fake());
      }
    } else {
      fn();
    }
  } catch (sample) {
    // This is inlined manually because closure doesn't do it for us.
    if (sample && typeof sample.stack === 'string') {
      // This extracts the first frame from the sample that isn't also in the control.
      // Skipping one frame that we assume is the frame that calls the two.
      const sampleLines = sample.stack.split('\n');
      const controlLines = control.stack.split('\n');
      let s = sampleLines.length - 1;
      let c = controlLines.length - 1;
      while (s >= 1 && c >= 0 && sampleLines[s] !== controlLines[c]) {
        // We expect at least one stack frame to be shared.
        // Typically this will be the root most one. However, stack frames may be
        // cut off due to maximum stack limits. In this case, one maybe cut off
        // earlier than the other. We assume that the sample is longer or the same
        // and there for cut off earlier. So we should find the root most frame in
        // the sample somewhere in the control.
        c--;
      }
      for (; s >= 1 && c >= 0; s--, c--) {
        // Next we find the first one that isn't the same which should be the
        // frame that called our sample function.
        if (sampleLines[s] !== controlLines[c]) {
          // Return the line we found.
          // V8 adds a "new" prefix for native classes. Let's remove it to make it prettier.
          const frame = '\n' + sampleLines[s - 1].replace(' at new ', ' at ');
          if (__DEV__) {
            if (typeof fn === 'function') {
              componentFrameCache.set(fn, frame);
            }
          }
          return frame;
        }
      }
    }
  } finally {
    reentry = false;
    if (__DEV__) {
      ReactCurrentDispatcher.current = previousDispatcher;
      reenableLogs();
    }
  }
  // Fallback to just using the name if we couldn't make it throw.
  const name = fn ? fn.displayName || fn.name : '';
  const syntheticFrame = name ? describeBuiltInComponentFrame(name) : '';
  if (__DEV__) {
    if (typeof fn === 'function') {
      componentFrameCache.set(fn, syntheticFrame);
    }
  }
  return syntheticFrame;
}

const BEFORE_SLASH_RE = /^(.*)[\\\/]/;

function describeComponentFrame(
  name: null | string,
  source: void | null | Source,
  ownerName: null | string,
) {
  let sourceInfo = '';
  if (__DEV__ && source) {
    const path = source.fileName;
    let fileName = path.replace(BEFORE_SLASH_RE, '');
    // In DEV, include code for a common special case:
    // prefer "folder/index.js" instead of just "index.js".
    if (/^index\./.test(fileName)) {
      const match = path.match(BEFORE_SLASH_RE);
      if (match) {
        const pathBeforeSlash = match[1];
        if (pathBeforeSlash) {
          const folderName = pathBeforeSlash.replace(BEFORE_SLASH_RE, '');
          fileName = folderName + '/' + fileName;
        }
      }
    }
    sourceInfo = ' (at ' + fileName + ':' + source.lineNumber + ')';
  } else if (ownerName) {
    sourceInfo = ' (created by ' + ownerName + ')';
  }
  return '\n    in ' + (name || 'Unknown') + sourceInfo;
}

export function describeClassComponentFrame(
  ctor: Function,
  source: void | null | Source,
  ownerFn: void | null | Function,
): string {
  if (enableComponentStackLocations) {
    return describeNativeComponentFrame(ctor, true);
  } else {
    return describeFunctionComponentFrame(ctor, source, ownerFn);
  }
}

export function describeFunctionComponentFrame(
  fn: Function,
  source: void | null | Source,
  ownerFn: void | null | Function,
): string {
  if (enableComponentStackLocations) {
    return describeNativeComponentFrame(fn, false);
  } else {
    if (!fn) {
      return '';
    }
    const name = fn.displayName || fn.name || null;
    let ownerName = null;
    if (__DEV__ && ownerFn) {
      ownerName = ownerFn.displayName || ownerFn.name || null;
    }
    return describeComponentFrame(name, source, ownerName);
  }
}

function shouldConstruct(Component: Function) {
  const prototype = Component.prototype;
  return !!(prototype && prototype.isReactComponent);
}

export function describeUnknownElementTypeFrameInDEV(
  type: any,
  source: void | null | Source,
  ownerFn: void | null | Function,
): string {
  if (!__DEV__) {
    return '';
  }
  if (type == null) {
    return '';
  }
  if (typeof type === 'function') {
    if (enableComponentStackLocations) {
      return describeNativeComponentFrame(type, shouldConstruct(type));
    } else {
      return describeFunctionComponentFrame(type, source, ownerFn);
    }
  }
  if (typeof type === 'string') {
    return describeBuiltInComponentFrame(type, source, ownerFn);
  }
  switch (type) {
    case REACT_SUSPENSE_TYPE:
      return describeBuiltInComponentFrame('Suspense', source, ownerFn);
    case REACT_SUSPENSE_LIST_TYPE:
      return describeBuiltInComponentFrame('SuspenseList', source, ownerFn);
  }
  if (typeof type === 'object') {
    switch (type.$$typeof) {
      case REACT_FORWARD_REF_TYPE:
        return describeFunctionComponentFrame(type.render, source, ownerFn);
      case REACT_MEMO_TYPE:
        // Memo may contain any component type so we recursively resolve it.
        return describeUnknownElementTypeFrameInDEV(type.type, source, ownerFn);
      case REACT_BLOCK_TYPE:
        return describeFunctionComponentFrame(type._render, source, ownerFn);
      case REACT_LAZY_TYPE: {
        const lazyComponent: LazyComponent<any, any> = (type: any);
        const payload = lazyComponent._payload;
        const init = lazyComponent._init;
        try {
          // Lazy may contain any component type so we recursively resolve it.
          return describeUnknownElementTypeFrameInDEV(
            init(payload),
            source,
            ownerFn,
          );
        } catch (x) {}
      }
    }
  }
  return '';
}
