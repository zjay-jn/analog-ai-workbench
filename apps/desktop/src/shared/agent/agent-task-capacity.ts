/** Logical byte lengths of owned files, not filesystem allocation or original project size. */
export type TaskCapacityBytes = Readonly<{ taskBytes: number; logBytes: number; workspaceBytes: number; totalBytes: number }>;
export type TaskCapacityBlock = 'active' | 'cleanup_unconfirmed' | 'referenced' | 'storage_unknown' | 'storage_changed' | null;
export type TaskCapacityEntry = TaskCapacityBytes & Readonly<{
  runId: string; projectId: string; expectedEventCount: number;
  capacityVersion: string; complete: boolean; canDelete: boolean;
  blockedReason: TaskCapacityBlock; dependentRunIds: readonly string[];
  deletionState: 'none' | 'pending' | 'failed';
}>;
export type TaskCapacity = Readonly<{
  runs: readonly TaskCapacityEntry[]; totals: TaskCapacityBytes;
  complete: boolean; measuredAt: string;
  scope: 'tool_tasks'; byteMeasure: 'logical_file_bytes';
}>;
