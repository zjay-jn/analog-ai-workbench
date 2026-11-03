export type ProjectReadModel = Readonly<{provider:'deepseek';model:'deepseek-v4-flash'} | {provider:'kimi';model:'kimi-k3'}>;
export const PROJECT_READ_MODELS: readonly ProjectReadModel[] = Object.freeze([
  Object.freeze({provider:'kimi',model:'kimi-k3'} as const),
  Object.freeze({provider:'deepseek',model:'deepseek-v4-flash'} as const),
]);
export const PROJECT_READ_DEFAULT_MODEL: ProjectReadModel = PROJECT_READ_MODELS[0]!;
export function parseProjectReadModel(value: unknown): ProjectReadModel | null {
  if (!value || typeof value !== 'object' || Object.getPrototypeOf(value) !== Object.prototype || Reflect.ownKeys(value).length !== 2) return null;
  const provider = Object.getOwnPropertyDescriptor(value,'provider'), model = Object.getOwnPropertyDescriptor(value,'model');
  if (!provider?.enumerable || !('value' in provider) || !model?.enumerable || !('value' in model)) return null;
  return PROJECT_READ_MODELS.find(item=>item.provider === provider.value && item.model === model.value) ?? null;
}
