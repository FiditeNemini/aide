/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Emitter, Event } from '../../../../base/common/event.js';
import { hash } from '../../../../base/common/hash.js';
import { IMarkdownString } from '../../../../base/common/htmlContent.js';
import { Disposable } from '../../../../base/common/lifecycle.js';
import * as marked from '../../../../base/common/marked/marked.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { URI } from '../../../../base/common/uri.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { getFullyQualifiedId, IAideAgentAgentNameService, IChatAgentCommand, IChatAgentData, IChatAgentResult } from './aideAgentAgents.js';
import { ChatModelInitState, IChatModel, IChatProgressRenderableResponseContent, IChatRequestModel, IChatRequestVariableEntry, IChatResponseModel, IChatTextEditGroup, IResponse } from './aideAgentModel.js';
import { IParsedChatRequest } from './aideAgentParserTypes.js';
import { ChatAgentVoteDirection, ChatAgentVoteDownReason, IChatCodeCitation, IChatContentReference, IChatFollowup, IChatProgressMessage, IChatResponseErrorDetails, IChatTask, IChatUsedContext } from './aideAgentService.js';
import { countWords } from './aideAgentWordCounter.js';
import { annotateVulnerabilitiesInText } from './annotations.js';
import { CodeBlockModelCollection } from './codeBlockModelCollection.js';

export function isRequestVM(item: unknown): item is IChatRequestViewModel {
	return !!item && typeof item === 'object' && 'message' in item;
}

export function isResponseVM(item: unknown): item is IChatResponseViewModel {
	return !!item && typeof (item as IChatResponseViewModel).setVote !== 'undefined';
}

export type IChatViewModelChangeEvent = IChatAddRequestEvent | IChangePlaceholderEvent | IChatSessionInitEvent | IChatSetHiddenEvent | null;

export interface IChatAddRequestEvent {
	kind: 'addRequest';
}

export interface IChangePlaceholderEvent {
	kind: 'changePlaceholder';
}

export interface IChatSessionInitEvent {
	kind: 'initialize';
}

export interface IChatSetHiddenEvent {
	kind: 'setHidden';
}

export interface IChatViewModel {
	readonly model: IChatModel;
	readonly initState: ChatModelInitState;
	readonly sessionId: string;
	readonly onDidDisposeModel: Event<void>;
	readonly onDidChange: Event<IChatViewModelChangeEvent>;
	readonly requestInProgress: boolean;
	readonly inputPlaceholder?: string;
	getItems(): (IChatRequestViewModel | IChatResponseViewModel)[];
	setInputPlaceholder(text: string): void;
	resetInputPlaceholder(): void;
}

export interface IChatRequestViewModel {
	readonly id: string;
	readonly sessionId: string;
	/** This ID updates every time the underlying data changes */
	readonly dataId: string;
	readonly username: string;
	readonly avatarIcon?: URI | ThemeIcon;
	readonly message: IParsedChatRequest | IChatFollowup;
	readonly messageText: string;
	readonly attempt: number;
	readonly variables: IChatRequestVariableEntry[];
	currentRenderedHeight: number | undefined;
	readonly contentReferences?: ReadonlyArray<IChatContentReference>;
	readonly confirmation?: string;
	readonly shouldBeRemovedOnSend: boolean;
	readonly isComplete: boolean;
}

export interface IChatResponseMarkdownRenderData {
	renderedWordCount: number;
	lastRenderTime: number;
	isFullyRendered: boolean;
	originalMarkdown: IMarkdownString;
}

export interface IChatResponseMarkdownRenderData2 {
	renderedWordCount: number;
	lastRenderTime: number;
	isFullyRendered: boolean;
	originalMarkdown: IMarkdownString;
}

export interface IChatProgressMessageRenderData {
	progressMessage: IChatProgressMessage;

	/**
	 * Indicates whether this is part of a group of progress messages that are at the end of the response.
	 * (Not whether this particular item is the very last one in the response).
	 * Need to re-render and add to partsToRender when this changes.
	 */
	isAtEndOfResponse: boolean;

	/**
	 * Whether this progress message the very last item in the response.
	 * Need to re-render to update spinner vs check when this changes.
	 */
	isLast: boolean;
}

export interface IChatTaskRenderData {
	task: IChatTask;
	isSettled: boolean;
	progressLength: number;
}

export interface IChatResponseRenderData {
	renderedParts: IChatRendererContent[];

	renderedWordCount: number;
	lastRenderTime: number;
}

/**
 * Content type for references used during rendering, not in the model
 */
export interface IChatReferences {
	references: ReadonlyArray<IChatContentReference>;
	kind: 'references';
}

/**
 * Content type for citations used during rendering, not in the model
 */
export interface IChatCodeCitations {
	citations: ReadonlyArray<IChatCodeCitation>;
	kind: 'codeCitations';
}

/**
 * Type for content parts rendered by IChatListRenderer
 */
export type IChatRendererContent = IChatProgressRenderableResponseContent | IChatReferences | IChatCodeCitations;

export interface IChatLiveUpdateData {
	firstWordTime: number;
	lastUpdateTime: number;
	impliedWordLoadRate: number;
	lastWordCount: number;
}

export interface IChatResponseViewModel {
	readonly model: IChatResponseModel;
	readonly id: string;
	readonly sessionId: string;
	/** This ID updates every time the underlying data changes */
	readonly dataId: string;
	/** The ID of the associated IChatRequestViewModel */
	// readonly requestId: string;
	readonly username: string;
	readonly avatarIcon?: URI | ThemeIcon;
	readonly agent?: IChatAgentData;
	readonly slashCommand?: IChatAgentCommand;
	readonly agentOrSlashCommandDetected: boolean;
	readonly response: IResponse;
	readonly usedContext: IChatUsedContext | undefined;
	readonly contentReferences: ReadonlyArray<IChatContentReference>;
	readonly codeCitations: ReadonlyArray<IChatCodeCitation>;
	readonly progressMessages: ReadonlyArray<IChatProgressMessage>;
	readonly isComplete: boolean;
	readonly isCanceled: boolean;
	readonly isStale: boolean;
	isFirst: boolean;
	isLast: boolean;
	readonly vote: ChatAgentVoteDirection | undefined;
	readonly voteDownReason: ChatAgentVoteDownReason | undefined;
	readonly replyFollowups?: IChatFollowup[];
	readonly errorDetails?: IChatResponseErrorDetails;
	readonly result?: IChatAgentResult;
	readonly contentUpdateTimings?: IChatLiveUpdateData;
	readonly shouldBeRemovedOnSend: boolean;
	renderData?: IChatResponseRenderData;
	currentRenderedHeight: number | undefined;
	setVote(vote: ChatAgentVoteDirection): void;
	setVoteDownReason(reason: ChatAgentVoteDownReason | undefined): void;
	usedReferencesExpanded?: boolean;
	vulnerabilitiesListExpanded: boolean;
	setEditApplied(edit: IChatTextEditGroup, editCount: number): void;
}

export class ChatViewModel extends Disposable implements IChatViewModel {

	private readonly _onDidDisposeModel = this._register(new Emitter<void>());
	readonly onDidDisposeModel = this._onDidDisposeModel.event;

	private readonly _onDidChange = this._register(new Emitter<IChatViewModelChangeEvent>());
	readonly onDidChange = this._onDidChange.event;

	private _items: (ChatRequestViewModel | ChatResponseViewModel)[] = [];

	private removeItem(index: number) {
		if (index >= 0) {
			const items = this._items.splice(index, 1);
			const item = items[0];
			if (item instanceof ChatResponseViewModel) {
				item.dispose();
			}
		}
	}

	private addItem(item: ChatRequestViewModel | ChatResponseViewModel) {
		// Clear the old last response no matter what we append
		for (let i = this._items.length - 1; i >= 0; i--) {
			const item = this._items[i];
			if (isResponseVM(item) && item.isLast) {
				item.isLast = false;
				break;
			}
		}
		this._items.push(item);

		// Set isFirst for response items based on previous item
		if (isResponseVM(item)) {
			// Get the second-last item
			const previousItem = this._items[this._items.length - 2];
			item.isFirst = !!previousItem && isRequestVM(previousItem);
		}
	}

	private _inputPlaceholder: string | undefined = undefined;
	get inputPlaceholder(): string | undefined {
		return this._inputPlaceholder;
	}

	get model(): IChatModel {
		return this._model;
	}

	setInputPlaceholder(text: string): void {
		this._inputPlaceholder = text;
		this._onDidChange.fire({ kind: 'changePlaceholder' });
	}

	resetInputPlaceholder(): void {
		this._inputPlaceholder = undefined;
		this._onDidChange.fire({ kind: 'changePlaceholder' });
	}

	get sessionId() {
		return this._model.sessionId;
	}

	get requestInProgress(): boolean {
		return this._model.requestInProgress;
	}

	get initState() {
		return this._model.initState;
	}

	constructor(
		private readonly _model: IChatModel,
		public readonly codeBlockModelCollection: CodeBlockModelCollection,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		_model.getExchanges().forEach((exchange, i) => {
			if ('message' in exchange) {
				const requestModel = this.instantiationService.createInstance(ChatRequestViewModel, exchange);
				this.addItem(requestModel);
				this.updateCodeBlockTextModels(requestModel);
			} else if ('response' in exchange) {
				this.onAddResponse(exchange);
			}
		});

		this._register(_model.onDidDispose(() => this._onDidDisposeModel.fire()));
		this._register(_model.onDidChange(e => {
			if (e.kind === 'addRequest') {
				const requestModel = this.instantiationService.createInstance(ChatRequestViewModel, e.request);
				this.addItem(requestModel);
				this.updateCodeBlockTextModels(requestModel);

				/* TODO(@ghostwriternr): Why do we need to do this?
				if (e.request.response) {
					this.onAddResponse(e.request.response);
				}
				*/
			} else if (e.kind === 'addResponse') {
				this.onAddResponse(e.response);
			} else if (e.kind === 'removeExchange') {
				const exchangeIdx = this._items.findIndex(item => item.id === e.exchangeId);
				this.removeItem(exchangeIdx);
			}

			const modelEventToVmEvent: IChatViewModelChangeEvent =
				e.kind === 'addRequest' ? { kind: 'addRequest' }
					: e.kind === 'initialize' ? { kind: 'initialize' }
						: e.kind === 'setHidden' ? { kind: 'setHidden' }
							: null;
			this._onDidChange.fire(modelEventToVmEvent);
		}));
	}

	private onAddResponse(responseModel: IChatResponseModel) {
		const response = this.instantiationService.createInstance(ChatResponseViewModel, responseModel);
		this._register(response.onDidChange(() => {
			if (response.isComplete) {
				this.updateCodeBlockTextModels(response);
			}
			return this._onDidChange.fire(null);
		}));
		this.addItem(response);
		this.updateCodeBlockTextModels(response);
	}

	getItems(): (IChatRequestViewModel | IChatResponseViewModel)[] {
		return this._items.filter((item) => !item.shouldBeRemovedOnSend);
	}

	override dispose() {
		super.dispose();
		this._items
			.filter((item): item is ChatResponseViewModel => item instanceof ChatResponseViewModel)
			.forEach((item: ChatResponseViewModel) => item.dispose());
	}

	private updateCodeBlockTextModels(model: IChatRequestViewModel | IChatResponseViewModel) {
		let content: string;
		if (isRequestVM(model)) {
			content = model.messageText;
		} else {
			content = annotateVulnerabilitiesInText(model.response.value).map(x => x.content.value).join('');
		}

		let codeBlockIndex = 0;
		marked.walkTokens(marked.lexer(content), token => {
			if (token.type === 'code') {
				const lang = token.lang || '';
				const text = token.text;
				this.codeBlockModelCollection.update(this._model.sessionId, model, codeBlockIndex++, { text, languageId: lang });
			}
		});
	}
}

export class ChatRequestViewModel implements IChatRequestViewModel {
	get id() {
		return this._model.id;
	}

	get dataId() {
		return this.id + `_${ChatModelInitState[this._model.session.initState]}_${hash(this.variables)}_${hash(this.isComplete)}`;
	}

	get sessionId() {
		return this._model.session.sessionId;
	}

	get username() {
		return this._model.username;
	}

	get avatarIcon() {
		return this._model.avatarIconUri;
	}

	get message() {
		return this._model.message;
	}

	get messageText() {
		return this.message.text;
	}

	get attempt() {
		return this._model.attempt;
	}

	get variables() {
		return this._model.variableData.variables;
	}

	get contentReferences() {
		// TODO(@ghostwriternr): This seems useful, but I don't want to fix this yet.
		// return this._model.response?.contentReferences;
		return [];
	}

	get confirmation() {
		return this._model.confirmation;
	}

	get isComplete() {
		return false;
	}

	get shouldBeRemovedOnSend() {
		return this._model.shouldBeRemovedOnSend;
	}

	currentRenderedHeight: number | undefined;

	constructor(
		private readonly _model: IChatRequestModel,
	) { }
}

export class ChatResponseViewModel extends Disposable implements IChatResponseViewModel {
	private _modelChangeCount = 0;

	private readonly _onDidChange = this._register(new Emitter<void>());
	readonly onDidChange = this._onDidChange.event;

	get model() {
		return this._model;
	}

	get id() {
		return this._model.id;
	}

	isFirst = false;
	isLast = true;

	get dataId() {
		return this._model.id + `_${this._modelChangeCount}` + `_${ChatModelInitState[this._model.session.initState]}`;
	}

	get sessionId() {
		return this._model.session.sessionId;
	}

	get username() {
		if (this.agent) {
			const isAllowed = this.chatAgentNameService.getAgentNameRestriction(this.agent);
			if (isAllowed) {
				return this.agent.fullName || this.agent.name;
			} else {
				return getFullyQualifiedId(this.agent);
			}
		}

		return this._model.username;
	}

	get avatarIcon() {
		return this._model.avatarIcon;
	}

	get agent() {
		return this._model.agent;
	}

	get slashCommand() {
		return this._model.slashCommand;
	}

	get agentOrSlashCommandDetected() {
		return this._model.agentOrSlashCommandDetected;
	}

	get response(): IResponse {
		return this._model.response;
	}

	get usedContext(): IChatUsedContext | undefined {
		return this._model.usedContext;
	}

	get contentReferences(): ReadonlyArray<IChatContentReference> {
		return this._model.contentReferences;
	}

	get codeCitations(): ReadonlyArray<IChatCodeCitation> {
		return this._model.codeCitations;
	}

	get progressMessages(): ReadonlyArray<IChatProgressMessage> {
		return this._model.progressMessages;
	}

	get isComplete() {
		return this._model.isComplete;
	}

	get isCanceled() {
		return this._model.isCanceled;
	}

	get shouldBeRemovedOnSend() {
		return this._model.shouldBeRemovedOnSend;
	}

	get replyFollowups() {
		return this._model.followups?.filter((f): f is IChatFollowup => f.kind === 'reply');
	}

	get result() {
		return this._model.result;
	}

	get errorDetails(): IChatResponseErrorDetails | undefined {
		return this.result?.errorDetails;
	}

	get vote() {
		return this._model.vote;
	}

	get voteDownReason() {
		return this._model.voteDownReason;
	}

	/* TODO(@ghostwriternr): Once we have a clear picture of how requests and responses are going to be linked, we can remove this entirely.
	get requestId() {
		return this._model.requestId;
	}
	*/

	get isStale() {
		return this._model.isStale;
	}

	renderData: IChatResponseRenderData | undefined = undefined;
	currentRenderedHeight: number | undefined;

	private _usedReferencesExpanded: boolean | undefined;
	get usedReferencesExpanded(): boolean | undefined {
		if (typeof this._usedReferencesExpanded === 'boolean') {
			return this._usedReferencesExpanded;
		}

		return false;
	}

	set usedReferencesExpanded(v: boolean) {
		this._usedReferencesExpanded = v;
	}

	private _vulnerabilitiesListExpanded: boolean = false;
	get vulnerabilitiesListExpanded(): boolean {
		return this._vulnerabilitiesListExpanded;
	}

	set vulnerabilitiesListExpanded(v: boolean) {
		this._vulnerabilitiesListExpanded = v;
	}

	private _contentUpdateTimings: IChatLiveUpdateData | undefined = undefined;
	get contentUpdateTimings(): IChatLiveUpdateData | undefined {
		return this._contentUpdateTimings;
	}

	constructor(
		private readonly _model: IChatResponseModel,
		@ILogService private readonly logService: ILogService,
		@IAideAgentAgentNameService private readonly chatAgentNameService: IAideAgentAgentNameService,
	) {
		super();

		if (!_model.isComplete) {
			this._contentUpdateTimings = {
				firstWordTime: 0,
				lastUpdateTime: Date.now(),
				impliedWordLoadRate: 0,
				lastWordCount: 0
			};
		}

		this._register(_model.onDidChange(() => {
			// This should be true, if the model is changing
			if (this._contentUpdateTimings) {
				const now = Date.now();
				const wordCount = countWords(_model.response.toString());

				// Apply a min time difference, or the rate is typically too high for first few words
				const timeDiff = Math.max(now - this._contentUpdateTimings.firstWordTime, 250);
				const impliedWordLoadRate = this._contentUpdateTimings.lastWordCount / (timeDiff / 1000);
				this.trace('onDidChange', `Update- got ${this._contentUpdateTimings.lastWordCount} words over last ${timeDiff}ms = ${impliedWordLoadRate} words/s. ${wordCount} words are now available.`);
				this._contentUpdateTimings = {
					firstWordTime: this._contentUpdateTimings.firstWordTime === 0 && this.response.value.some(v => v.kind === 'markdownContent') ? now : this._contentUpdateTimings.firstWordTime,
					lastUpdateTime: now,
					impliedWordLoadRate,
					lastWordCount: wordCount
				};
			} else {
				this.logService.warn('ChatResponseViewModel#onDidChange: got model update but contentUpdateTimings is not initialized');
			}

			// new data -> new id, new content to render
			this._modelChangeCount++;

			this._onDidChange.fire();
		}));
	}

	private trace(tag: string, message: string) {
		this.logService.trace(`ChatResponseViewModel#${tag}: ${message}`);
	}

	setVote(vote: ChatAgentVoteDirection): void {
		this._modelChangeCount++;
		this._model.setVote(vote);
	}

	setVoteDownReason(reason: ChatAgentVoteDownReason | undefined): void {
		this._modelChangeCount++;
		this._model.setVoteDownReason(reason);
	}

	setEditApplied(edit: IChatTextEditGroup, editCount: number) {
		this._modelChangeCount++;
		this._model.setEditApplied(edit, editCount);
	}
}
