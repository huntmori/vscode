/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import * as dom from '../../../../base/browser/dom.js';
import { RunOnceScheduler } from '../../../../base/common/async.js';
import { StandardMouseEvent } from '../../../../base/browser/mouseEvent.js';
import { Action } from '../../../../base/common/actions.js';
import { CancellationToken } from '../../../../base/common/cancellation.js';
import { DisposableStore, toDisposable, type IDisposable, type IReference } from '../../../../base/common/lifecycle.js';
import { basenameOrAuthority } from '../../../../base/common/resources.js';
import { URI } from '../../../../base/common/uri.js';
import { generateUuid } from '../../../../base/common/uuid.js';
import { CodeEditorWidget } from '../../../../editor/browser/widget/codeEditor/codeEditorWidget.js';
import { IResolvedTextEditorModel, ITextModelService } from '../../../../editor/common/services/resolverService.js';
import { getZoomFactor } from '../../../../base/browser/browser.js';
import { localize } from '../../../../nls.js';
import { IContextMenuService } from '../../../../platform/contextview/browser/contextView.js';
import { IFileDialogService } from '../../../../platform/dialogs/common/dialogs.js';
import { IEditorOptions } from '../../../../platform/editor/common/editor.js';
import { IFileService } from '../../../../platform/files/common/files.js';
import { IInstantiationService } from '../../../../platform/instantiation/common/instantiation.js';
import { ILogService } from '../../../../platform/log/common/log.js';
import { IQuickInputService } from '../../../../platform/quickinput/common/quickInput.js';
import { IStorageService } from '../../../../platform/storage/common/storage.js';
import { ITelemetryService } from '../../../../platform/telemetry/common/telemetry.js';
import { IThemeService } from '../../../../platform/theme/common/themeService.js';
import { EditorPane } from '../../../browser/parts/editor/editorPane.js';
import { IEditorOpenContext } from '../../../common/editor.js';
import { EditorInput } from '../../../common/editor/editorInput.js';
import { IEditorGroup } from '../../../services/editor/common/editorGroupsService.js';
import { BrowserEditorInput } from '../../browserView/common/browserEditorInput.js';
import { IBrowserViewModel, IBrowserViewWorkbenchService } from '../../browserView/common/browserView.js';
import { TerminalExitReason } from '../../../../platform/terminal/common/terminal.js';
import { ITerminalInstance, ITerminalService } from '../../terminal/browser/terminal.js';
import { NoripanCanvasEditorInput } from './noripanCanvasEditorInput.js';
import { clampNoripanCanvasZoom, NORIPAN_CANVAS_DOCUMENT_VERSION, NORIPAN_CANVAS_EDITOR_ID, NORIPAN_CANVAS_HEADER_HEIGHT, NORIPAN_CANVAS_ORIGIN_OFFSET, type INoripanCanvasBrowserSurface, type INoripanCanvasDocument, type INoripanCanvasSurface, type INoripanCanvasTerminalSurface, type INoripanCanvasTextEditorSurface } from './noripanCanvas.js';
import { normalizeNoripanCanvasBrowserUrl, rectsIntersect, resizeNoripanCanvasSurface, toSurfaceRect, type ICanvasRect, type ISurfaceResizeDirection } from './noripanCanvasSurfaceUtils.js';

const MINIMAP_WIDTH = 180;
const MINIMAP_HEIGHT = 120;
const ZOOM_STEP = 0.1;

export class NoripanCanvasEditor extends EditorPane {

	static readonly ID = NORIPAN_CANVAS_EDITOR_ID;

	private activeInput: NoripanCanvasEditorInput | undefined;
	private scrollElement!: HTMLElement;
	private canvasElement!: HTMLElement;
	private minimapElement!: HTMLElement;
	private minimapHandleElement!: HTMLElement;
	private minimapContentElement!: HTMLElement;
	private minimapViewportElement!: HTMLElement;
	private zoomLabelElement!: HTMLElement;
	private readonly renderDisposables = this._register(new DisposableStore());
	private readonly terminalInstances = new Map<string, ITerminalInstance>();
	private readonly textEditors = new Map<string, CodeEditorWidget>();
	private readonly textModelReferences = new Map<string, IReference<IResolvedTextEditorModel>>();
	private readonly browserInputs = new Map<string, BrowserEditorInput>();
	private readonly browserEventDisposables = new Map<string, IDisposable>();
	private readonly surfaceElements = new Map<string, HTMLElement>();
	private readonly surfaceBodyElements = new Map<string, HTMLElement>();
	private readonly terminalAttachElements = new Map<string, HTMLElement>();
	private readonly browserNoticeElements = new Map<HTMLElement, HTMLElement>();
	private readonly groupElements = new Set<HTMLElement>();
	private pendingOverlayDocument: INoripanCanvasDocument | undefined;
	private contextMenuVisible = false;
	private renderGeneration = 0;
	private readonly overlayRenderScheduler = this._register(new RunOnceScheduler(() => {
		const document = this.pendingOverlayDocument ?? this.activeInput?.getDocument();
		this.pendingOverlayDocument = undefined;
		if (!document) {
			return;
		}

		this.renderSurfaceGroups(document);
		this.renderMinimap(document);
	}, 0));
	private readonly autosaveScheduler = this._register(new RunOnceScheduler(() => {
		void this.saveActiveInput();
	}, 750));

	constructor(
		group: IEditorGroup,
		@ITelemetryService telemetryService: ITelemetryService,
		@IThemeService themeService: IThemeService,
		@IStorageService storageService: IStorageService,
		@IFileService private readonly fileService: IFileService,
		@ILogService private readonly logService: ILogService,
		@ITerminalService private readonly terminalService: ITerminalService,
		@IContextMenuService private readonly contextMenuService: IContextMenuService,
		@IInstantiationService private readonly instantiationService: IInstantiationService,
		@ITextModelService private readonly textModelService: ITextModelService,
		@IFileDialogService private readonly fileDialogService: IFileDialogService,
		@IQuickInputService private readonly quickInputService: IQuickInputService,
		@IBrowserViewWorkbenchService private readonly browserViewWorkbenchService: IBrowserViewWorkbenchService
	) {
		super(NoripanCanvasEditor.ID, group, telemetryService, themeService, storageService);
	}

	override async setInput(input: EditorInput, options: IEditorOptions | undefined, context: IEditorOpenContext, token: CancellationToken): Promise<void> {
		if (!(input instanceof NoripanCanvasEditorInput)) {
			throw new Error('NoripanCanvasEditor received an unexpected input type');
		}

		this.activeInput = input;
		await super.setInput(input, options, context, token);
		try {
			const document = await input.resolveCanvasDocument();
			if (!token.isCancellationRequested) {
				this.render(document);
			}
		} catch (error) {
			this.renderError(error);
		}
	}

	override clearInput(): void {
		super.clearInput();
		this.activeInput = undefined;
		this.renderDisposables.clear();
		this.disposeTerminals();
		this.disposeTextEditorResources();
		this.disposeBrowserSurfaces();
		this.clearSurfaceElementReferences();
		dom.clearNode(this.canvasElement);
		dom.clearNode(this.minimapContentElement);
	}

	protected createEditor(parent: HTMLElement): void {
		parent.classList.add('noripan-canvas-editor');

		const toolbar = dom.append(parent, dom.$('.noripan-canvas-toolbar'));
		const addTerminalLabel = localize('noripanCanvas.addTerminal', 'Add Terminal');
		const addFileLabel = localize('noripanCanvas.addFile', 'Add File');
		const addBrowserLabel = localize('noripanCanvas.addBrowser', 'Add Browser');
		const zoomOutLabel = localize('noripanCanvas.zoomOut', 'Zoom Out');
		const zoomInLabel = localize('noripanCanvas.zoomIn', 'Zoom In');
		const resetZoomLabel = localize('noripanCanvas.resetZoom', 'Reset Zoom');
		const addTerminalButton = dom.append(toolbar, dom.$('button.noripan-canvas-toolbar-button', { type: 'button', title: addTerminalLabel, 'aria-label': addTerminalLabel }, addTerminalLabel));
		const addFileButton = dom.append(toolbar, dom.$('button.noripan-canvas-toolbar-button', { type: 'button', title: addFileLabel, 'aria-label': addFileLabel }, addFileLabel));
		const addBrowserButton = dom.append(toolbar, dom.$('button.noripan-canvas-toolbar-button', { type: 'button', title: addBrowserLabel, 'aria-label': addBrowserLabel }, addBrowserLabel));
		const zoomOutButton = dom.append(toolbar, dom.$('button.noripan-canvas-toolbar-button', { type: 'button', title: zoomOutLabel, 'aria-label': zoomOutLabel }, '-'));
		this.zoomLabelElement = dom.append(toolbar, dom.$('span.noripan-canvas-zoom-label', undefined, '100%'));
		const zoomInButton = dom.append(toolbar, dom.$('button.noripan-canvas-toolbar-button', { type: 'button', title: zoomInLabel, 'aria-label': zoomInLabel }, '+'));
		const resetZoomButton = dom.append(toolbar, dom.$('button.noripan-canvas-toolbar-button', { type: 'button', title: resetZoomLabel, 'aria-label': resetZoomLabel }, resetZoomLabel));
		this.scrollElement = dom.append(parent, dom.$('.noripan-canvas-scroll', { tabIndex: 0 }));
		this.canvasElement = dom.append(this.scrollElement, dom.$('.noripan-canvas-root'));
		this.minimapElement = dom.append(parent, dom.$('.noripan-canvas-minimap'));
		this.minimapHandleElement = dom.append(this.minimapElement, dom.$('.noripan-canvas-minimap-handle', undefined, localize('noripanCanvas.minimap', 'Map')));
		this.minimapContentElement = dom.append(this.minimapElement, dom.$('.noripan-canvas-minimap-content'));
		this.minimapViewportElement = dom.append(this.minimapElement, dom.$('.noripan-canvas-minimap-viewport'));

		this._register(dom.addDisposableListener(addTerminalButton, dom.EventType.CLICK, () => void this.addTerminalSurface()));
		this._register(dom.addDisposableListener(addFileButton, dom.EventType.CLICK, () => void this.addTextFileSurface()));
		this._register(dom.addDisposableListener(addBrowserButton, dom.EventType.CLICK, () => void this.addBrowserSurface()));
		this._register(dom.addDisposableListener(zoomOutButton, dom.EventType.CLICK, () => this.zoomOut()));
		this._register(dom.addDisposableListener(zoomInButton, dom.EventType.CLICK, () => this.zoomIn()));
		this._register(dom.addDisposableListener(resetZoomButton, dom.EventType.CLICK, () => this.resetZoom()));
		this._register(dom.addDisposableListener(this.scrollElement, dom.EventType.SCROLL, () => {
			this.updateMinimapViewport();
			this.layoutBrowserSurfaces();
		}));
		this._register(dom.addDisposableListener(this.scrollElement, dom.EventType.WHEEL, (event: WheelEvent) => this.handleCanvasWheel(event), true));
		this._register(dom.addDisposableListener(this.minimapElement, dom.EventType.POINTER_DOWN, event => this.moveViewportFromMinimap(event)));
		this._register(dom.addDisposableListener(this.minimapHandleElement, dom.EventType.POINTER_DOWN, event => this.moveMinimap(event)));
		this._register(this.fileService.onDidFilesChange(e => {
			if (!this.activeInput || this.activeInput.isDirty() || !e.contains(this.activeInput.resource)) {
				return;
			}

			void this.reloadActiveInputFromDisk();
		}));
		this._register(this.contextMenuService.onDidShowContextMenu(() => {
			this.contextMenuVisible = true;
			this.hideBrowserSurfaces();
		}));
		this._register(this.contextMenuService.onDidHideContextMenu(() => {
			this.contextMenuVisible = false;
			this.layoutBrowserSurfaces();
		}));
	}

	override setEditorVisible(visible: boolean): void {
		for (const instance of this.terminalInstances.values()) {
			instance.setVisible(visible);
		}
		if (!visible) {
			for (const input of this.browserInputs.values()) {
				void input.model?.setVisible(false);
			}
			return;
		}
		if (visible) {
			for (const editor of this.textEditors.values()) {
				editor.render();
			}
			this.layoutSurfaceBodies();
			this.layoutBrowserSurfaces();
		}
	}

	layout(_dimension: dom.Dimension): void {
		this.layoutSurfaceBodies();
		this.layoutBrowserSurfaces();
		this.updateMinimapViewport();
	}

	override focus(): void {
		super.focus();
		const firstTextEditor = this.textEditors.values().next().value;
		if (firstTextEditor) {
			firstTextEditor.focus();
			return;
		}

		const firstTerminal = this.terminalInstances.values().next().value;
		if (firstTerminal) {
			firstTerminal.focus(true);
			return;
		}

		this.scrollElement.focus();
	}

	async addTerminalSurface(): Promise<void> {
		if (!this.activeInput) {
			return;
		}

		const document = this.activeInput.getDocument();
		const zIndex = Math.max(0, ...document.surfaces.map(surface => surface.zIndex)) + 1;
		const position = this.getNextSurfacePosition(document, 720, 420);
		const nextSurface: INoripanCanvasTerminalSurface = {
			id: generateUuid(),
			type: 'terminal',
			title: localize('noripanCanvas.terminalTitle', 'Terminal'),
			x: position.x,
			y: position.y,
			width: 720,
			height: 420,
			zIndex
		};

		this.updateDocument({ version: NORIPAN_CANVAS_DOCUMENT_VERSION, surfaces: [...document.surfaces, nextSurface] });
	}

	async addBrowserSurface(url?: string): Promise<void> {
		if (!this.activeInput) {
			return;
		}

		url = url ?? await this.quickInputService.input({
			placeHolder: 'https://example.com',
			prompt: localize('noripanCanvas.browserUrl', 'Enter a URL to open in the canvas')
		});
		if (!url) {
			return;
		}

		const normalizedUrl = normalizeNoripanCanvasBrowserUrl(url);
		const document = this.activeInput.getDocument();
		const zIndex = Math.max(0, ...document.surfaces.map(surface => surface.zIndex)) + 1;
		const position = this.getNextSurfacePosition(document, 960, 640);
		const nextSurface: INoripanCanvasBrowserSurface = {
			id: generateUuid(),
			type: 'browser',
			title: normalizedUrl,
			url: normalizedUrl,
			x: position.x,
			y: position.y,
			width: 960,
			height: 640,
			zIndex
		};

		this.updateDocument({ version: NORIPAN_CANVAS_DOCUMENT_VERSION, surfaces: [...document.surfaces, nextSurface] });
	}

	async addTextFileSurface(resource?: URI): Promise<void> {
		if (!this.activeInput) {
			return;
		}

		if (!resource) {
			const selected = await this.fileDialogService.showOpenDialog({
				title: localize('noripanCanvas.pickFile', 'Add File to Noripan Canvas'),
				canSelectFiles: true,
				canSelectFolders: false,
				canSelectMany: false,
			});
			resource = selected?.[0];
		}

		if (!resource || !this.textModelService.canHandleResource(resource)) {
			return;
		}

		const document = this.activeInput.getDocument();
		const zIndex = Math.max(0, ...document.surfaces.map(surface => surface.zIndex)) + 1;
		const position = this.getNextSurfacePosition(document, 820, 520);
		const nextSurface: INoripanCanvasTextEditorSurface = {
			id: generateUuid(),
			type: 'text-editor',
			title: basenameOrAuthority(resource),
			resource,
			x: position.x,
			y: position.y,
			width: 820,
			height: 520,
			zIndex
		};

		this.updateDocument({ version: NORIPAN_CANVAS_DOCUMENT_VERSION, surfaces: [...document.surfaces, nextSurface] });
	}

	zoomIn(): void {
		this.changeZoom(ZOOM_STEP);
	}

	zoomOut(): void {
		this.changeZoom(-ZOOM_STEP);
	}

	resetZoom(): void {
		this.setZoom(1);
	}

	private handleCanvasWheel(event: WheelEvent): void {
		if (!event.ctrlKey && !event.metaKey) {
			return;
		}

		event.preventDefault();
		this.applyCanvasWheelZoom(event.deltaY);
	}

	private applyCanvasWheelZoom(deltaY: number): void {
		const delta = deltaY > 0 ? -ZOOM_STEP : ZOOM_STEP;
		this.changeZoom(delta);
	}

	private render(document: INoripanCanvasDocument): void {
		const generation = ++this.renderGeneration;
		this.renderDisposables.clear();
		// Text editor widgets are bound to a specific DOM node, so rebuild them when the canvas DOM
		// is regenerated while keeping the underlying text model references alive.
		this.disposeTextEditors();
		this.clearSurfaceElementReferences();
		dom.clearNode(this.canvasElement);
		this.applyZoom(document);
		this.applyMinimapPosition(document);
		this.syncCanvasBounds(document);

		const message = document.surfaces.length === 0
			? localize('noripanCanvas.empty', 'Create surfaces on this canvas. Terminal and text file surfaces are available in the current slice.')
			: '';
		dom.append(this.canvasElement, dom.$('.noripan-canvas-message', undefined, message));
		this.renderSurfaceGroups(document);

		for (const surface of this.sortSurfaces(document.surfaces)) {
			const element = dom.append(this.canvasElement, dom.$('.noripan-canvas-surface'));
			this.surfaceElements.set(surface.id, element);
			element.dataset.surfaceId = surface.id;
			element.setAttribute('role', 'group');
			element.setAttribute('aria-label', localize('noripanCanvas.surfaceRegion', '{0} surface', surface.title));
			element.style.left = `${NORIPAN_CANVAS_ORIGIN_OFFSET + surface.x}px`;
			element.style.top = `${NORIPAN_CANVAS_ORIGIN_OFFSET + surface.y}px`;
			element.style.width = `${surface.width}px`;
			element.style.height = `${surface.minimized ? NORIPAN_CANVAS_HEADER_HEIGHT : surface.height}px`;
			element.style.zIndex = String(surface.zIndex);
			element.classList.toggle('minimized', surface.minimized === true);

			const headerLabel = localize('noripanCanvas.surfaceHeader', '{0} surface. Drag to move or use arrow keys to reposition.', surface.title);
			const header = dom.append(element, dom.$('.noripan-canvas-surface-header', { tabIndex: 0, role: 'button', 'aria-label': headerLabel }));
			dom.append(header, dom.$('.noripan-canvas-surface-drag-handle', { 'aria-hidden': 'true' }));
			dom.append(header, dom.$('.noripan-canvas-surface-title', undefined, surface.title));
			const actions = dom.append(header, dom.$('.noripan-canvas-surface-actions'));
			const minimizeLabel = surface.minimized ? localize('noripanCanvas.surface.restore', 'Restore') : localize('noripanCanvas.surface.minimize', 'Minimize');
			const closeLabel = localize('noripanCanvas.surface.close', 'Close');
			const minimizeButton = dom.append(actions, dom.$('button.noripan-canvas-surface-action', { type: 'button', title: minimizeLabel, 'aria-label': minimizeLabel, 'aria-pressed': String(surface.minimized === true) }, surface.minimized ? '+' : '-'));
			const closeButton = dom.append(actions, dom.$('button.noripan-canvas-surface-action', { type: 'button', title: closeLabel, 'aria-label': closeLabel }, 'x'));
			const body = dom.append(element, dom.$('.noripan-canvas-surface-body'));
			this.surfaceBodyElements.set(surface.id, body);
			const resizeHandles = [
				{ direction: 'n' as const },
				{ direction: 'e' as const },
				{ direction: 's' as const },
				{ direction: 'w' as const },
				{ direction: 'ne' as const },
				{ direction: 'nw' as const },
				{ direction: 'se' as const },
				{ direction: 'sw' as const }
			].map(({ direction }) => dom.append(element, dom.$(`.noripan-canvas-surface-resize.direction-${direction}`)));

			this.renderDisposables.add(this.registerSurfacePointerInteraction(surface.id, header, 'move'));
			this.renderDisposables.add(this.registerSurfaceKeyboardInteraction(surface.id, header));
			for (const resizeHandle of resizeHandles) {
				const direction = resizeHandle.className.match(/direction-([a-z]+)/)?.[1] as ISurfaceResizeDirection;
				this.renderDisposables.add(this.registerSurfacePointerInteraction(surface.id, resizeHandle, 'resize', direction));
			}
			this.renderDisposables.add(this.registerSurfaceContextMenu(surface.id, header));
			this.renderDisposables.add(this.registerSurfaceResizeObserver(surface, body));
			this.renderDisposables.add(dom.addDisposableListener(minimizeButton, dom.EventType.POINTER_DOWN, event => event.stopPropagation()));
			this.renderDisposables.add(dom.addDisposableListener(closeButton, dom.EventType.POINTER_DOWN, event => event.stopPropagation()));
			this.renderDisposables.add(dom.addDisposableListener(minimizeButton, dom.EventType.CLICK, event => {
				event.stopPropagation();
				this.toggleSurfaceMinimized(surface.id);
			}));
			this.renderDisposables.add(dom.addDisposableListener(closeButton, dom.EventType.CLICK, event => {
				event.stopPropagation();
				this.removeSurface(surface.id);
			}));
			this.renderDisposables.add(dom.addDisposableListener(element, dom.EventType.MOUSE_DOWN, () => this.focusSurface(surface.id)));

			if (surface.minimized) {
				continue;
			} else if (surface.type === 'terminal') {
				void this.attachTerminal(surface, body, generation);
			} else if (surface.type === 'browser') {
				void this.attachBrowser(surface, body, generation);
			} else {
				void this.attachTextEditor(surface, body, generation);
			}
		}

		this.renderMinimap(document);
		this.layoutSurfaceBodies();
		this.layoutBrowserSurfaces();
	}

	private renderError(error: unknown): void {
		this.renderDisposables.clear();
		dom.clearNode(this.canvasElement);
		dom.append(this.canvasElement, dom.$('.noripan-canvas-message.noripan-canvas-error', undefined, localize('noripanCanvas.invalidFile', 'Unable to open this canvas file. Fix the JSON and reopen it.')));
		this.logService.error('[NoripanCanvasEditor] Failed to load canvas', error);
	}

	private registerSurfacePointerInteraction(surfaceId: string, target: HTMLElement, mode: 'move' | 'resize', resizeDirection: ISurfaceResizeDirection = 'se') {
		return dom.addDisposableListener(target, dom.EventType.POINTER_DOWN, event => {
			if (!this.activeInput || event.button !== 0) {
				return;
			}

			event.preventDefault();
			target.setPointerCapture(event.pointerId);

			const startCanvasCoords = this.viewportToCanvasCoordinates(event.clientX, event.clientY);
			const startCanvasX = startCanvasCoords.canvasX;
			const startCanvasY = startCanvasCoords.canvasY;

			const baseDocument = this.activeInput.getDocument();
			const baseSurface = baseDocument.surfaces.find(surface => surface.id === surfaceId);
			if (!baseSurface) {
				return;
			}
			const minCanvasCoordinate = -NORIPAN_CANVAS_ORIGIN_OFFSET;
			const baseGroupSurfaces = baseSurface.groupId ? baseDocument.surfaces.filter(surface => surface.groupId === baseSurface.groupId) : [];

			const moveListener = dom.addDisposableListener(target, dom.EventType.POINTER_MOVE, moveEvent => {
				const currentCanvasCoords = this.viewportToCanvasCoordinates(moveEvent.clientX, moveEvent.clientY);
				const currentCanvasX = currentCanvasCoords.canvasX;
				const currentCanvasY = currentCanvasCoords.canvasY;

				const deltaX = currentCanvasX - startCanvasX;
				const deltaY = currentCanvasY - startCanvasY;

				if (mode === 'move' && baseSurface.groupId) {
					// Clamp group movement to the full canvas, including the top/left pre-origin area.
					const clampedDeltaX = Math.max(minCanvasCoordinate - baseSurface.x, deltaX);
					const clampedDeltaY = Math.max(minCanvasCoordinate - baseSurface.y, deltaY);
					if (clampedDeltaX !== deltaX || clampedDeltaY !== deltaY) {
						this.logService.trace(`[NoripanCanvasEditor] Group move delta clamped: (${deltaX.toFixed(1)}, ${deltaY.toFixed(1)}) -> (${clampedDeltaX.toFixed(1)}, ${clampedDeltaY.toFixed(1)})`);
					}
					this.patchSurfaceGroup(baseSurface.groupId, baseGroupSurfaces, clampedDeltaX, clampedDeltaY, false);
					return;
				}

				if (mode === 'move') {
					// Try with both deltas first
					const nextX = Math.max(minCanvasCoordinate, baseSurface.x + deltaX);
					let nextY = Math.max(minCanvasCoordinate, baseSurface.y + deltaY);
					const nextSurface = { ...baseSurface, x: nextX, y: nextY };

					// If there's a header collision, try vertical move only
					if (this.hasHeaderCollision(surfaceId, nextSurface)) {
						nextY = Math.max(minCanvasCoordinate, baseSurface.y + deltaY);
						const nextSurfaceVerticalOnly = { ...baseSurface, x: baseSurface.x, y: nextY };
						if (!this.hasHeaderCollision(surfaceId, nextSurfaceVerticalOnly)) {
							this.patchSurface(nextSurfaceVerticalOnly, false);
						}
						return;
					}

					this.patchSurface(nextSurface, false);
				} else {
					const nextSurface = resizeNoripanCanvasSurface(baseSurface, resizeDirection, deltaX, deltaY, minCanvasCoordinate);
					this.patchSurface(nextSurface, false);
				}
			});

			const stop = () => {
				if (target.hasPointerCapture(event.pointerId)) {
					target.releasePointerCapture(event.pointerId);
				}
				moveListener.dispose();
				upListener.dispose();
				cancelListener.dispose();
				const latest = this.activeInput?.getDocument().surfaces.find(surface => surface.id === surfaceId);
				if (latest) {
					if (mode === 'move' && baseSurface.groupId) {
						this.patchSurfaceGroup(baseSurface.groupId, baseGroupSurfaces, latest.x - baseSurface.x, latest.y - baseSurface.y, false);
					} else {
						this.patchSurface(latest, false);
					}
				}
			};

			const upListener = dom.addDisposableListener(target, dom.EventType.POINTER_UP, stop);
			const cancelListener = dom.addDisposableListener(target, dom.EventType.POINTER_LEAVE, stop);
		});
	}

	private registerSurfaceKeyboardInteraction(surfaceId: string, header: HTMLElement) {
		return dom.addDisposableListener(header, dom.EventType.KEY_DOWN, event => {
			if (!this.activeInput) {
				return;
			}

			const surface = this.activeInput.getDocument().surfaces.find(candidate => candidate.id === surfaceId);
			if (!surface) {
				return;
			}

			const step = event.shiftKey ? 80 : 24;
			switch (event.key) {
				case 'ArrowLeft':
					event.preventDefault();
					this.moveSurfaceByKeyboard(surface, -step, 0);
					break;
				case 'ArrowRight':
					event.preventDefault();
					this.moveSurfaceByKeyboard(surface, step, 0);
					break;
				case 'ArrowUp':
					event.preventDefault();
					this.moveSurfaceByKeyboard(surface, 0, -step);
					break;
				case 'ArrowDown':
					event.preventDefault();
					this.moveSurfaceByKeyboard(surface, 0, step);
					break;
				case 'Delete':
				case 'Backspace':
					event.preventDefault();
					this.removeSurface(surface.id);
					break;
				case ' ':
				case 'Enter':
					event.preventDefault();
					this.toggleSurfaceMinimized(surface.id);
					break;
			}
		});
	}

	private moveSurfaceByKeyboard(surface: INoripanCanvasSurface, deltaX: number, deltaY: number): void {
		if (surface.groupId && this.activeInput) {
			const groupSurfaces = this.activeInput.getDocument().surfaces.filter(candidate => candidate.groupId === surface.groupId);
			this.patchSurfaceGroup(surface.groupId, groupSurfaces, deltaX, deltaY, false);
			return;
		}

		this.patchSurface({ ...surface, x: surface.x + deltaX, y: surface.y + deltaY }, false);
	}

	private registerSurfaceContextMenu(surfaceId: string, header: HTMLElement) {
		return dom.addDisposableListener(header, dom.EventType.CONTEXT_MENU, event => {
			event.preventDefault();
			this.contextMenuService.showContextMenu({
				getAnchor: () => new StandardMouseEvent(this.window, event),
				getActions: () => [
					new Action('noripanCanvas.surface.bringToFront', localize('noripanCanvas.surface.bringToFront', 'Bring to Front'), undefined, true, async () => this.reorderSurface(surfaceId, 'front')),
					new Action('noripanCanvas.surface.sendToBack', localize('noripanCanvas.surface.sendToBack', 'Send to Back'), undefined, true, async () => this.reorderSurface(surfaceId, 'back')),
					new Action('noripanCanvas.surface.bringForward', localize('noripanCanvas.surface.bringForward', 'Bring Forward'), undefined, true, async () => this.reorderSurface(surfaceId, 'forward')),
					new Action('noripanCanvas.surface.sendBackward', localize('noripanCanvas.surface.sendBackward', 'Send Backward'), undefined, true, async () => this.reorderSurface(surfaceId, 'backward')),
					new Action('noripanCanvas.surface.groupNearby', localize('noripanCanvas.surface.groupNearby', 'Group Nearby Surfaces'), undefined, true, async () => this.groupNearbySurfaces(surfaceId)),
					new Action('noripanCanvas.surface.ungroup', localize('noripanCanvas.surface.ungroup', 'Ungroup'), undefined, true, async () => this.ungroupSurface(surfaceId)),
					new Action('noripanCanvas.surface.remove', localize('noripanCanvas.surface.remove', 'Remove Surface'), undefined, true, async () => this.removeSurface(surfaceId))
				]
			});
		});
	}

	private async attachTerminal(surface: INoripanCanvasTerminalSurface, body: HTMLElement, generation: number): Promise<void> {
		await this.whenSurfaceBodyReady(body);
		if (!this.isCurrentSurfaceBody(surface.id, body, generation)) {
			return;
		}
		const terminalAttachElement = this.ensureTerminalAttachElement(surface.id, body);

		let instance = this.terminalInstances.get(surface.id);
		if (!instance) {
			instance = await this.terminalService.createTerminal({ config: { name: surface.title } });
			if (!this.isCurrentSurfaceBody(surface.id, body, generation)) {
				instance.dispose(TerminalExitReason.User);
				return;
			}
			this.terminalService.moveToBackground(instance);
			this.terminalInstances.set(surface.id, instance);
		}

		instance.attachToElement(terminalAttachElement);
		instance.setVisible(this.isVisible());
		this.scheduleSurfaceLayout(surface.id, body);
	}

	private ensureTerminalAttachElement(surfaceId: string, body: HTMLElement): HTMLElement {
		body.classList.add('terminal-editor');
		body.dataset.surfaceTerminalId = surfaceId;
		let terminalAttachElement = this.terminalAttachElements.get(surfaceId);
		if (!terminalAttachElement) {
			terminalAttachElement = dom.append(body, dom.$('.terminal-overflow-guard.terminal-editor'));
			this.terminalAttachElements.set(surfaceId, terminalAttachElement);
		}

		return terminalAttachElement;
	}

	private async attachTextEditor(surface: INoripanCanvasTextEditorSurface, body: HTMLElement, generation: number): Promise<void> {
		await this.whenSurfaceBodyReady(body);
		if (!this.isCurrentSurfaceBody(surface.id, body, generation)) {
			return;
		}

		let editor = this.textEditors.get(surface.id);
		if (!editor) {
			editor = this.instantiationService.createInstance(CodeEditorWidget, body, {
				automaticLayout: false,
				scrollBeyondLastLine: false,
				minimap: { enabled: false },
				wordWrap: 'on',
				lineNumbers: 'on',
				glyphMargin: false,
				fixedOverflowWidgets: true
			}, {});
			this.textEditors.set(surface.id, editor);
		}

		let modelReference = this.textModelReferences.get(surface.id);
		if (!modelReference) {
			try {
				modelReference = await this.textModelService.createModelReference(surface.resource);
				if (!this.isCurrentSurfaceBody(surface.id, body, generation) || this.textEditors.get(surface.id) !== editor) {
					modelReference.dispose();
					return;
				}
				this.textModelReferences.set(surface.id, modelReference);
			} catch (error) {
				dom.clearNode(body);
				dom.append(body, dom.$('.noripan-canvas-surface-error', undefined, localize('noripanCanvas.surfaceLoadFailed', 'Unable to load this text resource into the canvas.')));
				this.logService.error('[NoripanCanvasEditor] Failed to load text surface', error);
				return;
			}
		}

		editor.setModel(modelReference.object.textEditorModel);
		body.dataset.surfaceTextEditorId = surface.id;
		this.scheduleSurfaceLayout(surface.id, body);
	}

	private async attachBrowser(surface: INoripanCanvasBrowserSurface, body: HTMLElement, generation: number): Promise<void> {
		await this.whenSurfaceBodyReady(body);
		if (!this.isCurrentSurfaceBody(surface.id, body, generation)) {
			return;
		}

		const input = this.browserInputs.get(surface.id) ?? this.browserViewWorkbenchService.getOrCreateLazy(surface.id, { url: surface.url, title: surface.title });
		this.browserInputs.set(surface.id, input);
		this.renderBrowserSurface(body, surface.url);
		body.dataset.surfaceBrowserId = surface.id;

		try {
			const model = await input.resolve();
			if (!this.isCurrentSurfaceBody(surface.id, body, generation)) {
				await model.setVisible(false);
				return;
			}
			this.ensureBrowserModelListeners(surface.id, model);
			if (model.url !== surface.url) {
				await model.loadURL(surface.url);
			}
			this.bindBrowserSurfaceStatus(model, body, surface.url);
			await this.layoutBrowserSurface(surface.id, body);
		} catch (error) {
			this.updateBrowserSurfaceStatus(body, localize('noripanCanvas.browserFailed', 'Browser surface failed to load: {0}', surface.url));
			this.logService.error('[NoripanCanvasEditor] Failed to attach browser surface', error);
		}
	}

	private registerSurfaceResizeObserver(surface: INoripanCanvasSurface, body: HTMLElement) {
		const resizeObserver = new this.window.ResizeObserver(() => {
			if (!this.isCurrentSurfaceBody(surface.id, body, this.renderGeneration)) {
				return;
			}

			if (surface.type === 'terminal') {
				this.layoutTerminalSurface(surface.id, body);
			} else if (surface.type === 'browser') {
				return;
			} else {
				this.layoutTextEditorSurface(surface.id, body);
			}
		});
		resizeObserver.observe(body);

		return toDisposable(() => resizeObserver.disconnect());
	}

	private scheduleSurfaceLayout(surfaceId: string, body: HTMLElement): void {
		const layout = () => {
			if (!body.isConnected) {
				return;
			}

			this.layoutTerminalSurface(surfaceId, body);
			this.layoutTextEditorSurface(surfaceId, body);
		};

		layout();
		this.renderDisposables.add(dom.scheduleAtNextAnimationFrame(this.window, () => {
			layout();
			this.renderDisposables.add(dom.scheduleAtNextAnimationFrame(this.window, layout));
		}));
	}

	private async whenSurfaceBodyReady(body: HTMLElement): Promise<void> {
		await new Promise<void>(resolve => this.window.requestAnimationFrame(() => resolve()));
		if (body.isConnected && (body.clientWidth <= 1 || body.clientHeight <= 1)) {
			await new Promise<void>(resolve => this.window.requestAnimationFrame(() => resolve()));
		}
	}

	private isCurrentSurfaceBody(surfaceId: string, body: HTMLElement, generation: number): boolean {
		return generation === this.renderGeneration && body.isConnected && body.closest<HTMLElement>('.noripan-canvas-surface')?.dataset.surfaceId === surfaceId;
	}

	private layoutSurfaceBodies(): void {
		for (const body of this.surfaceBodyElements.values()) {
			const terminalSurfaceId = body.dataset.surfaceTerminalId;
			if (terminalSurfaceId) {
				this.layoutTerminalSurface(terminalSurfaceId, body);
			}

			const textSurfaceId = body.dataset.surfaceTextEditorId;
			if (textSurfaceId) {
				this.layoutTextEditorSurface(textSurfaceId, body);
			}
		}
	}

	private layoutBrowserSurfaces(): void {
		if (this.contextMenuVisible) {
			this.hideBrowserSurfaces();
			return;
		}

		for (const body of this.surfaceBodyElements.values()) {
			const browserSurfaceId = body.dataset.surfaceBrowserId;
			if (browserSurfaceId) {
				void this.layoutBrowserSurface(browserSurfaceId, body);
			}
		}
	}

	private hideBrowserSurfaces(): void {
		for (const input of this.browserInputs.values()) {
			void input.model?.setVisible(false);
		}
	}

	private renderBrowserSurface(body: HTMLElement, url: string): void {
		dom.clearNode(body);
		dom.append(body, dom.$('.noripan-canvas-browser-native-host'));
		const notice = dom.append(body, dom.$('.noripan-canvas-browser-notice', undefined, localize('noripanCanvas.browserNotice', 'Loading browser surface...')));
		this.browserNoticeElements.set(body, notice);
	}

	private bindBrowserSurfaceStatus(model: IBrowserViewModel, body: HTMLElement, url: string): void {
		this.updateBrowserSurfaceStatus(body, model.loading
			? localize('noripanCanvas.browserLoading', 'Loading browser surface...')
			: localize('noripanCanvas.browserReady', 'Browser surface loaded.'));

		const error = model.error;
		if (error) {
			this.updateBrowserSurfaceStatus(body, localize('noripanCanvas.browserBlocked', 'Browser surface failed or was blocked by the page: {0}', error.errorDescription ?? url));
		}
	}

	private ensureBrowserModelListeners(surfaceId: string, model: IBrowserViewModel): void {
		if (this.browserEventDisposables.has(surfaceId)) {
			return;
		}

		const store = new DisposableStore();
		store.add(model.onDidWheel(event => {
			if (!event.ctrlKey && !event.metaKey) {
				return;
			}
			this.applyCanvasWheelZoom(event.deltaY);
		}));
		this.browserEventDisposables.set(surfaceId, store);
	}

	private updateBrowserSurfaceStatus(body: HTMLElement, text: string): void {
		const notice = this.browserNoticeElements.get(body);
		if (notice) {
			notice.textContent = text;
		}
	}

	private async layoutBrowserSurface(surfaceId: string, body: HTMLElement): Promise<void> {
		const input = this.browserInputs.get(surfaceId);
		const model = input?.model;
		if (!model || !body.isConnected) {
			return;
		}

		const surface = this.activeInput?.getDocument().surfaces.find(candidate => candidate.id === surfaceId);
		if (!surface || surface.minimized || !this.isVisible() || this.contextMenuVisible) {
			await model.setVisible(false);
			return;
		}

		const surfaceElement = body.closest<HTMLElement>('.noripan-canvas-surface');
		if (!surfaceElement) {
			await model.setVisible(false);
			return;
		}

		const zoom = this.getZoom();
		const scrollRect = this.scrollElement.getBoundingClientRect();
		const logicalLeft = surfaceElement.offsetLeft + body.offsetLeft;
		const logicalTop = surfaceElement.offsetTop + body.offsetTop;
		const x = scrollRect.left + logicalLeft * zoom - this.scrollElement.scrollLeft;
		const y = scrollRect.top + logicalTop * zoom - this.scrollElement.scrollTop;
		const width = body.clientWidth * zoom;
		const height = body.clientHeight * zoom;

		if (width <= 1 || height <= 1) {
			await model.setVisible(false);
			return;
		}

		const right = x + width;
		const bottom = y + height;
		const intersectsViewport = right > scrollRect.left
			&& bottom > scrollRect.top
			&& x < scrollRect.right
			&& y < scrollRect.bottom;

		if (!intersectsViewport) {
			await model.setVisible(false);
			return;
		}

		// Native browser views cannot be DOM-clipped perfectly. For now:
		// - hide if the surface goes above/left of the scroll viewport
		// - clip only against the right/bottom viewport edges
		if (x < scrollRect.left || y < scrollRect.top) {
			this.updateBrowserSurfaceStatus(body, localize('noripanCanvas.browserPartialViewport', 'Browser surface is temporarily hidden while it extends above or left of the visible canvas.'));
			await model.setVisible(false);
			return;
		}

		const clippedWidth = Math.min(width, scrollRect.right - x);
		const clippedHeight = Math.min(height, scrollRect.bottom - y);
		if (clippedWidth <= 1 || clippedHeight <= 1) {
			await model.setVisible(false);
			return;
		}

		await model.layout({
			windowId: this.group.windowId,
			x,
			y,
			width: clippedWidth,
			height: clippedHeight,
			zoomFactor: getZoomFactor(this.window),
			cornerRadius: 0
		});
		await model.setVisible(true);
		this.bindBrowserSurfaceStatus(model, body, surface.type === 'browser' ? surface.url : '');
	}

	private layoutTerminalSurface(surfaceId: string, body: HTMLElement): void {
		const instance = this.terminalInstances.get(surfaceId);
		if (!instance) {
			return;
		}

		const target = this.terminalAttachElements.get(surfaceId) ?? body;
		instance.attachToElement(target);
		const dimension = new dom.Dimension(Math.max(1, target.clientWidth), Math.max(1, target.clientHeight));
		instance.layout(dimension);
		this.renderDisposables.add(dom.scheduleAtNextAnimationFrame(this.window, () => {
			if (!target.isConnected) {
				return;
			}
			instance.attachToElement(target);
			instance.layout(new dom.Dimension(Math.max(1, target.clientWidth), Math.max(1, target.clientHeight)));
		}));
	}

	private layoutTextEditorSurface(surfaceId: string, body: HTMLElement): void {
		const editor = this.textEditors.get(surfaceId);
		if (!editor) {
			return;
		}

		editor.layout({ width: Math.max(1, body.clientWidth), height: Math.max(1, body.clientHeight) });
	}

	private updateDocument(document: INoripanCanvasDocument): void {
		if (!this.activeInput) {
			return;
		}

		const nextDocument = document.ui ? document : { ...document, ui: this.activeInput.getDocument().ui };
		this.activeInput.setDocument(nextDocument, true);
		this.scheduleAutosave();
		this.render(nextDocument);
	}

	private patchSurface(surface: INoripanCanvasSurface, rerender: boolean): void {
		if (!this.activeInput) {
			return;
		}

		const current = this.activeInput.getDocument();
		const minCanvasCoordinate = -NORIPAN_CANVAS_ORIGIN_OFFSET;

		const clampedSurface: INoripanCanvasSurface = {
			...surface,
			x: Math.max(minCanvasCoordinate, surface.x),
			y: Math.max(minCanvasCoordinate, surface.y)
		};

		if (clampedSurface.x !== surface.x || clampedSurface.y !== surface.y) {
			this.logService.trace(`[NoripanCanvasEditor] Surface ${surface.id} clamped: (${surface.x}, ${surface.y}) -> (${clampedSurface.x}, ${clampedSurface.y})`);
		}

		const next: INoripanCanvasDocument = {
			version: NORIPAN_CANVAS_DOCUMENT_VERSION,
			ui: current.ui,
			surfaces: current.surfaces.map(candidate => candidate.id === clampedSurface.id ? clampedSurface : candidate)
		};
		this.activeInput.setDocument(next, true);
		this.scheduleAutosave();

		if (rerender) {
			this.render(next);
			return;
		}

		const element = this.surfaceElements.get(clampedSurface.id);
		if (!element) {
			return;
		}

		element.style.left = `${NORIPAN_CANVAS_ORIGIN_OFFSET + clampedSurface.x}px`;
		element.style.top = `${NORIPAN_CANVAS_ORIGIN_OFFSET + clampedSurface.y}px`;
		element.style.width = `${clampedSurface.width}px`;
		element.style.height = `${clampedSurface.minimized ? NORIPAN_CANVAS_HEADER_HEIGHT : clampedSurface.height}px`;
		element.style.zIndex = String(clampedSurface.zIndex);
		element.classList.toggle('minimized', clampedSurface.minimized === true);
		this.syncCanvasBounds(next);
		this.ensureSurfaceVisible(clampedSurface);
		this.scheduleOverlayRender(next);

		const body = this.surfaceBodyElements.get(clampedSurface.id);
		if (!body) {
			return;
		}

		if (clampedSurface.type === 'terminal') {
			this.layoutTerminalSurface(clampedSurface.id, body);
		} else if (clampedSurface.type === 'browser') {
			void this.layoutBrowserSurface(clampedSurface.id, body);
			return;
		} else {
			this.layoutTextEditorSurface(clampedSurface.id, body);
		}
	}

	private patchSurfaceGroup(groupId: string, baseGroupSurfaces: readonly INoripanCanvasSurface[], deltaX: number, deltaY: number, rerender: boolean): void {
		if (!this.activeInput) {
			return;
		}

		const minCanvasCoordinate = -NORIPAN_CANVAS_ORIGIN_OFFSET;
		const baseById = new Map(baseGroupSurfaces.map(surface => [surface.id, surface]));
		const current = this.activeInput.getDocument();
		const next: INoripanCanvasDocument = {
			version: NORIPAN_CANVAS_DOCUMENT_VERSION,
			ui: current.ui,
			surfaces: current.surfaces.map(surface => {
				const base = baseById.get(surface.id);
				if (!base) {
					return surface;
				}
				return {
					...surface,
					x: Math.max(minCanvasCoordinate, base.x + deltaX),
					y: Math.max(minCanvasCoordinate, base.y + deltaY)
				};
			})
		};
		this.activeInput.setDocument(next, true);
		this.scheduleAutosave();

		if (rerender) {
			this.render(next);
			return;
		}

		for (const surface of next.surfaces) {
			if (surface.groupId !== groupId) {
				continue;
			}

			const element = this.surfaceElements.get(surface.id);
			if (!element) {
				continue;
			}

			element.style.left = `${NORIPAN_CANVAS_ORIGIN_OFFSET + surface.x}px`;
			element.style.top = `${NORIPAN_CANVAS_ORIGIN_OFFSET + surface.y}px`;
		}

		this.syncCanvasBounds(next);
		for (const surface of next.surfaces) {
			if (surface.groupId === groupId) {
				this.ensureSurfaceVisible(surface);
			}
		}
		this.scheduleOverlayRender(next);
	}

	private groupNearbySurfaces(surfaceId: string): void {
		if (!this.activeInput) {
			return;
		}

		const current = this.activeInput.getDocument();
		const baseSurface = current.surfaces.find(surface => surface.id === surfaceId);
		if (!baseSurface) {
			return;
		}

		const baseRect = toSurfaceRect(baseSurface, 48);
		const groupId = baseSurface.groupId ?? generateUuid();
		const nextSurfaces = current.surfaces.map(surface => {
			if (surface.id === surfaceId || rectsIntersect(baseRect, toSurfaceRect(surface, 48))) {
				return { ...surface, groupId };
			}

			return surface;
		});

		this.updateDocument({ version: NORIPAN_CANVAS_DOCUMENT_VERSION, ui: current.ui, surfaces: nextSurfaces });
	}

	private ungroupSurface(surfaceId: string): void {
		if (!this.activeInput) {
			return;
		}

		const current = this.activeInput.getDocument();
		const groupId = current.surfaces.find(surface => surface.id === surfaceId)?.groupId;
		if (!groupId) {
			return;
		}

		this.updateDocument({
			version: NORIPAN_CANVAS_DOCUMENT_VERSION,
			ui: current.ui,
			surfaces: current.surfaces.map(surface => surface.groupId === groupId ? { ...surface, groupId: undefined } : surface)
		});
	}

	private removeSurface(surfaceId: string): void {
		if (!this.activeInput) {
			return;
		}

		const current = this.activeInput.getDocument();
		this.disposeTerminal(surfaceId);
		this.disposeTextEditorSurface(surfaceId);
		this.disposeBrowserSurface(surfaceId);
		this.updateDocument({ version: NORIPAN_CANVAS_DOCUMENT_VERSION, surfaces: current.surfaces.filter(surface => surface.id !== surfaceId) });
	}

	private toggleSurfaceMinimized(surfaceId: string): void {
		if (!this.activeInput) {
			return;
		}

		const current = this.activeInput.getDocument();
		this.updateDocument({
			version: NORIPAN_CANVAS_DOCUMENT_VERSION,
			surfaces: current.surfaces.map(surface => surface.id === surfaceId ? { ...surface, minimized: !surface.minimized } : surface)
		});
	}

	private reorderSurface(surfaceId: string, direction: 'front' | 'back' | 'forward' | 'backward'): void {
		if (!this.activeInput) {
			return;
		}

		const ordered = this.sortSurfaces(this.activeInput.getDocument().surfaces);
		const index = ordered.findIndex(surface => surface.id === surfaceId);
		if (index < 0) {
			return;
		}

		const next = [...ordered];
		if (direction === 'front') {
			next.push(...next.splice(index, 1));
		} else if (direction === 'back') {
			next.unshift(...next.splice(index, 1));
		} else {
			const targetIndex = Math.min(next.length - 1, Math.max(0, index + (direction === 'forward' ? 1 : -1)));
			if (targetIndex === index) {
				return;
			}
			const [surface] = next.splice(index, 1);
			next.splice(targetIndex, 0, surface);
		}

		this.updateDocument({ version: NORIPAN_CANVAS_DOCUMENT_VERSION, surfaces: next.map((surface, order) => ({ ...surface, zIndex: order + 1 })) });
	}

	private focusSurface(surfaceId: string): void {
		const body = this.surfaceBodyElements.get(surfaceId);
		if (body) {
			this.layoutTerminalSurface(surfaceId, body);
			this.layoutTextEditorSurface(surfaceId, body);
		}

		this.terminalInstances.get(surfaceId)?.focus(true);
		this.textEditors.get(surfaceId)?.focus();
	}

	private hasHeaderCollision(surfaceId: string, candidate: ICanvasRect): boolean {
		if (!this.activeInput) {
			return false;
		}

		const header = { x: candidate.x, y: candidate.y, width: candidate.width, height: NORIPAN_CANVAS_HEADER_HEIGHT };
		for (const surface of this.activeInput.getDocument().surfaces) {
			if (surface.id === surfaceId) {
				continue;
			}

			const other = { x: surface.x, y: surface.y, width: surface.width, height: NORIPAN_CANVAS_HEADER_HEIGHT };
			if (rectsIntersect(header, other)) {
				return true;
			}
		}

		return false;
	}

	private renderSurfaceGroups(document: INoripanCanvasDocument): void {
		for (const element of this.groupElements) {
			element.remove();
		}
		this.groupElements.clear();

		const groups = new Map<string, INoripanCanvasSurface[]>();
		for (const surface of document.surfaces) {
			if (!surface.groupId) {
				continue;
			}

			const group = groups.get(surface.groupId) ?? [];
			group.push(surface);
			groups.set(surface.groupId, group);
		}

		for (const [groupId, surfaces] of groups) {
			if (surfaces.length < 2) {
				continue;
			}

			const left = Math.min(...surfaces.map(surface => surface.x)) - 16;
			const top = Math.min(...surfaces.map(surface => surface.y)) - 36;
			const right = Math.max(...surfaces.map(surface => surface.x + surface.width)) + 16;
			const bottom = Math.max(...surfaces.map(surface => surface.y + (surface.minimized ? NORIPAN_CANVAS_HEADER_HEIGHT : surface.height))) + 16;
			const element = dom.append(this.canvasElement, dom.$('.noripan-canvas-surface-group'));
			this.groupElements.add(element);
			element.dataset.groupId = groupId;
			element.style.left = `${NORIPAN_CANVAS_ORIGIN_OFFSET + left}px`;
			element.style.top = `${NORIPAN_CANVAS_ORIGIN_OFFSET + top}px`;
			element.style.width = `${right - left}px`;
			element.style.height = `${bottom - top}px`;
			element.style.zIndex = String(Math.min(...surfaces.map(surface => surface.zIndex)) - 1);
			dom.append(element, dom.$('.noripan-canvas-surface-group-title', undefined, localize('noripanCanvas.groupTitle', 'Group')));
		}
	}

	private clearSurfaceElementReferences(): void {
		this.surfaceElements.clear();
		this.surfaceBodyElements.clear();
		this.terminalAttachElements.clear();
		this.browserNoticeElements.clear();
		this.groupElements.clear();
	}

	private syncCanvasBounds(document: INoripanCanvasDocument): void {
		const MIN_SIZE = 10000;
		const BUFFER = 3000;

		if (document.surfaces.length === 0) {
			this.canvasElement.style.width = `${MIN_SIZE}px`;
			this.canvasElement.style.height = `${MIN_SIZE}px`;
		} else {
			const maxRight = document.surfaces.reduce(
				(value, surface) => Math.max(value, NORIPAN_CANVAS_ORIGIN_OFFSET + surface.x + surface.width + BUFFER),
				MIN_SIZE
			);
			const maxBottom = document.surfaces.reduce(
				(value, surface) => Math.max(value, NORIPAN_CANVAS_ORIGIN_OFFSET + surface.y + surface.height + BUFFER),
				MIN_SIZE
			);
			this.canvasElement.style.width = `${maxRight}px`;
			this.canvasElement.style.height = `${maxBottom}px`;
		}
		this.updateMinimapViewport();
	}

	private getZoom(document = this.activeInput?.getDocument()): number {
		return clampNoripanCanvasZoom(document?.ui?.zoom ?? 1);
	}

	private applyZoom(document: INoripanCanvasDocument): void {
		const zoom = this.getZoom(document);
		(this.canvasElement.style as CSSStyleDeclaration & { zoom?: string }).zoom = String(zoom);
		this.zoomLabelElement.textContent = `${Math.round(zoom * 100)}%`;
	}

	private changeZoom(delta: number): void {
		this.setZoom(this.getZoom() + delta);
	}

	private setZoom(value: number): void {
		if (!this.activeInput) {
			return;
		}

		const current = this.activeInput.getDocument();
		const previousZoom = this.getZoom(current);
		const nextZoom = clampNoripanCanvasZoom(Math.round(value * 10) / 10);
		const centerX = (this.scrollElement.scrollLeft + this.scrollElement.clientWidth / 2) / previousZoom;
		const centerY = (this.scrollElement.scrollTop + this.scrollElement.clientHeight / 2) / previousZoom;
		const nextDocument: INoripanCanvasDocument = {
			version: NORIPAN_CANVAS_DOCUMENT_VERSION,
			surfaces: current.surfaces,
			ui: { ...current.ui, zoom: nextZoom }
		};

		this.activeInput.setDocument(nextDocument, true);
		this.scheduleAutosave();
		this.applyZoom(nextDocument);
		this.scrollElement.scrollLeft = centerX * nextZoom - this.scrollElement.clientWidth / 2;
		this.scrollElement.scrollTop = centerY * nextZoom - this.scrollElement.clientHeight / 2;
		this.layoutSurfaceBodies();
		this.scheduleOverlayRender(nextDocument);
	}

	private getNextSurfacePosition(document: INoripanCanvasDocument, width: number, height: number): { x: number; y: number } {
		const zoom = this.getZoom(document);
		const visibleX = this.scrollElement.scrollLeft / zoom - NORIPAN_CANVAS_ORIGIN_OFFSET;
		const visibleY = this.scrollElement.scrollTop / zoom - NORIPAN_CANVAS_ORIGIN_OFFSET;
		const baseX = Math.round(visibleX + Math.max(24, (this.scrollElement.clientWidth / zoom - width) / 2));
		const baseY = Math.round(visibleY + Math.max(24, (this.scrollElement.clientHeight / zoom - height) / 2));
		const offset = document.surfaces.length * 28;

		return { x: baseX + offset, y: baseY + offset };
	}

	private renderMinimap(document: INoripanCanvasDocument): void {
		dom.clearNode(this.minimapContentElement);
		const canvasWidth = Math.max(1, this.canvasElement.offsetWidth);
		const canvasHeight = Math.max(1, this.canvasElement.offsetHeight);
		const scaleX = MINIMAP_WIDTH / canvasWidth;
		const scaleY = MINIMAP_HEIGHT / canvasHeight;

		for (const surface of document.surfaces) {
			const item = dom.append(this.minimapContentElement, dom.$('.noripan-canvas-minimap-surface'));
			item.classList.add(`type-${surface.type}`);
			item.classList.toggle('minimized', surface.minimized === true);
			item.classList.toggle('grouped', !!surface.groupId);
			item.title = surface.title;
			item.style.left = `${(NORIPAN_CANVAS_ORIGIN_OFFSET + surface.x) * scaleX}px`;
			item.style.top = `${(NORIPAN_CANVAS_ORIGIN_OFFSET + surface.y) * scaleY}px`;
			item.style.width = `${Math.max(8, surface.width * scaleX)}px`;
			item.style.height = `${Math.max(6, (surface.minimized ? NORIPAN_CANVAS_HEADER_HEIGHT : surface.height) * scaleY)}px`;
			dom.append(item, dom.$('.noripan-canvas-minimap-surface-label', undefined, this.getMinimapSurfaceLabel(surface)));
		}

		this.updateMinimapViewport();
	}

	private getMinimapSurfaceLabel(surface: INoripanCanvasSurface): string {
		switch (surface.type) {
			case 'terminal': return 'T';
			case 'text-editor': return 'F';
			case 'browser': return 'B';
		}
	}

	private ensureSurfaceVisible(surface: INoripanCanvasSurface): void {
		const zoom = this.getZoom();
		const surfaceLeft = NORIPAN_CANVAS_ORIGIN_OFFSET + surface.x;
		const surfaceTop = NORIPAN_CANVAS_ORIGIN_OFFSET + surface.y;
		const surfaceRight = surfaceLeft + surface.width;
		const surfaceBottom = surfaceTop + (surface.minimized ? NORIPAN_CANVAS_HEADER_HEIGHT : surface.height);

		const viewportLeft = this.scrollElement.scrollLeft / zoom;
		const viewportTop = this.scrollElement.scrollTop / zoom;
		const viewportRight = viewportLeft + this.scrollElement.clientWidth / zoom;
		const viewportBottom = viewportTop + this.scrollElement.clientHeight / zoom;
		const edgePaddingX = 96;
		const edgePaddingY = 72;
		const maxStepX = 120;
		const maxStepY = 96;

		const paddedViewportLeft = viewportLeft + edgePaddingX;
		const paddedViewportTop = viewportTop + edgePaddingY;
		const paddedViewportRight = viewportRight - edgePaddingX;
		const paddedViewportBottom = viewportBottom - edgePaddingY;

		if (surfaceLeft >= paddedViewportLeft && surfaceRight <= paddedViewportRight &&
			surfaceTop >= paddedViewportTop && surfaceBottom <= paddedViewportBottom) {
			return;
		}

		let nextViewportLeft = viewportLeft;
		let nextViewportTop = viewportTop;

		if (surfaceLeft < paddedViewportLeft) {
			nextViewportLeft -= Math.min(maxStepX, paddedViewportLeft - surfaceLeft);
		} else if (surfaceRight > paddedViewportRight) {
			nextViewportLeft += Math.min(maxStepX, surfaceRight - paddedViewportRight);
		}

		if (surfaceTop < paddedViewportTop) {
			nextViewportTop -= Math.min(maxStepY, paddedViewportTop - surfaceTop);
		} else if (surfaceBottom > paddedViewportBottom) {
			nextViewportTop += Math.min(maxStepY, surfaceBottom - paddedViewportBottom);
		}

		this.scrollElement.scrollLeft = Math.max(0, nextViewportLeft * zoom);
		this.scrollElement.scrollTop = Math.max(0, nextViewportTop * zoom);
	}

	private updateMinimapViewport(): void {
		if (!this.minimapViewportElement || !this.canvasElement) {
			return;
		}

		const zoom = this.getZoom();
		const canvasWidth = Math.max(1, this.canvasElement.offsetWidth);
		const canvasHeight = Math.max(1, this.canvasElement.offsetHeight);
		const scaleX = MINIMAP_WIDTH / canvasWidth;
		const scaleY = MINIMAP_HEIGHT / canvasHeight;
		const viewportLeft = this.scrollElement.scrollLeft / zoom;
		const viewportTop = this.scrollElement.scrollTop / zoom;
		const viewportWidth = this.scrollElement.clientWidth / zoom;
		const viewportHeight = this.scrollElement.clientHeight / zoom;
		this.minimapViewportElement.style.left = `${viewportLeft * scaleX}px`;
		this.minimapViewportElement.style.top = `${viewportTop * scaleY}px`;
		this.minimapViewportElement.style.width = `${Math.max(8, viewportWidth * scaleX)}px`;
		this.minimapViewportElement.style.height = `${Math.max(8, viewportHeight * scaleY)}px`;
	}

	private moveViewportFromMinimap(event: PointerEvent): void {
		if (event.target === this.minimapHandleElement) {
			return;
		}

		event.preventDefault();
		const bounds = this.minimapElement.getBoundingClientRect();
		const moveTo = (clientX: number, clientY: number) => {
			const ratioX = Math.min(1, Math.max(0, (clientX - bounds.left) / bounds.width));
			const ratioY = Math.min(1, Math.max(0, (clientY - bounds.top) / bounds.height));
			const zoom = this.getZoom();
			const canvasWidth = Math.max(1, this.canvasElement.offsetWidth);
			const canvasHeight = Math.max(1, this.canvasElement.offsetHeight);
			this.scrollElement.scrollLeft = ratioX * canvasWidth * zoom - this.scrollElement.clientWidth / 2;
			this.scrollElement.scrollTop = ratioY * canvasHeight * zoom - this.scrollElement.clientHeight / 2;
		};

		moveTo(event.clientX, event.clientY);
		this.minimapElement.setPointerCapture(event.pointerId);
		const moveListener = dom.addDisposableListener(this.minimapElement, dom.EventType.POINTER_MOVE, moveEvent => moveTo(moveEvent.clientX, moveEvent.clientY));
		const stop = () => {
			if (this.minimapElement.hasPointerCapture(event.pointerId)) {
				this.minimapElement.releasePointerCapture(event.pointerId);
			}
			moveListener.dispose();
			upListener.dispose();
			cancelListener.dispose();
		};
		const upListener = dom.addDisposableListener(this.minimapElement, dom.EventType.POINTER_UP, stop);
		const cancelListener = dom.addDisposableListener(this.minimapElement, dom.EventType.POINTER_LEAVE, stop);
	}

	private moveMinimap(event: PointerEvent): void {
		if (!this.activeInput) {
			return;
		}

		event.preventDefault();
		event.stopPropagation();
		const parentBounds = this.minimapElement.parentElement?.getBoundingClientRect();
		if (!parentBounds) {
			return;
		}

		const startLeft = this.minimapElement.offsetLeft;
		const startTop = this.minimapElement.offsetTop;
		const startX = event.clientX;
		const startY = event.clientY;
		const moveTo = (clientX: number, clientY: number) => {
			const left = Math.min(parentBounds.width - this.minimapElement.offsetWidth - 8, Math.max(8, startLeft + clientX - startX));
			const top = Math.min(parentBounds.height - this.minimapElement.offsetHeight - 8, Math.max(8, startTop + clientY - startY));
			this.minimapElement.style.left = `${left}px`;
			this.minimapElement.style.top = `${top}px`;
			this.minimapElement.style.right = 'auto';
			this.minimapElement.style.bottom = 'auto';
		};

		this.minimapHandleElement.setPointerCapture(event.pointerId);
		const moveListener = dom.addDisposableListener(this.minimapHandleElement, dom.EventType.POINTER_MOVE, moveEvent => moveTo(moveEvent.clientX, moveEvent.clientY));
		const stop = () => {
			if (this.minimapHandleElement.hasPointerCapture(event.pointerId)) {
				this.minimapHandleElement.releasePointerCapture(event.pointerId);
			}
			moveListener.dispose();
			upListener.dispose();
			cancelListener.dispose();

			const current = this.activeInput?.getDocument();
			if (current) {
				this.updateDocument({
					version: NORIPAN_CANVAS_DOCUMENT_VERSION,
					surfaces: current.surfaces,
					ui: { ...current.ui, minimapX: this.minimapElement.offsetLeft, minimapY: this.minimapElement.offsetTop }
				});
			}
		};
		const upListener = dom.addDisposableListener(this.minimapHandleElement, dom.EventType.POINTER_UP, stop);
		const cancelListener = dom.addDisposableListener(this.minimapHandleElement, dom.EventType.POINTER_LEAVE, stop);
	}

	private applyMinimapPosition(document: INoripanCanvasDocument): void {
		if (typeof document.ui?.minimapX !== 'number' || typeof document.ui.minimapY !== 'number') {
			this.minimapElement.style.left = '';
			this.minimapElement.style.top = '';
			this.minimapElement.style.right = '';
			this.minimapElement.style.bottom = '';
			return;
		}

		this.minimapElement.style.left = `${document.ui.minimapX}px`;
		this.minimapElement.style.top = `${document.ui.minimapY}px`;
		this.minimapElement.style.right = 'auto';
		this.minimapElement.style.bottom = 'auto';
	}

	private viewportToCanvasCoordinates(clientX: number, clientY: number): { canvasX: number; canvasY: number } {
		const zoom = this.getZoom();
		const scrollLeft = this.scrollElement.scrollLeft;
		const scrollTop = this.scrollElement.scrollTop;

		const scrollBounds = this.scrollElement.getBoundingClientRect();
		const viewportX = clientX - scrollBounds.left;
		const viewportY = clientY - scrollBounds.top;

		const canvasX = (viewportX + scrollLeft) / zoom;
		const canvasY = (viewportY + scrollTop) / zoom;

		return { canvasX, canvasY };
	}

	private scheduleOverlayRender(document: INoripanCanvasDocument): void {
		this.pendingOverlayDocument = document;
		this.overlayRenderScheduler.schedule();
	}

	private scheduleAutosave(): void {
		this.autosaveScheduler.schedule();
	}

	private async saveActiveInput(): Promise<void> {
		const input = this.activeInput;
		if (!input || !input.isDirty()) {
			return;
		}

		try {
			await input.save(this.group.id);
		} catch (error) {
			this.logService.error('[NoripanCanvasEditor] Failed to autosave canvas', error);
		}
	}

	private async reloadActiveInputFromDisk(): Promise<void> {
		const input = this.activeInput;
		if (!input || input.isDirty()) {
			return;
		}

		try {
			const document = await input.resolveCanvasDocument({ forceReadFromDisk: true });
			if (this.activeInput === input) {
				this.render(document);
			}
		} catch (error) {
			this.logService.error('[NoripanCanvasEditor] Failed to reload canvas from disk', error);
		}
	}

	private sortSurfaces(surfaces: readonly INoripanCanvasSurface[]): INoripanCanvasSurface[] {
		return [...surfaces].sort((a, b) => a.zIndex - b.zIndex || a.id.localeCompare(b.id));
	}

	private disposeTerminals(): void {
		for (const surfaceId of [...this.terminalInstances.keys()]) {
			this.disposeTerminal(surfaceId);
		}
	}

	private disposeTerminal(surfaceId: string): void {
		const instance = this.terminalInstances.get(surfaceId);
		if (!instance) {
			return;
		}

		instance.dispose(TerminalExitReason.User);
		this.terminalInstances.delete(surfaceId);
	}

	private disposeTextEditors(): void {
		for (const surfaceId of [...this.textEditors.keys()]) {
			this.disposeTextEditor(surfaceId);
		}
	}

	private disposeTextEditorResources(): void {
		for (const surfaceId of [...this.textEditors.keys()]) {
			this.disposeTextEditor(surfaceId);
		}
		for (const [surfaceId, reference] of this.textModelReferences) {
			reference.dispose();
			this.textModelReferences.delete(surfaceId);
		}
	}

	private disposeTextEditor(surfaceId: string): void {
		this.textEditors.get(surfaceId)?.dispose();
		this.textEditors.delete(surfaceId);
	}

	private disposeTextEditorSurface(surfaceId: string): void {
		this.disposeTextEditor(surfaceId);
		this.textModelReferences.get(surfaceId)?.dispose();
		this.textModelReferences.delete(surfaceId);
	}

	private disposeBrowserSurfaces(): void {
		for (const surfaceId of [...this.browserInputs.keys()]) {
			this.disposeBrowserSurface(surfaceId);
		}
	}

	private disposeBrowserSurface(surfaceId: string): void {
		this.browserEventDisposables.get(surfaceId)?.dispose();
		this.browserEventDisposables.delete(surfaceId);
		this.browserInputs.get(surfaceId)?.dispose();
		this.browserInputs.delete(surfaceId);
	}
}
