'use strict';

const path = require('path');

/** @type {import('webpack').Configuration[]} */
module.exports = [
  // --- Extension Host Bundle (Node.js) ---
  {
    name: 'extension',
    target: 'node',
    mode: 'none',
    entry: './src/extension.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'extension.js',
      libraryTarget: 'commonjs2',
      devtoolModuleFilenameTemplate: '../[resource-path]'
    },
    externals: {
      vscode: 'commonjs vscode'  // injected at runtime by VSCode
    },
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader' }]
        }
      ]
    },
    devtool: 'nosources-source-map',
    infrastructureLogging: { level: 'log' }
  },

  // --- Webview Bundle (Browser sandbox) ---
  {
    name: 'webview',
    target: 'web',
    mode: 'none',
    entry: './src/webview/main.ts',
    output: {
      path: path.resolve(__dirname, 'dist'),
      filename: 'webview.js'
    },
    resolve: {
      extensions: ['.ts', '.js']
    },
    module: {
      rules: [
        {
          test: /\.ts$/,
          exclude: /node_modules/,
          use: [{ loader: 'ts-loader' }]
        }
      ]
    },
    devtool: 'nosources-source-map'
  }
];
