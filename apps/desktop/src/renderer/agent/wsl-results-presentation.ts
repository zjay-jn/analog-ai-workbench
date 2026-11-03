import type {ProjectReadCode} from '../../shared/agent/agent-project-read';
import type {WslResultsBinding,WslResultsReadValue} from '../../shared/agent/wsl-results';

export const wslBindingIdentity=(value:WslResultsBinding|undefined|null)=>value?JSON.stringify([value.id,value.distro,value.user,value.rootPath,value.rootIdentity,value.readerVersion,value.selectedAt]):null;
export const wslCitationIdentity=(value:WslResultsReadValue)=>JSON.stringify([wslBindingIdentity(value.source),value.source.relativePath,value.source.absolutePath,value.citationId,value.fileId,value.fileIdentity,value.version,value.rawSha256,value.excerptSha256,value.startLine,value.endLine,value.totalLines,value.fileBytes,value.text,value.nextLine,value.complete,value.physicalReadBytes,value.scannedCandidates]);
export function wslResultsError(code:ProjectReadCode):string{
 const messages:Partial<Record<ProjectReadCode,string>>={
  NOT_BOUND:'本项目尚未连接实验 WSL 结果目录。',
  ROOT_UNAVAILABLE:'所选实验 WSL 结果目录暂时无法访问，请核对 WSL 环境和目录。',
  ROOT_CHANGED:'所选 WSL 目录身份已变化，请重新选择并连接；历史来源保留。',
  FILE_UNAVAILABLE:'此 WSL 结果文件暂时无法访问，历史片段保留。',
  SOURCE_CHANGED:'WSL 源文件已变化，继续显示任务时保存的片段。',
  CURSOR_STALE:'WSL 目录读取位置已失效，需要重新查询。',
  UNSUPPORTED_PATH:'请选择实验 WSL 支持范围内的普通结果目录。',
  UNSUPPORTED_TEXT:'此文件不是可读取的文本结果。',
  UNSUPPORTED_ENCODING:'此结果文件不是支持的 UTF-8 文本。',
  FILE_LIMIT:'此结果文件超过读取上限。',
  SCOPE_LIMIT:'本次目录查询达到范围限制，尚未覆盖全部条目。',
  BUSY:'实验 WSL 来源当前正在使用或核对，请稍后重试。',
  STORAGE_FAILED:'WSL 来源设置保存尚未确认，请重新读取保存状态。',
  ENGINE_FAILED:'实验 WSL 读取器未能完成操作，请核对环境后重试。',
  CLEANUP_FAILED:'实验 WSL 读取进程收尾尚未确认，请稍后核对。',
  IO_ERROR:'实验 WSL 结果读取失败，历史片段保留。',
  CAPABILITY_DENIED:'当前入口无法连接实验 WSL 结果。',
  INVALID_REQUEST:'WSL 目录或请求不符合支持范围。',
  CANCELLED:'本次 WSL 操作已取消。',
 };
 return messages[code]??`WSL 操作未完成（${code}）。`;
}
