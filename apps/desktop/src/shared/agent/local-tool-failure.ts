/** Fixed main-issued categories; never persist exception text or tool arguments. */
export const LOCAL_TOOL_FAILURE_CODES=['CLEANUP_FAILED','BUSY','STORAGE_FAILED','CAPABILITY_DENIED','NOT_BOUND','ROOT_CHANGED','RUN_NOT_FOUND','CONFLICT','BUDGET_EXCEEDED','UNEXPECTED'] as const;
export type LocalToolFailureCode=typeof LOCAL_TOOL_FAILURE_CODES[number];
export function localToolFailureCode(value:unknown):LocalToolFailureCode|undefined {
 return typeof value==='string'&&(LOCAL_TOOL_FAILURE_CODES as readonly string[]).includes(value)?value as LocalToolFailureCode:undefined;
}
export function localToolFailureMessage(code:LocalToolFailureCode):string {
 switch(code){
  case 'CLEANUP_FAILED':return '先前命令的收尾尚未确认，暂时无法执行这项操作。';
  case 'BUSY':return '本地工具资源正在使用中，暂时无法执行这项操作。';
  case 'STORAGE_FAILED':return '本地执行记录无法可靠读取或保存，本轮已停止。';
  case 'CAPABILITY_DENIED':return '这项操作不在当前工具的可用范围内。';
  case 'NOT_BOUND':return '这项操作需要关联有效的项目目录。';
  case 'ROOT_CHANGED':return '项目目录发生变化，需要重新核对后执行。';
  case 'RUN_NOT_FOUND':return '找不到这项操作对应的执行记录。';
  case 'CONFLICT':return '本地执行状态发生变化，需要重新核对。';
  case 'BUDGET_EXCEEDED':return '本地工具结果超过当前可保存的容量。';
  default:return '本地工具执行遇到错误，已保留收到的内容。';
 }
}
