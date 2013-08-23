var css = require('css-component');

/**
 * Extend any object with the properties from other objects, overriding of left
 * to right.
 *
 * @param  {Object} obj Root object to copy properties to.
 * @param  {Object} ... Any number of source objects that properties will be
 *                      copied from.
 * @return {Object}
 */
var extend = function (obj /*, ...source */) {
  var args = Array.prototype.slice.call(arguments, 1);

  for (var i = 0; i < args.length; i++) {
    if (typeof args[i] === 'object') {
      for (var p in args[i]) {
        obj[p] = args[i][p];
      }
    }
  }

  return obj;
};

/**
 * Simple function to loop over properties in an object or array.
 *
 * @param  {Object}   obj
 * @param  {Function} fn
 * @param  {*}        [context]
 */
var each = function (obj, fn, context) {
  if (Object.prototype.toString.call(obj) === '[object Object]') {
    for (var p in obj) {
      fn.call(context, obj[p], p, obj);
    }
  } else if (obj.length === +obj.length) {
    for (var i = 0, l = obj.length; i < l; i++) {
      fn.call(context, obj[i], i, obj);
    }
  }
};

/**
 * Getting all the data atrributes of an element. Works on all browsers.
 *
 * @param  {Element} el
 * @return {Object}
 */
var getDataAttributes = function (el) {
  var obj  = {};

  if (el.dataset) {
    return extend(obj, el.dataset);
  }

  var attrs = el.attributes;
  for (var i = 0, l = attrs.length; i < l; i++) {
    var attr = attrs.item(i);
    if (attr.nodeName.substr(0, 5) === 'data-') {
      var name = attr.nodeName.substr(5).replace(/\-(\w)/, function (_, $0) {
        return $0.toUpperCase();
      });

      obj[name] = attr.nodeValue;
    }
  }

  return obj;
};

/**
 * Copy of all the default options for a new Notebook instance.
 *
 * @type {Object}
 */
var defaults = {
  id:      null, // Initial id to pull content from
  content: null, // Fallback content in case of no id
  style:   {}    // Set styles on the iframe
};

/**
 * Copy of the default iframe style options.
 *
 * @type {Object}
 */
var styles = {
  border:    'none',
  display:   'block',
  padding:   '0',
  width:     '100%',
  minHeight: '260px'
};

/**
 * Creates an embeddable version of the notebook for general consumption.
 *
 * @param  {Element|Function} el Pass an element or a function that accepts an
 *                               element as the only argument.
 * @param  {Object}   options
 * @return {Notebook}
 */
var Notebook = module.exports = function (el, options) {
  if (!(this instanceof Notebook)) { return new Notebook(el, options); }

  // Extend default options with passed in options
  this.options = extend({}, defaults, options);
  this.options.style = extend({}, styles, options && options.style);

  this.makeFrame(el);
};

/**
 * Generate an iframe to house the embeddable widget and append to the
 * designated element in the DOM.
 *
 * @param  {Element|Function} el
 * @return {Notebook}
 */
Notebook.prototype.makeFrame = function (el) {
  var that = this;
  var src  = process.env.NOTEBOOK_URL;

  if (this.options.id) {
    src += ('/' === src[src.length - 1] ? '' : '/') + '#' + this.options.id;
  }

  var frame = this.frame = document.createElement('iframe');
  frame.src = src;

  if (typeof el.appendChild === 'function') {
    el.appendChild(frame);
  } else {
    el(frame);
  }

  // When the app is ready to receive events, send relevant info
  this.on('ready', function () {
    this.trigger('referrer', global.location.href);

    if (typeof this.options.content === 'string') {
      this.trigger('content', this.options.content);
    }
  });

  // When a new height comes through, update the iframe height
  this.on('height', function (height) {
    this.frame.style.height = height + 'px';
  });

  // Set up a single message listener that will trigger events from the frame
  global.addEventListener('message', this._messageListener = function (e) {
    if (e.source !== frame.contentWindow) { return; }

    that._frameEvent = e;
    that.trigger.apply(that, e.data);
  }, false);

  this.styleFrame(this.options.style);

  return this;
};

/**
 * Sets the inline styles of the frame.
 *
 * @param  {Object}   style
 * @return {Notebook}
 */
Notebook.prototype.styleFrame = function (style) {
  css(this.frame, style);
  return this;
};

/**
 * Removes the frame from the DOM.
 *
 * @return {Notebook}
 */
Notebook.prototype.removeFrame = function () {
  global.removeEventListener('message', this._messageListener);
  this.frame.parentNode.removeChild(this.frame);
  delete this.frame;

  return this;
};

/**
 * Removes any notebook associated data from the embedding frame.
 *
 * @return {Notebook}
 */
Notebook.prototype.remove = function () {
  return this.removeFrame();
};

/**
 * Listen to events triggered by the frame.
 *
 * @param  {String}   name
 * @param  {Function} fn
 * @return {Notebook}
 */
Notebook.prototype.on = function (name, fn) {
  this._events = this._events || {};
  var events = (this._events[name] = this._events[name] || []);
  events.push(fn);

  return this;
};

/**
 * Remove an event listener from the frame.
 *
 * @param  {String}   name
 * @param  {Function} [fn]
 * @return {Notebook}
 */
Notebook.prototype.off = function (name, fn) {
  if (!this._events || !this._events[name]) { return this; }

  if (!fn) {
    delete this._events[name];
    return this;
  }

  var events = this._events[name]
  for (var i = 0; i < events; i++) {
    if (events[i] === fn) {
      events.splice(i, 1);
      i--;
    }
  }

  if (!events.length) { delete this._events[name]; }

  return this;
};

/**
 * Trigger an event on the frame. Read: Sends an event to the frames postMessage
 * handler.
 *
 * @param  {String}   name
 * @param  {*}        ...  Any additional data you wish the send with the event
 * @return {Notebook}
 */
Notebook.prototype.trigger = function (name /*, ..args */) {
  var that = this;
  var args;

  if (this._frameEvent) {
    delete that._frameEvent;
    args = Array.prototype.slice.call(arguments, 1);
    if (this._events && this._events[name]) {
      each(this._events[name], function (fn) {
        fn.apply(that, args);
      });
    }
    return this;
  }

  args = Array.prototype.slice.call(arguments, 0);
  this.frame.contentWindow.postMessage(args, '*');
  return this;
};

/**
 * Attempts to automatically create the initial notebook by scanning for the
 * correct script tag and using the data from it to generate the notebook.
 *
 * @param  {Array} scripts [description]
 * @return {[type]}         [description]
 */
(function (scripts) {
  var script;

  for (var i = 0, l = scripts.length; i < l; i++) {
    script = scripts[i];
    // Allows the script to be loaded asyncronously if we provide this attribute
    if (script.getAttribute('data-notebook') != null) { break; }
  }

  var data = getDataAttributes(script);

  if (!data.selector) { return; }

  var el = document.querySelector(data.selector);
  // Remove the selector and pass the rest of the options to the notebook
  delete data.selector;
  // TODO: Discuss replacing this implementation with something more
  // cross-browser. Probably just stick with element ids.
  return new Notebook(el, data);
})(document.getElementsByTagName('script'));