/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Codicon } from '../../../../base/common/codicons.js';
import { dirname, isEqual } from '../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../base/common/themables.js';
import { hasKey } from '../../../../base/common/types.js';
import { URI } from '../../../../base/common/uri.js';
import { localize } from '../../../../nls.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../platform/label/common/label.js';
import { registerIcon } from '../../../../platform/theme/common/iconRegistry.js';
import { EditorInputCapabilities, GroupIdentifier, IRevertOptions, IUntypedEditorInput, Verbosity } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { ITextFileSaveOptions, ITextFileService } from '../../../services/textfile/common/textfiles.js';
import { NORIPAN_CANVAS_EDITOR_ID, NORIPAN_CANVAS_INPUT_ID, type INoripanCanvasDocument, normalizeNoripanCanvasDocument, serializeNoripanCanvasDocument } from './noripanCanvas.js';

const noripanCanvasIcon = registerIcon('noripan-canvas-editor-label-icon', Codicon.layoutPanelJustify, localize('noripanCanvasEditorLabelIcon', 'Icon of the Noripan canvas editor label.'));

export class NoripanCanvasEditorInput extends EditorInput {

	static readonly ID = NORIPAN_CANVAS_INPUT_ID;

	private documentState: INoripanCanvasDocument | undefined;
	private dirty = false;

	override get typeId(): string {
		return NoripanCanvasEditorInput.ID;
	}

	override get editorId(): string {
		return NORIPAN_CANVAS_EDITOR_ID;
	}

	override get capabilities(): EditorInputCapabilities {
		return EditorInputCapabilities.CanSplitInGroup;
	}

	constructor(
		readonly resource: URI,
		@ITextFileService private readonly textFileService: ITextFileService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ILabelService private readonly labelService: ILabelService
	) {
		super();
	}

	override getName(): string {
		return this.labelService.getUriBasenameLabel(this.resource);
	}

	override getDescription(verbosity = Verbosity.MEDIUM): string | undefined {
		const parent = dirname(this.resource);
		switch (verbosity) {
			case Verbosity.SHORT:
				return this.labelService.getUriBasenameLabel(parent);
			case Verbosity.LONG:
				return this.labelService.getUriLabel(parent);
			case Verbosity.MEDIUM:
			default:
				return this.labelService.getUriLabel(parent, { relative: true });
		}
	}

	override getTitle(verbosity = Verbosity.MEDIUM): string {
		switch (verbosity) {
			case Verbosity.SHORT:
				return this.getName();
			case Verbosity.LONG:
				return this.labelService.getUriLabel(this.resource);
			case Verbosity.MEDIUM:
			default:
				return this.labelService.getUriLabel(this.resource, { relative: true });
		}
	}

	override getIcon(): ThemeIcon {
		return noripanCanvasIcon;
	}

	override isDirty(): boolean {
		return this.dirty;
	}

	async resolveCanvasDocument(options?: { forceReadFromDisk?: boolean }): Promise<INoripanCanvasDocument> {
		if (!this.documentState || options?.forceReadFromDisk) {
			const content = await this.textFileService.read(this.resource, { acceptTextOnly: true });
			this.documentState = normalizeNoripanCanvasDocument(JSON.parse(content.value));
		}

		return this.cloneDocument(this.documentState);
	}

	getDocument(): INoripanCanvasDocument {
		return this.cloneDocument(this.documentState ?? normalizeNoripanCanvasDocument(undefined));
	}

	setDocument(document: INoripanCanvasDocument, dirty: boolean): void {
		this.documentState = this.cloneDocument(document);
		this.setDirty(dirty);
	}

	override async save(group: GroupIdentifier, options?: ITextFileSaveOptions): Promise<EditorInput | undefined> {
		await this.textFileService.write(this.resource, serializeNoripanCanvasDocument(this.documentState ?? normalizeNoripanCanvasDocument(undefined)), options);
		this.setDirty(false);
		return this;
	}

	override async saveAs(group: GroupIdentifier, options?: ITextFileSaveOptions): Promise<EditorInput | undefined> {
		const target = await this.fileDialogService.pickFileToSave(this.resource, options?.availableFileSystems);
		if (!target) {
			return undefined;
		}

		await this.textFileService.write(target, serializeNoripanCanvasDocument(this.documentState ?? normalizeNoripanCanvasDocument(undefined)), options);
		this.setDirty(false);
		return this.instantiationService.createInstance(NoripanCanvasEditorInput, target);
	}

	override async revert(group: GroupIdentifier, options?: IRevertOptions): Promise<void> {
		if (options?.soft) {
			this.setDirty(false);
			return;
		}

		this.documentState = undefined;
		await this.resolveCanvasDocument();
		this.setDirty(false);
	}

	override matches(other: EditorInput | IUntypedEditorInput): boolean {
		if (other instanceof NoripanCanvasEditorInput) {
			return isEqual(other.resource, this.resource);
		}

		if (typeof other === 'object' && other && hasKey(other, { resource: true }) && other.resource instanceof URI) {
			return isEqual(other.resource, this.resource);
		}

		return false;
	}

	override toUntyped(): IUntypedEditorInput {
		return {
			resource: this.resource,
			options: {
				override: this.editorId,
				pinned: true
			}
		};
	}

	private setDirty(dirty: boolean): void {
		if (this.dirty !== dirty) {
			this.dirty = dirty;
			this._onDidChangeDirty.fire();
		}
	}

	private cloneDocument(document: INoripanCanvasDocument): INoripanCanvasDocument {
		return normalizeNoripanCanvasDocument(JSON.parse(serializeNoripanCanvasDocument(document)));
	}
}
