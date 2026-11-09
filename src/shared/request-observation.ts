const nativeModels = new WeakMap<object, string>();

export function observeNativeModel(request: object, model: string | undefined): void {
  if (model) nativeModels.set(request, model);
}

export function getObservedNativeModel(request: object): string | undefined {
  return nativeModels.get(request);
}
