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

function createLazyPlugin(moduleName, globalVar, opts = {}) {
  const chunkFile = opts.chunkFile || moduleName;
  const failSoft = opts.failSoft === true;
  const failSoftStub = opts.failSoftStub || "{}";
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
                s.src = base + '${chunkFile}.min.js';
                s.onload = function() { ok(window.${globalVar} || {}); };
                s.onerror = function() {
                  ${failSoft
                    ? `var stub = ${failSoftStub};
                  window.${globalVar} = stub;
                  ok(stub);`
                    : `fail(new Error('Load failed: ${moduleName}'));`}
                };
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

const lazyHeatmapPlugin      = createLazyPlugin("heatmap",       "__grHeatmap");
const lazySurveyPlugin        = createLazyPlugin("survey",        "__grSurvey");
const lazySurveyWidgetPlugin  = createLazyPlugin("survey-widget", "__grSurveyWidget");
const lazyPanelsPlugin        = createLazyPlugin("panels",        "__grPanels");
const lazyGoalsPlugin         = createLazyPlugin("goals",         "__grGoals");
// Public chunk name avoids ad-block lists that match "audience" in script URLs.
const lazyAudiencePlugin      = createLazyPlugin("audience", "__grAudience", {
  chunkFile: "gr-attrs",
  failSoft: true,
  failSoftStub: "{ setupAudience: function() { return { cleanup: function(){}, urlScan: function(){} }; } }",
});
const lazyFormTrackerPlugin   = createLazyPlugin("form-tracker",  "__grFormTracker");

const corePlugins = [
  lazyHeatmapPlugin,
  lazySurveyPlugin,
  lazySurveyWidgetPlugin,
  lazyPanelsPlugin,
  lazyGoalsPlugin,
  lazyAudiencePlugin,
  lazyFormTrackerPlugin,
];

const sharedOptions = {
  entryPoints: ["src/index.ts"],
  bundle: true,
  platform: "browser",
  target: "es2022",
  treeShaking: true,
};

const minifyOptions = {
  minify: true,
  minifyWhitespace: true,
  minifyIdentifiers: true,
  minifySyntax: true,
  legalComments: "none",
  drop: ["debugger"],
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
    plugins: [...corePlugins, umdWrapper],
  });

  const minResult = await esbuild.build({
    ...sharedOptions,
    ...minifyOptions,
    format: "iife",
    globalName: "GrowthRoadmapsSDK",
    outfile: "dist/growth.min.js",
    plugins: [...corePlugins, umdWrapper],
    metafile: true,
  });

  console.log("\n--- Core Bundle Analysis ---");
  console.log(await esbuild.analyzeMetafile(minResult.metafile));

  // --- Lazy chunk builds ---

  await esbuild.build({
    entryPoints: ["src/panels.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "__grPanels",
    ...minifyOptions,
    outfile: "dist/panels.min.js",
  });

  await esbuild.build({
    entryPoints: ["src/goals.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "__grGoals",
    ...minifyOptions,
    outfile: "dist/goals.min.js",
  });

  await esbuild.build({
    entryPoints: ["src/audience.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "__grAudience",
    ...minifyOptions,
    outfile: "dist/gr-attrs.min.js",
  });

  await esbuild.build({
    entryPoints: ["src/form-tracker.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "__grFormTracker",
    ...minifyOptions,
    outfile: "dist/form-tracker.min.js",
  });

  await esbuild.build({
    entryPoints: ["src/heatmap.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "__grHeatmap",
    ...minifyOptions,
    outfile: "dist/heatmap.min.js",
  });

  await esbuild.build({
    entryPoints: ["src/survey.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    globalName: "__grSurvey",
    ...minifyOptions,
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
    ...minifyOptions,
    outfile: "dist/survey-widget.min.js",
  });

  execSync("npx tsc --emitDeclarationOnly", { stdio: "inherit" });

  await esbuild.build({
    entryPoints: ["src/loader.ts"],
    bundle: true,
    platform: "browser",
    target: "es2022",
    format: "iife",
    ...minifyOptions,
    outfile: "dist/growth-loader.min.js",
    metafile: true,
  });

  // --- Size report ---
  const raw = fs.statSync("dist/growth.min.js").size;
  const gz = Number(execSync(`gzip -9 < dist/growth.min.js | wc -c`).toString().trim());
  const sizeKB = (raw / 1024).toFixed(2);
  const gzKB   = (gz  / 1024).toFixed(2);

  const loaderFile = fs.statSync("dist/growth-loader.min.js");
  const loaderSizeKB = (loaderFile.size / 1024).toFixed(2);
  const surveyFile = fs.statSync("dist/survey.min.js");
  const surveySizeKB = (surveyFile.size / 1024).toFixed(2);
  const surveyWidgetFile = fs.statSync("dist/survey-widget.min.js");
  const surveyWidgetSizeKB = (surveyWidgetFile.size / 1024).toFixed(2);
  const heatmapFile = fs.statSync("dist/heatmap.min.js");
  const heatmapSizeKB = (heatmapFile.size / 1024).toFixed(2);
  const panelsFile = fs.statSync("dist/panels.min.js");
  const panelsSizeKB = (panelsFile.size / 1024).toFixed(2);
  const goalsFile = fs.statSync("dist/goals.min.js");
  const goalsSizeKB = (goalsFile.size / 1024).toFixed(2);
  const audFile = fs.statSync("dist/gr-attrs.min.js");
  const audSizeKB = (audFile.size / 1024).toFixed(2);
  const ftFile = fs.statSync("dist/form-tracker.min.js");
  const ftSizeKB = (ftFile.size / 1024).toFixed(2);

  console.log("\nBuild complete!");
  console.log("  dist/growth.min.js       " + sizeKB + " KB raw / " + gzKB + " KB gzip — core bundle");
  console.log("  dist/growth-loader.min.js " + loaderSizeKB + " KB");
  console.log("  dist/panels.min.js       " + panelsSizeKB + " KB — lazy chunk");
  console.log("  dist/goals.min.js        " + goalsSizeKB + " KB — lazy chunk");
  console.log("  dist/gr-attrs.min.js     " + audSizeKB + " KB — lazy chunk (audience attrs)");
  console.log("  dist/form-tracker.min.js " + ftSizeKB + " KB — lazy chunk");
  console.log("  dist/heatmap.min.js      " + heatmapSizeKB + " KB — lazy chunk");
  console.log("  dist/survey.min.js       " + surveySizeKB + " KB — lazy chunk");
  console.log("  dist/survey-widget.min.js " + surveyWidgetSizeKB + " KB — lazy chunk");
  console.log("  dist/growth.esm.js");
  console.log("  dist/growth.umd.js");
  console.log("  dist/index.d.ts");

  // Gzip budget: core bundle (growth.min.js) must stay under 11 KB.
  // Baseline: ~70 KB raw / 20,924 bytes gzip. Current: ~34 KB raw / ~10.2 KB gzip.
  const GZ_BUDGET = 11264;
  if (gz > GZ_BUDGET) {
    console.error(
      "\nERROR: Core bundle gzipped size is " + gz + " bytes (" + gzKB + " KB) — exceeds " + GZ_BUDGET + " byte budget!"
    );
    process.exit(1);
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
