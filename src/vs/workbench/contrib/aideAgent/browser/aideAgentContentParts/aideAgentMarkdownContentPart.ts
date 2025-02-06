/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../../base/browser/dom.js';
import { StandardMouseEvent } from '../../../../../base/browser/mouseEvent.js';
import { Codicon } from '../../../../../base/common/codicons.js';
import { Emitter } from '../../../../../base/common/event.js';
import { IMarkdownString } from '../../../../../base/common/htmlContent.js';
import { Disposable, DisposableStore, IDisposable } from '../../../../../base/common/lifecycle.js';
import { autorun } from '../../../../../base/common/observable.js';
import { equalsIgnoreCase } from '../../../../../base/common/strings.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { URI } from '../../../../../base/common/uri.js';
import { MarkdownRenderer } from '../../../../../editor/browser/widget/markdownRenderer/browser/markdownRenderer.js';
import { Range } from '../../../../../editor/common/core/range.js';
import { ILanguageService } from '../../../../../editor/common/languages/language.js';
import { ITextModel } from '../../../../../editor/common/model.js';
import { getIconClasses } from '../../../../../editor/common/services/getIconClasses.js';
import { IModelService } from '../../../../../editor/common/services/model.js';
import { ITextModelService } from '../../../../../editor/common/services/resolverService.js';
import { localize } from '../../../../../nls.js';
import { getFlatContextMenuActions } from '../../../../../platform/actions/browser/menuEntryActionViewItem.js';
import { IMenuService, MenuId } from '../../../../../platform/actions/common/actions.js';
import { IContextKeyService } from '../../../../../platform/contextkey/common/contextkey.js';
import { IContextMenuService } from '../../../../../platform/contextview/browser/contextView.js';
import { FileKind } from '../../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { IAideAgentEditingService } from '../../common/aideAgentEditingService.js';
import { IChatProgressRenderableResponseContent } from '../../common/aideAgentModel.js';
import { IChatMarkdownContent } from '../../common/aideAgentService.js';
import { isRequestVM, isResponseVM } from '../../common/aideAgentViewModel.js';
import { IMarkdownVulnerability } from '../../common/annotations.js';
import { CodeBlockModelCollection } from '../../common/codeBlockModelCollection.js';
import { IChatCodeBlockInfo, IChatListItemRendererOptions, IEditPreviewCodeBlockInfo } from '../aideAgent.js';
import { IChatRendererDelegate } from '../aideAgentListRenderer.js';
import { ChatMarkdownDecorationsRenderer } from '../aideAgentMarkdownDecorationsRenderer.js';
import { ChatEditorOptions } from '../aideAgentOptions.js';
import { CodeBlockPart, ICodeBlockData, localFileLanguageId, parseLocalFileData } from '../codeBlockPart.js';
import { EditPreviewBlockPart, IEditPreviewBlockData } from '../editPreviewPart.js';
import '../media/aideAgentCodeBlockPill.css';
import { IDisposableReference, ResourcePool } from './aideAgentCollections.js';
import { IChatContentPart, IChatContentPartRenderContext } from './aideAgentContentParts.js';

const $ = dom.$;

export class ChatMarkdownContentPart extends Disposable implements IChatContentPart {
	private static idPool = 0;
	public readonly id = String(++ChatMarkdownContentPart.idPool);
	public readonly domNode: HTMLElement;
	private readonly allRefs: IDisposableReference<CodeBlockPart | CollapsedCodeBlock>[] = [];
	private readonly allEditPreviewRefs: IDisposableReference<EditPreviewBlockPart>[] = [];

	private readonly _onDidChangeHeight = this._register(new Emitter<void>());
	public readonly onDidChangeHeight = this._onDidChangeHeight.event;

	public readonly codeblocks: IChatCodeBlockInfo[] = [];
	public readonly editPreviewBlocks: IEditPreviewCodeBlockInfo[] = [];

	private extractUriFromMarkdown(markdown: IMarkdownString): { uris: URI[]; cleanMarkdown: IMarkdownString } {
		const lines = markdown.value.split('\n');
		const extractedUris: URI[] = [];
		let inCodeBlock = false;

		// Find URIs and filter lines in a single pass
		const modifiedLines = lines.filter((line, i) => {
			const currentLine = line.trim();

			// Track if we're in a code block
			if (currentLine.startsWith('```')) {
				inCodeBlock = !inCodeBlock;
				return true;
			}

			// Skip URI extraction if we're inside a code block
			if (inCodeBlock) {
				return true;
			}

			// Only process standalone lines that look like file paths
			if (currentLine && (
				(currentLine.startsWith('/') && !currentLine.includes('/>') && !currentLine.includes('<')) || // Unix-style absolute path
				/^[a-zA-Z]:[/\\]/.test(currentLine) || // Windows-style absolute path
				currentLine.startsWith('file://'))) { // file:// URI
				try {
					// For plain paths, convert to file URI
					const uriToTry = currentLine.startsWith('file://')
						? currentLine
						: `file://${currentLine}`;
					const uri = URI.parse(uriToTry);

					// Additional validation - path should look like a real file path
					if (uri.path && uri.path.length > 2 && !uri.path.includes('<') && !uri.path.includes('>')) {
						extractedUris.push(uri);
						return false; // Remove the URI line
					}
				} catch {
					// Not a valid URI, keep the line
				}
			}
			return true;
		});

		return {
			uris: extractedUris,
			cleanMarkdown: { ...markdown, value: modifiedLines.join('\n') }
		};
	}

	private parseOutSRSystemMessage(markdown: IMarkdownString): { hasSearchReplace: boolean; cleanMarkdown: IMarkdownString } {
		const lines = markdown.value.split('\n');
		const hasSearchReplace = lines.some(line => line.includes('SEARCH/REPLACE'));

		if (!hasSearchReplace) {
			return { hasSearchReplace: false, cleanMarkdown: markdown };
		}

		const modifiedLines = lines.filter(line => !line.includes('SEARCH/REPLACE'));

		return {
			hasSearchReplace: true,
			cleanMarkdown: { ...markdown, value: modifiedLines.join('\n') }
		};
	}

	constructor(
		private readonly markdown: IChatMarkdownContent,
		context: IChatContentPartRenderContext,
		private readonly editorPool: EditorPool,
		private readonly editPreviewEditorPool: EditPreviewEditorPool,
		fillInIncompleteTokens = false,
		codeBlockStartIndex = 0,
		renderer: MarkdownRenderer,
		currentWidth: number,
		private readonly codeBlockModelCollection: CodeBlockModelCollection,
		private readonly rendererOptions: IChatListItemRendererOptions,
		@IContextKeyService contextKeyService: IContextKeyService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
	) {
		super();

		const element = context.element;

		// Extract URIs before rendering
		const { uris: extractedUris, cleanMarkdown: uriCleanedMarkdown } = this.extractUriFromMarkdown(markdown.content);
		// Remove SEARCH/REPLACE system messages
		const { cleanMarkdown } = this.parseOutSRSystemMessage(uriCleanedMarkdown);
		let currentUriIndex = 0;

		// We release editors in order so that it's more likely that the same editor will be assigned if this element is re-rendered right away, like it often is during progressive rendering
		const orderedDisposablesList: IDisposable[] = [];

		// Need to track the index of the codeblock within the response so it can have a unique ID,
		// and within this part to find it within the codeblocks array
		let globalCodeBlockIndexStart = codeBlockStartIndex;
		let thisPartCodeBlockIndexStart = 0;
		const result = this._register(renderer.render(cleanMarkdown, {
			fillInIncompleteTokens,
			codeBlockRendererSync: (languageId, text, raw) => {
				if (!isRequestVM(element) && !isResponseVM(element)) {
					return $('div');
				}

				if (raw?.includes('```')) {
					const uriTagAfterBackticks = raw.match(/```[\s\n]*<vscode_codeblock_uri>.*?<\/vscode_codeblock_uri>/);
					if (uriTagAfterBackticks) {
						raw = raw.replace(uriTagAfterBackticks[0], '```');
					}
				}

				const isCodeBlockComplete = !isResponseVM(context.element) || context.element.isComplete || !raw || codeblockHasClosingBackticks(raw);
				if ((!text || (text.startsWith('<vscode_codeblock_uri>') && !text.includes('\n'))) && !isCodeBlockComplete && rendererOptions.renderCodeBlockPills) {
					const hideEmptyCodeblock = $('div');
					hideEmptyCodeblock.style.display = 'none';
					return hideEmptyCodeblock;
				}

				const editPreviewBlock = this.parseEditPreviewBlock(text);
				if (editPreviewBlock) {
					const sessionId = isResponseVM(element) || isRequestVM(element) ? element.sessionId : '';
					const originalIndex = globalCodeBlockIndexStart++;
					const original = this.codeBlockModelCollection.getOrCreate(sessionId, element, originalIndex).model;
					const modifiedIndex = globalCodeBlockIndexStart++;
					const modified = this.codeBlockModelCollection.getOrCreate(sessionId, element, modifiedIndex).model;

					const uri = extractedUris[currentUriIndex++] || URI.parse('');
					const codeBlockInfo: IEditPreviewBlockData = {
						uri,
						element,
						languageId,
						parentContextKeyService: contextKeyService,
						original: { model: original, text: editPreviewBlock.original, codeBlockIndex: originalIndex },
						modified: { model: modified, text: editPreviewBlock.modified, codeBlockIndex: modifiedIndex },
					};

					let ref: IDisposableReference<EditPreviewBlockPart | CollapsedCodeBlock>;
					if (!rendererOptions.renderCodeBlockPills) {
						const editPreviewRef = ref = this.renderEditPreviewBlock(codeBlockInfo, isCodeBlockComplete, currentWidth);
						this.allEditPreviewRefs.push(editPreviewRef);

						this._register(editPreviewRef.object.onDidChangeContentHeight(() => this._onDidChangeHeight.fire()));

						const ownerMarkdownPartId = this.id;
						const info: IEditPreviewCodeBlockInfo = new class {
							readonly ownerMarkdownPartId = ownerMarkdownPartId;
							readonly element = element;
						}();
						this.editPreviewBlocks.push(info);
					} else {
						const pillRef = ref = this.renderCodeBlockPill(element.sessionId, element.id, codeBlockInfo.uri, !isCodeBlockComplete);
						this.allRefs.push(pillRef);

						const ownerMarkdownPartId = this.id;
						const info: IChatCodeBlockInfo = new class {
							readonly ownerMarkdownPartId = ownerMarkdownPartId;
							readonly codeBlockIndex = modifiedIndex;
							readonly element = element;
							readonly isStreaming = !isCodeBlockComplete;
							readonly codemapperUri = uri;
							readonly uri = uri;
							readonly uriPromise = Promise.resolve(uri);
							public focus() {
								return pillRef.object.element.focus();
							}
							public getContent(): string {
								return ''; // Not needed for collapsed code blocks
							}
						}();
						this.codeblocks.push(info);
					}

					orderedDisposablesList.push(ref);
					return ref.object.element;
				}

				const globalIndex = globalCodeBlockIndexStart++;
				const thisPartIndex = thisPartCodeBlockIndexStart++;
				let textModel: Promise<ITextModel>;
				let range: Range | undefined;
				let vulns: readonly IMarkdownVulnerability[] | undefined;
				let codemapperUri: URI | undefined;
				if (equalsIgnoreCase(languageId, localFileLanguageId)) {
					try {
						const parsedBody = parseLocalFileData(text);
						range = parsedBody.range && Range.lift(parsedBody.range);
						textModel = this.textModelService.createModelReference(parsedBody.uri).then(ref => ref.object.textEditorModel);
					} catch (e) {
						return $('div');
					}
				} else {
					const sessionId = isResponseVM(element) || isRequestVM(element) ? element.sessionId : '';
					const modelEntry = this.codeBlockModelCollection.getOrCreate(sessionId, element, globalIndex);
					const fastUpdateModelEntry = this.codeBlockModelCollection.updateSync(sessionId, element, globalIndex, { text, languageId, isComplete: isCodeBlockComplete });
					vulns = modelEntry.vulns;
					codemapperUri = fastUpdateModelEntry.codemapperUri;
					textModel = modelEntry.model;
				}

				const hideToolbar = isResponseVM(element) && element.errorDetails?.responseIsFiltered;
				const codeBlockInfo: ICodeBlockData = { languageId, textModel, codeBlockIndex: globalIndex, codeBlockPartIndex: thisPartIndex, element, range, hideToolbar, parentContextKeyService: contextKeyService, vulns, codemapperUri };

				if (!rendererOptions.renderCodeBlockPills || element.isCompleteAddedRequest || !codemapperUri) {
					const ref = this.renderCodeBlock(codeBlockInfo, text, isCodeBlockComplete, currentWidth);
					this.allRefs.push(ref);

					// Attach this after updating text/layout of the editor, so it should only be fired when the size updates later (horizontal scrollbar, wrapping)
					// not during a renderElement OR a progressive render (when we will be firing this event anyway at the end of the render)
					this._register(ref.object.onDidChangeContentHeight(() => this._onDidChangeHeight.fire()));

					const ownerMarkdownPartId = this.id;
					const info: IChatCodeBlockInfo = new class {
						readonly ownerMarkdownPartId = ownerMarkdownPartId;
						readonly codeBlockIndex = globalIndex;
						readonly element = element;
						readonly isStreaming = !rendererOptions.renderCodeBlockPills;
						codemapperUri = undefined; // will be set async
						public get uri() {
							// here we must do a getter because the ref.object is rendered
							// async and the uri might be undefined when it's read immediately
							return ref.object.uri;
						}
						readonly uriPromise = textModel.then(model => model.uri);
						public focus() {
							ref.object.focus();
						}
						public getContent(): string {
							return ref.object.editor.getValue();
						}
					}();
					this.codeblocks.push(info);
					orderedDisposablesList.push(ref);
					return ref.object.element;
				} else {
					const ref = this.renderCodeBlockPill(element.sessionId, element.id, codeBlockInfo.codemapperUri, !isCodeBlockComplete);
					if (isResponseVM(codeBlockInfo.element)) {
						// TODO@joyceerhl: remove this code when we change the codeblockUri API to make the URI available synchronously
						this.codeBlockModelCollection.update(codeBlockInfo.element.sessionId, codeBlockInfo.element, codeBlockInfo.codeBlockIndex, { text, languageId: codeBlockInfo.languageId, isComplete: isCodeBlockComplete }).then((e) => {
							// Update the existing object's codemapperUri
							this.codeblocks[codeBlockInfo.codeBlockPartIndex].codemapperUri = e.codemapperUri;
							this._onDidChangeHeight.fire();
						});
					}
					this.allRefs.push(ref);
					const ownerMarkdownPartId = this.id;
					const info: IChatCodeBlockInfo = new class {
						readonly ownerMarkdownPartId = ownerMarkdownPartId;
						readonly codeBlockIndex = globalIndex;
						readonly element = element;
						readonly isStreaming = !isCodeBlockComplete;
						readonly codemapperUri = codemapperUri;
						public get uri() {
							return undefined;
						}
						readonly uriPromise = Promise.resolve(undefined);
						public focus() {
							return ref.object.element.focus();
						}
						public getContent(): string {
							return ''; // Not needed for collapsed code blocks
						}
					}();
					this.codeblocks.push(info);
					orderedDisposablesList.push(ref);
					return ref.object.element;
				}
			},
			asyncRenderCallback: () => this._onDidChangeHeight.fire(),
		}));

		const markdownDecorationsRenderer = instantiationService.createInstance(ChatMarkdownDecorationsRenderer);
		this._register(markdownDecorationsRenderer.walkTreeAndAnnotateReferenceLinks(markdown, result.element));

		orderedDisposablesList.reverse().forEach(d => this._register(d));
		this.domNode = result.element;
	}

	private parseEditPreviewBlock(text: string): { original: string; modified: string } | null {
		const startMarker = '<<<<<<< SEARCH';
		const separatorMarker = '=======';
		const endMarker = '>>>>>>> REPLACE';

		const startIndex = text.indexOf(startMarker);
		if (startIndex === -1) {
			return null;
		}

		let original = '';
		let modified = '';

		const contentAfterStart = text.slice(startIndex + startMarker.length);
		const separatorIndex = contentAfterStart.indexOf(separatorMarker);
		const endIndex = contentAfterStart.indexOf(endMarker);

		if (separatorIndex !== -1 && endIndex !== -1) {
			// Full block with both search and replace
			original = contentAfterStart.slice(0, separatorIndex).trim();
			modified = contentAfterStart.slice(separatorIndex + separatorMarker.length, endIndex).trim();
		} else if (separatorIndex !== -1) {
			// Separator exists but end doesn't
			original = contentAfterStart.slice(0, separatorIndex).trim();
			modified = contentAfterStart.slice(separatorIndex + separatorMarker.length).trim();
		} else {
			// Partial block with only start
			original = contentAfterStart.trim();
		}

		return { original, modified };
	}

	private renderCodeBlockPill(sessionId: string, exchangeId: string, codemapperUri: URI | undefined, isStreaming: boolean): IDisposableReference<CollapsedCodeBlock> {
		const codeBlock = this.instantiationService.createInstance(CollapsedCodeBlock, sessionId, exchangeId);
		if (codemapperUri) {
			codeBlock.render(codemapperUri, isStreaming);
		}
		return {
			object: codeBlock,
			isStale: () => false,
			dispose: () => codeBlock.dispose()
		};
	}

	private renderCodeBlock(data: ICodeBlockData, text: string, isComplete: boolean, currentWidth: number): IDisposableReference<CodeBlockPart> {
		const ref = this.editorPool.get();
		const editorInfo = ref.object;
		if (isResponseVM(data.element)) {
			this.codeBlockModelCollection.update(data.element.sessionId, data.element, data.codeBlockIndex, { text, languageId: data.languageId, isComplete }).then((e) => {
				// Update the existing object's codemapperUri
				this.codeblocks[data.codeBlockPartIndex].codemapperUri = e.codemapperUri;
				this._onDidChangeHeight.fire();
			});
		}

		editorInfo.render(data, currentWidth);
		return ref;
	}

	private renderEditPreviewBlock(data: IEditPreviewBlockData, isComplete: boolean, currentWidth: number): IDisposableReference<EditPreviewBlockPart> {
		const ref = this.editPreviewEditorPool.get();
		const editPreviewEditorInfo = ref.object;
		if (isResponseVM(data.element)) {
			this.codeBlockModelCollection.update(data.element.sessionId, data.element, data.original.codeBlockIndex, { text: data.original.text, languageId: data.languageId, isComplete }).then((e) => {
				this._onDidChangeHeight.fire();
			});
			this.codeBlockModelCollection.update(data.element.sessionId, data.element, data.modified.codeBlockIndex, { text: data.modified.text, languageId: data.languageId, isComplete }).then((e) => {
				this._onDidChangeHeight.fire();
			});
		}

		editPreviewEditorInfo.render(data, currentWidth);
		return ref;
	}

	hasSameContent(other: IChatProgressRenderableResponseContent): boolean {
		return other.kind === 'markdownContent' && !!(other.content.value === this.markdown.content.value
			|| this.rendererOptions.renderCodeBlockPills && this.codeblocks.at(-1)?.isStreaming && this.codeblocks.at(-1)?.codemapperUri !== undefined && other.content.value.lastIndexOf('```') === this.markdown.content.value.lastIndexOf('```'));
	}

	layout(width: number): void {
		this.allRefs.forEach((ref, index) => {
			if (ref.object instanceof CodeBlockPart) {
				ref.object.layout(width);
			} else if (ref.object instanceof CollapsedCodeBlock) {
				const codeblockModel = this.codeblocks[index];
				if (codeblockModel.codemapperUri && ref.object.uri?.toString() !== codeblockModel.codemapperUri.toString()) {
					ref.object.render(codeblockModel.codemapperUri, codeblockModel.isStreaming);
				}
			}
		});
		this.allEditPreviewRefs.forEach(ref => ref.object.layout(width));
	}

	addDisposable(disposable: IDisposable): void {
		this._register(disposable);
	}
}

export class EditorPool extends Disposable {

	private readonly _pool: ResourcePool<CodeBlockPart>;

	public inUse(): Iterable<CodeBlockPart> {
		return this._pool.inUse;
	}

	constructor(
		options: ChatEditorOptions,
		delegate: IChatRendererDelegate,
		overflowWidgetsDomNode: HTMLElement | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._pool = this._register(new ResourcePool(() => {
			return instantiationService.createInstance(CodeBlockPart, options, MenuId.AideAgentCodeBlock, delegate, overflowWidgetsDomNode);
		}));
	}

	get(): IDisposableReference<CodeBlockPart> {
		const codeBlock = this._pool.get();
		let stale = false;
		return {
			object: codeBlock,
			isStale: () => stale,
			dispose: () => {
				codeBlock.reset();
				stale = true;
				this._pool.release(codeBlock);
			}
		};
	}
}

export function codeblockHasClosingBackticks(str: string): boolean {
	str = str.trim();
	return !!str.match(/\n```+$/);
}

export class EditPreviewEditorPool extends Disposable {
	private readonly _pool: ResourcePool<EditPreviewBlockPart>;

	public inUse(): Iterable<EditPreviewBlockPart> {
		return this._pool.inUse;
	}

	constructor(
		options: ChatEditorOptions,
		delegate: IChatRendererDelegate,
		overflowWidgetsDomNode: HTMLElement | undefined,
		@IInstantiationService instantiationService: IInstantiationService,
	) {
		super();
		this._pool = this._register(new ResourcePool(() => {
			return instantiationService.createInstance(EditPreviewBlockPart, options, delegate, overflowWidgetsDomNode);
		}));
	}

	get(): IDisposableReference<EditPreviewBlockPart> {
		const editPreviewBlock = this._pool.get();
		let stale = false;
		return {
			object: editPreviewBlock,
			isStale: () => stale,
			dispose: () => {
				editPreviewBlock.reset();
				stale = true;
				this._pool.release(editPreviewBlock);
			}
		};
	}
}

class CollapsedCodeBlock extends Disposable {

	public readonly element: HTMLElement;

	private _uri: URI | undefined;
	public get uri(): URI | undefined {
		return this._uri;
	}

	private readonly _progressStore = this._store.add(new DisposableStore());

	constructor(
		sessionId: string,
		exchangeId: string,
		@ILabelService private readonly labelService: ILabelService,
		@IEditorService private readonly editorService: IEditorService,
		@IModelService private readonly modelService: IModelService,
		@ILanguageService private readonly languageService: ILanguageService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IContextKeyService private readonly contextKeyService: IContextKeyService,
		@IMenuService private readonly menuService: IMenuService,
		@IAideAgentEditingService private readonly chatEditingService: IAideAgentEditingService,
	) {
		super();
		this.element = $('.aideagent-codeblock-pill-widget');
		this.element.classList.add('show-file-icons');
		this._register(dom.addDisposableListener(this.element, 'click', async () => {
			if (this.uri) {
				this.editorService.openEditor({ resource: this.uri });
			}
		}));
		this._register(dom.addDisposableListener(this.element, dom.EventType.CONTEXT_MENU, domEvent => {
			const event = new StandardMouseEvent(dom.getWindow(domEvent), domEvent);
			dom.EventHelper.stop(domEvent, true);

			this.contextMenuService.showContextMenu({
				contextKeyService: this.contextKeyService,
				getAnchor: () => event,
				getActions: () => {
					const menu = this.menuService.getMenuActions(MenuId.AideAgentEditingCodeBlockContext, this.contextKeyService, { arg: { sessionId, exchangeId, uri: this.uri } });
					return getFlatContextMenuActions(menu);
				},
			});
		}));
	}

	render(uri: URI, isStreaming?: boolean): void {
		this._progressStore.clear();

		this._uri = uri;

		const iconText = this.labelService.getUriBasenameLabel(uri);
		const modifiedEntry = this.chatEditingService.currentEditingSession?.getEntry(uri);
		const isComplete = !modifiedEntry?.isCurrentlyBeingModified.get();

		let iconClasses: string[] = [];
		if (isStreaming || !isComplete) {
			const codicon = ThemeIcon.modify(Codicon.loading, 'spin');
			iconClasses = ThemeIcon.asClassNameArray(codicon);
		} else {
			const fileKind = uri.path.endsWith('/') ? FileKind.FOLDER : FileKind.FILE;
			iconClasses = getIconClasses(this.modelService, this.languageService, uri, fileKind);
		}

		const iconEl = dom.$('span.icon');
		iconEl.classList.add(...iconClasses);

		const children = [dom.$('span.icon-label', {}, iconText)];
		if (isStreaming) {
			children.push(dom.$('span.label-detail', {}, localize('chat.codeblock.generating', "Generating edits...")));
		} else if (!isComplete) {
			children.push(dom.$('span.label-detail', {}, ''));
		}
		this.element.replaceChildren(iconEl, ...children);
		this.element.title = this.labelService.getUriLabel(uri, { relative: false });

		// Show a percentage progress that is driven by the rewrite

		this._progressStore.add(autorun(r => {
			const rewriteRatio = modifiedEntry?.rewriteRatio.read(r);

			const labelDetail = this.element.querySelector('.label-detail');
			const isComplete = !modifiedEntry?.isCurrentlyBeingModified.read(r);
			if (labelDetail && !isStreaming && !isComplete) {
				const value = rewriteRatio;
				labelDetail.textContent = value === 0 || !value ? localize('chat.codeblock.applying', "Applying edits...") : localize('chat.codeblock.applyingPercentage', "Applying edits ({0}%)...", Math.round(value * 100));
			} else if (labelDetail && !isStreaming && isComplete) {
				iconEl.classList.remove(...iconClasses);
				const fileKind = uri.path.endsWith('/') ? FileKind.FOLDER : FileKind.FILE;
				iconEl.classList.add(...getIconClasses(this.modelService, this.languageService, uri, fileKind));
				labelDetail.textContent = '';
			}

			if (!isStreaming && isComplete) {
				const labelAdded = this.element.querySelector('.label-added') ?? this.element.appendChild(dom.$('span.label-added'));
				const labelRemoved = this.element.querySelector('.label-removed') ?? this.element.appendChild(dom.$('span.label-removed'));
				const changes = modifiedEntry?.diffInfo.read(r);
				if (changes && !changes?.identical && !changes?.quitEarly) {
					let removedLines = 0;
					let addedLines = 0;
					for (const change of changes.changes) {
						removedLines += change.original.endLineNumberExclusive - change.original.startLineNumber;
						addedLines += change.modified.endLineNumberExclusive - change.modified.startLineNumber;
					}
					labelAdded.textContent = `+${addedLines}`;
					labelRemoved.textContent = `-${removedLines}`;
					const insertionsFragment = addedLines === 1 ? localize('chat.codeblock.insertions.one', "1 insertion") : localize('chat.codeblock.insertions', "{0} insertions", addedLines);
					const deletionsFragment = removedLines === 1 ? localize('chat.codeblock.deletions.one', "1 deletion") : localize('chat.codeblock.deletions', "{0} deletions", removedLines);
					this.element.ariaLabel = this.element.title = localize('summary', 'Edited {0}, {1}, {2}', iconText, insertionsFragment, deletionsFragment);
				}
			}
		}));
	}
}
