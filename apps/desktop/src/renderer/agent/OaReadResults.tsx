import type {OaReadToolValue} from '../../shared/agent/oa-read';
import type {SchematicReference} from '../../shared/schematic/reviewed-schematic';
import {oaDisplayReferences} from '../schematic/schematic-query-links';

export function OaReadResults({value, onLocate}: {value: OaReadToolValue; onLocate?: (reference: SchematicReference) => void}) {
  const {data, source, coverage} = value;
  const references = oaDisplayReferences(value);
  return <section className="project-read-results" aria-label="原理图查询结果">
    <h3>{source.lcv.cell}</h3>
    <p className="engine-pilot-muted">本地副本 · 已保存的原理图快照</p>
    {data.kind === 'design' && <p>{data.observedCounts.instances} 个实例 · {data.observedCounts.nets} 个网络 · {data.observedCounts.ports} 个端口</p>}
    {data.kind === 'instances' && <table aria-label="查询到的器件"><thead><tr><th>器件</th><th>来源</th><th>参数</th><th>端子</th></tr></thead><tbody>
      {data.items.map(item => <tr key={item.id}><td>{item.name}</td><td>{item.master.library} / {item.master.cell} / {item.master.view}</td><td>{item.parameters.observedCount}</td><td>{item.terminals.observedCount}</td></tr>)}
    </tbody></table>}
    {data.kind === 'nets' && <table aria-label="查询到的网络"><thead><tr><th>网络</th><th>显式成员</th></tr></thead><tbody>
      {data.items.map(item => <tr key={item.id}><td>{item.name || '未命名网络'}</td><td>{item.memberCount ?? `${item.observedMemberCount}（已观察）`}</td></tr>)}
    </tbody></table>}
    {data.kind === 'net_members' && <table aria-label="网络成员"><thead><tr><th>器件或端口</th><th>端子</th></tr></thead><tbody>
      {data.items.map(item => item.kind === 'port'
        ? <tr key={item.port.id}><td>端口 · {item.port.name || '未命名'}</td><td>{item.port.direction || '方向未知'}</td></tr>
        : <tr key={item.terminal.id}><td>{item.instanceName}</td><td>{item.terminal.name || '名称未知'}</td></tr>)}
    </tbody></table>}
    {data.kind === 'device_parameters' && <table aria-label="器件原始参数"><thead><tr><th>参数</th><th>保存原值</th></tr></thead><tbody>
      {data.items.map((item, index) => <tr key={index}><td>{item.name}</td><td>{item.valueText}</td></tr>)}
    </tbody></table>}
    {data.kind === 'device_terminals' && <table aria-label="器件端子连接"><thead><tr><th>端子</th><th>网络 ID</th><th>语义角色</th></tr></thead><tbody>
      {data.items.map(item => <tr key={item.id}><td>{item.name || '名称未知'}</td><td>{item.netId || '未知'}</td><td>未知</td></tr>)}
    </tbody></table>}
    {'items' in data && !data.items.length && <p>本次查询没有匹配条目。</p>}
    {!coverage.complete && <p role="status">本页返回 {coverage.returned} 项，查询尚未完整返回。{coverage.nextCursor ? '后续内容需继续查询。' : '源数据存在未覆盖的内容。'}</p>}
    <div className="file-citation-list">{references.map((display, index) => <button type="button" className="chat-result-link" key={index}
      disabled={!onLocate} title="定位到已核对映射的原理图版本" onClick={() => onLocate?.(display.reference)}>{display.label} · 在图中定位</button>)}</div>
    {!references.length && <p className="engine-pilot-muted">{data.kind === 'design' ? '本条为设计概览，未指定可定位对象。' : '本次结果尚无已核对的图形映射。'}</p>}
    <details><summary>来源与查询范围</summary>
      <p>{source.lcv.library} / {source.lcv.cell} / {source.lcv.view}</p>
      <p>读取时间：{source.capturedAt}</p><p>保存版本：{source.savedRevision}</p>
      <p>未观测原编辑器中的未保存修改；未读取子层、符号 master 或有效 CDF。</p>
      <p>端子角色保持未知，连接以 OA 显式成员关系为准。</p>
      <p>已返回 {coverage.returned} 项 · 未知字段 {coverage.fieldUnknown} · 未支持字段 {coverage.fieldUnsupported}</p>
    </details>
  </section>;
}
