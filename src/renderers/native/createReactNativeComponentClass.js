/**
 * Copyright (c) 2015-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule createReactNativeComponentClass
 * @flow
 */

'use strict';

const ReactNativeViewConfigRegistry = require('ReactNativeViewConfigRegistry');

import type {ReactNativeBaseComponentViewConfig} from 'ReactNativeTypes';

/**
 * Creates a renderable ReactNative host component.
 * Use this method when the view config is defined within JavaScript.
 * Use lazilyCreateReactNativeComponentClass() for view configs retrieved from UIManager.
 *
 * @param {string} config iOS View configuration.
 * @private
 */
const createReactNativeComponentClass = function(
  viewConfig: ReactNativeBaseComponentViewConfig,
): string {
  return ReactNativeViewConfigRegistry.register(viewConfig);
};

module.exports = createReactNativeComponentClass;
