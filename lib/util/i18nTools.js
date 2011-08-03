var vm = require('vm'),
    _ = require('underscore'),
    seq = require('seq'),
    memoizer = require('memoizer'),
    passError = require('assetgraph/lib/util/passError'),
    uglify = require('uglify-js'),
    uglifyAst = require('assetgraph/lib/util/uglifyAst'),
    i18nTools = {};

// Helper for getting a prioritized list of relevant locale ids from a specific locale id.
// For instance, "en_US" produces ["en_US", "en"]
i18nTools.expandLocaleIdToPrioritizedList = memoizer(function (localeId) {
    var localeIds = [localeId];
    while (/_[^_]+$/.test(localeId)) {
        localeId = localeId.replace(/_[^_]+$/, '');
        localeIds.push(localeId);
    }
    return localeIds;
});

i18nTools.tokenizePattern = function (pattern) {
    var tokens = [];
    // Split pattern into tokens (return value of replace isn't used):
    pattern.replace(/\{(\d+)\}|((?:[^\\\{]|\\[\\\{])+)/g, function ($0, placeHolderNumberStr, text) {
        if (placeHolderNumberStr) {
            tokens.push({
                type: 'placeHolder',
                value: parseInt(placeHolderNumberStr, 10)
            });
        } else {
            tokens.push({
                type: 'text',
                value: text.replace(/\\([\{\}])/g, "$1")
            });
        }
    });
    return tokens;
};

i18nTools.patternToAst = function (pattern, placeHolderAsts) {
    var ast;
    i18nTools.tokenizePattern(pattern).forEach(function (token) {
        var term;
        if (token.type === 'placeHolder') {
            term = placeHolderAsts[token.value];
        } else {
            term = ['string', token.value];
        }
        if (ast) {
            ast = ['binary', '+', ast, term];
        } else {
            ast = term;
        }
    });
    return ast || ['string', ''];
};

i18nTools.eachOneTrInAst = function (ast, lambda) {
    var q = [ast];
    while (q.length) {
        var node = q.pop();
        if (node[0] === 'call' && Array.isArray(node[1]) && node[1][0] === 'call' &&
            Array.isArray(node[1][1]) && node[1][1][0] === 'dot' &&  Array.isArray(node[1][1][1]) &&
            node[1][1][1][0] === 'name' && node[1][1][1][1] === 'one' &&
            (node[1][1][2] === 'trPattern')) {

            if (lambda('callTrPattern', node[1][2][0][1], node, node[1][2][1]) === false) { // type, key, node, defaultValueAst
                return;
            }
        } else if (node[0] === 'call' && Array.isArray(node[1]) && node[1][0] === 'dot' &&
                   Array.isArray(node[1][1]) && node[1][1][0] === 'name' && node[1][1][1] === 'one' &&
                   (node[1][2] === 'tr' || node[1][2] === 'trPattern')) {

            if (node[2].length === 0 || !Array.isArray(node[2][0]) || node[2][0][0] !== 'string') {
                console.warn("Invalid one." + node[1][2] + " syntax: " + uglify.uglify.gen_code(node));
            }
            if (lambda(node[1][2], node[2][0][1], node, node[2][1]) === false) { // type, key, node, defaultValueAst
                return;
            }
        }
        for (var i = 0 ; i < node.length ; i += 1) {
            if (Array.isArray(node[i])) {
                q.push(node[i]);
            }
        }
    }
};

i18nTools.getBootstrappedContext = function (assetGraph, htmlAsset, cb) {
    var context = vm.createContext();
    context.window = context;
    context.__defineSetter__('document', function () {});
    context.__defineGetter__('document', function () {
        htmlAsset.markDirty();
        return htmlAsset.parseTree;
    });

    var bootstrapperRelations = assetGraph.findRelations({from: htmlAsset, node: {id: 'oneBootstrapper'}, to: {type: 'JavaScript'}});

    if (bootstrapperRelations.length === 0) {
        return process.nextTick(function () {
            cb(null, context);
        });
    } else if (bootstrapperRelations.length > 1) {
        return cb(new Error("i18nTools.getBootstrappedContext: Unexpected number of One bootstrapper relations found: " + bootstrapRelations.length));
    }

    bootstrapperRelations[0].to.getParseTree(passError(cb, function (parseTree) {
        try {
            new vm.Script(uglify.uglify.gen_code(parseTree), "bootstrap code for " + (htmlAsset.url || "inline")).runInContext(context);
        } catch (e) {
            return cb(e);
        }
        cb(null, context);
    }));
};

// initialAsset must be Html or JavaScript
i18nTools.extractAllReachableKeys = function (assetGraph, initialAssets, cb) {
    if (!_.isArray(initialAssets)) {
        initialAssets = [initialAssets];
    }
    var allKeys = {};
    seq(initialAssets)
        .seqEach(function (initialAsset) {
            var callback = this;
            seq(
                assetGraph.collectAssetsPostOrder(initialAsset, {type: ['HtmlScript', 'JavaScriptOneInclude']}).filter(function (asset) {
                    return asset.type === 'I18n';
                })
            )
                .parMap(function (i18nAsset) {
                    i18nAsset.getParseTree(this);
                })
                .parEach(function (parseTree) {
                    _.extend(allKeys, parseTree);
                    this();
                })
                .seq(function () {
                    callback();
                })
                ['catch'](callback);
        })
        .seq(function () {
            cb(null, allKeys);
        })
        ['catch'](cb);
};

// initialAsset must be Html or JavaScript
i18nTools.extractAllReachableKeysForLocale = function (assetGraph, localeId, initialAsset, cb) {
    i18nTools.extractAllReachableKeys(assetGraph, initialAsset, passError(cb, function (allKeys) {
        var prioritizedLocaleIds = i18nTools.expandLocaleIdToPrioritizedList(localeId),
            allKeysForLocale = {};
        _.keys(allKeys).forEach(function (key) {
            var found = false;
            for (var i = 0 ; i < prioritizedLocaleIds.length ; i += 1) {
                if (prioritizedLocaleIds[i] in allKeys[key]) {
                    allKeysForLocale[key] = allKeys[key][prioritizedLocaleIds[i]];
                    found = true;
                    break;
                }
            }
            if (!found) {
                console.warn("i18nTools.extractAllReachableKeysForLocale: Key " + key + " not found for " + localeId);
            }
        });
        cb(null, allKeysForLocale);
    }));
};

i18nTools.createOneTrReplacer = function (allKeys, localeId) { // localeId is optional and will only be used for warning messages
    return function oneTrReplacer(type, key, node, defaultValueAst) {
        var value = allKeys[key],
            valueAst;
        if (value === null || typeof value === 'undefined') {
            // FIXME: Assumes that the defaultValueAst is in English, perhaps that should be configurable.
            if (!localeId || !(/^en([\-_]|$)/.test(localeId) && defaultValueAst)) {
                console.warn('oneTrReplacer: Key ' + key + ' not found' + (localeId ? ' in ' + localeId : ''));
            }
            if (defaultValueAst) {
                valueAst = defaultValueAst;
            } else {
                valueAst = ['string', '[!' + key + '!]'];
            }
        } else {
            valueAst = uglifyAst.objToAst(value);
        }
        if (type === 'callTrPattern') {
            // Replace one.trPattern('keyName')(placeHolderValue, ...) with a string concatenation:
            if (!Array.isArray(valueAst) || valueAst[0] !== 'string') {
                console.warn("oneTrReplacer: Invalid one.trPattern syntax: " + value);
                return;
            }
            Array.prototype.splice.apply(node, [0, node.length].concat(i18nTools.patternToAst(valueAst[1], node[2])));
        } else if (type === 'tr') {
            Array.prototype.splice.apply(node, [0, node.length].concat(valueAst));
        } else if (type === 'trPattern') {
            if (!Array.isArray(valueAst) || valueAst[0] !== 'string') {
                console.warn("oneTrReplacer: Invalid one.trPattern syntax: " + value);
                return;
            }
            var highestPlaceHolderNumber;
            i18nTools.tokenizePattern(valueAst[1]).forEach(function (token) {
                if (token.type === 'placeHolder' && (!highestPlaceHolderNumber || token.value > highestPlaceHolderNumber)) {
                    highestPlaceHolderNumber = token.value;
                }
            });
            var argumentNames = [],
                placeHolderAsts = [];
            for (var j = 0 ; j <= highestPlaceHolderNumber ; j += 1) {
                placeHolderAsts.push(['name', 'a' + j]);
                argumentNames.push('a' + j);
            }
            var returnExpressionAst = i18nTools.patternToAst(valueAst[1], placeHolderAsts);
            node.splice(0, node.length, 'function', null, argumentNames, [['return', returnExpressionAst]]);
        }
    };
};

// Get a object: key => array of "occurrence" objects: {asset: ..., type: ..., node, ..., defaultValueAst: ...}
i18nTools.findOneTrOccurrences = function (assetGraph, initialAssets, cb) {
    var oneTrOccurrencesByKey = {};
    seq(initialAssets)
        .seqEach(function (htmlAsset) {
            var callback = this,
                javaScriptAssets = assetGraph.collectAssetsPostOrder(htmlAsset, {type: ['HtmlScript', 'JavaScriptOneInclude']}).filter(function (asset) {
                    return asset.type === 'JavaScript';
                });
            seq(javaScriptAssets)
                .parEach(function (javaScript) {
                    javaScript.getParseTree(this.into(javaScript.id));
                })
                .parEach(function (javaScript) {
                    var hasOneTr = false;
                    i18nTools.eachOneTrInAst(javaScript.parseTree, function (type, key, node, defaultValueAst) {
                        hasOneTr = true;
                        (oneTrOccurrencesByKey[key] = oneTrOccurrencesByKey[key] || []).push({
                            asset: javaScript,
                            type: type,
                            node: node,
                            defaultValueAst: defaultValueAst
                        });
                    });
                    this();
                })
                .seq(function () {
                    callback();
                })
                ['catch'](callback);
        })
        .seq(function () {
            cb(null, oneTrOccurrencesByKey);
        })
        ['catch'](cb);
};

i18nTools.getOrCreateI18nAssetForKey = function (assetGraph, key, oneTrOccurrencesByKey, cb) {
    seq(assetGraph.findAssets({type: 'I18n'}))
        .parEach(function (i18nAsset) {
            i18nAsset.getParseTree(this);
        })
        .seq(function () {
            var i18nAssets = this.stack,
                i18nAssetsWithTheKey = [];
            i18nAssets.forEach(function (i18nAsset) {
                if (key in i18nAsset.parseTree) {
                    i18nAssetsWithTheKey.push(i18nAsset);
                }
            });
            if (i18nAssetsWithTheKey.length > 1) {
                throw new Error("i18nTools.getOrCreateI18nAssetForKey: The key '" + key + "' was found in multiple I18n assets, cannot proceed");
            }
            if (i18nAssetsWithTheKey.length === 1) {
                return cb(null, i18nAssetsWithTheKey[0]);
            } else {
                // Key isn't present in any I18n asset, try to work out from the one.tr occurrences where to put it
                var addToI18nForJavaScriptAsset,
                    includingAssetsById = {};
                if (!(key in oneTrOccurrencesByKey)) {
                    return cb(new Error("i18nTools.getOrCreateI18nAssetForKey: The key '" + key + "' isn't used anywhere, cannot work out which .i18n file to add it to!"));
                }
                oneTrOccurrencesByKey[key].forEach(function (occurrence) {
                    includingAssetsById[occurrence.asset.id] = occurrence.asset;
                });
                var includingAssets = _.values(includingAssetsById);
                if (includingAssets.length === 0) {
                    return cb(new Error("i18nTools.getOrCreateI18nAssetForKey: The key '" + key + "' isn't found in any I18n asset and isn't used in any one.tr statements"));
                }
                if (includingAssets.length === 1) {
                    addToI18nForJavaScriptAsset = includingAssets[0];
                } else {
                    console.warn("i18nTools.getOrCreateI18nAssetForKey: The key '" + key + "' occurs in one.tr expressions in multiple JavaScript assets, arbitrarily choosing the last one seen");
                    addToI18nForJavaScriptAsset = includingAssets[includingAssets.length - 1];
                }
                var existingI18nRelations = assetGraph.findRelations({from: addToI18nForJavaScriptAsset, to: {type: 'I18n'}}),
                    i18nAsset;
                if (existingI18nRelations.length === 0) {
                    i18nAsset = new assetGraph.constructor.assets.I18n({
                        isDirty: true,
                        parseTree: {}
                    });
                    var relation = new assetGraph.constructor.relations.JavaScriptOneInclude({
                        from: addToI18nForJavaScriptAsset,
                        to: i18nAsset
                    });
                    i18nAsset.url = (addToI18nForJavaScriptAsset.url || this.getBaseAssetForRelation(relation)).replace(/(?:\.js|\.html)?$/, ".i18n");
                    console.warn("i18nTools.getOrCreateI18nAssetForKey: Creating new I18n asset: " + i18nAsset.url);
                    assetGraph.addAsset(i18nAsset);
                    assetGraph.addRelation(relation);
                } else {
                    if (existingI18nRelations.length > 1) {
                        console.warn("i18nTools.getOrCreateI18nAssetForKey: " + addToI18nForJavaScriptAsset + " has multiple I18n relations, choosing the first one");
                    }
                    i18nAsset = existingI18nRelations[0].to;
                }
                cb(null, i18nAsset);
            }
        });
};

_.extend(exports, i18nTools);
