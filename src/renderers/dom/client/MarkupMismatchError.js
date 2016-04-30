/**
 * Copyright 2013-present, Facebook, Inc.
 * All rights reserved.
 *
 * This source code is licensed under the BSD-style license found in the
 * LICENSE file in the root directory of this source tree. An additional grant
 * of patent rights can be found in the PATENTS file in the same directory.
 *
 * @providesModule MarkupMismatchError
 */

'use strict';

var getInstanceDisplayName = require('getInstanceDisplayName');

var ELEMENT_NODE_TYPE = 1;
var TEXT_NODE_TYPE = 3;
var COMMENT_NODE_TYPE = 8;

// we cannot use class MarkupMismatchError extends Error {} because Babel cannot extend built-in
// objects in a way that allows for instanceof checks.
// this error subclassing code is copied and modified from
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error#Custom_Error_Types
// According to https://developer.mozilla.org/en-US/docs/MDN/About#Copyrights_and_licenses, all code in MDN
// added on or after August 20, 2010 is public domain, and according to the wiki page history, the earliest
// version of this code was added on June 7, 2011:
// https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Error$revision/62425
function MarkupMismatchError(message, node, serverVersion, clientVersion) {
  this.name = 'MarkupMismatchError';
  this.message = message || 'The pre-rendered markup did not match the component being rendered.';
  this.node = node;
  this.serverVersion = serverVersion;
  this.clientVersion = clientVersion;
  this.stack = (new Error()).stack;
}
MarkupMismatchError.prototype = Object.create(Error.prototype);
MarkupMismatchError.prototype.constructor = MarkupMismatchError;

/**
 * throw an error when there is a child of the node in the client component tree
 * that was not present in the server markup.
 * @param {DOMElement} node parent in the server markup
 * @param {ReactComponent} child The child instance in the client component tree
 * that wasn't present in the server markup.
 */
function throwChildAddedError(node, child) {
  throw new MarkupMismatchError(
    `The client rendered a node that was not present in the server-generated markup.`,
    node,
    `<Nothing>`,
    `A child of type '${getInstanceDisplayName(child)}'`);
}

/**
 * throw an error when there is a child of the node in the server markup that
 * is not present in the client component tree.
 * @param {DOMNode} the DOM child that wasn't present in the client
 *   component tree.
 */
function throwChildMissingError(serverChild) {
  let serverText = `A child node of type ${serverChild.nodeType}`;
  switch (serverChild.nodeType) {
    case ELEMENT_NODE_TYPE:
      serverText = `A child <${serverChild.tagName}> element with text: '${abridgeContent(serverChild.textContent)}'`;
      break;
    case TEXT_NODE_TYPE:
      serverText = `A text node with text '${abridgeContent(serverChild.textContent)}'`;
      break;
  }
  throw new MarkupMismatchError(
    'The client failed to render a node that was present in the server-generated markup.',
    serverChild,
    serverText,
    '<Nothing>'
  );
}

/**
 * throw an error when there is a DOM node in the server markup that has a different
 * tag than the client component tree.
 * @param {DOMElement} the DOM element from the server markup
 * @param {String} the client component tree element tag ("div", "span", etc.)
 *   component tree.
 */
function throwNodeTypeMismatchError(node, clientTagname) {
  throw new MarkupMismatchError(
    'The client rendered a DOM element with a different HTML tag than that ' +
    'which was present in the server-generated markup.',
    node,
    `A <${node.tagName.toLowerCase()}> tag`,
    `A <${clientTagname}> tag`);
}

/**
 * throw an error when there is a DOM attribute in the server markup that is not
 * present in the client component tree.
 * @param {DOMElement} the DOM element from the server markup that has an extra attribute
 * @param {String} the attribute name
 * @param {String} the attribute value in the server markup
 */
function throwAttributeMissingMismatchError(node, attr, value) {
  throw new MarkupMismatchError(
    `The client failed to render a '${attr}' attribute that was present in the server-generated markup.`,
    node,
    `${attr}=${value}`,
    `<No ${attr} value>`);
}

/**
 * throw an error when there is a DOM attribute in the client component tree that is not
 * present in the server markup.
 * @param {DOMElement} the DOM element from the server markup that is missing an attribute
 * @param {String} the attribute name
 * @param {String} the attribute value in the client component tree.
 */
function throwAttributeAddedMismatchError(node, attr, value) {
  throw new MarkupMismatchError(
    `The client rendered a '${attr}' attribute that was not present in the server-generated markup.`,
    node,
    `<No ${attr} value>`,
    `${attr}=${value}`);
}

/**
 * throw an error when there is a DOM attribute in the client component tree that has a
 * different value in the server markup.
 * @param {DOMElement} the DOM element from the server markup that has the changed attribute
 * @param {String} the attribute name
 * @param {String} the attribute value in the server markup
 * @param {String} the attribute value in the client component tree.
 */
function throwAttributeChangedMismatchError(node, attr, serverValue, clientValue) {
  throw new MarkupMismatchError(
    `The client rendered a '${attr}' attribute with a different value than ` +
    `that which was present in the server-generated markup.`,
    node,
    `${attr}=${serverValue}`,
    `${attr}=${clientValue}`);
}

/**
 * throw an error when html set with dangerouslySetInnerHTML has a
 * different value in the server markup and client component tree.
 * @param {DOMElement} the DOM element from the server markup that has the dangerouslySetInnerHTML
 * @param {String} the dangerouslySetInnerHTML value in the server markup
 * @param {String} the dangerouslySetInnerHTML value in the client component tree.
 */
function throwInnerHtmlMismatchError(node, serverValue, clientValue) {
  throw new MarkupMismatchError(
    'The client rendered a dangerouslySetInnerHTML value that was different ' +
    'than that which was present in the server-generated markup.',
    node,
    serverValue,
    clientValue
  );
}

/**
 * throw an error when the text content of a node has a
 * different value in the server markup and client component tree.
 * @param {DOMElement} the DOM element from the server markup that has differing text
 * @param {String} the text value in the server markup
 * @param {String} the text value in the client component tree.
 */
function throwTextMismatchError(node, serverValue, clientValue) {
  throw new MarkupMismatchError(
    'The client rendered some text which was different than that which was ' +
    'present in the server-generated markup.',
    node,
    `'${serverValue}'`,
    `'${clientValue}'`);
}

/**
 * throw an error when the component type (i.e. element, text, empty) of a node has a
 * different value in the server markup and client component tree.
 * @param {DOMNode|Array<DOMNode>} the DOM element or elements from the server
 *   markup that is/are different on client
 * @param {String} a user-readable description of the component in the client
 *   component tree.
 */
function throwComponentTypeMismatchError(node, clientComponentDesc) {
  var serverValue = '';

  if (Array.isArray(node) && node.length === 3) {
    serverValue = `A text node with text: '${abridgeContent(node[1].textContent)}'`;
  } else if (Array.isArray(node) && node.length === 2) {
    serverValue = 'A blank text node.';
  } else if (node.nodeType === COMMENT_NODE_TYPE) {
    serverValue = 'An empty (or null) node';
  } else if (node.nodeType === ELEMENT_NODE_TYPE) {
    serverValue = `A <${node.tagName.toLowerCase()}> element with text: '${abridgeContent(node.textContent)}'`;
  } else {
    serverValue = `An illegal DOM node with text: '${abridgeContent(node.textContent)}'`;
  }

  throw new MarkupMismatchError(
    'The client rendered one type of node, but a different type of node ' +
    'was present in the server-generated markup.',
    Array.isArray(node) ? node[0] : node,
    serverValue,
    clientComponentDesc);
}

/**
 * truncate text utility function.
 * @private
 * @param {String} text to truncate
 * @param {Number?} maximum length
 */
function abridgeContent(text, maxLength = 30) {
  if (text.length < maxLength) {
    return text;
  }
  return text.substr(0, maxLength) + '...';
}

module.exports = {
  error: MarkupMismatchError,
  throwChildAddedError,
  throwChildMissingError,
  throwNodeTypeMismatchError,
  throwAttributeMissingMismatchError,
  throwAttributeAddedMismatchError,
  throwAttributeChangedMismatchError,
  throwInnerHtmlMismatchError,
  throwTextMismatchError,
  throwComponentTypeMismatchError,
};
