import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDesign,continuationLayouts,selectedCatalogImages,catalogImages,catalogPages,MAX_CATALOG_PAGES} from '../shared/catalog-design.mjs';
import {createCatalogRenderer} from '../src/catalog-renderer.js';

const photo=i=>`/api/files/photo-${i}`;
const art=(id,count=8)=>({id,title:`Artwork ${id}`,artist:'Private artist',description:'Private description',medium:'Private medium',dimensions:'Private dimensions',year:2026,status:'Reserved',price:998877,images:Array.from({length:count},(_,i)=>photo(i)),image:photo(0)});
const continuation=(layout='single',showTitle=true)=>({enabled:true,layout,showTitle});
const plan=(arts,settings={})=>{const design=normalizeDesign({includeCover:false,...settings});return {design,pages:catalogPages(design,arts)};};

function recordingCanvas(){
  const calls=[],stack=[],stateKeys=['font','fillStyle','globalAlpha','textAlign','textBaseline','shadowColor','shadowBlur','shadowOffsetY'];
  const ctx={font:'400 12px Inter',globalAlpha:1,shadowBlur:0,
    save(){stack.push(Object.fromEntries(stateKeys.map(k=>[k,this[k]])));},restore(){Object.assign(this,stack.pop());},
    measureText(text){return {width:String(text).length*Number(this.font.match(/([\d.]+)px/)?.[1]||12)*.5};},
    fillText(text,x,y){calls.push({op:'text',text,x,y,color:this.fillStyle,alpha:this.globalAlpha});},
    drawImage(img,...rect){calls.push({op:'image',src:img.src,rect,shadow:this.shadowBlur});},
    createLinearGradient(){return {addColorStop(){}};},createRadialGradient(){return {addColorStop(){}};}
  };
  for(const op of ['beginPath','rect','clip','fillRect','strokeRect','moveTo','lineTo','quadraticCurveTo','closePath','stroke','translate','rotate'])ctx[op]=(...args)=>calls.push({op,args});
  return {calls,canvas:{width:0,height:0,getContext:()=>ctx}};
}
async function render(layout='single',settings={},count=8,page=1){
  const artwork=art('a1',count),design=normalizeDesign({includeCover:false,logoPosition:'none',showFooter:false,showPageNumbers:false,continuations:{a1:continuation(layout,false)},...settings});
  const output=recordingCanvas(),renderer=createCatalogRenderer({loadFonts:async()=>{},loadImage:async src=>({src,width:200,height:100}),formatPrice:()=>'$998,877'});
  await renderer.renderCatalogPage({title:'Catalog',design},[artwork],page,output.canvas);return {...output,design,artwork};
}
const frames=result=>result.calls.filter(c=>c.op==='rect').map(c=>c.args);
const pictures=result=>result.calls.filter(c=>c.op==='image');

test('continuations are off by default and normalize a bounded map of safe per-product settings',()=>{
  assert.deepEqual(normalizeDesign().continuations,{});
  const input={a1:{enabled:true,layout:'grid',showTitle:false,untrusted:'ignored'},a2:{enabled:'yes',layout:'unknown',showTitle:'yes'},a3:null,a4:[],a5:true,'invalid key':continuation()},d=normalizeDesign({continuations:input});
  assert.deepEqual(d.continuations,{a1:{enabled:true,layout:'grid',showTitle:false},a2:{enabled:false,layout:'single',showTitle:true}});
  assert.deepEqual(normalizeDesign({continuations:[continuation()]}).continuations,{});
  assert.equal(Object.keys(normalizeDesign({continuations:Object.fromEntries(Array.from({length:150},(_,i)=>[`a${i}`,continuation()]))}).continuations).length,100);
  d.continuations.a1.layout='single';assert.equal(input.a1.layout,'grid');assert.deepEqual(normalizeDesign().continuations,{});
  assert.deepEqual(continuationLayouts.map(x=>[x.id,x.name,x.capacity]),[['single','Full page',1],['split','Two images',2],['grid','Grid',4],['feature','Feature collage',3]]);
});

test('normal products keep legacy page packing for every product count when continuations are disabled',()=>{
  const arts=Array.from({length:9},(_,i)=>art(`a${i}`));
  for(let count=1;count<=6;count++)for(const includeCover of [true,false]){
    const design=normalizeDesign({productsPerPage:count,includeCover,continuations:{a0:{enabled:false,layout:'feature',showTitle:false}}}),expected=includeCover?[{kind:'cover',arts}]:[];
    for(let i=0;i<arts.length;i+=count)expected.push({kind:'products',arts:arts.slice(i,i+count)});
    assert.deepEqual(catalogPages(design,arts),expected);
  }
});

test('enabled overflow products get their own opening page and immediate continuation pages before normal packing resumes',()=>{
  const arts=[art('a1',1),art('a2',6),art('a3',1),art('a4',1),art('a5',4),art('a6',1)],{pages}=plan(arts,{productsPerPage:3,imagesPerProduct:2,continuations:{a2:continuation('feature'),a5:continuation('split',false)}});
  assert.deepEqual(pages.map(p=>[p.kind,p.arts.map(a=>a.id)]),[['products',['a1']],['products',['a2']],['continuation',['a2']],['continuation',['a2']],['products',['a3','a4']],['products',['a5']],['continuation',['a5']],['products',['a6']]]);
  assert.equal(pages[1].productsPerPage,1);assert.equal(pages[5].productsPerPage,1);assert.equal(pages[0].productsPerPage,undefined);
  assert.deepEqual(pages[2],{kind:'continuation',arts:[arts[1]],sources:[photo(2),photo(3),photo(4)],layout:'feature',showTitle:true,continuationIndex:0});
  assert.equal(pages[3].continuationIndex,1);assert.equal(pages[6].continuationIndex,0);assert.equal(pages[6].showTitle,false);
});

test('chosen image ordering, explicit empty selections, missing images and duplicates are respected',()=>{
  const artwork=art('a1',5),raw={selectedImages:{a1:[photo(4),photo(4),photo(99),photo(2),photo(0)]},imagesPerProduct:1};
  assert.deepEqual(selectedCatalogImages(artwork,raw),[photo(4),photo(2),photo(0)]);assert.deepEqual(catalogImages(artwork,raw),[photo(4)]);
  const {pages,design}=plan([artwork],{...raw,continuations:{a1:continuation('split')}});
  assert.deepEqual([...catalogImages(artwork,design),...pages.filter(p=>p.kind==='continuation').flatMap(p=>p.sources)],[photo(4),photo(2),photo(0)]);
  const empty=plan([artwork],{selectedImages:{a1:[]},continuations:{a1:continuation()}});assert.deepEqual(selectedCatalogImages(artwork,empty.design),[]);assert.equal(empty.pages.length,1);assert.equal(empty.pages[0].productsPerPage,undefined);
  const noOverflow=plan([artwork],{imagesPerProduct:6,continuations:{a1:continuation()}});assert.equal(noOverflow.pages.length,1);assert.equal(noOverflow.pages[0].productsPerPage,undefined);
});

test('every selected image appears exactly once across product and continuation pages for every layout and main image count',()=>{
  const artwork=art('a1',30);
  for(const layout of continuationLayouts)for(let mainCount=1;mainCount<=6;mainCount++){
    const {pages,design}=plan([artwork],{imagesPerProduct:mainCount,continuations:{a1:continuation(layout.id)}}),extras=pages.filter(p=>p.kind==='continuation');
    assert.equal(pages.length,1+Math.ceil((30-mainCount)/layout.capacity));assert.ok(extras.every(p=>p.sources.length<=layout.capacity));
    assert.deepEqual([...catalogImages(artwork,design),...extras.flatMap(p=>p.sources)],artwork.images);
  }
});

test('continuation layouts render full-page, paired, grid and feature geometry',async()=>{
  const full=frames(await render('single'));assert.equal(full.length,1);assert.deepEqual(full[0],[48,100,904,1174]);
  const pair=frames(await render('split'));assert.equal(pair.length,2);assert.equal(pair[0][2],904);assert.equal(pair[0][3],pair[1][3]);assert.equal(pair[1][1]-(pair[0][1]+pair[0][3]),12);
  const grid=frames(await render('grid'));assert.equal(grid.length,4);assert.equal(grid[0][2],grid[3][2]);assert.equal(grid[0][3],grid[3][3]);assert.equal(grid[0][1],grid[1][1]);assert.equal(grid[2][1],grid[3][1]);assert.ok(grid[2][1]>grid[0][1]);
  const feature=frames(await render('feature'));assert.equal(feature.length,3);assert.ok(feature[0][2]>feature[1][2]);assert.ok(feature[0][3]>feature[1][3]);assert.equal(feature[1][0],feature[2][0]);assert.equal(feature[1][3],feature[2][3]);
});

test('partial continuation pages expand remaining images instead of leaving empty slots',async()=>{
  for(const layout of continuationLayouts){const result=await render(layout.id,{},2);assert.equal(frames(result).length,1);assert.deepEqual(frames(result)[0],[48,100,904,1174]);}
  const grid=frames(await render('grid',{},4));assert.equal(grid.length,3);assert.equal(grid[2][2],904);assert.equal(grid[2][0],48);
  const feature=frames(await render('feature',{},3));assert.equal(feature.length,2);assert.equal(feature[0][3],1174);assert.equal(feature[1][3],1174);
});

test('continuation geometry is independent of the main product layout and opening pages use one full product slot',async()=>{
  const stack=await render('grid',{productLayout:'stacked'}),beside=await render('grid',{productLayout:'side-by-side'});assert.deepEqual(frames(stack),frames(beside));
  const opening=await render('single',{productsPerPage:6,showTitle:false,showArtist:false,showDescription:false,showMedium:false,showDimensions:false,showPrice:false},8,0);
  assert.deepEqual(frames(opening),[[48,100,904,1174]]);
});

test('continuation titles are optional and no prices or other product details repeat',async()=>{
  const hidden=await render('single',{showTitle:true,showYear:true,showStatus:true});assert.equal(hidden.calls.filter(c=>c.op==='text').length,0);
  const titled=await render('single',{showTitle:false,showYear:true,showStatus:true,continuations:{a1:continuation('single',true)}});
  assert.deepEqual(titled.calls.filter(c=>c.op==='text').map(c=>c.text),['Artwork a1']);assert.ok(frames(titled)[0][1]>100);
});

test('continuation pages preserve crop overrides, ratio, shadows, image gaps, branding and watermark',async()=>{
  const settings={imageRatio:'square',imageGap:0,imageShadow:true,imageOverrides:{[photo(1)]:{zoom:2,x:100,y:0,fit:'cover'}},watermarkText:'PRIVATE',watermarkOpacity:.2,showFooter:true,footerText:'Gallery',showPageNumbers:true,logoPosition:'top-left',brandText:'Studio'};
  const result=await render('split',settings),first=frames(result)[0],draw=pictures(result)[0];
  assert.equal(first[2],first[3]);assert.equal(draw.src,photo(1));assert.equal(draw.shadow,18);assert.equal(draw.rect[2],first[2]*4);assert.equal(draw.rect[3],first[3]*2);assert.equal(draw.rect[0],first[0]-first[2]*3);assert.equal(draw.rect[1],first[1]);
  const renderedText=result.calls.filter(c=>c.op==='text');assert.ok(renderedText.some(c=>c.text==='PRIVATE'&&c.alpha===.2));assert.ok(renderedText.some(c=>c.text==='Studio'));assert.ok(renderedText.some(c=>c.text==='Gallery'));assert.ok(renderedText.some(c=>c.text===`2 / ${catalogPages(result.design,[result.artwork]).length}`));
  const noGap=frames(await render('grid',{imageGap:0}));assert.equal(noGap[1][0],noGap[0][0]+noGap[0][2]);assert.equal(noGap[2][1],noGap[0][1]+noGap[0][3]);
});

test('continuation frames stay within the page at maximum margins, large logos and all orientations',async()=>{
  for(const format of ['portrait','landscape','square'])for(const layout of continuationLayouts){
    const result=await render(layout.id,{format,margin:80,imageGap:32,titleSize:48,logo:'/api/files/logo',logoPosition:'top-right',logoSize:35,continuations:{a1:continuation(layout.id,true)}});
    for(const [x,y,w,h] of frames(result)){assert.ok(w>0&&h>0);assert.ok(x>=0&&y>=0&&x+w<=result.canvas.width+.001&&y+h<=result.canvas.height+.001);}
  }
});

test('page planning never silently truncates extras and PDF refuses more than 200 pages before rendering',async()=>{
  const arts=Array.from({length:7},(_,i)=>art(`a${i}`,30)),design=normalizeDesign({includeCover:false,continuations:Object.fromEntries(arts.map(a=>[a.id,continuation()]))});
  assert.equal(MAX_CATALOG_PAGES,200);assert.equal(catalogPages(design,arts).length,210);
  let work=0;const renderer=createCatalogRenderer({loadFonts:async()=>{work++;},loadImage:async()=>{work++;}});
  await assert.rejects(renderer.makePDF({title:'Oversized',design},arts,()=>{work++;}),/at most 200 pages/);assert.equal(work,0);
});
