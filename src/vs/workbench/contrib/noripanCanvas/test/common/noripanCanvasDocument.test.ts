/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { Schemas } from '../../../../../base/common/network.js';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { clampNoripanCanvasZoom, DEFAULT_NORIPAN_CANVAS_DOCUMENT, migrateNoripanCanvasDocument, normalizeNoripanCanvasDocument, serializeNoripanCanvasDocument } from '../../common/noripanCanvas.js';

suite('NoripanCanvasDocument', () => {
	ensureNoDisposablesAreLeakedInTestSuite();

	test('invalid payload falls back to the default document', () => {
		const expected = { ...DEFAULT_NORIPAN_CANVAS_DOCUMENT, ui: undefined };
		assert.deepStrictEqual(normalizeNoripanCanvasDocument(undefined), expected);
		assert.deepStrictEqual(normalizeNoripanCanvasDocument({ surfaces: 'bad' }), expected);
	});

	test('serialize and normalize round-trip preserves supported surfaces and ui state', () => {
		const document = {
			version: 1 as const,
			surfaces: [
				{ id: 'terminal-1', type: 'terminal' as const, title: 'Terminal', x: 10, y: 20, width: 720, height: 420, zIndex: 1 },
				{ id: 'file-1', type: 'text-editor' as const, title: 'Editor', resource: URI.from({ scheme: Schemas.vscodeUserData, path: '/workspace/file.txt' }), x: 30, y: 40, width: 820, height: 520, zIndex: 2, groupId: 'g1' },
				{ id: 'browser-1', type: 'browser' as const, title: 'Browser', url: 'https://example.com', x: 50, y: 60, width: 960, height: 640, zIndex: 3, minimized: true }
			],
			ui: { minimapX: 12, minimapY: 34, zoom: 1.6 }
		};

		const roundTripped = normalizeNoripanCanvasDocument(JSON.parse(serializeNoripanCanvasDocument(document)));

		assert.deepStrictEqual(JSON.parse(serializeNoripanCanvasDocument(roundTripped)), {
			version: 1,
			surfaces: [
				{ id: 'terminal-1', type: 'terminal', title: 'Terminal', x: 10, y: 20, width: 720, height: 420, zIndex: 1, minimized: false },
				{ id: 'file-1', type: 'text-editor', title: 'Editor', resource: 'vscode-userdata:/workspace/file.txt', x: 30, y: 40, width: 820, height: 520, zIndex: 2, minimized: false, groupId: 'g1' },
				{ id: 'browser-1', type: 'browser', title: 'Browser', url: 'https://example.com', x: 50, y: 60, width: 960, height: 640, zIndex: 3, minimized: true }
			],
			ui: { minimapX: 12, minimapY: 34, zoom: 1.6 }
		});
	});

	test('migration entry point preserves surfaces for unknown versions', () => {
		const migrated = migrateNoripanCanvasDocument({ version: 99, surfaces: [{ id: 'surface-1', type: 'terminal', x: 0, y: 0, width: 100, height: 100, zIndex: 0 }] });
		assert.ok(Array.isArray(migrated.surfaces));
		assert.strictEqual(normalizeNoripanCanvasDocument(migrated).surfaces.length, 1);
	});

	test('zoom clamping stays within supported bounds', () => {
		assert.strictEqual(clampNoripanCanvasZoom(0.1), 0.4);
		assert.strictEqual(clampNoripanCanvasZoom(1.2), 1.2);
		assert.strictEqual(clampNoripanCanvasZoom(4), 2);
	});
});
