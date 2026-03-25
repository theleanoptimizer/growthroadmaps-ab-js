const esbuild = require("esbuild");
const { execSync } = require("child_process");
const fs = require("fs");

const umdWrapper = {
  name: "umd-wrapper",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const outfile = build.initialOptions.outfile;
      const globalName = build.initialOptions.globalName || "GrowthRoadmapsSDK";
      const code = fs.readFileSync(outfile, "utf8");
      const umd = `(function(root, factory) {
  if (typeof define === 'function' && define.amd) {
    define([], factory);
  } else if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.${globalName} = factory();
  }
})(typeof self !== 'undefined' ? self : this, function() {
${code}
return ${globalName};
});`;
      fs.writeFileSync(outfile, umd);
    });
  },
};

function createLazyPlugin(moduleName, globalVar) {
  return {
    name: "lazy-" + moduleName,
    setup(build) {
      build.onResolve({ filter: new RegExp("^\\.\\/"+moduleName+"$") }, () => {
        return { path: moduleName, namespace: "lazy-mod" };
      });
      build.onLoad({ filter: new RegExp("^"+moduleName+"$"), namespace: "lazy-mod" }, () => {
        return {
          contents: `
            export function __lazyLoad() {
              if (typeof window.${globalVar} !== 'undefined') return Promise.resolve(window.${globalVar});
              if (!window.__grLazy) window.__grLazy = {};
              if (window.__grLazy['${moduleName}']) return window.__grLazy['${moduleName}'];
              window.__grLazy['${moduleName}'] = new Promise(function(ok, fail) {
                var s = document.createElement('script');
                var base = '';
                try {
                  var scripts = document.querySelectorAll('script[src*="growth"]');
                  if (scripts.length) base = scripts[scripts.length-1].src.replace(/[^/]*$/, '');
                  else base = 'https://js.growthroadmaps.com/';
                } catch(e) { base = 'https://js.growthroadmaps.com/'; }
                s.src = base + '${moduleName}.min.js';
                s.onload = function() { ok(window.${globalVar} || {}); };
                s.onerror = function() { fail(new Error('Load failed: ${moduleName}')); };
                document.head.appendChild(s);
              });
              return window.__grLazy['${moduleName}'];
            }
          `,
          loader: "js",
        };
      });
    },
  };
}
const lazyHeatmapPlugin = createLazyPlugin("heatmap", "__grHeatmap");
const lazySurveyPlugin = createLazyPlugin("survey", "__grSurvey");
const lazySurveyWidgetPlugin = createLazyPlugin("survey-widget", "__grSurveyWidget");

const sharedOptions = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  treeShaking: true,
};

async function build() {
  await esbuild.build({
    ...sharedOptions,
    format: "esm",
    outfile: "dist/growth.esm.js",
  });

  await esbuild.build({
    ...sharedOptions,
    format: "iife",
    globalName: "GrowthRoadmapsSDK",
    outfile: "dist/growth.umd.js",
    plugins: [lazyHeatmapPlugin, lazySurveyPlugin, lazySurveyWidgetPlugin, umdWrapper],
  });

  const minResult = await esbuild.build({
    ...sharedOptions,
    format: "iife",
    globalName: "GrowthRoadmapsSDK",
    minify: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    legalComments: "none",
    drop: ["debugger"],
    outfile: "dist/growth.min.js",
    plugins: [lazyHeatmapPlugin, lazySurveyPlugin, lazySurveyWidgetPlugin, umdWrapper],
    metafile: true,
  });

  console.log("\n--- Core Bundle Analysis ---");
  console.log(await esbuild.analyzeMetafile(minResult.metafile));

  await esbuild.build({
    entryPoints: ["src/heatmap.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "__grHeatmap",
    minify: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    legalComments: "none",
    outfile: "dist/heatmap.min.js",
  });

  await esbuild.build({
    entryPoints: ["src/survey.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "__grSurvey",
    minify: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    legalComments: "none",
    outfile: "dist/survey.min.js",
    plugins: [lazySurveyWidgetPlugin],
  });

  await esbuild.build({
    entryPoints: ["src/survey-widget-iife.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "__grSurveyWidget",
    minify: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    legalComments: "none",
    outfile: "dist/survey-widget.min.js",
  });

  execSync("npx tsc --emitDeclarationOnly", { stdio: "inherit" });

  await esbuild.build({
    entryPoints: ["src/loader.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    minify: true,
    minifyWhitespace: true,
    minifyIdentifiers: true,
    minifySyntax: true,
    legalComments: "none",
    drop: ["debugger"],
    outfile: "dist/growth-loader.min.js",
    metafile: true,
  });

  const minified = fs.statSync("dist/growth.min.js");
  const sizeKB = (minified.size / 1024).toFixed(2);
  const loaderFile = fs.statSync("dist/growth-loader.min.js");
  const loaderSizeKB = (loaderFile.size / 1024).toFixed(2);
  const surveyFile = fs.statSync("dist/survey.min.js");
  const surveySizeKB = (surveyFile.size / 1024).toFixed(2);
  const surveyWidgetFile = fs.statSync("dist/survey-widget.min.js");
  const surveyWidgetSizeKB = (surveyWidgetFile.size / 1024).toFixed(2);
  console.log("\nBuild complete!");
  console.log("  dist/growth.esm.js");
  console.log("  dist/growth.umd.js");
  const heatmapFile = fs.statSync("dist/heatmap.min.js");
  const heatmapSizeKB = (heatmapFile.size / 1024).toFixed(2);
  console.log("  dist/growth.min.js (" + sizeKB + " KB) — core bundle");
  console.log("  dist/growth-loader.min.js (" + loaderSizeKB + " KB)");
  console.log("  dist/heatmap.min.js (" + heatmapSizeKB + " KB) — lazy loaded");
  console.log("  dist/survey.min.js (" + surveySizeKB + " KB) — lazy loaded");
  console.log("  dist/survey-widget.min.js (" + surveyWidgetSizeKB + " KB) — lazy loaded");
  console.log("  dist/index.d.ts");

  if (minified.size > 16384) {
    console.error(
      "\nWARNING: Minified core bundle is " + sizeKB + " KB (exceeds 16 KB limit)",
    );
    process.exit(0);
  }

  if (loaderFile.size > 2048) {
    console.error(
      "\nWARNING: Loader is " + loaderSizeKB + " KB (exceeds 2 KB limit)",
    );
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
