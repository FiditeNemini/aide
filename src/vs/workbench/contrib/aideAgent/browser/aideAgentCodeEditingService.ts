/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter } from '../../../../base/common/event.js';
import { Disposable, DisposableMap } from '../../../../base/common/lifecycle.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { IAideAgentCodeEditingService, IAideAgentCodeEditingSession } from '../common/aideAgentCodeEditingService.js';
import { AideAgentCodeEditingSession } from './aideAgentCodeEditingSession.js';

export class AideAgentCodeEditingService extends Disposable implements IAideAgentCodeEditingService {
	_serviceBrand: undefined;

	private readonly _onDidComplete = this._register(new Emitter<void>());
	readonly onDidComplete = this._onDidComplete.event;

	private _editingSessions = new DisposableMap<string, IAideAgentCodeEditingSession>();

	constructor(
		@IInstantiationService private readonly instantiationService: IInstantiationService
	) {
		super();
	}

	getOrStartCodeEditingSession(sessionId: string): IAideAgentCodeEditingSession {
		if (this._editingSessions.get(sessionId)) {
			return this._editingSessions.get(sessionId)!;
		}

		const editingSession = this.instantiationService.createInstance(AideAgentCodeEditingSession, sessionId);
		this._register(editingSession.onDidComplete(() => {
			editingSession.dispose();
			this._editingSessions.deleteAndDispose(sessionId);
			this._onDidComplete.fire();
		}));

		this._editingSessions.set(sessionId, editingSession);
		return editingSession;
	}

	getExistingCodeEditingSession(sessionId: string): IAideAgentCodeEditingSession | undefined {
		return this._editingSessions.get(sessionId);
	}
}
