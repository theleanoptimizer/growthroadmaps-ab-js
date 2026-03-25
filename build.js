const esbuild = require("esbuild");
const { execSync } = require("child_process");
const fs = require("fs");

const umdWrapper = {
  name: "umd-wrapper",
  setup(build) {
    build.onEnd((result) => {
      if (result.errors.length > 0) return;
      const outfile = build.initialOptions.outfile;
      const globalName = build.initialOptions.globalName || "ABTestingSDK";
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

async function build() {
  await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "esm",
    target: "es2017",
    outfile: "dist/ab-testing.esm.js",
  });

  await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "iife",
    globalName: "ABTestingSDK",
    target: "es2017",
    outfile: "dist/ab-testing.umd.js",
    plugins: [umdWrapper],
  });

  await esbuild.build({
    entryPoints: ["src/index.ts"],
    bundle: true,
    format: "iife",
    globalName: "ABTestingSDK",
    target: "es2017",
    minify: true,
    outfile: "dist/ab-testing.min.js",
    plugins: [umdWrapper],
  });

  execSync("npx tsc --emitDeclarationOnly", { stdio: "inherit" });

  const minified = fs.statSync("dist/ab-testing.min.js");
  const sizeKB = (minified.size / 1024).toFixed(2);
  console.log("\nBuild complete!");
  console.log("  dist/ab-testing.esm.js");
  console.log("  dist/ab-testing.umd.js");
  console.log("  dist/ab-testing.min.js (" + sizeKB + " KB)");
  console.log("  dist/index.d.ts");

  if (minified.size > 8192) {
    console.error(
      "\nWARNING: Minified bundle is " + sizeKB + " KB (exceeds 8 KB limit)",
    );
    process.exit(0);
  }
}

build().catch((err) => {
  console.error(err);
  process.exit(1);
});
