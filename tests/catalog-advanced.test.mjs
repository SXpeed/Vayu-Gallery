import test from 'node:test';
import assert from 'node:assert/strict';
import {normalizeDesign} from '../shared/catalog-design.mjs';
import {createCatalogRenderer} from '../src/catalog-renderer.js';
import {makeSeed} from '../server/seed.mjs';
import {act,upload} from '../server/domain.mjs';

// Record the canvas drawing contract without requiring browser globals or a graphics driver.
function canvasRecorder(){
  const calls=[],stack=[];
  const ctx={font:'400 12px Inter',fillStyle:'#000000',globalAlpha:1,textAlign:'left',textBaseline:'top',
    save(){stack.push(Object.fromEntries(['font','fillStyle','globalAlpha','textAlign','textBaseline'].map(k=>[k,this[k]])));},
    restore(){Object.assign(this,stack.pop());},
    measureText(text){return {width:String(text).length*Number(this.font.match(/([\d.]+)px/)?.[1]||12)*.52};},
    fillText(text,x,y){calls.push({op:'text',text,x,y,color:this.fillStyle,alpha:this.globalAlpha,font:this.font});},
    drawImage(img,...rect){calls.push({op:'image',src:img.src,rect});},
    createLinearGradient(){return {addColorStop(){}};},createRadialGradient(){return {addColorStop(){}};}
  };
  for(const op of ['beginPath','rect','clip','fillRect','strokeRect','moveTo','lineTo','quadraticCurveTo','closePath','stroke','translate','rotate'])ctx[op]=(...args)=>calls.push({op,args});
  return {calls,ctx,canvas:{width:0,height:0,getContext:()=>ctx}};
}
const images=['/art/quiet.svg','/art/earth.svg','/art/blue.svg','/art/stone.svg','/art/amber.svg','/art/green.svg'];
const artwork={id:'a1',title:'Morning study',artist:'A. Maker',description:'Original work',medium:'Oil on linen',dimensions:'20 × 30 cm',year:2026,status:'Available',price:1200,image:images[0],images};
const plain={includeCover:false,showFooter:false,showPageNumbers:false,logoPosition:'none',showDescription:false,showArtist:false,showMedium:false,showDimensions:false,showPrice:false};
async function render(design={},arts=[artwork],index=0){const output=canvasRecorder();const renderer=createCatalogRenderer({loadFonts:async()=>{},loadImage:async src=>({src,width:200,height:200}),formatPrice:a=>`USD ${a.price}`});await renderer.renderCatalogPage({title:'Collection',description:'Selected works',design:normalizeDesign({...plain,...design})},arts,index,output.canvas);return output;}
const frames=output=>output.calls.filter(c=>c.op==='rect').map(c=>c.args);
const text=output=>output.calls.filter(c=>c.op==='text');

test('advanced design options have safe defaults, allow zero gaps, and reject unknown choices',()=>{
  const d=normalizeDesign({productLayout:'floating',imageRatio:'ultrawide',imageGap:0,cardRadius:999,priceColor:'url(javascript:bad)',watermarkText:'x'.repeat(120),watermarkOpacity:0});
  assert.equal(d.productLayout,'auto');assert.equal(d.imageRatio,'auto');assert.equal(d.imageGap,0);assert.equal(d.cardRadius,32);assert.equal(d.priceColor,'#29392f');assert.equal(d.watermarkText.length,100);assert.equal(d.watermarkOpacity,.03);
  const high=normalizeDesign({imageGap:99,watermarkOpacity:99,cardRadius:-1});assert.equal(high.imageGap,32);assert.equal(high.watermarkOpacity,.25);assert.equal(high.cardRadius,0);
  const invalid=normalizeDesign({imageGap:NaN,cardRadius:Infinity,watermarkOpacity:'high',watermarkText:123});assert.equal(invalid.imageGap,12);assert.equal(invalid.cardRadius,0);assert.equal(invalid.watermarkOpacity,.08);assert.equal(invalid.watermarkText,'');
  assert.equal(normalizeDesign({watermarkText:'PRIVATE\nCOLLECTION\u0000'}).watermarkText,'PRIVATE COLLECTION ');
  assert.equal(normalizeDesign({},'Charcoal').priceColor,'#f4eedf');
});

test('advanced settings survive saving and generated versions retain an immutable design snapshot',()=>{
  const s=makeSeed(),u=s.users[0],design=normalizeDesign({productLayout:'side-by-side',imageRatio:'portrait',imageGap:0,cardRadius:24,priceColor:'#ac3d21',watermarkText:'Collector preview',watermarkOpacity:.15});
  act(s,u,{action:'save',entity:'catalogs',entityId:'cat1',data:{design}});
  const pdf=upload(s,u,{name:'collection.pdf',mime:'application/pdf',data:Buffer.from('%PDF-1.4').toString('base64')});
  const version=act(s,u,{action:'catalog.version',entityId:'cat1',data:{fileId:pdf.id,generated:true}});
  act(s,u,{action:'save',entity:'catalogs',entityId:'cat1',data:{design:normalizeDesign({})}});
  for(const key of ['productLayout','imageRatio','imageGap','cardRadius','priceColor','watermarkText','watermarkOpacity'])assert.equal(version.snapshot.design[key],design[key]);
});

test('auto retains stacked geometry while side-by-side moves details beside the images',async()=>{
  const auto=await render({format:'landscape'}),stacked=await render({format:'landscape',productLayout:'stacked'}),beside=await render({format:'landscape',productLayout:'side-by-side'});
  assert.deepEqual(frames(auto),frames(stacked));assert.deepEqual(text(auto),text(stacked));
  const [sx,sy,sw,sh]=frames(stacked)[0],stackTitle=text(stacked).find(c=>c.text==='Morning study');assert.ok(stackTitle.y>=sy+sh);assert.equal(stackTitle.x,sx);
  const [x,y,w,h]=frames(beside)[0],title=text(beside).find(c=>c.text==='Morning study');assert.ok(title.x>x+w);assert.ok(title.y>=y&&title.y<y+h);assert.ok(w<sw);
});

test('image frames respect square, portrait and landscape ratios independently of crop settings',async()=>{
  for(const [ratio,expected] of [['square',1],['portrait',.75],['landscape',4/3]]){
    const result=await render({imageRatio:ratio,imageFit:'cover',imageZoom:1.4,imagesPerProduct:3});
    assert.equal(frames(result).length,3);
    for(const [x,y,w,h] of frames(result)){assert.ok(Math.abs(w/h-expected)<1e-9);assert.ok(x>=0&&y>=0&&w>0&&h>0);assert.ok(x+w<=result.canvas.width&&y+h<=result.canvas.height);}
  }
});

test('image gap changes actual photo separation and permits edge-to-edge images',async()=>{
  for(const gap of [0,12,32]){
    const result=await render({imagesPerProduct:2,imageGap:gap}),[left,right]=frames(result);
    assert.equal(right[0]-(left[0]+left[2]),gap);
  }
  const cover=await render({includeCover:true,template:'mosaic',imagesPerProduct:4,imageGap:23,coverTitle:false,coverDescription:false});
  const [first,second]=frames(cover);assert.equal(second[0]-(first[0]+first[2]),23);
});

test('price color applies only to visible prices and does not replace title or body color',async()=>{
  const output=await render({showArtist:true,showPrice:true,titleBold:true,titleColor:'#112233',textColor:'#445566',priceColor:'#dd2200'});
  assert.equal(text(output).find(c=>c.text==='Morning study').color,'#112233');assert.equal(text(output).find(c=>c.text==='A. Maker').color,'#445566');assert.equal(text(output).find(c=>c.text==='USD 1200').color,'#dd2200');
  assert.ok(!text(await render({showPrice:false,priceColor:'#dd2200'})).some(c=>c.text.includes('1200')));
});

test('rounded cards clip content and draw a rounded border after their images',async()=>{
  const output=await render({cardRadius:24,cardBorder:true,cardBackground:true});
  assert.equal(output.calls.filter(c=>c.op==='quadraticCurveTo').length,8);
  const firstClip=output.calls.findIndex(c=>c.op==='clip'),imageIndex=output.calls.findIndex(c=>c.op==='image'),strokeIndex=output.calls.findIndex(c=>c.op==='stroke');assert.ok(firstClip<imageIndex&&strokeIndex>imageIndex);
  assert.equal((await render({cardRadius:0,cardBorder:true})).calls.filter(c=>c.op==='quadraticCurveTo').length,0);
});

test('watermark overlays cover and product pages at chosen opacity without dimming branding',async()=>{
  for(const index of [0,1]){
    const output=await render({includeCover:true,watermarkText:'PRIVATE PREVIEW',watermarkOpacity:.17,showFooter:true,footerText:'Gallery archive'},[artwork],index),mark=text(output).find(c=>c.text==='PRIVATE PREVIEW');
    assert.equal(mark.alpha,.17);assert.equal(mark.x,0);assert.equal(mark.y,0);assert.deepEqual(output.calls.find(c=>c.op==='translate').args,[500,707]);assert.deepEqual(output.calls.find(c=>c.op==='rotate').args,[-Math.PI/6]);
    assert.equal(text(output).find(c=>c.text==='Gallery archive').alpha,1);assert.ok(output.calls.indexOf(mark)>output.calls.findIndex(c=>c.op==='image'));
  }
  assert.ok(!(await render({watermarkText:'  '})).calls.some(c=>c.op==='rotate'));
});

test('dense cards keep positive image geometry at maximum gaps, margins, logo size and photo count',async()=>{
  for(const format of ['portrait','landscape','square'])for(const productLayout of ['stacked','side-by-side']){
    const result=await render({format,productLayout,productsPerPage:6,imagesPerProduct:6,imageGap:32,gap:40,margin:80,cardBorder:true,cardRadius:32,logo:'/art/quiet.svg',logoPosition:'bottom-center',logoSize:35,showArtist:true,showDescription:true,showPrice:true,showMedium:true,showDimensions:true,showYear:true,showStatus:true,titleSize:48,bodySize:20},Array.from({length:6},(_,i)=>({...artwork,id:`a${i}`,description:'A long description '.repeat(30)})));
    for(const [x,y,w,h] of frames(result)){assert.ok(Number.isFinite(x+y+w+h));assert.ok(w>0&&h>0,`${format}/${productLayout}: ${w} × ${h}`);assert.ok(x>=0&&y>=0&&x+w<=result.canvas.width+.001&&y+h<=result.canvas.height+.001);}
    assert.equal(text(result).filter(c=>c.text==='USD 1200').length,6);
  }
});
