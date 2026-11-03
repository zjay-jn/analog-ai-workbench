import type {SchematicQueryDestination, SchematicQueryLink} from './schematic-query-links';

export function SchematicRelatedQueries({links, onNavigate}: {
  links: readonly SchematicQueryLink[]; onNavigate: (link: SchematicQueryLink, destination: SchematicQueryDestination) => void;
}) {
  if (!links.length) return null;
  const groups = new Map<string, {link: SchematicQueryLink; labels: string[]}>();
  for (const link of links) {
    const key = JSON.stringify([link.turnId, link.callId, link.evidenceId]);
    const group = groups.get(key);
    if (group) {if (!group.labels.includes(link.label)) group.labels.push(link.label);}
    else groups.set(key, {link, labels: [link.label]});
  }
  return <section className="reviewed-schematic-details" aria-label="相关查询与回答">
    <h4>相关查询与回答</h4>
    {[...groups.entries()].map(([key, {link, labels}]) => <div key={key} data-schematic-evidence={link.evidenceId}>
      <p title={link.question}>{link.question.length > 96 ? link.question.slice(0, 96) + '…' : link.question}</p>
      <small>{labels.join('、')} · <time dateTime={link.capturedAt}>{link.capturedAt.replace('T', ' ').replace(/\.\d+Z$/u, ' UTC')}</time></small>
      <p><button type="button" className="chat-result-link" onClick={() => onNavigate(link, 'answer')}>查看回答</button>{' '}
        <button type="button" className="chat-result-link" onClick={() => onNavigate(link, 'query')}>查看查询</button></p>
    </div>)}
  </section>;
}
