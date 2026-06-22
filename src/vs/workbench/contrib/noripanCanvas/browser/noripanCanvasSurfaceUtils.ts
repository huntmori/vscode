/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { NORIPAN_CANVAS_HEADER_HEIGHT, type INoripanCanvasSurface } from './noripanCanvas.js';

export type ICanvasRect = { x: number; y: number; width: number; height: number };
export type ISurfaceResizeDirection = 'n' | 'e' | 's' | 'w' | 'ne' | 'nw' | 'se' | 'sw';

export const MIN_NORIPAN_CANVAS_SURFACE_WIDTH = 320;
export const MIN_NORIPAN_CANVAS_SURFACE_HEIGHT = 220;

export function normalizeNoripanCanvasBrowserUrl(value: string): string {
	const trimmed = value.trim();
	if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(trimmed)) {
		return trimmed;
	}

	return `https://${trimmed}`;
}

export function rectsIntersect(a: ICanvasRect, b: ICanvasRect): boolean {
	return a.x < b.x + b.width && a.x + a.width > b.x && a.y < b.y + b.height && a.y + a.height > b.y;
}

export function toSurfaceRect(surface: INoripanCanvasSurface, padding = 0): ICanvasRect {
	return {
		x: surface.x - padding,
		y: surface.y - padding,
		width: surface.width + padding * 2,
		height: (surface.minimized ? NORIPAN_CANVAS_HEADER_HEIGHT : surface.height) + padding * 2
	};
}

export function resizeNoripanCanvasSurface(baseSurface: INoripanCanvasSurface, direction: ISurfaceResizeDirection, deltaX: number, deltaY: number, minCanvasCoordinate: number): INoripanCanvasSurface {
	const right = baseSurface.x + baseSurface.width;
	const bottom = baseSurface.y + baseSurface.height;

	let x = baseSurface.x;
	let y = baseSurface.y;
	let width = baseSurface.width;
	let height = baseSurface.height;

	if (direction.includes('w')) {
		x = Math.max(minCanvasCoordinate, baseSurface.x + deltaX);
		width = Math.max(MIN_NORIPAN_CANVAS_SURFACE_WIDTH, right - x);
		x = right - width;
	}

	if (direction.includes('e')) {
		width = Math.max(MIN_NORIPAN_CANVAS_SURFACE_WIDTH, baseSurface.width + deltaX);
	}

	if (direction.includes('n')) {
		y = Math.max(minCanvasCoordinate, baseSurface.y + deltaY);
		height = Math.max(MIN_NORIPAN_CANVAS_SURFACE_HEIGHT, bottom - y);
		y = bottom - height;
	}

	if (direction.includes('s')) {
		height = Math.max(MIN_NORIPAN_CANVAS_SURFACE_HEIGHT, baseSurface.height + deltaY);
	}

	return {
		...baseSurface,
		x,
		y,
		width,
		height
	};
}
