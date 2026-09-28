//@ts-check

'use strict';

const path = require('path');
const CopyPlugin = require('copy-webpack-plugin');
const wasmLanguages = ['python', 'javascript', 'typescript', 'tsx', 'go', 'ruby', 'java', 'php', 'cpp'];

// The upstream snapshot stores text BPE ranks; its runtime loader expects
// length-prefixed binary ranks in ascending token-ID order.
function compressTikToken(source) {
  const lines = source.toString('utf8').trimEnd().split(/\r?\n/);
  const chunks = [];
  for (let rank = 0; rank < lines.length; rank++) {
    const separator = lines[rank].lastIndexOf(' ');
    const sourceRank = Number(lines[rank].slice(separator + 1));
    if (separator < 0 || sourceRank !== rank) throw new Error(`Invalid tokenizer rank ${rank}`);
    const token = Buffer.from(lines[rank].slice(0, separator), 'base64');
    const prefix = [];
    let length = token.length;
    do {
      let byte = length & 0x7f;
      length >>>= 7;
      if (length) byte |= 0x80;
      prefix.push(byte);
    } while (length);
    chunks.push(Buffer.from(prefix), token);
  }
  return Buffer.concat(chunks);
}

//@ts-check
/** @typedef {import('webpack').Configuration} WebpackConfig **/

/** @type WebpackConfig */
const extensionConfig = {
  plugins: [
    new CopyPlugin({
      patterns: [
        { from: 'node_modules/web-tree-sitter/tree-sitter.wasm', to: 'wasm/tree-sitter.wasm' },
        // The bundled Copilot parser resolves WASM files beside native-core.js.
        // Localalot's parser uses the wasm/ subdirectory, so include both paths.
        { from: 'node_modules/web-tree-sitter/tree-sitter.wasm', to: 'tree-sitter.wasm' },
        { from: 'resources/tokenizer/o200k_base.tiktoken', to: 'tokenizer/o200k_base.tiktoken' },
        { from: 'resources/tokenizer/LICENSE.txt', to: 'tokenizer/LICENSE.txt' },
        { from: 'vendor/copilot/src/platform/tokenizer/node/cl100k_base.tiktoken', to: 'cl100k_base.tiktoken', transform: compressTikToken },
        { from: 'vendor/copilot/src/platform/tokenizer/node/o200k_base.tiktoken', to: 'o200k_base.tiktoken', transform: compressTikToken },
        ...wasmLanguages.map(language => ({
          from: `node_modules/tree-sitter-wasms/out/tree-sitter-${language}.wasm`,
          to: `wasm/tree-sitter-${language}.wasm`,
        })),
        ...wasmLanguages.map(language => ({
          from: `node_modules/tree-sitter-wasms/out/tree-sitter-${language}.wasm`,
          to: `tree-sitter-${language}.wasm`,
        })),
        { from: 'node_modules/tree-sitter-wasms/out/tree-sitter-c_sharp.wasm', to: 'wasm/tree-sitter-c-sharp.wasm' },
        { from: 'node_modules/tree-sitter-wasms/out/tree-sitter-c_sharp.wasm', to: 'tree-sitter-c-sharp.wasm' },
      ],
    }),
  ],
  target: 'node', // VS Code extensions run in a Node.js-context 📖 -> https://webpack.js.org/configuration/node/
	mode: 'none', // this leaves the source code as close as possible to the original (when packaging we set this to 'production')

  entry: './src/extension.ts', // the entry point of this extension, 📖 -> https://webpack.js.org/configuration/entry-context/
  output: {
    // the bundle is stored in the 'dist' folder (check package.json), 📖 -> https://webpack.js.org/configuration/output/
    path: path.resolve(__dirname, 'dist'),
    filename: 'extension.js',
    libraryTarget: 'commonjs2'
  },
  externals: {
    vscode: 'commonjs vscode' // the vscode-module is created on-the-fly and must be excluded. Add other modules that cannot be webpack'ed, 📖 -> https://webpack.js.org/configuration/externals/
    // modules added here also need to be added in the .vscodeignore file
  },
  resolve: {
    // support reading TypeScript and JavaScript files, 📖 -> https://github.com/TypeStrong/ts-loader
    extensions: ['.ts', '.js']
  },
  
  module: {
    rules: [
      {
        test: /\.ts$/,
        exclude: [/node_modules/, /docs[\\/]copilot/],
        use: [
          {
            loader: 'ts-loader'
          }
        ]
      }
    ]
  },
  devtool: 'nosources-source-map',
  infrastructureLogging: {
    level: "log", // enables logging required for problem matchers
  },
};
module.exports = [ extensionConfig ];
