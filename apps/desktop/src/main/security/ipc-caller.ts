export interface IpcCallerSnapshot {
  readonly senderId: number;
  readonly expectedSenderId: number;
  readonly isTopFrame: boolean;
  readonly frameUrl: string;
  readonly allowedFrameUrls: readonly string[];
}

function normalizedPageUrl(value: string): string | null {
  try {
    const url = new URL(value);
    url.hash = "";
    url.search = "";
    return url.toString();
  } catch {
    return null;
  }
}

export function isAllowedFrameUrl(
  frameUrl: string,
  allowedFrameUrls: readonly string[],
): boolean {
  const normalizedFrame = normalizedPageUrl(frameUrl);
  if (normalizedFrame === null) {
    return false;
  }
  return allowedFrameUrls.some(
    (allowed) => normalizedPageUrl(allowed) === normalizedFrame,
  );
}

export function isTrustedIpcCaller(snapshot: IpcCallerSnapshot): boolean {
  return (
    snapshot.senderId === snapshot.expectedSenderId &&
    snapshot.isTopFrame &&
    isAllowedFrameUrl(snapshot.frameUrl, snapshot.allowedFrameUrls)
  );
}
