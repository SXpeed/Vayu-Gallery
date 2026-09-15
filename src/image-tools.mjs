// Remove only connected background pixels, retaining similarly colored areas inside a product.
export function removeConnectedBackground(pixels,width,height,{tolerance=40,color=null,start=null,feather=8}={}){
 const out=new Uint8ClampedArray(pixels),seen=new Uint8Array(width*height),queue=new Int32Array(width*height);let head=0,tail=0;
 const sample=color||[pixels[0],pixels[1],pixels[2]],limit=tolerance+feather;
 const add=i=>{if(i<0||i>=width*height||seen[i])return;seen[i]=1;const p=i*4,diff=Math.hypot(pixels[p]-sample[0],pixels[p+1]-sample[1],pixels[p+2]-sample[2])/Math.sqrt(3);if(diff>limit&&pixels[p+3])return;queue[tail++]=i;out[p+3]=Math.round(pixels[p+3]*(feather?Math.max(0,Math.min(1,(diff-tolerance)/feather)):0));};
 if(start!==null)add(start);else{for(let x=0;x<width;x++){add(x);add((height-1)*width+x);}for(let y=0;y<height;y++){add(y*width);add(y*width+width-1);}}
 while(head<tail){const i=queue[head++],x=i%width;if(x)add(i-1);if(x<width-1)add(i+1);if(i>=width)add(i-width);if(i<width*(height-1))add(i+width);}return out;
}
