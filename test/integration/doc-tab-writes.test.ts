import assert from 'node:assert/strict';
import { after, before, beforeEach, describe, it } from 'node:test';
import type { docs_v1 } from 'googleapis';
import { callTool, setupTestServer, type TestContext } from '../helpers/setup-server.js';

const documentId = 'synthetic-doc-tab-writes';
const firstTabId = 'synthetic-first';
const secondTabId = 'synthetic-second';
const nestedTabId = 'synthetic-nested';

type SyntheticTab = { tabId: string; title: string; text: string; tables: number; parentTabId?: string };
type NativeBatch = { documentId: string; requestBody: { requests: docs_v1.Schema$Request[] } };
type NativeTarget = { index?: number | null; startIndex?: number | null; endIndex?: number | null; tabId?: string | null };

class SyntheticGoogleDocument {
  tabs: SyntheticTab[] = [];
  batches: NativeBatch[] = [];
  reads: Array<{ documentId: string; includeTabsContent?: boolean }> = [];
  expectedTabId: string | undefined;

  reset() {
    this.tabs = [{ tabId: firstTabId, title: 'First', text: '', tables: 0 }];
    this.batches = [];
    this.reads = [];
    this.expectedTabId = undefined;
  }

  tab(tabId: string): SyntheticTab {
    const selectedTab = this.tabs.find(tab => tab.tabId === tabId);
    assert.ok(selectedTab, `Synthetic Docs: unknown tab ${tabId}`);
    return selectedTab;
  }

  target(location: NativeTarget): SyntheticTab {
    assert.equal(location.tabId, this.expectedTabId, 'Synthetic Docs: missing or wrong native tab target');
    return this.tab(location.tabId ?? firstTabId);
  }

  body(tab: SyntheticTab): docs_v1.Schema$Body {
    return { content: [{ startIndex: 1, endIndex: tab.text.length + 2, paragraph: {
      elements: [{ startIndex: 1, endIndex: tab.text.length + 2, textRun: { content: `${tab.text}\n` } }],
    } }] };
  }

  nativeTab(tab: SyntheticTab): docs_v1.Schema$Tab {
    return {
      tabProperties: { tabId: tab.tabId, title: tab.title },
      documentTab: { body: this.body(tab) },
      childTabs: this.tabs.filter(child => child.parentTabId === tab.tabId).map(child => this.nativeTab(child)),
    };
  }

  read(query: { documentId: string; includeTabsContent?: boolean }) {
    assert.equal(query.documentId, documentId);
    this.reads.push(structuredClone(query));
    return { data: {
      documentId, title: 'Synthetic tab regression', body: this.body(this.tab(firstTabId)),
      ...(query.includeTabsContent ? {
        tabs: this.tabs.filter(tab => !tab.parentTabId).map(tab => this.nativeTab(tab)),
      } : {}),
    } };
  }

  apply(request: docs_v1.Schema$Request) {
    if (request.insertText) {
      const { location, text } = request.insertText;
      assert.ok(location);
      assert.equal(typeof text, 'string');
      const tab = this.target(location);
      const offset = (location.index ?? 0) - 1;
      assert.ok(offset >= 0 && offset <= tab.text.length);
      tab.text = tab.text.slice(0, offset) + text + tab.text.slice(offset);
    } else if (request.deleteContentRange) {
      const range = request.deleteContentRange.range;
      assert.ok(range);
      const tab = this.target(range);
      assert.equal(range.startIndex, 1);
      assert.equal(range.endIndex, tab.text.length + 1, 'Deletion must use selected tab extent');
      assert.ok(tab.text.length > 0, 'Empty tab must not be deleted');
      tab.text = '';
    } else if (request.updateParagraphStyle) {
      const range = request.updateParagraphStyle.range;
      assert.ok(range);
      const tab = this.target(range);
      assert.deepEqual(request.updateParagraphStyle, {
        range: { startIndex: 1, endIndex: tab.text.length + 1, ...(this.expectedTabId ? { tabId: this.expectedTabId } : {}) },
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType',
      });
    } else if (request.insertTable) {
      assert.ok(request.insertTable.location);
      this.target(request.insertTable.location).tables++;
    } else {
      this.applyTabRequest(request);
    }
  }

  applyTabRequest(request: docs_v1.Schema$Request) {
    const tabRequest = request as {
      addDocumentTab?: { tabProperties: { title: string } };
      updateDocumentTabProperties?: { tabProperties: { tabId: string; title: string }; fields: string };
    };
    if (tabRequest.addDocumentTab) {
      assert.equal(this.tabs.length, 1);
      this.tabs.push({ tabId: secondTabId, title: tabRequest.addDocumentTab.tabProperties.title, text: '', tables: 0 });
    } else {
      assert.ok(tabRequest.updateDocumentTabProperties, 'Synthetic Docs: unsupported request');
      const rename = tabRequest.updateDocumentTabProperties;
      assert.deepEqual(Object.keys(rename).sort(), ['fields', 'tabProperties']);
      assert.deepEqual(Object.keys(rename.tabProperties).sort(), ['tabId', 'title']);
      assert.equal(rename.fields, 'title');
      this.tab(rename.tabProperties.tabId).title = rename.tabProperties.title;
    }
  }

  batch(batch: NativeBatch) {
    assert.equal(batch.documentId, documentId);
    this.batches.push(structuredClone(batch));
    for (const request of batch.requestBody.requests) this.apply(request);
    return { data: { replies: batch.requestBody.requests.map(() => ({})) } };
  }
}

function batch(...requests: docs_v1.Schema$Request[]): NativeBatch {
  return { documentId, requestBody: { requests } };
}

function replacement(content: string, tabId?: string): NativeBatch {
  const target = tabId === undefined ? {} : { tabId };
  return batch(
    { insertText: { location: { index: 1, ...target }, text: content } },
    { updateParagraphStyle: {
      range: { startIndex: 1, endIndex: content.length + 1, ...target },
      paragraphStyle: { namedStyleType: 'NORMAL_TEXT' }, fields: 'namedStyleType',
    } },
  );
}

describe('Google Docs native tab write regressions (synthetic Google fixture)', () => {
  let ctx: TestContext;
  const fixture = new SyntheticGoogleDocument();

  before(async () => {
    ctx = await setupTestServer();
    ctx.mocks.docs.service.documents.get._setImpl(async query => fixture.read(query));
    ctx.mocks.docs.service.documents.batchUpdate._setImpl(async request => fixture.batch(request));
    ctx.mocks.drive.service.files.create._setImpl(async () => {
      fixture.reset();
      return { data: { id: documentId, name: 'Synthetic tab regression', webViewLink: 'https://example.invalid/synthetic-doc' } };
    });
  });
  after(async () => { await ctx.cleanup(); });
  beforeEach(() => { fixture.reset(); ctx.mocks.docs.tracker.reset(); });

  async function succeed(name: string, args: Record<string, unknown>) {
    const response = await callTool(ctx.client, name, args);
    assert.equal(response.isError, false, JSON.stringify(response));
    return response;
  }

  it('advertises optional nonempty tabId on all three public tool schemas', async () => {
    const catalog = await ctx.client.listTools();
    for (const name of ['insertText', 'updateGoogleDoc', 'insertTable']) {
      const tool = catalog.tools.find(candidate => candidate.name === name);
      assert.ok(tool, `Missing tool ${name}`);
      const tabIdSchema = tool.inputSchema.properties?.tabId as { type?: string; minLength?: number } | undefined;
      assert.ok(tabIdSchema, `Missing public tabId schema on ${name}`);
      assert.equal(tabIdSchema.type, 'string');
      assert.equal(tabIdSchema.minLength, 1);
      assert.ok(!tool.inputSchema.required?.includes('tabId'));
    }
  });

  it('creates, adds, targets, replaces, renames and reads both tabs without sibling mutations', async () => {
    await succeed('createGoogleDoc', { name: 'Synthetic tab regression', content: 'First seed' });
    await succeed('addDocumentTab', { documentId, title: 'Second' });
    fixture.expectedTabId = firstTabId;
    await succeed('insertText', { documentId, tabId: firstTabId, index: 1, text: 'First distinct ' });
    assert.deepEqual(fixture.batches.slice(-1)[0], batch({ insertText: { location: { index: 1, tabId: firstTabId }, text: 'First distinct ' } }));
    fixture.expectedTabId = secondTabId;
    await succeed('insertText', { documentId, tabId: secondTabId, index: 1, text: 'Second unique longer text' });
    assert.deepEqual(fixture.batches.slice(-1)[0], batch({ insertText: { location: { index: 1, tabId: secondTabId }, text: 'Second unique longer text' } }));
    const sibling = structuredClone(fixture.tab(firstTabId));
    fixture.batches = [];
    await succeed('updateGoogleDoc', { documentId, tabId: secondTabId, content: 'Replacement' });
    assert.deepEqual(fixture.reads.slice(-1)[0], { documentId, includeTabsContent: true });
    assert.deepEqual(fixture.batches, [
      batch({ deleteContentRange: { range: { startIndex: 1, endIndex: 26, tabId: secondTabId } } }),
      replacement('Replacement', secondTabId),
    ]);
    await succeed('renameDocumentTab', { documentId, tabId: secondTabId, title: 'Renamed second' });
    assert.deepEqual(fixture.batches.slice(-1)[0], { documentId, requestBody: { requests: [{
      updateDocumentTabProperties: { tabProperties: { tabId: secondTabId, title: 'Renamed second' }, fields: 'title' },
    }] } });
    assert.deepEqual(fixture.tab(firstTabId), sibling);
    assert.equal(fixture.tab(secondTabId).text, 'Replacement');
    const readback = await succeed('getGoogleDocContent', { documentId });
    assert.match(readback.content[0].text, /First distinct First seed/);
    assert.match(readback.content[0].text, /=== Tab: Renamed second ===/);
    assert.match(readback.content[0].text, /Replacement/);
    assert.doesNotMatch(readback.content[0].text, /Second unique longer text/);
  });

  it('resolves a nested tab and derives its deletion extent independently of the legacy body', async () => {
    fixture.tab(firstTabId).text = 'A much longer sibling that must survive';
    fixture.tabs.push({ tabId: nestedTabId, title: 'Nested', text: 'Child', tables: 0, parentTabId: firstTabId });
    const sibling = structuredClone(fixture.tab(firstTabId));
    fixture.expectedTabId = nestedTabId;
    await succeed('updateGoogleDoc', { documentId, tabId: nestedTabId, content: 'New child' });
    assert.deepEqual(fixture.batches, [
      batch({ deleteContentRange: { range: { startIndex: 1, endIndex: 6, tabId: nestedTabId } } }),
      replacement('New child', nestedTabId),
    ]);
    assert.deepEqual(fixture.tab(firstTabId), sibling);
    const readback = await succeed('getGoogleDocContent', { documentId });
    assert.match(readback.content[0].text, /New child/);
  });

  it('rejects a missing tab before any batch write', async () => {
    fixture.tab(firstTabId).text = 'Keep first';
    const beforeTabs = structuredClone(fixture.tabs);
    fixture.expectedTabId = 'synthetic-missing';
    const response = await callTool(ctx.client, 'updateGoogleDoc', { documentId, tabId: 'synthetic-missing', content: 'Never write' });
    assert.equal(response.isError, true);
    assert.match(response.content[0].text, /synthetic-missing/);
    assert.deepEqual(fixture.reads, [{ documentId, includeTabsContent: true }]);
    assert.deepEqual(fixture.batches, []);
    assert.deepEqual(fixture.tabs, beforeTabs);
  });

  it('inserts into an empty selected tab without deleting the populated sibling', async () => {
    fixture.tab(firstTabId).text = 'Keep sibling';
    fixture.tabs.push({ tabId: secondTabId, title: 'Empty', text: '', tables: 0 });
    fixture.expectedTabId = secondTabId;
    await succeed('updateGoogleDoc', { documentId, tabId: secondTabId, content: 'New' });
    assert.deepEqual(fixture.batches, [replacement('New', secondTabId)]);
    assert.equal(fixture.tab(firstTabId).text, 'Keep sibling');
    assert.equal(fixture.tab(secondTabId).text, 'New');
  });

  it('targets table insertion using location.tabId', async () => {
    fixture.tabs.push({ tabId: secondTabId, title: 'Table', text: '', tables: 0 });
    fixture.expectedTabId = secondTabId;
    await succeed('insertTable', { documentId, tabId: secondTabId, index: 1, rows: 2, columns: 3 });
    assert.deepEqual(fixture.batches, [batch({ insertTable: { location: { index: 1, tabId: secondTabId }, rows: 2, columns: 3 } })]);
    assert.equal(fixture.tab(firstTabId).tables, 0);
    assert.equal(fixture.tab(secondTabId).tables, 1);
  });

  it('preserves exact omitted-tab payloads and response text', async () => {
    const inserted = await succeed('insertText', { documentId, index: 1, text: 'Old' });
    assert.deepEqual(inserted, { content: [{ type: 'text', text: 'Successfully inserted 3 characters at index 1' }], isError: false });
    assert.deepEqual(fixture.batches, [batch({ insertText: { location: { index: 1 }, text: 'Old' } })]);
    fixture.batches = [];
    const updated = await succeed('updateGoogleDoc', { documentId, content: 'New' });
    assert.deepEqual(updated, { content: [{ type: 'text', text: 'Updated Google Doc: Synthetic tab regression' }], isError: false });
    assert.deepEqual(fixture.reads, [{ documentId }]);
    assert.deepEqual(fixture.batches, [batch({ deleteContentRange: { range: { startIndex: 1, endIndex: 4 } } }), replacement('New')]);
    fixture.batches = [];
    const table = await succeed('insertTable', { documentId, index: 1, rows: 2, columns: 3 });
    assert.deepEqual(table, { content: [{ type: 'text', text: 'Successfully inserted 2x3 table at index 1' }], isError: false });
    assert.deepEqual(fixture.batches, [batch({ insertTable: { location: { index: 1 }, rows: 2, columns: 3 } })]);
  });

  for (const [name, args] of [
    ['insertText', { index: 1, text: 'Invalid' }],
    ['updateGoogleDoc', { content: 'Invalid' }],
    ['insertTable', { index: 1, rows: 1, columns: 1 }],
  ] as const) {
    for (const tabId of ['', 42, null, false, {}, []]) {
      it(`${name} rejects invalid tabId ${JSON.stringify(tabId)} before Google calls`, async () => {
        const beforeTabs = structuredClone(fixture.tabs);
        const response = await callTool(ctx.client, name, { documentId, ...args, tabId });
        assert.equal(response.isError, true);
        assert.deepEqual(ctx.mocks.docs.tracker.calls, []);
        assert.deepEqual(fixture.tabs, beforeTabs);
      });
    }
  }
});
