const SAFE_MANAGED_PATH_SEGMENT = /^[A-Za-z0-9_-]+$/;

export function assertSafeManagedPathSegment(value: string, label: string): string {
  const normalized = value.trim();
  if (!SAFE_MANAGED_PATH_SEGMENT.test(normalized)) {
    throw new Error(`${label} must be a safe path segment`);
  }
  return normalized;
}
