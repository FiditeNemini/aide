/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

//@ts-check

'use strict';

const withDefaults = require('../shared.webpack.config');

const CopyWebpackPlugin = require('copy-webpack-plugin');


module.exports = withDefaults({
	context: __dirname,
	resolve: {
		fallback: {
			'request': require.resolve('node-fetch')
		}
	},
	plugins: [
		CopyWebpackPlugin({
			patterns: [
				{
					from: 'node_modules/web-tree-sitter/tree-sitter.wasm',
					to: '[name][ext]',
				}
			]
		})
	],
	externals: {
		bufferutil: 'commonjs bufferutil',
		'utf-8-validate': 'commonjs utf-8-validate',
	},
	entry: {
		extension: './src/extension.ts'
	}
});
