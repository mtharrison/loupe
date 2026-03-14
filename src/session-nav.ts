export type SessionNavHierarchyNode = {
  children: SessionNavHierarchyNode[];
  count: number;
  id: string;
  meta: Record<string, any>;
  traceIds: string[];
  type: string;
};

export type SessionNavTraceSummary = {
  costUsd: number | null;
  flags?: {
    hasHighlights: boolean;
  };
  hierarchy: {
    rootActorId: string;
    sessionId: string;
  };
  id: string;
  startedAt: string;
  status: "pending" | "ok" | "error";
};

export type SessionNavItem = {
  callCount: number;
  costUsd: number | null;
  hasHighlights: boolean;
  id: string;
  latestStartedAt: string | null;
  latestTimestamp: string | null;
  primaryActor: string;
  primaryLabel: string;
  shortSessionId: string;
  status: "error" | "ok" | "pending";
};

export function deriveSessionNavItems(
  sessionNodes: SessionNavHierarchyNode[],
  traceById: Map<string, SessionNavTraceSummary>,
): SessionNavItem[] {
  return sessionNodes
    .map((node) => deriveSessionNavItem(node, traceById))
    .sort(compareSessionNavItems);
}

function deriveSessionNavItem(
  node: SessionNavHierarchyNode,
  traceById: Map<string, SessionNavTraceSummary>,
): SessionNavItem {
  const traces = node.traceIds
    .map((traceId) => traceById.get(traceId))
    .filter((trace): trace is SessionNavTraceSummary => Boolean(trace));
  const latestTrace = getLatestTrace(traces);
  const sessionId =
    getSessionId(node) ?? latestTrace?.hierarchy.sessionId ?? "unknown";
  const shortSessionId = shortId(sessionId);
  const primaryActor =
    getPrimaryActor(node) ?? latestTrace?.hierarchy.rootActorId ?? shortSessionId;

  return {
    callCount: node.count,
    costUsd: getCostUsd(node, traces),
    hasHighlights: traces.some((trace) => Boolean(trace.flags?.hasHighlights)),
    id: node.id,
    latestStartedAt: latestTrace?.startedAt ?? null,
    latestTimestamp: latestTrace?.startedAt
      ? formatCompactTimestamp(latestTrace.startedAt)
      : null,
    primaryActor,
    primaryLabel: primaryActor,
    shortSessionId,
    status: getAggregateStatus(traces),
  };
}

function getCostUsd(
  node: SessionNavHierarchyNode,
  traces: SessionNavTraceSummary[],
): number | null {
  if (
    typeof node.meta?.costUsd === "number" &&
    Number.isFinite(node.meta.costUsd)
  ) {
    return roundCostUsd(node.meta.costUsd);
  }

  const traceCosts = traces
    .map((trace) => trace.costUsd)
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    );

  if (!traceCosts.length) {
    return null;
  }

  return roundCostUsd(traceCosts.reduce((sum, value) => sum + value, 0));
}

function getLatestTrace(
  traces: SessionNavTraceSummary[],
): SessionNavTraceSummary | null {
  let latestTrace: SessionNavTraceSummary | null = null;
  let latestTimestamp = Number.NEGATIVE_INFINITY;

  for (const trace of traces) {
    const nextTimestamp = Date.parse(trace.startedAt);
    if (!Number.isFinite(nextTimestamp)) {
      continue;
    }

    if (nextTimestamp > latestTimestamp) {
      latestTrace = trace;
      latestTimestamp = nextTimestamp;
    }
  }

  return latestTrace;
}

function getAggregateStatus(
  traces: SessionNavTraceSummary[],
): "error" | "ok" | "pending" {
  if (traces.some((trace) => trace.status === "error")) {
    return "error";
  }

  if (traces.some((trace) => trace.status === "pending")) {
    return "pending";
  }

  return "ok";
}

function getSessionId(node: SessionNavHierarchyNode): string | null {
  if (typeof node.meta?.sessionId === "string" && node.meta.sessionId) {
    return node.meta.sessionId;
  }

  if (node.id.startsWith("session:")) {
    return node.id.slice("session:".length);
  }

  return null;
}

function getPrimaryActor(node: SessionNavHierarchyNode): string | null {
  const actorNode = node.children.find((child) => child.type === "actor");
  return (
    actorNode?.meta?.actorId ??
    actorNode?.meta?.rootActorId ??
    node.meta?.rootActorId ??
    null
  );
}

function compareSessionNavItems(
  left: SessionNavItem,
  right: SessionNavItem,
): number {
  const timestampDelta =
    toSortableTimestamp(right.latestStartedAt) -
    toSortableTimestamp(left.latestStartedAt);
  if (timestampDelta !== 0) {
    return timestampDelta;
  }

  const statusDelta = getStatusRank(left.status) - getStatusRank(right.status);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  const costDelta = (right.costUsd ?? 0) - (left.costUsd ?? 0);
  if (costDelta !== 0) {
    return costDelta;
  }

  return left.primaryLabel.localeCompare(right.primaryLabel);
}

function getStatusRank(status: SessionNavItem["status"]): number {
  switch (status) {
    case "error":
      return 0;
    case "pending":
      return 1;
    default:
      return 2;
  }
}

function toSortableTimestamp(value: string | null): number {
  if (!value) {
    return Number.NEGATIVE_INFINITY;
  }

  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

function roundCostUsd(value: number): number {
  return Math.round(value * 1e12) / 1e12;
}

function shortId(value: string): string {
  if (!value) {
    return "unknown";
  }

  return value.length > 8 ? value.slice(0, 8) : value;
}

function formatCompactTimestamp(value: string): string {
  return new Date(value).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
  });
}
