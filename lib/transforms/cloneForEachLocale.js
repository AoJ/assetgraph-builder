var _ = require('underscore'),
    seq = require('seq'),
    passError = require('assetgraph/lib/util/passError'),
    query = require('assetgraph').query,
    i18nTools = require('../util/i18nTools');

module.exports = function (queryObj, localeIds) {
    return function cloneForEachLocale(assetGraph, cb) {
        seq(assetGraph.findAssets(_.extend({type: 'Html'}, queryObj)))
            .parEach(function (originalHtmlAsset) {
                var callback = this,
                    nonInlineJavaScriptsToCloneById = {};

                // First note which JavaScript assets need to be cloned for each locale:
                seq(assetGraph.findRelations({type: 'HtmlScript', from: originalHtmlAsset, to: {url: query.isDefined}, node: {id: query.not('oneBootstrapper')}}))
                    .parEach(function (htmlScript) {
                        htmlScript.to.getParseTree(this);
                    })
                    .parEach(function (htmlScript) {
                        var hasOneTr = false;
                        i18nTools.eachOneTrInAst(htmlScript.to.parseTree, function () {
                            nonInlineJavaScriptsToCloneById[htmlScript.to.id] = htmlScript.to;
                            return false;
                        });
                        this();
                    })
                    .set(localeIds)
                    .parEach(function (localeId) {
                        assetGraph.cloneAsset(originalHtmlAsset, this.into(localeId));
                    })
                    .parEach(function (localeId) {
                        var localizedHtml = this.vars[localeId];
                        assetGraph.setAssetUrl(localizedHtml, originalHtmlAsset.url.replace(/(?:\.html)?$/, '.' + localeId + '.html'));
                        localizedHtml.getParseTree(this);
                    })
                    .parEach(function (localeId) {
                        var callback2 = this,
                            localizedHtml = this.vars[localeId],
                            document = localizedHtml.parseTree;
                        document.documentElement.setAttribute('lang', localeId);
                        localizedHtml.markDirty();
                        i18nTools.extractAllReachableKeysForLocale(assetGraph, localeId, localizedHtml, passError(callback2, function (allKeys) {
                            seq(assetGraph.findRelations({type: 'HtmlScript', from: localizedHtml, node: {id: query.not('oneBootstrapper')}}))
                                .parMap(function (htmlScript) {
                                    if (htmlScript.to.id in nonInlineJavaScriptsToCloneById) {
                                        assetGraph.cloneAsset(htmlScript.to, [htmlScript], this);
                                    } else {
                                        this(null, htmlScript.to);
                                    }
                                })
                                .parEach(function (javaScript) {
                                    javaScript.getParseTree(this);
                                })
                                .parEach(function (javaScript) {
                                    i18nTools.eachOneTrInAst(javaScript.parseTree, i18nTools.createOneTrReplacer(allKeys, localeId));
                                    javaScript.markDirty();
                                    this();
                                })
                                .seq(function () {
                                    callback2();
                                })
                                ['catch'](callback2);
                        }));
                    })
                    .seq(function () {
                        // Remove the original Html and those of the cloned JavaScript assets that have become orphaned:
                        assetGraph.removeAsset(originalHtmlAsset);
                        _.values(nonInlineJavaScriptsToCloneById).forEach(function (javaScript) {
                            if (assetGraph.findRelations({to: javaScript}).length === 0) {
                                assetGraph.removeAsset(javaScript);
                            }
                        });
                        callback();
                    })
                    ['catch'](callback);
            })
            .seq(function () {
                cb();
            })
            ['catch'](cb);
    };
};
