/**
 * Copyright (c) 2013-present, Facebook, Inc.
 *
 * This source code is licensed under the MIT license found in the
 * LICENSE file in the root directory of this source tree.
 *
 * @emails react-core
 */

'use strict';

let React;
let ReactFeatureFlags;
let ReactDOMServer;

describe('ReactDOMServerLifecycles', () => {
  beforeEach(() => {
    ReactFeatureFlags = require('shared/ReactFeatureFlags');
    ReactFeatureFlags.warnAboutDeprecatedLifecycles = true;

    React = require('react');
    ReactDOMServer = require('react-dom/server');
  });

  // TODO (RFC #6) Merge this back into ReactDOMServerLifecycles-test once
  // the 'warnAboutDeprecatedLifecycles' feature flag has been removed.
  it('should warn about deprecated lifecycle hooks', () => {
    class Component extends React.Component {
      componentWillMount() {}
      render() {
        return null;
      }
    }

    expect(() => ReactDOMServer.renderToString(<Component />)).toWarnDev(
      'Warning: Component: componentWillMount() is deprecated and will be removed ' +
        'in the next major version.',
    );

    // De-duped
    ReactDOMServer.renderToString(<Component />);
  });

  describe('react-lifecycles-compat', () => {
    // TODO Replace this with react-lifecycles-compat once it's been published
    function polyfill(Component) {
      Component.prototype.componentWillMount = function() {};
      Component.prototype.componentWillMount.__suppressDeprecationWarning = true;
      Component.prototype.componentWillReceiveProps = function() {};
      Component.prototype.componentWillReceiveProps.__suppressDeprecationWarning = true;
    }

    it('should not warn about deprecated cWM/cWRP for polyfilled components', () => {
      class PolyfilledComponent extends React.Component {
        state = {};
        static getDerivedStateFromProps() {
          return null;
        }
        render() {
          return null;
        }
      }

      polyfill(PolyfilledComponent);

      ReactDOMServer.renderToString(<PolyfilledComponent />);
    });
  });
});
