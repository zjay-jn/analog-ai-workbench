// Pure bounded JSON utilities. SHA-256 reused from the product's desktop-agent-api implementation.
export function reviewedSha256(value: string): string {
  const bytes = new TextEncoder().encode(value);
  const bitLength = bytes.length * 8;
  const paddedLength = Math.ceil((bytes.length + 9) / 64) * 64;
  const data = new Uint8Array(paddedLength);
  data.set(bytes);
  data[bytes.length] = 0x80;
  const view = new DataView(data.buffer);
  view.setUint32(paddedLength - 4, bitLength >>> 0, false);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000), false);
  const k = [0x428a2f98,0x71374491,0xb5c0fbcf,0xe9b5dba5,0x3956c25b,0x59f111f1,0x923f82a4,0xab1c5ed5,0xd807aa98,0x12835b01,0x243185be,0x550c7dc3,0x72be5d74,0x80deb1fe,0x9bdc06a7,0xc19bf174,0xe49b69c1,0xefbe4786,0x0fc19dc6,0x240ca1cc,0x2de92c6f,0x4a7484aa,0x5cb0a9dc,0x76f988da,0x983e5152,0xa831c66d,0xb00327c8,0xbf597fc7,0xc6e00bf3,0xd5a79147,0x06ca6351,0x14292967,0x27b70a85,0x2e1b2138,0x4d2c6dfc,0x53380d13,0x650a7354,0x766a0abb,0x81c2c92e,0x92722c85,0xa2bfe8a1,0xa81a664b,0xc24b8b70,0xc76c51a3,0xd192e819,0xd6990624,0xf40e3585,0x106aa070,0x19a4c116,0x1e376c08,0x2748774c,0x34b0bcb5,0x391c0cb3,0x4ed8aa4a,0x5b9cca4f,0x682e6ff3,0x748f82ee,0x78a5636f,0x84c87814,0x8cc70208,0x90befffa,0xa4506ceb,0xbef9a3f7,0xc67178f2];
  const rotr = (x: number, n: number) => (x >>> n) | (x << (32 - n));
  const h = [0x6a09e667,0xbb67ae85,0x3c6ef372,0xa54ff53a,0x510e527f,0x9b05688c,0x1f83d9ab,0x5be0cd19];
  const w = new Uint32Array(64);
  for (let offset = 0; offset < data.length; offset += 64) {
    for (let i = 0; i < 16; i += 1) w[i] = view.getUint32(offset + i * 4, false);
    for (let i = 16; i < 64; i += 1) { const x = w[i - 15]!; const y = w[i - 2]!; w[i] = (w[i - 16]! + (rotr(x,7)^rotr(x,18)^(x>>>3)) + w[i - 7]! + (rotr(y,17)^rotr(y,19)^(y>>>10))) >>> 0; }
    let [a,b,c,d,e,f,g,hh] = h as [number,number,number,number,number,number,number,number];
    for (let i = 0; i < 64; i += 1) { const s1=rotr(e,6)^rotr(e,11)^rotr(e,25); const ch=(e&f)^((~e)&g); const t1=(hh+s1+ch+k[i]!+w[i]!)>>>0; const s0=rotr(a,2)^rotr(a,13)^rotr(a,22); const maj=(a&b)^(a&c)^(b&c); const t2=(s0+maj)>>>0; hh=g;g=f;f=e;e=(d+t1)>>>0;d=c;c=b;b=a;a=(t1+t2)>>>0; }
    h[0]=(h[0]!+a)>>>0;h[1]=(h[1]!+b)>>>0;h[2]=(h[2]!+c)>>>0;h[3]=(h[3]!+d)>>>0;h[4]=(h[4]!+e)>>>0;h[5]=(h[5]!+f)>>>0;h[6]=(h[6]!+g)>>>0;h[7]=(h[7]!+hh)>>>0;
  }
  return h.map((word) => word.toString(16).padStart(8, "0")).join("");
}

export function reviewedBad():never{throw new TypeError('Invalid reviewed schematic data');}
export function reviewedExact(value:unknown,keys:readonly string[],optional:readonly string[]=[]):Record<string,unknown>{
  if(!value||typeof value!=='object'||Array.isArray(value)||Object.getPrototypeOf(value)!==Object.prototype)reviewedBad();
  const names=Reflect.ownKeys(value);if(names.length<keys.length||names.length>keys.length+optional.length)reviewedBad();
  const result:Record<string,unknown>={};
  for(const key of names){if(typeof key!=='string'||(!keys.includes(key)&&!optional.includes(key)))reviewedBad();const d=Object.getOwnPropertyDescriptor(value,key);if(!d||!('value'in d)||!d.enumerable)reviewedBad();result[key]=d.value;}
  for(const key of keys)if(!Object.hasOwn(result,key))reviewedBad();return result;
}
/** Limits apply before allocation-heavy clone/serialization: 100k visited values/keys, depth32, dense arrays<=4096, keys<=64/object, 1MiB aggregate strings, 2MiB serialized bytes. */
export function boundReviewedJson(value:unknown,maxBytes=2097152):void{
  let nodes=0,stringBytes=0;const seen=new Set<object>();
  const visit=(v:unknown,depth:number):void=>{
    if(++nodes>100000||depth>32)reviewedBad();
    if(typeof v==='string'){if(v.length>16384||/\p{Surrogate}/u.test(v))reviewedBad();stringBytes+=new TextEncoder().encode(v).length;if(stringBytes>1048576)reviewedBad();return;}
    if(v===null||typeof v==='boolean')return;if(typeof v==='number'){if(!Number.isFinite(v)||Object.is(v,-0))reviewedBad();return;}
    if(typeof v!=='object'||seen.has(v))reviewedBad();const array=Array.isArray(v);
    if(Object.getPrototypeOf(v)!==(array?Array.prototype:Object.prototype))reviewedBad();
    const keys=Reflect.ownKeys(v);if(keys.length>(array?4097:64))reviewedBad();
    if(array){const length=Object.getOwnPropertyDescriptor(v,'length')?.value;if(!Number.isSafeInteger(length)||length>4096||keys.length!==length+1)reviewedBad();for(let i=0;i<length;i++)if(!Object.hasOwn(v,String(i)))reviewedBad();}
    seen.add(v);for(const key of keys){if(typeof key!=='string')reviewedBad();if(array&&key==='length')continue;const d=Object.getOwnPropertyDescriptor(v,key);if(!d||!('value'in d)||!d.enumerable)reviewedBad();visit(key,depth+1);visit(d.value,depth+1);}seen.delete(v);
  };visit(value,0);if(new TextEncoder().encode(JSON.stringify(value)).length>maxBytes)reviewedBad();
}
// Call only after boundReviewedJson. Same finite-number/key ordering domain as aaw-json-c14n/v1 for this pinned payload.
export function reviewedCanonical(value:unknown):string{
  if(value===null||typeof value!=='object')return JSON.stringify(value);
  if(Array.isArray(value))return '['+value.map(reviewedCanonical).join(',')+']';
  const v=value as Record<string,unknown>;return '{'+Object.keys(v).sort().map(k=>JSON.stringify(k)+':'+reviewedCanonical(v[k])).join(',')+'}';
}
