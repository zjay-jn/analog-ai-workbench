import type {OpenReviewedValue, SchematicSelectionTarget} from '../../shared/schematic/reviewed-schematic';
import type {ViewerViewStateV1} from '../../../../../packages/schematic-workbench/src/viewer/view-state';
import {reviewedBasicPort} from '../../../../../packages/schematic-workbench/src/viewer/reviewed-port-display';

export function reviewedSelectionTargets(document: OpenReviewedValue, state: ViewerViewStateV1, kind: 'instances' | 'net'): SchematicSelectionTarget[] {
  if (state.occurrencePath.length) return [];
  const definitionId = document.display.definitionId;
  if (kind === 'net') {
    const net = state.netHighlight;
    if (net && net.artifactId === document.artifactRef.artifactId && net.revisionId === document.artifactRef.revisionId
      && net.definitionId === definitionId && !net.occurrencePath.length
    ) return [{kind: 'net', occurrencePath: [], definitionId, netId: net.netId}];
    const netIds = new Set<string>();
    const definition = document.reviewedCircuitIr.definitions.find(value => value.definitionId === definitionId);
    for (const target of state.selection) {
      if (target.artifactId !== document.artifactRef.artifactId || target.revisionId !== document.artifactRef.revisionId || target.definitionId !== definitionId || target.occurrencePath.length) continue;
      const netId = target.elementKind === 'wire' ? definition?.wires.find(wire => wire.wireId === target.elementId)?.netId
        : target.elementKind === 'label' ? document.display.labels.find(label => label.id === target.elementId && label.targetKind === 'net')?.targetId : undefined;
      if (netId) netIds.add(netId);
    }
    return document.display.nets.filter(net => netIds.has(net.id)).map(net => ({kind: 'net', occurrencePath: [], definitionId, netId: net.id}));
  }
  return state.selection.filter(target => target.elementKind === 'instance' && target.artifactId === document.artifactRef.artifactId
    && target.revisionId === document.artifactRef.revisionId && target.definitionId === definitionId && !target.occurrencePath.length)
    .map(target => ({kind: 'instance', occurrencePath: [], definitionId, elementId: target.elementId}));
}

export function reviewedElementLabels(document: OpenReviewedValue) {
  const display = document.display;
  return {
    elements: Object.fromEntries([
      ...display.devices.map(device => [device.id, device.name || `未命名器件 · ${device.id}`]),
      ...display.terminals.map(terminal => [terminal.id, `端子 · ${terminal.id}`]),
      ...display.ports.map(port => [port.id, `端口 · ${port.name || port.id}`]),
      ...document.reviewedCircuitIr.definitions.flatMap(definition => definition.wires.map(wire => [wire.wireId, `线段 · ${wire.wireId}`])),
      ...display.labels.map(label => [label.id, `标注 · ${label.text}`]),
    ]),
    nets: Object.fromEntries(display.nets.map(net => [net.id, net.name || `未命名网络 · ${net.id}`])),
  };
}

export function ReviewedSchematicInspector({document, viewState}: {document: OpenReviewedValue; viewState: ViewerViewStateV1}) {
  const display = document.display;
  const deviceIds = new Set(reviewedSelectionTargets(document, viewState, 'instances').flatMap(target => target.kind === 'instance' ? [target.elementId] : []));
  const devices = display.devices.filter(device => deviceIds.has(device.id));
  const network = viewState.netHighlight && display.nets.find(net => net.id === viewState.netHighlight?.netId);
  const selectedWires = viewState.selection.filter(target => target.elementKind === 'wire');
  const selectedLabels = viewState.selection.filter(target => target.elementKind === 'label');
  const selectedNets = reviewedSelectionTargets(document, {...viewState, netHighlight: null}, 'net');
  const netName = (id: string) => display.nets.find(net => net.id === id)?.name || `未命名网络 · ${id}`;
  return <div className="reviewed-schematic-details" data-reviewed-inspector="true">
    <details><summary>来源与显示范围</summary>
      <p>{display.source.library} / {display.source.cell} / {display.source.view}</p>
      <p>导出版本：{document.documentRef.revisionId}</p>
      <p>{display.counts.devices} 个实例，{display.counts.nets} 个网络。仅包含当前单元，无可浏览子层。</p>
      <p>MOS 为规范化显示轮廓，可对应端口的 basic pin 使用标准端口图形，均非 PDK 原始符号。端子角色和电气锚点未知；连接以导出的显式成员关系为准。</p>
    </details>
    {devices.length > 0 && <h4>已选器件 · {devices.length}</h4>}
    {devices.map(device => <details key={device.id} open={devices.length === 1} data-reviewed-device={device.id}>
      <summary>{device.name || device.id}</summary>
      <p>实例 ID：{device.id}</p><p>源器件：{device.master.library} / {device.master.cell} / {device.master.view}</p>
      <p>{reviewedBasicPort(display, device) ? '标准端口显示图形（源符号未提供）' : device.renderEvidence === 'placeholder' ? '占位图形' : '规范化显示轮廓'}；内部层次未提供。{device.bulkBinding ? 'Bulk 连接未解析。' : '导出未提供 Bulk 连接信息。'}</p>
      {device.parameters.length ? <table aria-label={`${device.name || device.id} 参数`}><thead><tr><th>参数</th><th>导出原值</th></tr></thead><tbody>{device.parameters.map((parameter, index) => <tr key={index}><td>{parameter.name}</td><td>{parameter.valueText}</td></tr>)}</tbody></table> : <p>导出未提供参数。</p>}
      <p>端子角色、电气位置：未知</p>
      <table aria-label={`${device.name || device.id} 连接`}><thead><tr><th>端子 ID</th><th>网络</th></tr></thead><tbody>{device.pinIds.map(pinId => {
        const terminal = display.terminals.find(value => value.id === pinId && value.instanceId === device.id);
        return <tr key={pinId}><td>{pinId}</td><td>{terminal ? netName(terminal.netId) : '导出未提供'}</td></tr>;
      })}</tbody></table>
    </details>)}
    {(selectedWires.length > 0 || selectedLabels.length > 0) && <details open data-reviewed-local-selection="true">
      <summary>已选线段 {selectedWires.length} · 标注 {selectedLabels.length}</summary>
      <p>仅选中局部元素。所属网络：{selectedNets.flatMap(target => target.kind === 'net' ? [netName(target.netId)] : []).join('、') || '未提供'}</p>
    </details>}
    {network && <details open data-reviewed-net={network.id}><summary>网络 · {network.name || '未命名'}</summary>
      <p>ID：{network.id}</p><p>{network.memberIds.length} 个显式端子/端口，{network.wireIds.length} 个线段。</p>
      <ul aria-label="网络显式成员">{network.memberIds.map(id => {
        const terminal = display.terminals.find(value => value.id === id), port = display.ports.find(value => value.id === id);
        const device = terminal?.instanceId && display.devices.find(value => value.id === terminal.instanceId);
        return <li key={id}>{device ? `${device.name || device.id} · ` : port ? `端口 ${port.name} · ` : ''}{id}</li>;
      })}</ul>
      <details><summary>线段 ID · {network.wireIds.length}</summary><p>{network.wireIds.join('、') || '无'}</p></details>
      <p>端子角色和电气锚点未知；未根据图形相交或显示插口推断连接。</p>
    </details>}
    {!devices.length && !network && !selectedWires.length && !selectedLabels.length && <p>选择器件或网络查看参数与连接。</p>}
  </div>;
}
