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

export type SessionTreeSelection = {
  selectedNodeId: string | null;
  selectedTraceId: string | null;
};

export function deriveSessionNavItems(
  sessionNodes: SessionNavHierarchyNode[],
  traceById: Map<string, SessionNavTraceSummary>,
): SessionNavItem[] {
  return sessionNodes
    .map((node) => deriveSessionNavItem(node, traceById))
    .sort(compareSessionNavItems);
}

export function sortSessionNodesForNav(
  sessionNodes: SessionNavHierarchyNode[],
  traceById: Map<string, SessionNavTraceSummary>,
): SessionNavHierarchyNode[] {
  const itemById = new Map(
    sessionNodes.map((node) => [node.id, deriveSessionNavItem(node, traceById)]),
  );

  return sessionNodes
    .slice()
    .sort(
      (left, right) =>
        compareSessionNavItems(
          itemById.get(left.id) as SessionNavItem,
          itemById.get(right.id) as SessionNavItem,
        ),
    );
}

export function findSessionNodePath(
  nodes: SessionNavHierarchyNode[],
  id: string,
  trail: SessionNavHierarchyNode[] = [],
): SessionNavHierarchyNode[] {
  for (const node of nodes) {
    const nextTrail = [...trail, node];
    if (node.id === id) {
      return nextTrail;
    }

    const childTrail = findSessionNodePath(node.children, id, nextTrail);
    if (childTrail.length) {
      return childTrail;
    }
  }

  return [];
}

export function findSessionNodeById(
  nodes: SessionNavHierarchyNode[],
  id: string,
): SessionNavHierarchyNode | null {
  return findSessionNodePath(nodes, id).at(-1) ?? null;
}

export function getNewestTraceIdForNode(
  node: SessionNavHierarchyNode | null | undefined,
): string | null {
  if (!node?.traceIds.length) {
    return null;
  }

  if (typeof node.meta?.traceId === "string" && node.meta.traceId) {
    return node.meta.traceId;
  }

  return node.traceIds[0] || null;
}

export function resolveSessionTreeSelection(
  sessionNodes: SessionNavHierarchyNode[],
  selectedNodeId: string | null,
  selectedTraceId: string | null,
): SessionTreeSelection {
  const selectedNode = selectedNodeId
    ? findSessionNodeById(sessionNodes, selectedNodeId)
    : null;
  const selectedTraceNode = selectedTraceId
    ? findSessionNodeById(sessionNodes, `trace:${selectedTraceId}`)
    : null;
  const fallbackNode = selectedNode ?? selectedTraceNode ?? sessionNodes[0] ?? null;

  if (!fallbackNode) {
    return {
      selectedNodeId: null,
      selectedTraceId: null,
    };
  }

  const nextSelectedNodeId = selectedNode?.id ?? fallbackNode.id;
  const nextSelectedTraceId =
    selectedTraceId && fallbackNode.traceIds.includes(selectedTraceId)
      ? selectedTraceId
      : getNewestTraceIdForNode(fallbackNode);

  return {
    selectedNodeId: nextSelectedNodeId,
    selectedTraceId: nextSelectedTraceId,
  };
}

export function getDefaultExpandedSessionTreeNodeIds(
  sessionNodes: SessionNavHierarchyNode[],
  activeSessionId: string | null,
  selectedNodeId: string | null,
  selectedTraceId: string | null = null,
): Set<string> {
  const expanded = new Set<string>();
  const activeSession =
    (activeSessionId
      ? sessionNodes.find((node) => node.id === activeSessionId) ?? null
      : null) ?? sessionNodes[0] ?? null;

  if (!activeSession) {
    return expanded;
  }

  if (activeSession.children.length) {
    expanded.add(activeSession.id);
  }

  visitSessionTree(activeSession.children, (node) => {
    if (node.children.length && node.type === "actor") {
      expanded.add(node.id);
    }
  });

  if (selectedNodeId) {
    for (const node of findSessionNodePath([activeSession], selectedNodeId)) {
      if (node.children.length) {
        expanded.add(node.id);
      }
    }
  }

  if (selectedTraceId) {
    for (const node of findSessionNodePath(
      [activeSession],
      `trace:${selectedTraceId}`,
    )) {
      if (node.children.length) {
        expanded.add(node.id);
      }
    }
  }

  return expanded;
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

function visitSessionTree(
  nodes: SessionNavHierarchyNode[],
  visitor: (node: SessionNavHierarchyNode) => void,
) {
  for (const node of nodes) {
    visitor(node);
    visitSessionTree(node.children, visitor);
  }
}
