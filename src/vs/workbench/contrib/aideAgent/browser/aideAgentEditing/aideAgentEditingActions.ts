/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../../base/common/codicons.js';
import { KeyCode, KeyMod } from '../../../../../base/common/keyCodes.js';
import { basename } from '../../../../../base/common/resources.js';
import { URI } from '../../../../../base/common/uri.js';
import { ServicesAccessor } from '../../../../../editor/browser/editorExtensions.js';
import { localize, localize2 } from '../../../../../nls.js';
import { Action2, MenuId, registerAction2 } from '../../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { IDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { KeybindingWeight } from '../../../../../platform/keybinding/common/keybindingsRegistry.js';
import { IEditorService } from '../../../../services/editor/common/editorService.js';
import { ChatAgentLocation } from '../../common/aideAgentAgents.js';
import { CONTEXT_CHAT_INPUT_HAS_TEXT, CONTEXT_CHAT_LOCATION, CONTEXT_CHAT_REQUEST_IN_PROGRESS, CONTEXT_IN_CHAT_INPUT, CONTEXT_IN_CHAT_SESSION } from '../../common/aideAgentContextKeys.js';
import { applyingChatEditsFailedContextKey, CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME, chatEditingResourceContextKey, chatEditingWidgetFileStateContextKey, decidedChatEditingResourceContextKey, hasAppliedChatEditsContextKey, hasUndecidedChatEditingResourceContextKey, IAideAgentEditingService, IChatEditingSession, WorkingSetEntryState } from '../../common/aideAgentEditingService.js';
import { IAideAgentService } from '../../common/aideAgentService.js';
import { isRequestVM, isResponseVM } from '../../common/aideAgentViewModel.js';
import { CHAT_CATEGORY } from '../actions/aideAgentActions.js';
import { ChatTreeItem, IAideAgentWidgetService, IChatWidget } from '../aideAgent.js';

abstract class WorkingSetAction extends Action2 {
	run(accessor: ServicesAccessor, ...args: any[]) {
		const chatEditingService = accessor.get(IAideAgentEditingService);
		const currentEditingSession = chatEditingService.currentEditingSession;
		if (!currentEditingSession) {
			return;
		}

		const chatWidget = accessor.get(IAideAgentWidgetService).lastFocusedWidget;

		const uris: URI[] = [];
		if (URI.isUri(args[0])) {
			uris.push(args[0]);
		} else if (chatWidget) {
			uris.push(...chatWidget.input.selectedElements);
		}
		if (!uris.length) {
			return;
		}

		return this.runWorkingSetAction(accessor, currentEditingSession, chatWidget, ...uris);
	}

	abstract runWorkingSetAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, chatWidget: IChatWidget | undefined, ...uris: URI[]): any;
}

registerAction2(class OpenFileInDiffAction extends WorkingSetAction {
	constructor() {
		super({
			id: 'aideAgentEditing.openFileInDiff',
			title: localize2('open.fileInDiff', 'Open Changes in Diff Editor'),
			icon: Codicon.diffSingle,
			menu: [{
				id: MenuId.AideAgentEditingWidgetModifiedFilesToolbar,
				when: ContextKeyExpr.equals(chatEditingWidgetFileStateContextKey.key, WorkingSetEntryState.Modified),
				order: 2,
				group: 'navigation'
			}],
		});
	}

	async runWorkingSetAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, _chatWidget: IChatWidget, ...uris: URI[]): Promise<void> {
		const editorService = accessor.get(IEditorService);
		for (const uri of uris) {
			const editedFile = currentEditingSession.getEntry(uri);
			if (editedFile?.state.get() === WorkingSetEntryState.Modified) {
				await editorService.openEditor({
					original: { resource: URI.from(editedFile.originalURI, true) },
					modified: { resource: URI.from(editedFile.modifiedURI, true) },
				});
			} else {
				await editorService.openEditor({ resource: uri });
			}
		}
	}
});

registerAction2(class AcceptAction extends WorkingSetAction {
	constructor() {
		super({
			id: 'aideAgentEditing.acceptFile',
			title: localize2('accept.file', 'Accept'),
			icon: Codicon.check,
			menu: [{
				when: ContextKeyExpr.and(ContextKeyExpr.equals('resourceScheme', CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME), ContextKeyExpr.notIn(chatEditingResourceContextKey.key, decidedChatEditingResourceContextKey.key)),
				id: MenuId.MultiDiffEditorFileToolbar,
				order: 0,
				group: 'navigation',
			}, {
				id: MenuId.AideAgentEditingWidgetModifiedFilesToolbar,
				when: ContextKeyExpr.equals(chatEditingWidgetFileStateContextKey.key, WorkingSetEntryState.Modified),
				order: 0,
				group: 'navigation'
			}],
		});
	}

	async runWorkingSetAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, chatWidget: IChatWidget, ...uris: URI[]): Promise<void> {
		await currentEditingSession.accept(...uris);
	}
});

registerAction2(class DiscardAction extends WorkingSetAction {
	constructor() {
		super({
			id: 'aideAgentEditing.discardFile',
			title: localize2('discard.file', 'Discard'),
			icon: Codicon.discard,
			menu: [{
				when: ContextKeyExpr.and(ContextKeyExpr.equals('resourceScheme', CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME), ContextKeyExpr.notIn(chatEditingResourceContextKey.key, decidedChatEditingResourceContextKey.key)),
				id: MenuId.MultiDiffEditorFileToolbar,
				order: 2,
				group: 'navigation',
			}, {
				id: MenuId.AideAgentEditingWidgetModifiedFilesToolbar,
				when: ContextKeyExpr.equals(chatEditingWidgetFileStateContextKey.key, WorkingSetEntryState.Modified),
				order: 1,
				group: 'navigation'
			}],
		});
	}

	async runWorkingSetAction(accessor: ServicesAccessor, currentEditingSession: IChatEditingSession, chatWidget: IChatWidget, ...uris: URI[]): Promise<void> {
		await currentEditingSession.reject(...uris);
	}
});

export class ChatEditingAcceptAllAction extends Action2 {

	constructor() {
		super({
			id: 'aideAgentEditing.acceptAllFiles',
			title: localize('accept', 'Accept'),
			icon: Codicon.check,
			tooltip: localize('acceptAllEdits', 'Accept All Edits'),
			precondition: ContextKeyExpr.and(CONTEXT_CHAT_REQUEST_IN_PROGRESS.negate(), hasUndecidedChatEditingResourceContextKey),
			keybinding: {
				primary: KeyMod.CtrlCmd | KeyCode.Enter,
				when: ContextKeyExpr.and(CONTEXT_CHAT_REQUEST_IN_PROGRESS.negate(), hasUndecidedChatEditingResourceContextKey, CONTEXT_CHAT_LOCATION.isEqualTo(ChatAgentLocation.Panel), CONTEXT_IN_CHAT_INPUT),
				weight: KeybindingWeight.WorkbenchContrib,
			},
			menu: [
				{
					when: ContextKeyExpr.equals('resourceScheme', CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME),
					id: MenuId.EditorTitle,
					order: 0,
					group: 'navigation',
				},
				{
					id: MenuId.AideAgentEditingWidgetToolbar,
					group: 'navigation',
					order: 0,
					when: ContextKeyExpr.and(applyingChatEditsFailedContextKey.negate(), ContextKeyExpr.and(hasUndecidedChatEditingResourceContextKey, ContextKeyExpr.and(CONTEXT_CHAT_LOCATION.isEqualTo(ChatAgentLocation.Panel))))
				}
			]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const chatEditingService = accessor.get(IAideAgentEditingService);
		const currentEditingSession = chatEditingService.currentEditingSession;
		if (!currentEditingSession) {
			return;
		}
		await currentEditingSession.accept();
	}
}
registerAction2(ChatEditingAcceptAllAction);

export class ChatEditingDiscardAllAction extends Action2 {

	constructor() {
		super({
			id: 'aideAgentEditing.discardAllFiles',
			title: localize('discard', 'Discard'),
			icon: Codicon.discard,
			tooltip: localize('discardAllEdits', 'Discard All Edits'),
			precondition: ContextKeyExpr.and(CONTEXT_CHAT_REQUEST_IN_PROGRESS.negate(), hasUndecidedChatEditingResourceContextKey),
			menu: [
				{
					when: ContextKeyExpr.equals('resourceScheme', CHAT_EDITING_MULTI_DIFF_SOURCE_RESOLVER_SCHEME),
					id: MenuId.EditorTitle,
					order: 1,
					group: 'navigation',
				},
				{
					id: MenuId.AideAgentEditingWidgetToolbar,
					group: 'navigation',
					order: 1,
					when: ContextKeyExpr.and(applyingChatEditsFailedContextKey.negate(), ContextKeyExpr.and(CONTEXT_CHAT_LOCATION.isEqualTo(ChatAgentLocation.Panel), hasUndecidedChatEditingResourceContextKey))
				}
			],
			keybinding: {
				when: ContextKeyExpr.and(CONTEXT_CHAT_REQUEST_IN_PROGRESS.negate(), hasUndecidedChatEditingResourceContextKey, CONTEXT_CHAT_LOCATION.isEqualTo(ChatAgentLocation.Panel), CONTEXT_IN_CHAT_INPUT, CONTEXT_CHAT_INPUT_HAS_TEXT.negate()),
				weight: KeybindingWeight.WorkbenchContrib,
				primary: KeyMod.CtrlCmd | KeyCode.Backspace,
			},
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		await discardAllEditsWithConfirmation(accessor);
	}
}
registerAction2(ChatEditingDiscardAllAction);

export async function discardAllEditsWithConfirmation(accessor: ServicesAccessor): Promise<boolean> {
	const chatEditingService = accessor.get(IAideAgentEditingService);
	const dialogService = accessor.get(IDialogService);
	const currentEditingSession = chatEditingService.currentEditingSession;
	if (!currentEditingSession) {
		return false;
	}

	// Ask for confirmation if there are any edits
	const entries = currentEditingSession.entries.get();
	if (entries.length > 0) {
		const confirmation = await dialogService.confirm({
			title: localize('aideAgent.editing.discardAll.confirmation.title', "Discard all edits?"),
			message: entries.length === 1
				? localize('aideAgent.editing.discardAll.confirmation.oneFile', "This will undo changes made by {0} in {1}. Do you want to proceed?", 'Aide', basename(entries[0].modifiedURI))
				: localize('aideAgent.editing.discardAll.confirmation.manyFiles', "This will undo changes made by {0} in {1} files. Do you want to proceed?", 'Aide', entries.length),
			primaryButton: localize('aideAgent.editing.discardAll.confirmation.primaryButton', "Yes"),
			type: 'info'
		});
		if (!confirmation.confirmed) {
			return false;
		}
	}

	await currentEditingSession.reject();
	return true;
}

export class ChatEditingShowChangesAction extends Action2 {
	static readonly ID = 'aideAgentEditing.viewChanges';
	static readonly LABEL = localize('aideAgentEditing.viewChanges', 'View All Edits');

	constructor() {
		super({
			id: ChatEditingShowChangesAction.ID,
			title: ChatEditingShowChangesAction.LABEL,
			tooltip: ChatEditingShowChangesAction.LABEL,
			f1: false,
			icon: Codicon.diffMultiple,
			precondition: hasUndecidedChatEditingResourceContextKey,
			menu: [
				{
					id: MenuId.AideAgentEditingWidgetToolbar,
					group: 'navigation',
					order: 4,
					when: ContextKeyExpr.and(applyingChatEditsFailedContextKey.negate(), ContextKeyExpr.and(hasAppliedChatEditsContextKey, hasUndecidedChatEditingResourceContextKey, CONTEXT_CHAT_LOCATION.isEqualTo(ChatAgentLocation.Panel)))
				}
			],
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]): Promise<void> {
		const chatEditingService = accessor.get(IAideAgentEditingService);
		const currentEditingSession = chatEditingService.currentEditingSession;
		if (!currentEditingSession) {
			return;
		}
		await currentEditingSession.show();
	}
}
registerAction2(ChatEditingShowChangesAction);

registerAction2(class RemoveAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.aideAgent.undoEdits',
			title: localize2('chat.undoEdits.label', "Revert until here"),
			f1: false,
			category: CHAT_CATEGORY,
			icon: Codicon.discard,
			keybinding: {
				primary: KeyCode.Delete,
				mac: {
					primary: KeyMod.CtrlCmd | KeyCode.Backspace,
				},
				when: ContextKeyExpr.and(CONTEXT_CHAT_LOCATION.isEqualTo(ChatAgentLocation.Panel), CONTEXT_IN_CHAT_SESSION, CONTEXT_IN_CHAT_INPUT.negate()),
				weight: KeybindingWeight.WorkbenchContrib,
			},
			menu: [
				{
					id: MenuId.AideAgentMessageTitle,
					group: 'navigation',
					order: 2,
					when: ContextKeyExpr.and(CONTEXT_CHAT_LOCATION.isEqualTo(ChatAgentLocation.Panel))
				}
			]
		});
	}

	async run(accessor: ServicesAccessor, ...args: any[]) {
		let item: ChatTreeItem | undefined = args[0];
		if (!isResponseVM(item) && !isRequestVM(item)) {
			const chatWidgetService = accessor.get(IAideAgentWidgetService);
			const widget = chatWidgetService.lastFocusedWidget;
			item = widget?.getFocus();
		}
		if (!item) {
			return;
		}

		const chatEditingService = accessor.get(IAideAgentEditingService);
		const chatService = accessor.get(IAideAgentService);
		const chatModel = chatService.getSession(item.sessionId);
		if (chatModel?.initialLocation !== ChatAgentLocation.Panel) {
			return;
		}

		const session = chatEditingService.currentEditingSession;
		if (!session) {
			return;
		}

		const exchangeId = item.id;
		if (exchangeId) {
			const chatExchanges = chatModel.getExchanges();
			const itemIndex = chatExchanges.findIndex(exchange => exchange.id === exchangeId);
			const exchangesToRemove = chatExchanges.slice(itemIndex);

			// Restore the snapshot to what it was before the exchange(s) that we deleted
			const snapshotExchangeId = chatExchanges[itemIndex].id;
			await session.restoreSnapshot(snapshotExchangeId);

			// Remove the request and all that come after it
			for (const exchange of exchangesToRemove) {
				await chatService.removeExchange(item.sessionId, exchange.id);
			}
		}
	}
});
