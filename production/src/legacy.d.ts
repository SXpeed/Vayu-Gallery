declare module '*catalog-renderer.js' {
 export function createCatalogRenderer(runtime:{loadImage:(src:string)=>Promise<unknown>;loadFonts:()=>Promise<void>;formatPrice?:(art:any)=>string;formatDimensions?:(dimensions:any)=>string}):{renderCatalogPage:(catalog:any,artworks:any[],index:number,canvas:any)=>Promise<unknown>};
}
declare module '*catalog-design.mjs' {
 export const MAX_CATALOG_PAGES:number;
 export function normalizeDesign(input:unknown):any;
 export function catalogPages(design:any,artworks:any[]):any[];
 export function pageDimensions(design:any):[number,number];
 export function designImageSources(design:any):string[];
}
declare module '*catalog-editor.mjs' {
 export function exportChecks(catalog:any,artworks:any[]):Array<{severity:'error'|'warning';message:string}>;
}
