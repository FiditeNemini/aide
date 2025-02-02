/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { devtools } from 'vscode';
import { SidecarImageContent } from './types';

export async function getBrowserScreenshot(): Promise<SidecarImageContent> {
	const data = await devtools.getScreenshot();
	return {
		type: 'base64',
		media_type: 'image/jpeg',
		data: data ?? '',
	};
}
