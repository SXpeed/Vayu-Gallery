export const templates = [
  {id:'editorial',name:'Editorial',description:'Large title, a single framed image.'},
  {id:'banner',name:'Panorama',description:'A wide banner and a bold introduction.'},
  {id:'split',name:'Split story',description:'Image and typography, side by side.'},
  {id:'mosaic',name:'Gallery',description:'A cover with up to four selected images.'},
  {id:'minimal',name:'Type only',description:'A quiet cover focused on your title.'}
];
export const fonts = ['Playfair Display','Inter','Georgia','Arial','Courier New'];
export const MAX_CATALOG_PAGES = 200;
export const continuationLayouts = [
  {id:'single',name:'Full page',description:'One additional image fills each page.',capacity:1},
  {id:'split',name:'Two images',description:'A balanced pair of additional views.',capacity:2},
  {id:'grid',name:'Grid',description:'Up to four images in an even gallery grid.',capacity:4},
  {id:'feature',name:'Feature collage',description:'One large image with up to two supporting views.',capacity:3}
];
export const defaults = {template:'editorial',format:'portrait',background:'#f7f5ed',background2:'#dfd8c7',backgroundMode:'solid',gradientAngle:135,titleColor:'#29392f',textColor:'#465448',priceColor:'#29392f',titleFont:'Playfair Display',bodyFont:'Inter',titleSize:28,bodySize:12,titleBold:false,textAlign:'left',logo:'',logoPosition:'bottom-center',logoSize:16,brandText:'vayu.',footerText:'DESIGN FOR LIVING',watermarkText:'',watermarkOpacity:.08,coverImage:'',coverTitle:true,coverDescription:true,includeCover:true,showTitle:true,showArtist:true,showDescription:true,showPrice:true,showMedium:true,showDimensions:true,showYear:false,showStatus:false,showFooter:true,showPageNumbers:true,productsPerPage:1,productLayout:'auto',imagesPerProduct:1,imageFit:'contain',imageRatio:'auto',imageGap:12,imageZoom:1,imageX:50,imageY:50,imageShadow:false,cardBorder:false,cardBackground:false,cardRadius:0,gap:18,margin:48,selectedImages:{},imageOverrides:{},continuations:{}};
const bools=Object.keys(defaults).filter(k=>typeof defaults[k]==='boolean');
const choices={template:templates.map(t=>t.id),format:['portrait','landscape','square'],backgroundMode:['solid','linear','radial'],titleFont:fonts,bodyFont:fonts,textAlign:['left','center','right'],logoPosition:['none','top-left','top-center','top-right','bottom-left','bottom-center','bottom-right'],imageFit:['contain','cover'],productLayout:['auto','stacked','side-by-side'],imageRatio:['auto','square','portrait','landscape']};
const ranges={gradientAngle:[0,360],titleSize:[16,48],bodySize:[9,20],logoSize:[6,35],productsPerPage:[1,6],imagesPerProduct:[1,6],imageZoom:[.5,3],imageX:[0,100],imageY:[0,100],imageGap:[0,32],cardRadius:[0,32],watermarkOpacity:[.03,.25],gap:[6,40],margin:[20,80]};
export const validImageSource=s=>typeof s==='string'&&(/^\/art\/[a-z]+\.svg$/.test(s)||/^\/api\/files\/[a-z0-9-]+$/.test(s));
export function normalizeDesign(input={},theme='Ivory') {
  const base={...defaults,selectedImages:{},imageOverrides:{},continuations:{}};
  if(theme==='Charcoal')Object.assign(base,{background:'#27302c',background2:'#495548',titleColor:'#f4eedf',textColor:'#e1dfd4',priceColor:'#f4eedf'});
  if(theme==='Clay')Object.assign(base,{background:'#e2d0b8',background2:'#c9a884'});
  if(!input||typeof input!=='object'||Array.isArray(input))return base;
  for(const [k,opts] of Object.entries(choices))if(opts.includes(input[k]))base[k]=input[k];
  for(const k of bools)if(typeof input[k]==='boolean')base[k]=input[k];
  for(const [k,[min,max]] of Object.entries(ranges))if(Number.isFinite(input[k]))base[k]=Math.max(min,Math.min(max,input[k]));
  for(const k of ['productsPerPage','imagesPerProduct'])base[k]=Math.round(base[k]);
  for(const k of ['background','background2','titleColor','textColor','priceColor'])if(/^#[0-9a-f]{6}$/i.test(input[k]))base[k]=input[k];
  for(const k of ['brandText','footerText'])if(typeof input[k]==='string')base[k]=input[k].slice(0,150);
  if(typeof input.watermarkText==='string')base.watermarkText=input.watermarkText.replace(/[\u0000-\u001f\u007f]/g,' ').slice(0,100);
  for(const k of ['logo','coverImage'])if(input[k]===''||validImageSource(input[k]))base[k]=input[k];
  if(input.selectedImages&&typeof input.selectedImages==='object')for(const [id,urls] of Object.entries(input.selectedImages).slice(0,500))if(/^[a-z0-9-]+$/i.test(id)&&Array.isArray(urls))base.selectedImages[id]=[...new Set(urls.filter(validImageSource))].slice(0,30);
  if(input.imageOverrides&&typeof input.imageOverrides==='object')for(const [url,v] of Object.entries(input.imageOverrides).slice(0,500))if(validImageSource(url)&&v&&typeof v==='object')base.imageOverrides[url]={zoom:Number.isFinite(v.zoom)?Math.max(.5,Math.min(3,v.zoom)):1,x:Number.isFinite(v.x)?Math.max(0,Math.min(100,v.x)):50,y:Number.isFinite(v.y)?Math.max(0,Math.min(100,v.y)):50,fit:['contain','cover'].includes(v.fit)?v.fit:'contain'};
  if(input.continuations&&typeof input.continuations==='object'&&!Array.isArray(input.continuations))for(const [id,v] of Object.entries(input.continuations).slice(0,100))if(/^[a-z0-9-]{1,128}$/i.test(id)&&v&&typeof v==='object'&&!Array.isArray(v))base.continuations[id]={enabled:v.enabled===true,layout:continuationLayouts.some(l=>l.id===v.layout)?v.layout:'single',showTitle:typeof v.showTitle==='boolean'?v.showTitle:true};
  return base;
}
export function productImages(art){return [...new Set([...(art?.images||[]),art?.image,art?.bannerImage].filter(Boolean))];}
export function selectedCatalogImages(art,d){const all=productImages(art),selected=d.selectedImages?.[art?.id];return Array.isArray(selected)?[...new Set(selected.filter(x=>all.includes(x)))]:all;}
export function catalogImages(art,d){return selectedCatalogImages(art,d).slice(0,d.imagesPerProduct);}
export function pageDimensions(d){return d.format==='landscape'?[1414,1000]:d.format==='square'?[1000,1000]:[1000,1414];}
export function catalogPages(d,arts){
  const pages=d.includeCover?[{kind:'cover',arts}]:[],perPage=Math.max(1,Math.min(6,Math.round(Number(d.productsPerPage)||1)));let pending=[];
  const flush=()=>{if(pending.length){pages.push({kind:'products',arts:pending});pending=[];}};
  for(const art of arts){
    const setting=d.continuations?.[art.id],extras=setting?.enabled===true?selectedCatalogImages(art,d).slice(d.imagesPerProduct):[];
    if(extras.length){
      flush();pages.push({kind:'products',arts:[art],productsPerPage:1});
      const layout=continuationLayouts.find(l=>l.id===setting.layout)||continuationLayouts[0];
      for(let offset=0;offset<extras.length;offset+=layout.capacity)pages.push({kind:'continuation',arts:[art],sources:extras.slice(offset,offset+layout.capacity),layout:layout.id,showTitle:setting.showTitle!==false,continuationIndex:offset/layout.capacity});
    }else{pending.push(art);if(pending.length===perPage)flush();}
  }
  flush();return pages;
}
export function designImageSources(d){return [d?.logo,d?.coverImage,...Object.values(d?.selectedImages||{}).flat(),...Object.keys(d?.imageOverrides||{})].filter(Boolean);}
