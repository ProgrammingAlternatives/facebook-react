/**
 * Copyright (c) Facebook, Inc. and its affiliates.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @flow
 */
import type {
  ReactDOMEventResponder,
  ReactDOMResponderEvent,
  ReactDOMResponderContext,
} from 'shared/ReactDOMTypes';

import React from 'react';

type FocusScopeProps = {
  autoFocus: Boolean,
  contain: Boolean,
  restoreFocus: Boolean,
};

type FocusScopeState = {
  nodeToRestore: null | HTMLElement,
  currentFocusedNode: null | HTMLElement,
};

const targetEventTypes = ['keydown_active'];
const rootEventTypes = ['focus'];

function focusElement(element: ?HTMLElement) {
  if (element != null) {
    try {
      element.focus();
    } catch (err) {}
  }
}

function getFirstFocusableElement(
  context: ReactDOMResponderContext,
  state: FocusScopeState,
): ?HTMLElement {
  const elements = context.getFocusableElementsInScope(false);
  if (elements.length > 0) {
    return elements[0];
  }
}

export const FocusScopeResponder: ReactDOMEventResponder = {
  displayName: 'FocusScope',
  targetEventTypes,
  rootEventTypes,
  getInitialState(): FocusScopeState {
    return {
      nodeToRestore: null,
      currentFocusedNode: null,
    };
  },
  onEvent(
    event: ReactDOMResponderEvent,
    context: ReactDOMResponderContext,
    props: FocusScopeProps,
    state: FocusScopeState,
  ) {
    const {type, nativeEvent} = event;

    if (type === 'keydown' && nativeEvent.key === 'Tab') {
      const focusedElement = context.getActiveDocument().activeElement;
      if (
        focusedElement !== null &&
        context.isTargetWithinResponder(focusedElement)
      ) {
        const {altkey, ctrlKey, metaKey, shiftKey} = (nativeEvent: any);
        // Skip if any of these keys are being pressed
        if (altkey || ctrlKey || metaKey) {
          return;
        }
        const elements = context.getFocusableElementsInScope(false);
        const position = elements.indexOf(focusedElement);
        const lastPosition = elements.length - 1;
        let nextElement = null;

        if (shiftKey) {
          if (position === 0) {
            if (props.contain) {
              nextElement = elements[lastPosition];
            } else {
              // TODO remove this, this is hacky
              const allElements = context.getFocusableElementsInScope(true);
              const prevPosition = allElements.indexOf(focusedElement) - 1;
              nextElement = allElements[prevPosition] || null;
            }
          } else {
            nextElement = elements[position - 1];
          }
        } else {
          if (position === lastPosition) {
            if (props.contain) {
              nextElement = elements[0];
            } else {
              // TODO remove this, this is hacky
              const allElements = context.getFocusableElementsInScope(true);
              const nextPosition = allElements.indexOf(focusedElement) + 1;
              nextElement = allElements[nextPosition] || null;
            }
          } else {
            nextElement = elements[position + 1];
          }
        }
        if (nextElement !== null) {
          focusElement(nextElement);
          state.currentFocusedNode = nextElement;
          ((nativeEvent: any): KeyboardEvent).preventDefault();
        }
      }
    }
  },
  onRootEvent(
    event: ReactDOMResponderEvent,
    context: ReactDOMResponderContext,
    props: FocusScopeProps,
    state: FocusScopeState,
  ) {
    const {target} = event;

    // Handle global focus containment
    if (props.contain) {
      if (!context.isTargetWithinResponder(target)) {
        const currentFocusedNode = state.currentFocusedNode;
        if (currentFocusedNode !== null) {
          focusElement(currentFocusedNode);
        } else if (props.autoFocus) {
          const firstElement = getFirstFocusableElement(context, state);
          focusElement(firstElement);
        }
      }
    }
  },
  onMount(
    context: ReactDOMResponderContext,
    props: FocusScopeProps,
    state: FocusScopeState,
  ): void {
    if (props.restoreFocus) {
      state.nodeToRestore = context.getActiveDocument().activeElement;
    }
    if (props.autoFocus) {
      const firstElement = getFirstFocusableElement(context, state);
      focusElement(firstElement);
    }
  },
  onUnmount(
    context: ReactDOMResponderContext,
    props: FocusScopeProps,
    state: FocusScopeState,
  ): void {
    if (props.restoreFocus && state.nodeToRestore !== null) {
      focusElement(state.nodeToRestore);
    }
  },
};

export function useFocusScopeResponder(props: FocusScopeProps): void {
  React.unstable_useResponder(FocusScopeResponder, null, props);
}
