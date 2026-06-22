/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import assert from 'assert';
import { URI } from '../../../../../base/common/uri.js';
import { ensureNoDisposablesAreLeakedInTestSuite } from '../../../../../base/test/common/utils.js';
import { IFileDialogService } from '../../../../../platform/dialogs/common/dialogs.js';
import { IInstantiationService } from '../../../../../platform/instantiation/common/instantiation.js';
import { ILabelService } from '../../../../../platform/label/common/label.js';
import { GroupIdentifier } from '../../../../common/editor.js';
import { ITextFileService } from '../../../../services/textfile/common/textfiles.js';
import { DEFAULT_NORIPAN_CANVAS_DOCUMENT, normalizeNoripanCanvasDocument, serializeNoripanCanvasDocument } from '../../browser/noripanCanvas.js';
import { NoripanCanvasEditorInput } from '../../browser/noripanCanvasEditorInput.js';

suite('NoripanCanvasEditorInput', () => {
	const inputs: NoripanCanvasEditorInput[] = [];

	teardown(() => {
		while (inputs.length) {
			inputs.pop()!.dispose();
		}
	});

	ensureNoDisposablesAreLeakedInTestSuite();

	test('save persists the in-memory document and clears dirty state', async () => {
		const resource = URI.parse('test://workspace/canvas.noripan.canvas.json');
		const store = new Map<string, string>([[resource.toString(), serializeNoripanCanvasDocument(DEFAULT_NORIPAN_CANVAS_DOCUMENT)]]);
		const services = createServices(store);
		const input = createInput(resource, services);

		const nextDocument = {
			version: 1 as const,
			surfaces: [
				{ id: 'surface-1', type: 'terminal' as const, title: 'Terminal', x: 12, y: 34, width: 720, height: 420, zIndex: 1 }
			]
		};

		input.setDocument(nextDocument, true);
		inputs.push(input);
		assert.strictEqual(input.isDirty(), true);

		await input.save(0 as GroupIdentifier);
		assert.strictEqual(input.isDirty(), false);
		assert.deepStrictEqual(JSON.parse(store.get(resource.toString())!), JSON.parse(serializeNoripanCanvasDocument(normalizeNoripanCanvasDocument(nextDocument))));
	});

	test('saveAs writes to the picked target and returns a new input', async () => {
		const resource = URI.parse('test://workspace/original.noripan.canvas.json');
		const target = URI.parse('test://workspace/copy.noripan.canvas.json');
		const store = new Map<string, string>([[resource.toString(), serializeNoripanCanvasDocument(DEFAULT_NORIPAN_CANVAS_DOCUMENT)]]);
		const services = createServices(store, target);
		const input = createInput(resource, services);

		input.setDocument({
			version: 1,
			surfaces: [
				{ id: 'surface-1', type: 'browser', title: 'Browser', url: 'https://example.com', x: 0, y: 0, width: 960, height: 640, zIndex: 1 }
			]
		}, true);
		inputs.push(input);

		const savedAs = await input.saveAs(0 as GroupIdentifier);
		assert.ok(savedAs instanceof NoripanCanvasEditorInput);
		inputs.push(savedAs as NoripanCanvasEditorInput);
		assert.strictEqual((savedAs as NoripanCanvasEditorInput).resource.toString(), target.toString());
		assert.strictEqual(input.isDirty(), false);
		assert.strictEqual(store.get(target.toString())!.includes('https://example.com'), true);
	});

	test('hard revert reloads the document from disk', async () => {
		const resource = URI.parse('test://workspace/revert.noripan.canvas.json');
		const original = {
			version: 1 as const,
			surfaces: [
				{ id: 'surface-1', type: 'text-editor' as const, title: 'Editor', resource: URI.parse('test://workspace/file.txt'), x: 4, y: 5, width: 820, height: 520, zIndex: 1 }
			]
		};
		const store = new Map<string, string>([[resource.toString(), serializeNoripanCanvasDocument(original)]]);
		const services = createServices(store);
		const input = createInput(resource, services);
		inputs.push(input);

		await input.resolveCanvasDocument();
		input.setDocument(DEFAULT_NORIPAN_CANVAS_DOCUMENT, true);

		await input.revert(0 as GroupIdentifier);
		assert.strictEqual(input.isDirty(), false);
		assert.deepStrictEqual(await input.resolveCanvasDocument(), normalizeNoripanCanvasDocument(JSON.parse(serializeNoripanCanvasDocument(original))));
	});
});

function createInput(resource: URI, services: ReturnType<typeof createServices>): NoripanCanvasEditorInput {
	return new NoripanCanvasEditorInput(resource, services.textFileService, services.fileDialogService, services.instantiationService, services.labelService);
}

function createServices(store: Map<string, string>, fileToSave?: URI) {
	const labelService = {
		getUriBasenameLabel: (resource: URI) => resource.path.split('/').at(-1) ?? resource.path,
		getUriLabel: (resource: URI) => resource.toString()
	} as unknown as ILabelService;

	const textFileService = {
		read: async (resource: URI) => ({ value: store.get(resource.toString()) ?? serializeNoripanCanvasDocument(DEFAULT_NORIPAN_CANVAS_DOCUMENT) }),
		write: async (resource: URI, value: string) => {
			store.set(resource.toString(), value);
			return {};
		}
	} as unknown as ITextFileService;

	const fileDialogService = {
		pickFileToSave: async () => fileToSave
	} as unknown as IFileDialogService;

	const instantiationService = {
		createInstance<T>(ctor: new (...args: any[]) => T, ...args: any[]): T {
			return new ctor(...args, textFileService, fileDialogService, instantiationService, labelService);
		}
	} as unknown as IInstantiationService;

	return { textFileService, fileDialogService, instantiationService, labelService };
}
