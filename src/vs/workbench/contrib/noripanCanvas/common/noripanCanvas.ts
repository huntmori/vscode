/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { URI } from '../../../../base/common/uri.js';

export const NORIPAN_CANVAS_EDITOR_ID = 'workbench.editor.noripanCanvas';
export const NORIPAN_CANVAS_INPUT_ID = 'workbench.input.noripanCanvas';
export const NORIPAN_CANVAS_FILE_EXTENSION = '.noripan.canvas.json';
export const NORIPAN_CANVAS_GLOB = `*${NORIPAN_CANVAS_FILE_EXTENSION}`;
export const NORIPAN_CANVAS_DOCUMENT_VERSION = 1;
export const NORIPAN_CANVAS_ROOT_SIZE = 6000;
export const NORIPAN_CANVAS_ORIGIN_OFFSET = 3000;
export const NORIPAN_CANVAS_HEADER_HEIGHT = 40;

export interface INoripanCanvasUiState {
	readonly minimapX?: number;
	readonly minimapY?: number;
	readonly zoom?: number;
}

interface INoripanCanvasSurfaceBase {
	readonly id: string;
	readonly title: string;
	readonly x: number;
	readonly y: number;
	readonly width: number;
	readonly height: number;
	readonly zIndex: number;
	readonly minimized?: boolean;
	readonly groupId?: string;
}

export interface INoripanCanvasTerminalSurface extends INoripanCanvasSurfaceBase {
	readonly type: 'terminal';
}

export interface INoripanCanvasTextEditorSurface extends INoripanCanvasSurfaceBase {
	readonly type: 'text-editor';
	readonly resource: URI;
}

export interface INoripanCanvasBrowserSurface extends INoripanCanvasSurfaceBase {
	readonly type: 'browser';
	readonly url: string;
}

export type INoripanCanvasSurface = INoripanCanvasTerminalSurface | INoripanCanvasTextEditorSurface | INoripanCanvasBrowserSurface;

export interface INoripanCanvasDocument {
	readonly version: typeof NORIPAN_CANVAS_DOCUMENT_VERSION;
	readonly surfaces: readonly INoripanCanvasSurface[];
	readonly ui?: INoripanCanvasUiState;
}

interface IRawNoripanCanvasDocument {
	readonly version?: unknown;
	readonly surfaces?: unknown;
	readonly ui?: unknown;
}

export const DEFAULT_NORIPAN_CANVAS_DOCUMENT: INoripanCanvasDocument = {
	version: NORIPAN_CANVAS_DOCUMENT_VERSION,
	surfaces: []
};

export function normalizeNoripanCanvasDocument(value: unknown): INoripanCanvasDocument {
	const candidate = migrateNoripanCanvasDocument(value);
	const surfaces = Array.isArray(candidate.surfaces) ? candidate.surfaces : [];

	return {
		version: NORIPAN_CANVAS_DOCUMENT_VERSION,
		surfaces: surfaces.map(surface => normalizeSurface(surface)).filter((surface): surface is INoripanCanvasSurface => !!surface),
		ui: normalizeUiState(candidate.ui)
	};
}

export function migrateNoripanCanvasDocument(value: unknown): IRawNoripanCanvasDocument {
	if (!value || typeof value !== 'object') {
		return { version: NORIPAN_CANVAS_DOCUMENT_VERSION, surfaces: [], ui: undefined };
	}

	const candidate = value as IRawNoripanCanvasDocument;
	const version = typeof candidate.version === 'number' ? candidate.version : NORIPAN_CANVAS_DOCUMENT_VERSION;

	if (version !== NORIPAN_CANVAS_DOCUMENT_VERSION) {
		return {
			version: NORIPAN_CANVAS_DOCUMENT_VERSION,
			surfaces: candidate.surfaces,
			ui: candidate.ui
		};
	}

	return candidate;
}

export function clampNoripanCanvasZoom(value: number): number {
	return Math.min(2, Math.max(0.4, value));
}

function normalizeUiState(value: unknown): INoripanCanvasUiState | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	return {
		minimapX: typeof candidate.minimapX === 'number' && Number.isFinite(candidate.minimapX) ? candidate.minimapX : undefined,
		minimapY: typeof candidate.minimapY === 'number' && Number.isFinite(candidate.minimapY) ? candidate.minimapY : undefined,
		zoom: typeof candidate.zoom === 'number' && Number.isFinite(candidate.zoom) ? clampNoripanCanvasZoom(candidate.zoom) : undefined
	};
}

function normalizeSurface(value: unknown): INoripanCanvasSurface | undefined {
	if (!value || typeof value !== 'object') {
		return undefined;
	}

	const candidate = value as Record<string, unknown>;
	if (typeof candidate.id !== 'string' || typeof candidate.type !== 'string') {
		return undefined;
	}

	const common = {
		id: candidate.id,
		title: typeof candidate.title === 'string' && candidate.title.trim().length > 0 ? candidate.title : 'Surface',
		x: asNumber(candidate.x, 0),
		y: asNumber(candidate.y, 0),
		width: Math.max(320, asNumber(candidate.width, 720)),
		height: Math.max(220, asNumber(candidate.height, 420)),
		zIndex: Math.max(1, Math.floor(asNumber(candidate.zIndex, 1))),
		minimized: candidate.minimized === true,
		groupId: typeof candidate.groupId === 'string' && candidate.groupId.length > 0 ? candidate.groupId : undefined
	};

	if (candidate.type === 'terminal') {
		return {
			...common,
			type: 'terminal',
			title: common.title === 'Surface' ? 'Terminal' : common.title
		};
	}

	if (candidate.type === 'text-editor' && typeof candidate.resource === 'string') {
		return {
			...common,
			type: 'text-editor',
			title: common.title === 'Surface' ? 'Editor' : common.title,
			resource: URI.parse(candidate.resource)
		};
	}

	if (candidate.type === 'browser' && typeof candidate.url === 'string') {
		return {
			...common,
			type: 'browser',
			title: common.title === 'Surface' ? 'Browser' : common.title,
			url: candidate.url
		};
	}

	return undefined;
}

function asNumber(value: unknown, fallback: number): number {
	return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function serializeNoripanCanvasDocument(document: INoripanCanvasDocument): string {
	return JSON.stringify({
		version: NORIPAN_CANVAS_DOCUMENT_VERSION,
		surfaces: document.surfaces.map(surface => surface.type === 'text-editor' ? { ...surface, resource: surface.resource.toString() } : surface),
		ui: document.ui
	}, null, '\t') + '\n';
}
