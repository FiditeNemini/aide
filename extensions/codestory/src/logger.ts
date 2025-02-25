/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
import { window } from 'vscode';
import { createLogger } from 'winston';
import { LogOutputChannelTransport } from 'winston-transport-vscode';

const outputChannel = window.createOutputChannel('CodeStory', {
	log: true,
});

const logger = createLogger({
	level: 'trace',
	levels: LogOutputChannelTransport.config.levels,
	format: LogOutputChannelTransport.format(),
	transports: [new LogOutputChannelTransport({ outputChannel })],
});

export default logger;
