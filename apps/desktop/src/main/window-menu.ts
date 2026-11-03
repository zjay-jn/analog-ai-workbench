import {Menu,dialog,type BrowserWindow,type IpcMain,type MenuItemConstructorOptions} from 'electron';
import {WINDOW_MENU_CHANNEL,parseWindowMenuRequest,type WindowMenu} from '../shared/window-menu';
import {createAgentCallerFenceV1,type AgentCallerContextV1} from './agent/agent-caller-fence';

export function menuTemplate(menu:WindowMenu,window:BrowserWindow):MenuItemConstructorOptions[]{
 switch(menu){
  case 'file':return [{label:'关闭窗口',role:'close',accelerator:'Alt+F4'},{type:'separator'},{label:'退出',role:'quit'}];
  case 'edit':return [{label:'撤销',role:'undo'},{label:'重做',role:'redo'},{type:'separator'},{label:'剪切',role:'cut'},{label:'复制',role:'copy'},{label:'粘贴',role:'paste'},{type:'separator'},{label:'全选',role:'selectAll'}];
  case 'view':return [{label:'实际大小',role:'resetZoom'},{label:'放大',role:'zoomIn'},{label:'缩小',role:'zoomOut'},{type:'separator'},{label:'全屏',role:'togglefullscreen'}];
  case 'window':return [{label:'最小化',role:'minimize'},{label:window.isMaximized()?'还原':'最大化',click:()=>window.isMaximized()?window.unmaximize():window.maximize()}];
  case 'help':return [{label:'关于 Analog AI Workbench',click:()=>{void dialog.showMessageBox(window,{type:'info',title:'Analog AI Workbench',message:'Analog AI Workbench',detail:'模拟集成电路工程工作台',buttons:['关闭']});}}];
 }
}

export function registerWindowMenu(options:{window:BrowserWindow;ipcMain:Pick<IpcMain,'handle'|'removeHandler'>;owner:AgentCallerContextV1;deriveCallerContext:(event:unknown)=>AgentCallerContextV1|null;buildMenu?:(template:MenuItemConstructorOptions[])=>Menu}){
 const {window,ipcMain}=options;
 const fence=createAgentCallerFenceV1({caller:options.owner,capabilities:['start_turn'],generation:1});
 let revoked=false,current:Menu|undefined,settle:((value:{ok:boolean})=>void)|undefined;
 // A removed native menu cannot reappear as a separate row when Alt is pressed.
 window.setMenu(null);
 ipcMain.removeHandler(WINDOW_MENU_CHANNEL);
 ipcMain.handle(WINDOW_MENU_CHANNEL,async(event:unknown,value:unknown)=>{
  let openedMenu:Menu|undefined;
  try{
   if(revoked||window.isDestroyed()||!fence.authorizeInvocation({caller:options.deriveCallerContext(event),operation:'startTurn'}).allowed)return {ok:false};
   const r=parseWindowMenuRequest(value),zoom=window.webContents.getZoomFactor(),[width]=window.getContentSize();
   if(current||width===undefined||r.x*zoom>width)return {ok:false};
   openedMenu=(options.buildMenu??Menu.buildFromTemplate)(menuTemplate(r.menu,window));current=openedMenu;
   return await new Promise<{ok:boolean}>(resolve=>{
    settle=resolve;
    current!.popup({window,x:Math.round(r.x*zoom),y:Math.round(r.y*zoom),callback:()=>{current=undefined;settle=undefined;resolve({ok:!revoked});}});
   });
  }catch{if(openedMenu&&current===openedMenu){current=undefined;settle?.({ok:false});settle=undefined;}return {ok:false};}
 });
 const revoke=()=>{if(revoked)return;revoked=true;current?.closePopup(window);current=undefined;settle?.({ok:false});settle=undefined;};
 return {revoke,dispose(){revoke();ipcMain.removeHandler(WINDOW_MENU_CHANNEL);}};
}
