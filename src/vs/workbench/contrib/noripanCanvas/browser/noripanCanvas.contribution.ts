/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import './media/noripanCanvas.css';
import { joinPath } from '../../../../base/common/resources.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize, localize2 } from '../../../../nls.js';
import { Action2, MenuId, MenuRegistry, registerAction2 } from '../../../../platform/actions/common/actions.js';
import { ContextKeyExpr } from '../../../../platform/contextkey/common/contextkey.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { SyncDescriptor } from '../../../../platform/instantiation/common/descriptors.js';
import { IInstantiationService, ServicesAccessor } from '../../../../platform/instantiation/common/instantiation.js';
import { INotificationService } from '../../../../platform/notification/common/notification.js';
import { Registry } from '../../../../platform/registry/common/platform.js';
import { IWorkspaceContextService } from '../../../../platform/workspace/common/workspace.js';
import { EditorPaneDescriptor, IEditorPaneRegistry } from '../../../browser/editor.js';
import { ResourceContextKey } from '../../../common/contextkeys.js';
import { IWorkbenchContribution, registerWorkbenchContribution2, WorkbenchPhase } from '../../../common/contributions.js';
import { EditorExtensions, IEditorFactoryRegistry, IEditorSerializer } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ExplorerFolderContext } from '../../files/common/files.js';
import { IEditorService } from '../../../services/editor/common/editorService.js';
import { IEditorResolverService, RegisteredEditorPriority } from '../../../services/editor/common/editorResolverService.js';
import { ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { NoripanCanvasEditor } from './noripanCanvasEditor.js';
import { NoripanCanvasEditorInput } from './noripanCanvasEditorInput.js';
import { DEFAULT_NORIPAN_CANVAS_DOCUMENT, NORIPAN_CANVAS_EDITOR_ID, NORIPAN_CANVAS_FILE_EXTENSION, NORIPAN_CANVAS_GLOB, NORIPAN_CANVAS_INPUT_ID, serializeNoripanCanvasDocument } from './noripanCanvas.js';

Registry.as<IEditorPaneRegistry>(EditorExtensions.EditorPane).registerEditorPane(
	EditorPaneDescriptor.create(
		NoripanCanvasEditor,
		NORIPAN_CANVAS_EDITOR_ID,
		localize('noripanCanvas.editor', 'Noripan Canvas')
	),
	[
		new SyncDescriptor(NoripanCanvasEditorInput)
	]
);

class NoripanCanvasEditorInputSerializer implements IEditorSerializer {
	canSerialize(editor: EditorInput): editor is NoripanCanvasEditorInput {
		return editor instanceof NoripanCanvasEditorInput;
	}

	serialize(editor: EditorInput): string | undefined {
		if (!this.canSerialize(editor)) {
			return undefined;
		}

		return editor.resource.toString();
	}

	deserialize(instantiationService: IInstantiationService, serializedEditor: string): EditorInput | undefined {
		return instantiationService.createInstance(NoripanCanvasEditorInput, URI.parse(serializedEditor));
	}
}

Registry.as<IEditorFactoryRegistry>(EditorExtensions.EditorFactory).registerEditorSerializer(NORIPAN_CANVAS_INPUT_ID, NoripanCanvasEditorInputSerializer);

class NoripanCanvasResolverContribution implements IWorkbenchContribution {

	static readonly ID = 'workbench.contrib.noripanCanvasResolver';

	constructor(
		@IEditorResolverService editorResolverService: IEditorResolverService,
		@IInstantiationService instantiationService: IInstantiationService
	) {
		editorResolverService.registerEditor(
			NORIPAN_CANVAS_GLOB,
			{
				id: NORIPAN_CANVAS_EDITOR_ID,
				label: localize('noripanCanvas.displayName', 'Noripan Canvas'),
				priority: RegisteredEditorPriority.default
			},
			{},
			{
				createEditorInput: editor => ({
					editor: instantiationService.createInstance(NoripanCanvasEditorInput, editor.resource),
					options: { pinned: true }
				})
			}
		);
	}
}

registerWorkbenchContribution2(NoripanCanvasResolverContribution.ID, NoripanCanvasResolverContribution, WorkbenchPhase.BlockRestore);

class NewNoripanCanvasAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.noripanCanvas.new',
			title: localize2('newNoripanCanvas', 'New Noripan Canvas'),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		await createNoripanCanvas(accessor);
	}
}

async function createNoripanCanvas(accessor: ServicesAccessor): Promise<NoripanCanvasEditor | undefined> {
	const workspaceContextService = accessor.get(IWorkspaceContextService);
	const fileService = accessor.get(IFileService);
	const textFileService = accessor.get(ITextFileService);
	const editorService = accessor.get(IEditorService);
	const notificationService = accessor.get(INotificationService);

	const workspaceFolder = workspaceContextService.getWorkspace().folders[0];
	if (!workspaceFolder) {
		notificationService.error(localize('noripanCanvas.workspaceRequired', 'Noripan Canvas requires an open workspace folder.'));
		return undefined;
	}

	const canvasDirectory = joinPath(workspaceFolder.uri, '.noripan');
	await fileService.createFolder(canvasDirectory);

	let index = 1;
	let resource = joinPath(canvasDirectory, `canvas-${index}${NORIPAN_CANVAS_FILE_EXTENSION}`);
	while (await fileService.exists(resource)) {
		index++;
		resource = joinPath(canvasDirectory, `canvas-${index}${NORIPAN_CANVAS_FILE_EXTENSION}`);
	}

	await textFileService.write(resource, serializeNoripanCanvasDocument(DEFAULT_NORIPAN_CANVAS_DOCUMENT));
	const editorPane = await editorService.openEditor({
		resource,
		options: {
			override: NORIPAN_CANVAS_EDITOR_ID,
			pinned: true
		}
	});

	return editorPane instanceof NoripanCanvasEditor ? editorPane : undefined;
}

function getResourceFromActionArgs(args: unknown[]): URI | undefined {
	for (const arg of args) {
		if (arg instanceof URI) {
			return arg;
		}

		const candidate = arg && typeof arg === 'object' ? arg : undefined;
		if (candidate && hasKey(candidate, { resource: true })) {
			const resource = candidate.resource;
			if (resource instanceof URI) {
				return resource;
			}
		}
	}

	return undefined;
}

class AddTerminalToNoripanCanvasAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.noripanCanvas.addTerminalSurface',
			title: localize2('addTerminalSurface', 'Noripan Canvas: Add Terminal Surface'),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activeEditorPane = editorService.activeEditorPane;
		if (activeEditorPane instanceof NoripanCanvasEditor) {
			await activeEditorPane.addTerminalSurface();
		}
	}
}

class AddFileToNoripanCanvasAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.noripanCanvas.addFileSurface',
			title: localize2('addFileSurface', 'Noripan Canvas: Add File Surface'),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activeEditorPane = editorService.activeEditorPane;
		if (activeEditorPane instanceof NoripanCanvasEditor) {
			await activeEditorPane.addTextFileSurface();
		}
	}
}

class AddBrowserToNoripanCanvasAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.noripanCanvas.addBrowserSurface',
			title: localize2('addBrowserSurface', 'Noripan Canvas: Add Browser Surface'),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor): Promise<void> {
		const editorService = accessor.get(IEditorService);
		const activeEditorPane = editorService.activeEditorPane;
		if (activeEditorPane instanceof NoripanCanvasEditor) {
			await activeEditorPane.addBrowserSurface();
		}
	}
}

class OpenFileInNoripanCanvasAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.noripanCanvas.openFileSurface',
			title: localize2('openFileInNoripanCanvas', 'Open in Noripan Canvas'),
			f1: true
		});
	}

	override async run(accessor: ServicesAccessor, ...args: unknown[]): Promise<void> {
		const resource = getResourceFromActionArgs(args);
		if (!resource) {
			return;
		}

		const editorService = accessor.get(IEditorService);
		let canvasEditor: NoripanCanvasEditor | undefined = editorService.activeEditorPane instanceof NoripanCanvasEditor ? editorService.activeEditorPane : undefined;
		if (!canvasEditor) {
			canvasEditor = await createNoripanCanvas(accessor);
		}

		await canvasEditor?.addTextFileSurface(resource);
	}
}

class ZoomInNoripanCanvasAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.noripanCanvas.zoomIn',
			title: localize2('noripanCanvasZoomIn', 'Noripan Canvas: Zoom In'),
			f1: true
		});
	}

	override run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		if (editorService.activeEditorPane instanceof NoripanCanvasEditor) {
			editorService.activeEditorPane.zoomIn();
		}
	}
}

class ZoomOutNoripanCanvasAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.noripanCanvas.zoomOut',
			title: localize2('noripanCanvasZoomOut', 'Noripan Canvas: Zoom Out'),
			f1: true
		});
	}

	override run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		if (editorService.activeEditorPane instanceof NoripanCanvasEditor) {
			editorService.activeEditorPane.zoomOut();
		}
	}
}

class ResetZoomNoripanCanvasAction extends Action2 {
	constructor() {
		super({
			id: 'workbench.action.noripanCanvas.resetZoom',
			title: localize2('noripanCanvasResetZoom', 'Noripan Canvas: Reset Zoom'),
			f1: true
		});
	}

	override run(accessor: ServicesAccessor): void {
		const editorService = accessor.get(IEditorService);
		if (editorService.activeEditorPane instanceof NoripanCanvasEditor) {
			editorService.activeEditorPane.resetZoom();
		}
	}
}

registerAction2(NewNoripanCanvasAction);
registerAction2(AddTerminalToNoripanCanvasAction);
registerAction2(AddFileToNoripanCanvasAction);
registerAction2(AddBrowserToNoripanCanvasAction);
registerAction2(OpenFileInNoripanCanvasAction);
registerAction2(ZoomInNoripanCanvasAction);
registerAction2(ZoomOutNoripanCanvasAction);
registerAction2(ResetZoomNoripanCanvasAction);

MenuRegistry.appendMenuItem(MenuId.ExplorerContext, {
	group: 'navigation',
	order: 45,
	command: {
		id: 'workbench.action.noripanCanvas.openFileSurface',
		title: localize2('openFileInNoripanCanvasMenu', 'Open in Noripan Canvas')
	},
	when: ContextKeyExpr.and(ResourceContextKey.HasResource, ExplorerFolderContext.toNegated())
});
