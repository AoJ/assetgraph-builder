var urlTools = require('assetgraph/lib/util/urlTools');

module.exports = function (options) {
    options = options || {};
    return function buildDevelopment(assetGraph, cb) {
        var query = assetGraph.query;
        assetGraph
            .moveAssets({isInitial: true}, function (asset) {return asset.url.replace(/\.template$/, "");})
            .if(options.version)
                .addContentVersionMetaElement({type: 'Html', isInitial: true}, options.version)
            .endif()
            .populate({
                followRelations: {
                    type: ['HtmlScript', 'HtmlRequireJsMain', 'JavaScriptAmdRequire', 'JavaScriptAmdDefine', 'JavaScriptInclude', 'JavaScriptExtJsRequire'],
                    to: {url: assetGraph.query.not(/^https?:/)}
                }
            })
            .injectBootstrapper({isInitial: true}, {
                defaultLocaleId: options.defaultLocaleId,
                supportedLocaleIds: options.supportedLocaleIds,
                localeCookieName: options.localeCookieName
            })
            .flattenStaticIncludes({isInitial: true})
            .removeAssets({isLoaded: true, isEmpty: true, type: 'JavaScript'})
            .inlineRelations({type: 'HtmlStyle', from: {isInitial: true, type: 'Html'}, to: {fixedUpExtJS: true}})
            .if(options.cssImports)
                .convertHtmlStylesToInlineCssImports()
            .endif()
            .inlineRelations({type: 'HtmlScript', from: {isInitial: true, type: 'Html'}, to: {fixedUpExtJS: true}})
            .prettyPrintAssets({type: 'JavaScript', incoming: {type: 'HtmlScript', from: {isInitial: true, type: 'Html'}}})
            .prettyPrintAssets({type: 'Css', incoming: {type: 'HtmlStyle', from: {isInitial: true, type: 'Html'}}})
            .runJavaScriptConditionalBlocks({type: 'Html'}, 'BUILDDEVELOPMENT')
            .if(options.inlineUrlWildCard)
                .inlineRelations({to: {url: urlTools.makeFileUrlMatcher(options.inlineUrlWildCard)}})
            .endif()
            .run(cb);
    };
};
