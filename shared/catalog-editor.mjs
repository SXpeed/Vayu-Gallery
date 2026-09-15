import {normalizeDesign, catalogImages, catalogPages, MAX_CATALOG_PAGES} from './catalog-design.mjs';

const HISTORY_LIMIT = 40;

// Catalog forms contain plain structured data. Compare object contents rather
// than property insertion order so normalization does not add an undo step.
function sameValue(a, b) {
  if (Object.is(a, b)) return true;
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every(key =>
    Object.hasOwn(b, key) && sameValue(a[key], b[key]));
}

export function createEditorHistory(value) {
  return {past: [], present: structuredClone(value), future: []};
}

export function editorHistory(state, action) {
  switch (action.type) {
    case 'change':
      if (sameValue(state.present, action.value)) return state;
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: structuredClone(action.value),
        future: []
      };
    case 'replace':
      if (sameValue(state.present, action.value)) return state;
      return {...state, present: structuredClone(action.value), future: []};
    case 'undo':
      if (!state.past.length) return state;
      return {
        past: state.past.slice(0, -1),
        present: state.past.at(-1),
        future: [state.present, ...state.future]
      };
    case 'redo':
      if (!state.future.length) return state;
      return {
        past: [...state.past, state.present].slice(-HISTORY_LIMIT),
        present: state.future[0],
        future: state.future.slice(1)
      };
    case 'reset':
      return createEditorHistory(action.value);
    default:
      return state;
  }
}

export function mergeSelection(selected, additions, limit = 100) {
  const maximum = limit === Infinity ? Infinity : Math.max(0, Math.floor(Number(limit) || 0));
  return [...new Set([...selected, ...additions])].slice(0, maximum);
}

export function sortSelection(ids, artworks, mode) {
  if (mode === 'reverse') return [...ids].reverse();
  if (!['title-asc', 'title-desc'].includes(mode)) return [...ids];
  const records = new Map(artworks.map(art => [art.id, art]));
  const direction = mode === 'title-desc' ? -1 : 1;
  return ids.map((id, index) => ({id, index})).sort((a, b) => {
    const left = records.get(a.id), right = records.get(b.id);
    if (!left || !right) return !left && !right ? a.index - b.index : !left ? 1 : -1;
    return direction * String(left.title || '').localeCompare(String(right.title || ''), 'en', {
      sensitivity: 'base', numeric: true
    }) || a.index - b.index;
  }).map(item => item.id);
}

export function exportChecks(catalog, artworks) {
  const checks = [];
  const selected = [...new Set(catalog?.artworkIds || [])];
  const records = new Map(artworks.map(art => [art.id, art]));
  const design = normalizeDesign(catalog?.design, catalog?.theme);
  if (!catalog?.title?.trim()) checks.push({severity: 'error', message: 'Add a catalog name before generating a PDF.'});
  if (!selected.length) checks.push({severity: 'error', message: 'Select at least one product before generating a PDF.'});
  const unavailable = selected.filter(id => !records.has(id));
  if (unavailable.length) checks.push({severity: 'error', message: `${unavailable.length} selected ${unavailable.length === 1 ? 'product is' : 'products are'} unavailable. Reload or remove the selection before generating.`});
  if (catalogPages(design, selected.map(id => records.get(id)).filter(Boolean)).length > MAX_CATALOG_PAGES) checks.push({
    severity: 'error', message: `Catalogs can contain at most ${MAX_CATALOG_PAGES} pages. Use fewer continuation pages or select fewer products.`
  });
  const withoutImages = selected.filter(id => records.has(id) && !catalogImages(records.get(id), design).length);
  if (withoutImages.length) checks.push({severity: 'warning', message: `${withoutImages.length} selected ${withoutImages.length === 1 ? 'product has' : 'products have'} no included images. Check the image selection.`});
  if (selected.length && design.productsPerPage >= 4 && design.showDescription) checks.push({
    severity: 'warning', message: 'Four or more products per page leave less room for descriptions. Check the preview for shortened text.'
  });
  return checks;
}
