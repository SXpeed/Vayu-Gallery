import test from 'node:test';
import assert from 'node:assert/strict';
import {createEditorHistory, editorHistory, mergeSelection, sortSelection, exportChecks} from '../shared/catalog-editor.mjs';

const original = () => ({title: 'Summer', artworkIds: ['a1'], design: {
  logo: '/api/files/9de8affd-414e-4b55-a067-e3f89d906cbb', selectedImages: {a1: ['/art/quiet.svg']}
}});

test('history snapshots isolate inputs and restore nested selections and canonical media references', () => {
  const initial = original();
  const start = createEditorHistory(initial);
  initial.design.selectedImages.a1.push('/art/earth.svg');
  assert.deepEqual(start.present, original());
  const changed = {...original(), artworkIds: ['a2', 'a1']};
  const next = editorHistory(start, {type: 'change', value: changed});
  changed.artworkIds.push('a3');
  assert.deepEqual(next.present.artworkIds, ['a2', 'a1']);
  assert.deepEqual(start, createEditorHistory(original()));
  const previous = editorHistory(next, {type: 'undo'});
  assert.deepEqual(previous.present, original());
  assert.deepEqual(editorHistory(previous, {type: 'redo'}), next);
});

test('equal snapshots do not add undo steps or discard the redo branch', () => {
  const start = createEditorHistory(original());
  assert.equal(editorHistory(start, {type: 'undo'}), start);
  assert.equal(editorHistory(start, {type: 'redo'}), start);
  const change = editorHistory(start, {type: 'change', value: {...original(), title: 'Winter'}});
  const undone = editorHistory(change, {type: 'undo'});
  const reordered = {design: original().design, artworkIds: ['a1'], title: 'Summer'};
  assert.equal(editorHistory(undone, {type: 'change', value: reordered}), undone);
  const branched = editorHistory(undone, {type: 'change', value: {...original(), title: 'Autumn'}});
  assert.deepEqual(branched.future, []);
  assert.equal(editorHistory(branched, {type: 'redo'}), branched);
});

test('history retains at most 40 past snapshots and reset clears both directions', () => {
  let history = createEditorHistory({number: 0});
  for (let number = 1; number <= 70; number++) history = editorHistory(history, {type: 'change', value: {number}});
  assert.equal(history.past.length, 40);
  assert.deepEqual(history.past[0], {number: 30});
  for (let i = 0; i < 40; i++) history = editorHistory(history, {type: 'undo'});
  assert.deepEqual(history.present, {number: 30});
  assert.equal(history.future.length, 40);
  for (let i = 0; i < 40; i++) history = editorHistory(history, {type: 'redo'});
  assert.equal(history.past.length, 40);
  assert.deepEqual(history.present, {number: 70});
  const resetValue = original();
  const reset = editorHistory(history, {type: 'reset', value: resetValue});
  resetValue.title = 'External edit';
  assert.deepEqual(reset, createEditorHistory(original()));
});

test('slider replacements coalesce into one undo step and isolate the latest input', () => {
  const start = createEditorHistory({zoom: 1});
  let dragged = editorHistory(start, {type: 'change', value: {zoom: 1.1}});
  dragged = editorHistory(dragged, {type: 'replace', value: {zoom: 1.2}});
  const last = {zoom: 2};
  dragged = editorHistory(dragged, {type: 'replace', value: last});
  last.zoom = 3;
  assert.equal(dragged.past.length, 1);
  assert.deepEqual(dragged.present, {zoom: 2});
  assert.deepEqual(editorHistory(dragged, {type: 'undo'}).present, {zoom: 1});
  assert.equal(editorHistory(dragged, {type: 'replace', value: {zoom: 2}}), dragged);
  const undone = editorHistory(dragged, {type: 'undo'});
  const replacement = editorHistory(undone, {type: 'replace', value: {zoom: 1.5}});
  assert.deepEqual(replacement.future, []);
  assert.equal(replacement.past.length, 0);
});

test('bulk selection retains previous pages, deduplicates and caps additions', () => {
  const selected = ['a3', 'a1'];
  const additions = ['a1', 'a2', 'a3', 'a4'];
  assert.deepEqual(mergeSelection(selected, additions), ['a3', 'a1', 'a2', 'a4']);
  assert.deepEqual(mergeSelection(selected, additions, 3), ['a3', 'a1', 'a2']);
  assert.deepEqual(selected, ['a3', 'a1']);
  assert.deepEqual(additions, ['a1', 'a2', 'a3', 'a4']);
  assert.equal(mergeSelection([], Array.from({length: 105}, (_, i) => `a${i}`)).length, 100);
  assert.equal(mergeSelection([], Array.from({length: 105}, (_, i) => `a${i}`), Infinity).length, 105);
  assert.deepEqual(mergeSelection(selected, additions, 0), []);
});

test('sorting changes only selected IDs and leaves unavailable records at the end', () => {
  const ids = ['missing-1', 'a3', 'a2', 'missing-2', 'a1'];
  const artworks = [{id: 'a1', title: 'Artwork 2'}, {id: 'a2', title: 'Artwork 10'}, {id: 'a3', title: 'Apple'}, {id: 'not-selected', title: 'Aardvark'}];
  assert.deepEqual(sortSelection(ids, artworks, 'title-asc'), ['a3', 'a1', 'a2', 'missing-1', 'missing-2']);
  assert.deepEqual(sortSelection(ids, artworks, 'title-desc'), ['a2', 'a1', 'a3', 'missing-1', 'missing-2']);
  assert.deepEqual(sortSelection(ids, artworks, 'reverse'), ['a1', 'missing-2', 'a2', 'a3', 'missing-1']);
  assert.deepEqual(sortSelection(ids, artworks, 'unknown'), ids);
  assert.deepEqual(ids, ['missing-1', 'a3', 'a2', 'missing-2', 'a1']);
});

test('case-equivalent titles keep their original order', () => {
  const records = [{id: 'a1', title: 'Study'}, {id: 'a2', title: 'STUDY'}];
  assert.deepEqual(sortSelection(['a2', 'a1'], records, 'title-asc'), ['a2', 'a1']);
  assert.deepEqual(sortSelection(['a2', 'a1'], records, 'title-desc'), ['a2', 'a1']);
});

test('export errors explain missing name, empty selection and unavailable selected products', () => {
  const blank = exportChecks({title: '  ', artworkIds: []}, []);
  assert.equal(blank.filter(check => check.severity === 'error').length, 2);
  assert.match(blank[0].message, /catalog name/);
  assert.match(blank[1].message, /at least one product/);
  const unavailable = exportChecks({title: 'Summer', artworkIds: ['a1', 'a2']}, [{id: 'a1', images: ['/art/quiet.svg']}]);
  assert.deepEqual(unavailable.map(check => check.severity), ['error']);
  assert.match(unavailable[0].message, /1 selected product is unavailable/);
  const allMissing = exportChecks({title: 'Summer', artworkIds: ['a1', 'a2']}, []);
  assert.equal(allMissing.length, 1);
  assert.equal(allMissing[0].severity, 'error');
  assert.match(allMissing[0].message, /2 selected products are unavailable/);
});

test('export checks honor explicit empty image selections and ignore unselected inventory', () => {
  const artworks = [{id: 'a1', images: ['/art/quiet.svg']}, {id: 'a2', images: []}];
  assert.deepEqual(exportChecks(original(), artworks), []);
  const checks = exportChecks({...original(), design: {selectedImages: {a1: []}}}, artworks);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].severity, 'warning');
  assert.match(checks[0].message, /1 selected product has no included images/);
  const staleChoice = exportChecks({...original(), design: {selectedImages: {a1: ['/art/earth.svg']}}}, artworks);
  assert.match(staleChoice[0].message, /no included images/);
});

test('dense descriptions are advisory and disappear for image-only layouts', () => {
  const artwork = {id: 'a1', images: ['/art/quiet.svg']};
  const form = {...original(), design: {productsPerPage: 6, showDescription: true}};
  const checks = exportChecks(form, [artwork]);
  assert.equal(checks.length, 1);
  assert.equal(checks[0].severity, 'warning');
  assert.match(checks[0].message, /descriptions/);
  assert.deepEqual(exportChecks({...form, design: {...form.design, showDescription: false}}, [artwork]), []);
  assert.deepEqual(exportChecks({...form, design: {...form.design, productsPerPage: 3}}, [artwork]), []);
  assert.deepEqual(form.design, {productsPerPage: 6, showDescription: true});
});
