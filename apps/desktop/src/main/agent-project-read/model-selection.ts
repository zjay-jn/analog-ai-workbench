import path from 'node:path';
import { createAtomicJsonStore } from '../cloud/session-store';
import { PROJECT_READ_DEFAULT_MODEL, parseProjectReadModel, type ProjectReadModel } from '../../shared/agent/agent-project-model';
import {runtimePaths} from '../runtime-paths';

/** Public model identity only. Reuses the existing bounded atomic store and its file/link/CAS checks. */
export function createProjectReadModelSelection(productRoot: string, dataRoot: string) {
  const root=path.resolve(productRoot), data=path.resolve(dataRoot), relative=path.relative(root,data).replaceAll('\\','/');
  if(root.toLowerCase()!==runtimePaths().storageRoot.toLowerCase()
    || relative!=='.local' && !/^\.local\/(?:agent-project-read-tests|agent-engine-live-tests)\/[a-f0-9-]{36}$/u.test(relative)) throw Error('PROJECT_READ_SELECTION_UNAVAILABLE');
  const parse=(value:unknown):ProjectReadModel=>{const model=parseProjectReadModel(value);if(!model)throw Error('PROJECT_READ_SELECTION_UNAVAILABLE');return model;};
  return createAtomicJsonStore(root,path.join(data,'agent-project-read-model'),'model-settings.json',parse,1024,()=>PROJECT_READ_DEFAULT_MODEL);
}
