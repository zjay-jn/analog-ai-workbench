export const WINDOW_MENU_CHANNEL='workbench.windowMenu.open.v1';
export const WINDOW_MENUS=['file','edit','view','window','help'] as const;
export type WindowMenu=typeof WINDOW_MENUS[number];
export type WindowMenuRequest={menu:WindowMenu;x:number;y:number};
export type WindowMenuResult={ok:boolean};
export type WorkbenchWindowMenuApi={open:(request:WindowMenuRequest)=>Promise<WindowMenuResult>};
function exact(value:unknown,keys:string[]):Record<string,unknown>{
 if(!value||typeof value!=='object'||Object.getPrototypeOf(value)!==Object.prototype||Reflect.ownKeys(value).length!==keys.length)throw Error('Invalid menu request');
 const result:Record<string,unknown>={};for(const key of keys){const d=Object.getOwnPropertyDescriptor(value,key);if(!d?.enumerable||!('value'in d))throw Error('Invalid menu request');result[key]=d.value;}return result;
}
export function parseWindowMenuRequest(value:unknown):WindowMenuRequest{
 const r=exact(value,['menu','x','y']);if(!WINDOW_MENUS.includes(r.menu as WindowMenu))throw Error('Unknown menu');
 for(const n of [r.x,r.y])if(!Number.isSafeInteger(n)||Object.is(n,-0)||(n as number)<0||(n as number)>32768)throw Error('Invalid menu position');
 if((r.y as number)>100)throw Error('Outside title bar');return r as WindowMenuRequest;
}
export function parseWindowMenuResult(value:unknown):WindowMenuResult{const r=exact(value,['ok']);if(typeof r.ok!=='boolean')throw Error('Invalid menu result');return {ok:r.ok};}
