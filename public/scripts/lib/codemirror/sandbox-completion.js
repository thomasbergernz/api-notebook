var _            = require('underscore');
var Pos          = CodeMirror.Pos;
var middleware   = require('../../state/middleware');
var getToken     = require('./get-token');
var correctToken = require('./correct-token');
var tokenHelper  = require('./lib/token-helper');

/**
 * Verifies whether a given token is whitespace or not.
 *
 * @param  {Object}  token
 * @return {Boolean}
 */
var isWhitespaceToken = function (token) {
  return token.type === null && /^\s*$/.test(token.string);
};

/**
 * Returns the previous token in the editor, taking care to take into account
 * new lines.
 *
 * @param  {CodeMirror} cm
 * @param  {Object}     token
 * @return {Object}
 */
var getPrevToken = function (cm, token) {
  // Get the last token of the previous line. If we are at the beginning of the
  // editor already, return `null`.
  if (token.pos.ch === 0) {
    if (token.pos.line > 0) {
      return getToken(cm, {
        ch:   Infinity,
        line: token.pos.line - 1
      });
    } else {
      return null;
    }
  }

  return getToken(cm, token.pos);
};

/**
 * Returns the current token position, removing potential whitespace tokens.
 *
 * @param  {CodeMirror} cm
 * @param  {Object}     token
 * @return {Object}
 */
var eatSpace = function (cm, token) {
  while (token && isWhitespaceToken(token)) {
    token = getPrevToken(cm, token);
  }

  return token;
};

/**
 * Similar to `eatSpace`, but also takes moves the current token position.
 *
 * @param  {CodeMirror} cm
 * @param  {Object}     token
 * @return {Object}
 */
var eatSpaceAndMove = function (cm, token) {
  // No token, break.
  if (!token) { return token; }

  return eatSpace(cm, getPrevToken(cm, token));
};

/**
 * Check whether the token is a possible accessor token (can read a result).
 *
 * @param  {Object}  token
 * @return {Boolean}
 */
var canAccess = function (token) {
  if (!_.contains([null, 'keyword', 'invalid'], token.type)) {
    return true;
  }

  return token.type === null && _.contains([')', ']'], token.string);
};

/**
 * Proxy the return objects for the property and variable middleware and turn
 * it into something actionable for the widget display.
 *
 * @param  {Function} done
 * @return {Function}
 */
var completeResults = function (done) {
  return function (err, data) {
    // Sorts the keys and maps to an object that the widget can understand.
    var results = _.map(_.keys(data.results), function (key) {
      if (!_.isObject(data.results[key])) {
        return {
          name:  key,
          value: key
        };
      }

      return {
        name:    key,
        value:   data.results[key].value,
        special: data.results[key].special
      };
    }).sort(function (a, b) {
      if (a.special && b.special) {
        return a.value > b.value ? 1 : -1;
      } else if (a.special) {
        return 1;
      } else if (b.special) {
        return -1;
      }

      return a.value > b.value ? 1 : -1;
    });

    return done(err, {
      context: data.context,
      results: results
    });
  };
};

/**
 * Complete variable completion suggestions.
 *
 * @param  {CodeMirror} cm
 * @param  {Object}     token
 * @param  {Object}     options
 * @param  {Function}   done
 */
var completeVariable = function (cm, token, options, done) {
  // Trigger the completion middleware to run
  middleware.trigger('completion:variable', _.extend({
    token:   token,
    editor:  cm,
    results: {}
  }, options), completeResults(done));
};

/**
 * Get the full property path to a property token.
 *
 * @param  {CodeMirror} cm
 * @param  {Object}     token
 * @return {Array}
 */
var getPropertyPath = function (cm, token) {
  var context = [];

  /**
   * Mix in to with a token indicate an invalid/unexpected token.
   *
   * @type {Object}
   */
  var invalidToken = {
    type:   'invalid',
    string: null
  };

  /**
   * Eats the current token and any whitespace.
   *
   * @param  {Object} token
   * @return {Object}
   */
  var eatToken = function (token) {
    return eatSpaceAndMove(cm, token);
  };

  /**
   * Resolves regular property notation.
   *
   * @param  {Object} token
   * @return {Object}
   */
  var resolveProperty = function (token) {
    context.push(token);
    return eatToken(token);
  };

  /**
   * Resolves square bracket notation.
   *
   * @param  {Object} token
   * @return {Object}
   */
  var resolveDynamicProperty = function (token) {
    var level = 1;
    var prev  = token;

    while (token && level > 0) {
      token = getPrevToken(cm, token);
      if (token.string === ']') {
        level++;
      } else if (token.string === '[') {
        level--;
      }
    }

    // Keep track of the open token to confirm the location in the bracket
    // resolution.
    var startToken = token;
    token = eatToken(token);

    // Resolve the contents of the brackets as a text string.
    var string = cm.doc.getRange({
      ch:   startToken.start,
      line: startToken.pos.line
    }, {
      ch:   prev.end,
      line: prev.pos.line
    });

    // Only kick into bracket notation mode when the preceding token is a
    // property, variable, string, etc. Only things you can't use it on are
    // `undefined` and `null` (and syntax, of course).
    if (token && canAccess(token)) {
      if (eatToken(prev).string === '[') {
        context.push(_.extend(token, invalidToken));
        return token;
      }

      var subContext = getPropertyPath(cm, eatToken(prev));
      var startPos   = eatToken(subContext[subContext.length - 1]).start;

      // Ensures that the only tokens being resolved can be done statically.
      if (startPos === startToken.start) {
        context.push(_.extend(prev, {
          start:  subContext[subContext.length - 1].start,
          end:    subContext[0].end,
          string: string,
          tokens: subContext,
          state:  prev.state,
          type:   'dynamic-property'
        }));
      } else {
        context.push(_.extend(token, invalidToken));
      }

      return token;
    }

    if (!token || token.type === null) {
      context.push({
        start:  startToken.start,
        end:    prev.end,
        string: string,
        state:  prev.state,
        type:   'array'
      });
    }

    return token;
  };

  /**
   * Resolves any other token types.
   *
   * @param  {Object} token
   * @return {Object}
   */
  var resolveOther = function (token) {
    context.push(token);
    return eatToken(token);
  };

  /**
   * Resolves the closing parenthesis to a possible function or context change.
   *
   * @param  {[type]} token [description]
   * @return {[type]}       [description]
   */
  var resolvePossibleFunction = function (token) {
    var level = 1;
    var prev  = token;

    // While still in parens *and not at the beginning of the editor*
    while (token && level > 0) {
      token = getPrevToken(cm, token);
      if (token.string === ')') {
        level++;
      } else if (token.string === '(') {
        level--;
      }
    }

    // No support for resolving across multiple lines.. yet.
    if (level > 0) {
      context.push(_.extend(token, invalidToken));
      return token;
    }

    token = eatToken(token);

    // Resolves as a function argument.
    if (token && canAccess(token)) {
      // If the previous token was a function (E.g. the closing paren) it must
      // be an immediately invoked property.
      if (prev.isFunction) {
        context.push(_.extend(prev, {
          type:       'immed',
          string:     null,
          isFunction: true
        }));
      }

      token.isFunction = true;
      return token;
    }

    // Set `token` to be the token inside the parens and start working from
    // that instead.
    if (!token || token.type === null) {
      var subContext = getPropertyPath(cm, eatToken(prev));

      // The context could be being invoked as a function.
      if (prev.isFunction && subContext.length) {
        subContext[0].isFunction = true;
      }

      // Ensure that the subcontext has correctly set the `new` flag.
      if (subContext.hasNew && subContext.length) {
        subContext[0].isFunction    = true;
        subContext[0].isConstructor = true;
      }

      context.push.apply(context, subContext);
      return false;
    }

    return eatToken(token);
  };

  while (token && (token.string === '.' || canAccess(token))) {
    // Skip over period notation.
    if (token.type === null && token.string === '.') {
      token = eatToken(token);
    }

    if (token.string === ']') {
      token = resolveDynamicProperty(token);
    } else if (token.string === ')') {
      token = resolvePossibleFunction(token);
    } else if (token.type === 'property') {
      token = resolveProperty(token);
    } else if (canAccess(token)) {
      token = resolveOther(token);
    } else {
      token = _.extend(token, invalidToken);
      context.push(token);
    }
  }

  // Using the new keyword doesn't actually require parens to invoke, so we need
  // to do a quick special case check here.
  if (token && token.type === 'keyword' && token.string === 'new') {
    context.hasNew = true;

    // Try to set the first function to be the constructor function.
    _.some(context, function (token) {
      if (!token.isFunction) { return; }

      // Remove the `hasNew` flag and set the function to be a constructor
      delete context.hasNew;
      return token.isConstructor = true;
    });
  }

  return context;
};

/**
 * Collects information about the current token context by traversing through
 * the CodeMirror editor. Currently it's pretty simplistic and only works over
 * a single line.
 *
 * @param  {CodeMirror} cm
 * @param  {Object}     token
 * @return {Array}
 */
var getPropertyContext = function (cm, token) {
  if (token.type !== 'property') {
    return [];
  }

  token = eatSpaceAndMove(cm, token);

  if (token.type !== null || token.string !== '.') {
    return [];
  }

  return getPropertyPath(cm, token);
};

/**
 * Gets the property context for completing a property by looping through each
 * of the context tokens. Provides some additional help by moving primitives to
 * their prototype objects so it can continue autocompletion.
 *
 * @param {CodeMirror} cm
 * @param {Object}     token
 * @param {Object}     options
 * @param {Function}   done
 */
var getPropertyObject = function (cm, token, options, done) {
  return tokenHelper.propertyLookup(
    cm, getPropertyContext(cm, token), options, done
  );
};

/**
 * Provides completion suggestions for a property.
 *
 * @param  {CodeMirror} cm
 * @param  {Object}     token
 * @param  {Object}     options
 * @param  {Function}   done
 */
var completeProperty = function (cm, token, options, done) {
  getPropertyObject(cm, token, options, function (err, context) {
    middleware.trigger('completion:property', _.extend({
      token:   token,
      editor:  cm,
      results: {}
    }, options, {
      context: context
    }), completeResults(done));
  });
};

/**
 * Provides completion suggestions for function arguments.
 *
 * @param  {CodeMirror} cm
 * @param  {Object}     token
 * @param  {Object}     context
 * @param  {Function}   done
 */
var completeArguments = function (cm, token, options, done) {
  var tokens = getPropertyPath(cm, eatSpaceAndMove(cm, token));

  tokenHelper.resolveTokens(cm, tokens, options, function (err, tokens) {
    if (err || !tokens.length) {
      return done(err);
    }

    var lastToken = tokens.shift();

    if (lastToken.type !== 'property' && lastToken.type !== 'variable') {
      return done();
    }

    tokenHelper.propertyLookup(cm, tokens, options, function (err, context) {
      if (err || !_.isFunction(context[lastToken.string])) {
        return done(err);
      }

      middleware.trigger('completion:arguments', _.extend({
        context: context[lastToken.string],
        editor:  cm
      }, options, {
        parent: context
      }), function (err, args) {
        // No arguments provided.
        if (!args.length) {
          return done();
        }

        // Sanitize the arguments for rendering as a result.
        return done(null, {
          results: [{
            display: 'Arguments',
            value:   args.join(', ') + ')',
            special: true
          }],
          context: context
        });
      });
    });
  });
};

/**
 * Trigger the completion module by passing in the current codemirror instance.
 *
 * @param  {CodeMirror} cm
 * @param  {Object}     options
 * @param  {Function}   done
 */
module.exports = function (cm, options, done) {
  var cur     = cm.getCursor();
  var token   = correctToken(cm, cur);
  var results = [];
  var type    = token.type;

  var cb = function (err, completion) {
    completion = completion || {};

    return done(err, {
      token:   token,
      context: completion.context,
      results: completion.results,
      to:      new Pos(cur.line, token.end),
      from:    new Pos(cur.line, token.start)
    });
  };

  if (type === null && token.string === '(') {
    return completeArguments(cm, token, options, cb);
  }

  if (type === 'keyword' || type === 'variable') {
    return completeVariable(cm, token, options, cb);
  }

  if (type === 'property') {
    return completeProperty(cm, token, options, cb);
  }

  return done();
};
