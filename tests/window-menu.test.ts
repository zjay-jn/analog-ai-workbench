import assert from 'node:assert/strict';
import test from 'node:test';
import type {BrowserWindow,IpcMain,Menu,PopupOptions} from 'electron';
import {WINDOW_MENU_CHANNEL,WINDOW_MENUS,parseWindowMenuRequest,parseWindowMenuResult} from '../apps/desktop/src/shared/window-menu';
import {registerWindowMenu} from '../apps/desktop/src/main/window-menu';
const owner={senderId:1,isTopFrame:true,appOrigin:'null',navigationEpoch:1,appSessionId:'s',windowId:'w',webContentsId:1,workspaceId:'ws',rootId:'r'};
test('titlebar menu accepts only fixed menu names and bounded plain data',()=>{
 for(const menu of WINDOW_MENUS)assert.deepEqual(parseWindowMenuRequest({menu,x:100,y:32}),{menu,x:100,y:32});
 for(const value of [null,[],{menu:'execute',x:0,y:32},{menu:'file',x:0,y:101},{menu:'file',x:-0,y:32},{menu:'file',x:NaN,y:32},{menu:'file',x:0.5,y:32},{menu:'file',x:32769,y:32},{menu:'file',x:0,y:32,command:'quit'},Object.assign(Object.create({}),{menu:'file',x:0,y:32})])assert.throws(()=>parseWindowMenuRequest(value));
 let called=false;assert.throws(()=>parseWindowMenuRequest({get menu(){called=true;return 'file';},x:0,y:32}));assert.equal(called,false);
 assert.deepEqual(parseWindowMenuResult({ok:true}),{ok:true});assert.throws(()=>parseWindowMenuResult({ok:true,secret:'extra'}));
});
function setup(){
 const handlers=new Map<string,(event:unknown,value:unknown)=>Promise<unknown>>();let popup:PopupOptions|undefined,popupCount=0,closed=0,removed=false;
 const window={setMenu(value:unknown){removed=value===null;},isDestroyed:()=>false,isMaximized:()=>false,getContentSize:()=>[1480,920],webContents:{getZoomFactor:()=>1.25}} as unknown as BrowserWindow;
 const runtime=registerWindowMenu({window,owner,deriveCallerContext:event=>event as typeof owner,ipcMain:{removeHandler:(name:string)=>handlers.delete(name),handle:(name:string,handler:typeof handlers extends Map<string,infer V>?V:never)=>handlers.set(name,handler)} as unknown as IpcMain,buildMenu:()=>({popup:(options:PopupOptions)=>{popup=options;popupCount++;},closePopup:()=>{closed++;popup?.callback?.();}} as unknown as Menu)});
 return {runtime,handlers,invoke:(event:unknown,value:unknown)=>handlers.get(WINDOW_MENU_CHANNEL)!(event,value),state:()=>({popup,popupCount,closed,removed})};
}
test('titlebar menu fences callers and does not disturb an open popup on rejected requests',async()=>{
 const s=setup(),request={menu:'edit',x:100,y:32};assert.equal(s.state().removed,true);
 for(const caller of [null,{...owner,isTopFrame:false},{...owner,navigationEpoch:2},{...owner,webContentsId:2}])assert.deepEqual(await s.invoke(caller,request),{ok:false});
 assert.deepEqual(await s.invoke(owner,{...request,x:1400}),{ok:false});
 const pending=s.invoke(owner,request);assert.equal(s.state().popupCount,1);assert.equal(s.state().popup?.x,125);assert.equal(s.state().popup?.y,40);
 assert.deepEqual(await s.invoke(owner,{bad:true}),{ok:false});assert.deepEqual(await s.invoke(owner,request),{ok:false});assert.equal(s.state().popupCount,1);
 s.state().popup?.callback?.();assert.deepEqual(await pending,{ok:true});s.runtime.dispose();assert.equal(s.handlers.size,0);
});
test('titlebar menu revocation closes popup and denies future invocations',async()=>{
 const s=setup(),request={menu:'view',x:200,y:32},pending=s.invoke(owner,request);s.runtime.revoke();assert.deepEqual(await pending,{ok:false});assert.equal(s.state().closed,1);assert.deepEqual(await s.invoke(owner,request),{ok:false});s.runtime.dispose();assert.equal(s.handlers.size,0);
});
