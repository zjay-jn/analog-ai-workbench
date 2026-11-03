import { createHash } from 'node:crypto';
import type { AgentSkillDescriptor, AgentSkillSource } from '../../shared/agent/agent-skills';
import { AGENT_SKILL_LIMITS as S, isSkillEntry, isSkillResource } from '../../shared/agent/agent-skills';
import type { ProjectReadEntry, ProjectReadToolCall } from '../../shared/agent/agent-project-read';
import { ProjectReadFsError, readProjectMetadataPrefix, type ProjectReadFile, type ProjectReadIoBudget, type ProjectReadOperation } from './project-read-files';
import type { FolderRoot } from './project-folder-files';
import type { ProjectReadIndex } from './project-read-index';

export type SkillReadBinding = Readonly<{
  entry: AgentSkillDescriptor; entryFile: ProjectReadFile; snapshotId: string;
  role: 'entry' | 'reference'; entryVersion: string | null;
}>;
type Discovered = { descriptor: AgentSkillDescriptor; file: ProjectReadFile; snapshotId: string };
const fail = (code: ConstructorParameters<typeof ProjectReadFsError>[0]): never => { throw new ProjectReadFsError(code); };
export const skillObservationVersion = (file: ProjectReadFile): string => createHash('sha256').update(JSON.stringify({
  fileIdentity: file.fileIdentity, size: file.size, mtimeNs: file.mtimeNs, ctimeNs: file.ctimeNs,
}), 'utf8').digest('hex');

/** Deliberately bounded YAML frontmatter subset: scalar quotes and |/> blocks; no tags or aliases. */
export function parseSkillMetadata(prefix: Buffer, totalBytes: number): Pick<AgentSkillDescriptor, 'name' | 'description' | 'metadataStatus'> {
  const bad = (metadataStatus: AgentSkillDescriptor['metadataStatus']) => ({ name: null, description: null, metadataStatus });
  let text: string;
  try { text = new TextDecoder('utf-8', { fatal: true }).decode(prefix, { stream: prefix.length < totalBytes }); }
  catch { return bad('unsupported_encoding'); }
  const lines = text.replace(/^\uFEFF/, '').replace(/\r\n/g, '\n').split('\n');
  if (lines[0] !== '---') return bad('missing_frontmatter');
  const end = lines.findIndex((line, i) => i > 0 && (line === '---' || line === '...')
    && !(prefix.length < totalBytes && i === lines.length - 1));
  if (end < 0) return bad(prefix.length < totalBytes ? 'header_too_large' : 'invalid_frontmatter');
  const values = new Map<string, string>();
  for (let i = 1; i < end; i++) {
    const line = lines[i]!;
    if (!line.trim() || line.trimStart().startsWith('#')) continue;
    const pair = /^(name|description):\s*(.*)$/.exec(line);
    if (!pair) continue;
    const key = pair[1]!, raw = pair[2]!;
    if (values.has(key)) return bad('invalid_frontmatter');
    let value: string;
    if (/^[|>][-+]?$/.test(raw)) {
      const block: string[] = [];
      while (i + 1 < end && (/^\s/.test(lines[i + 1]!) || !lines[i + 1]!.trim())) block.push(lines[++i]!);
      const nonblank = block.filter(line => line.trim());
      if (!nonblank.length || nonblank.some(line => /^\t/.test(line))) return bad('invalid_frontmatter');
      const indent = Math.min(...nonblank.map(line => /^ */.exec(line)![0].length));
      value = block.map(line => line.slice(indent)).join(raw[0] === '>' ? ' ' : '\n').trimEnd();
    } else if (raw.startsWith('"')) {
      try { const parsed: unknown = JSON.parse(raw); if (typeof parsed !== 'string') return bad('invalid_frontmatter'); value = parsed; }
      catch { return bad('invalid_frontmatter'); }
    } else if (raw.startsWith("'")) {
      if (!/^'(?:[^']|'')*'$/.test(raw)) return bad('invalid_frontmatter');
      value = raw.slice(1, -1).replace(/''/g, "'");
    } else {
      if (!raw || /^[!&*\[{]/.test(raw) || /:\s/.test(raw)) return bad('invalid_frontmatter');
      value = raw.replace(/\s+#.*$/, '').trim();
    }
    if (!value.trim() || /[\u0000-\u0008\u000b-\u001f\u007f\p{Surrogate}]/u.test(value)
      || Buffer.byteLength(value) > (key === 'name' ? S.nameBytes : S.descriptionBytes)) return bad('invalid_frontmatter');
    values.set(key, value);
  }
  if (!values.has('name') || !values.has('description')) return bad('invalid_frontmatter');
  return { name: values.get('name')!, description: values.get('description')!, metadataStatus: 'ready' };
}

/** Bounded by the existing index and tool budget; no independent filesystem or content reader. */
export function createProjectReadSkills(index: ProjectReadIndex, options: Readonly<{ root: FolderRoot; signal: AbortSignal; budget: ProjectReadIoBudget }>) {
  const discovered = new Map<string, Discovered>(), loaded = new Map<string, { snapshotId: string; version: string }>();
  function verify(skillId: string): Discovered {
    const entry = discovered.get(skillId);
    if (!entry) return fail('CAPABILITY_DENIED');
    if (entry.snapshotId !== index.snapshotId()) return fail('CURSOR_STALE');
    const current = index.resolveFile(skillId);
    if (skillObservationVersion(current) !== entry.descriptor.discoveryVersion) return fail('SOURCE_CHANGED');
    return entry;
  }
  return Object.freeze({
    async describe(entry: ProjectReadEntry, operation: ProjectReadOperation): Promise<AgentSkillDescriptor | null> {
      if (entry.kind !== 'file' || entry.readability !== 'readable' || !entry.fileId || !isSkillEntry(entry.relativePath)) return null;
      const file = index.resolveFile(entry.fileId);
      const prefix = await readProjectMetadataPrefix({ ...options, file, operation, maxBytes: S.metadataBytes });
      const descriptor: AgentSkillDescriptor = Object.freeze({ skillId: entry.fileId, entryRelativePath: file.relativePath,
        directoryId: entry.parentId, discoveryVersion: skillObservationVersion(file), versionMethod: 'metadata-observation-sha256-v1',
        baseRelativeDirectory: file.relativePath.split('/').slice(0, -1).join('/'), ...parseSkillMetadata(prefix, file.size) });
      return descriptor;
    },
    prepareDiscovery(entries: readonly AgentSkillDescriptor[]): () => void {
      const pending: Discovered[] = [];
      for (const descriptor of entries) {
        const file = index.resolveFile(descriptor.skillId);
        if (skillObservationVersion(file) !== descriptor.discoveryVersion) return fail('SOURCE_CHANGED');
        pending.push({ descriptor, file, snapshotId: index.snapshotId() });
      }
      return () => { for (const entry of pending) discovered.set(entry.descriptor.skillId, entry); };
    },
    bind(call: Extract<ProjectReadToolCall, { toolName: 'skill_load' | 'skill_read_reference' }>): SkillReadBinding {
      const found = verify(call.arguments.skillId);
      if (call.toolName === 'skill_load') {
        if (call.arguments.discoveryVersion !== found.descriptor.discoveryVersion) return fail('SOURCE_CHANGED');
        if (call.arguments.cursor === null && (call.arguments.start.line !== 1 || call.arguments.start.column !== 1)) return fail('INVALID_REQUEST');
        return { entry: found.descriptor, entryFile: found.file, snapshotId: found.snapshotId, role: 'entry', entryVersion: null };
      }
      const prior = loaded.get(call.arguments.skillId);
      if (!prior || prior.snapshotId !== found.snapshotId) return fail('RULES_UNAVAILABLE');
      if (prior.version !== call.arguments.skillVersion) return fail('SOURCE_CHANGED');
      const resource = index.resolveFile(call.arguments.fileId);
      if (!isSkillResource(found.file.relativePath, resource.relativePath)) return fail('CAPABILITY_DENIED');
      return { entry: found.descriptor, entryFile: found.file, snapshotId: found.snapshotId, role: 'reference', entryVersion: prior.version };
    },
    source(binding: SkillReadBinding, file: ProjectReadFile, version: string | null, complete: boolean): AgentSkillSource {
      return Object.freeze({ sourceKind: 'selected_project', skillId: binding.entry.skillId, entryRelativePath: binding.entry.entryRelativePath,
        discoveryVersion: binding.entry.discoveryVersion, entryVersion: binding.role === 'entry' ? version : binding.entryVersion,
        entryComplete: binding.role === 'reference' || complete, resourceRole: binding.role,
        resourceRelativePath: file.relativePath, resourceVersion: version });
    },
    prepareComplete(binding: SkillReadBinding, version: string): () => void {
      const found = verify(binding.entry.skillId);
      if (found.snapshotId !== binding.snapshotId) return fail('CURSOR_STALE');
      return () => { if (binding.role === 'entry') loaded.set(binding.entry.skillId, { snapshotId: binding.snapshotId, version }); };
    },
    clear(): void { discovered.clear(); loaded.clear(); },
  });
}
