/** Native JSON consumers reject lone UTF-16 surrogates; limits still count UTF-16 code units. */
export function wellFormedProductText(value:string):boolean {
  for(let index=0;index<value.length;index++) {
    const unit=value.charCodeAt(index)
    if(unit>=0xd800&&unit<=0xdbff) {
      const next=value.charCodeAt(++index)
      if(!(next>=0xdc00&&next<=0xdfff))return false
    } else if(unit>=0xdc00&&unit<=0xdfff)return false
  }
  return true
}
/** A prefix ends only at a Unicode scalar boundary; callers retain the remainder when chunking. */
export function productTextPrefix(value:string,maximum:number):string {
  if(!wellFormedProductText(value))throw new Error('Product text contains an incomplete Unicode surrogate')
  let end=Math.min(Math.max(0,Math.floor(maximum)),value.length)
  const unit=value.charCodeAt(end-1)
  if(end<value.length&&unit>=0xd800&&unit<=0xdbff)end--
  return value.slice(0,end)
}
